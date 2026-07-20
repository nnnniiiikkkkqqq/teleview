import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TELEGRAM_EXPORT_MODEL_VERSION,
  TelegramExportParseError,
  normalizeTelegramText,
  parseTelegramExport,
  parseTelegramHtml,
  parseTelegramJson,
} from '../src/telegram-parser.js';

test('normalizes a single-chat JSON export without guessing the owner', () => {
  const archive = parseTelegramJson({
    name: 'Design crew',
    type: 'private_group',
    id: 901,
    messages: [
      {
        id: 10,
        type: 'message',
        date: '2024-01-02T10:30:00',
        date_unixtime: '1704191400',
        from: 'Ada',
        from_id: 'user100',
        text: ['Read ', { type: 'bold', text: 'this' }, ' and ', { type: 'link', text: 'that', href: 'https://example.test' }],
        text_entities: [
          { type: 'plain', text: 'Read ' },
          { type: 'bold', text: 'this' },
          { type: 'plain', text: ' and ' },
          { type: 'link', text: 'that', href: 'https://example.test' },
        ],
        reply_to_message_id: 9,
        forwarded_from: 'Research channel',
        forwarded_from_id: 'channel77',
        media_type: 'voice_message',
        file: 'voice_messages/audio_10.ogg',
        file_name: 'Note.ogg',
        mime_type: 'audio/ogg',
        duration_seconds: 14,
        reactions: [{ type: 'emoji', emoji: '👍', count: 3, recent: [{ from: 'Lin' }] }],
        poll: {
          question: 'Ship it?',
          total_voters: 5,
          answers: [{ text: 'Yes', voters: 4, chosen: true }, { text: 'No', voters: 1 }],
        },
        contact_information: { first_name: 'Grace', last_name: 'Hopper', phone_number: '+1 555 0100' },
        location_information: { latitude: 48.1486, longitude: 17.1077, place_name: 'Bratislava' },
      },
      {
        id: 11,
        type: 'service',
        date_unixtime: '1704191460',
        actor: 'Ada',
        actor_id: 'user100',
        action: 'invite_members',
        members: ['Lin'],
        text: 'Ada added Lin',
      },
    ],
  });

  assert.equal(archive.modelVersion, TELEGRAM_EXPORT_MODEL_VERSION);
  assert.equal(archive.format, 'json');
  assert.equal(archive.title, 'Design crew');
  assert.equal(archive.chats[0].id, '901');
  assert.equal(archive.chats[0].messages.length, 2);

  const message = archive.chats[0].messages[0];
  assert.equal(message.text, 'Read this and that');
  assert.deepEqual(message.textEntities.map(({ type, offset, length }) => ({ type, offset, length })), [
    { type: 'plain', offset: 0, length: 5 },
    { type: 'bold', offset: 5, length: 4 },
    { type: 'plain', offset: 9, length: 5 },
    { type: 'link', offset: 14, length: 4 },
  ]);
  assert.equal(message.textEntities[3].href, 'https://example.test');
  assert.equal(message.replyToId, '9');
  assert.equal(message.forwardedFrom, 'Research channel');
  assert.equal(message.forwarded.id, 'channel77');
  assert.equal(message.isOutgoing, undefined);
  assert.deepEqual(message.media[0], {
    type: 'voice',
    path: 'voice_messages/audio_10.ogg',
    fileName: 'Note.ogg',
    mimeType: 'audio/ogg',
    duration: 14,
  });
  assert.equal(message.reactions[0].emoji, '👍');
  assert.deepEqual(message.reactions[0].recent, [{ from: 'Lin' }]);
  assert.equal(message.poll.options[0].votes, 4);
  assert.equal(message.poll.options[0].chosen, true);
  assert.equal(message.contact.name, 'Grace Hopper');
  assert.equal(message.location.placeName, 'Bratislava');

  const service = archive.chats[0].messages[1];
  assert.equal(service.type, 'service');
  assert.equal(service.senderName, 'Ada');
  assert.equal(service.service.action, 'invite_members');
  assert.deepEqual(service.service.details.members, ['Lin']);
  assert.deepEqual(archive.stats, { chats: 1, messages: 2, serviceMessages: 1, media: 1, sourceFiles: 1 });
});

test('parses chats.list account JSON, exposes the owner, and marks outgoing messages by id', async () => {
  const data = {
    personal_information: {
      user_id: 42,
      first_name: 'Mina',
      last_name: 'Stone',
      phone_number: '+421900123456',
      username: 'mina',
    },
    chats: {
      about: 'All chats',
      list: [
        {
          id: 3,
          type: 'personal_chat',
          name: 'Lee',
          messages: [
            { id: 1, type: 'message', date_unixtime: '1700000000', from: 'Mina Stone', from_id: 'user42', text: 'Mine' },
            { id: 2, type: 'message', date_unixtime: '1700000010', from: 'Lee', from_id: 'user7', text: 'Theirs' },
          ],
        },
      ],
    },
  };
  const entry = {
    path: 'takeout/result.json',
    file: Promise.resolve({ text: async () => JSON.stringify(data) }),
  };
  const archive = await parseTelegramExport({ name: 'My export', entries: [entry] });

  assert.deepEqual(archive.owner, {
    id: '42', name: 'Mina Stone', phone: '+421900123456', username: 'mina',
  });
  assert.equal(archive.title, 'Mina Stone’s Telegram archive');
  assert.equal(archive.sourceName, 'My export');
  assert.equal(archive.chats[0].messages[0].isOutgoing, true);
  assert.equal(archive.chats[0].messages[1].isOutgoing, false);
});

test('parses paginated HTML, rich text, replies, forwarding, media, reactions, services, and joined senders', async () => {
  const firstPage = `<!DOCTYPE html>
  <html><head><title>Exported Data</title></head><body>
    <div class="page_header"><div class="content"><div class="text bold">Weekend crew</div></div></div>
    <div class="message default clearfix" id="message101">
      <div class="body">
        <div class="pull_right date details" title="02.01.2024 10:30:00 UTC+01:00">10:30</div>
        <div class="from_name">Ada &amp; Co</div>
        <div class="reply_to details">In reply to <a href="#go_to_message99">this message</a></div>
        <div class="forwarded body">
          <div class="from_name">Forwarded from News desk</div>
          <div class="date details" title="01.01.2024 09:00:00 UTC+01:00">09:00</div>
        </div>
        <div class="media_wrap clearfix">
          <a class="photo_wrap clearfix pull_left" href="photos/photo_1.jpg">
            <img class="photo" src="photos/photo_1_thumb.jpg" style="width: 320px; height: 180px">
          </a>
        </div>
        <div class="text">Hello <strong>world</strong><br>Visit <a href="https://example.test">our site</a>.</div>
        <div class="reactions"><span class="reaction">🔥 2</span></div>
      </div>
    </div>
    <div class="message service" id="message102">
      <div class="body details">Ada pinned a message</div>
    </div>
  </body></html>`;
  const secondPage = `<html><body>
    <div class="page_header"><div class="text bold">Weekend crew</div></div>
    <div class="message default clearfix joined" id="message103">
      <div class="body">
        <div class="pull_right date details" title="02.01.2024 10:31:00 UTC+01:00">10:31</div>
        <div class="text">One more thing</div>
        <a class="media clearfix pull_left media_voice_message" href="voice_messages/audio_3.ogg"><div class="status details">0:37</div></a>
        <a class="media_location" href="https://maps.google.com/?q=48.1486,17.1077"><div class="title">Old Town</div></a>
      </div>
    </div>
  </body></html>`;

  const archive = await parseTelegramExport([
    { path: 'chats/chat_001/messages2.html', content: secondPage },
    { path: 'chats/chat_001/messages.html', content: firstPage },
    { path: 'chats/chat_001/photos/photo_1.jpg', content: 'not read' },
  ], { sourceName: 'HTML takeout' });

  assert.equal(archive.format, 'html');
  assert.equal(archive.title, 'Weekend crew');
  assert.equal(archive.chats.length, 1);
  assert.equal(archive.chats[0].messages.length, 3);
  const message = archive.chats[0].messages[0];
  assert.equal(message.id, '101');
  assert.equal(message.date, '2024-01-02T09:30:00.000Z');
  assert.equal(message.senderName, 'Ada & Co');
  assert.equal(message.replyToId, '99');
  assert.equal(message.forwardedFrom, 'News desk');
  assert.equal(message.text, 'Hello world\nVisit our site.');
  assert.deepEqual(message.textEntities.map(({ type, text }) => ({ type, text })), [
    { type: 'bold', text: 'world' },
    { type: 'link', text: 'our site' },
  ]);
  assert.equal(message.textEntities[1].href, 'https://example.test');
  assert.deepEqual(message.media, [{
    type: 'photo',
    path: 'chats/chat_001/photos/photo_1.jpg',
    fileName: 'photo_1.jpg',
    thumbnailPath: 'chats/chat_001/photos/photo_1_thumb.jpg',
    width: 320,
    height: 180,
  }]);
  assert.deepEqual(message.reactions, [{ emoji: '🔥', count: 2 }]);
  assert.equal(archive.chats[0].messages[1].service.action, 'pin_message');
  const joined = archive.chats[0].messages[2];
  assert.equal(joined.senderName, 'Ada & Co');
  assert.equal(joined.media[0].type, 'voice');
  assert.equal(joined.media[0].duration, 37);
  assert.equal(joined.location.latitude, 48.1486);
  assert.equal(joined.location.longitude, 17.1077);
  assert.deepEqual(archive.stats, { chats: 1, messages: 3, serviceMessages: 1, media: 2, sourceFiles: 2 });
});

test('groups multiple HTML chat folders and de-duplicates repeated page messages', () => {
  const makePage = (name, messages) => `<html><body>
    <div class="page_header"><div class="text bold">${name}</div></div>${messages}
  </body></html>`;
  const message = (id, sender, text) => `<div class="message default" id="message${id}"><div class="body">
    <div class="from_name">${sender}</div><div class="text">${text}</div>
  </div></div>`;
  const archive = parseTelegramHtml([
    { path: 'chats/chat_2/messages.html', content: makePage('Two', message(1, 'B', 'Second')) },
    { path: 'chats/chat_1/messages.html', content: makePage('One', message(1, 'A', 'First')) },
    { path: 'chats/chat_1/messages2.html', content: makePage('One', message(1, 'A', 'Repeated') + message(2, 'A', 'Next')) },
  ]);
  assert.deepEqual(archive.chats.map((chat) => chat.name), ['One', 'Two']);
  assert.deepEqual(archive.chats[0].messages.map((item) => item.text), ['First', 'Next']);
  assert.match(archive.warnings[0], /duplicate message 1/i);
});

test('falls back to HTML when a result.json entry is damaged', async () => {
  const archive = await parseTelegramExport([
    { path: 'result.json', content: '{bad json' },
    { path: 'messages.html', content: '<div class="message service" id="message1"><div class="body details">History was cleared</div></div>' },
  ]);
  assert.equal(archive.format, 'html');
  assert.match(archive.warnings[0], /ignored unreadable json/i);
});

test('reports unsupported folders with a stable error code', async () => {
  await assert.rejects(
    parseTelegramExport([{ path: 'photos/photo.jpg', content: 'binary' }]),
    (error) => error instanceof TelegramExportParseError && error.code === 'NO_SUPPORTED_FILES',
  );
});

test('normalizeTelegramText also accepts explicit offset entities', () => {
  assert.deepEqual(normalizeTelegramText('hello', [{ type: 'italic', offset: 1, length: 3, text: 'ell' }]), {
    text: 'hello',
    textEntities: [{ type: 'italic', offset: 1, length: 3, text: 'ell' }],
  });
});
