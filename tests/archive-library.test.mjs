import test from 'node:test';
import assert from 'node:assert/strict';

import { AssetResolver } from '../src/archive-source.js';
import { mergeArchiveChats, namespaceArchiveSource } from '../src/archive-library.js';

test('namespaces added media and entries so equal Telegram filenames do not collide', async () => {
  const firstFile = { name: 'first' };
  const secondFile = { name: 'second' };
  const firstEntry = { path: 'photos/photo_1.jpg', getFile: async () => firstFile };
  const secondEntry = { path: 'photos/photo_1.jpg', getFile: async () => secondFile };
  const archive = {
    chats: [{ id: 'new', messages: [{ id: '1', media: [{ type: 'photo', path: 'photos/photo_1.jpg', thumbnailPath: 'photos/photo_1_thumb.jpg' }] }] }],
  };

  const namespaced = namespaceArchiveSource(archive, [secondEntry], 'added-1');
  assert.equal(archive.chats[0].messages[0].media[0].path, '__teleview_sources/added-1/photos/photo_1.jpg');
  assert.equal(archive.chats[0].messages[0].media[0].thumbnailPath, '__teleview_sources/added-1/photos/photo_1_thumb.jpg');
  assert.equal(namespaced.entries[0].path, '__teleview_sources/added-1/photos/photo_1.jpg');

  const resolver = new AssetResolver([firstEntry]);
  resolver.addEntries(namespaced.entries);
  assert.equal(await resolver.getFile('photos/photo_1.jpg'), firstFile);
  assert.equal(await resolver.getFile('__teleview_sources/added-1/photos/photo_1.jpg'), secondFile);
});

test('adds new chats, keeps colliding ids unique, and merges updated exports', () => {
  const existing = [{ id: '10', _telegramId: '10', name: 'Alice', messages: [{ id: '1', text: 'old' }] }];
  const sameChat = [{ id: '10', name: 'Alice', messages: [{ id: '1', text: 'updated' }, { id: '2', text: 'new' }] }];
  const merged = mergeArchiveChats(existing, sameChat, 'added-1');

  assert.equal(merged.added.length, 0);
  assert.equal(merged.updated.length, 1);
  assert.deepEqual(merged.chats[0].messages.map(({ id, text }) => [id, text]), [['1', 'updated'], ['2', 'new']]);
  assert.equal(merged.selectedChatId, '10');

  const collision = mergeArchiveChats(merged.chats, [{ id: '10', name: 'Different chat', messages: [] }], 'added-2');
  assert.equal(collision.added.length, 1);
  assert.equal(collision.added[0].id, '10@added-2');
  assert.equal(collision.chats.length, 2);
});
