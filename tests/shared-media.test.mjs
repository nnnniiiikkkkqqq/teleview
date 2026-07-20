import test from 'node:test';
import assert from 'node:assert/strict';

import { collectShared, mediaKind } from '../src/shared-media.js';

test('shared content separates Telegram media categories and excludes stickers', () => {
  const chat = {
    messages: [
      {
        id: 1,
        text: 'See https://example.com/a',
        media: [
          { type: 'photo', path: 'photos/a.jpg' },
          { type: 'video', path: 'video/a.mp4' },
          { type: 'file', path: 'files/a.pdf' },
          { type: 'audio', path: 'audio/song.mp3' },
          { type: 'voice', path: 'voice/note.ogg' },
          { type: 'animation', path: 'animations/a.gif' },
          { type: 'sticker', path: 'stickers/a.webp' },
          { type: 'link', url: 'https://example.com/a' },
        ],
      },
    ],
  };

  const shared = collectShared(chat);
  assert.deepEqual(Object.fromEntries(
    ['photos', 'videos', 'files', 'audio', 'links', 'voice', 'gifs', 'previewable']
      .map((key) => [key, shared[key].length]),
  ), {
    photos: 1,
    videos: 1,
    files: 1,
    audio: 1,
    links: 1,
    voice: 1,
    gifs: 1,
    previewable: 3,
  });
  assert.equal(shared.previewable.some(({ media }) => media.type === 'sticker'), false);
});

test('media kind keeps voice messages distinct from music files', () => {
  assert.equal(mediaKind({ type: 'voice_message' }), 'voice');
  assert.equal(mediaKind({ type: 'audio_file' }), 'audio');
  assert.equal(mediaKind({ type: 'gif' }), 'animation');
  assert.equal(mediaKind({ type: 'video_message' }), 'video');
});
