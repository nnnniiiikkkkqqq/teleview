export function mediaKind(media) {
  const type = String(media?.type || '').toLocaleLowerCase();
  if (/photo|image/.test(type)) return 'photo';
  if (/video|round_video|video_message/.test(type)) return 'video';
  if (/voice/.test(type)) return 'voice';
  if (/audio|music/.test(type)) return 'audio';
  if (/sticker/.test(type)) return 'sticker';
  if (/animation|gif/.test(type)) return 'animation';
  if (/link|webpage/.test(type)) return 'link';
  return 'file';
}

export function collectShared(chat) {
  const items = {
    photos: [],
    videos: [],
    files: [],
    audio: [],
    links: [],
    voice: [],
    gifs: [],
    previewable: [],
  };
  const seenLinks = new Set();

  for (const message of chat?.messages || []) {
    const mediaItems = Array.isArray(message.media) ? message.media : [];
    for (let index = 0; index < mediaItems.length; index += 1) {
      const media = mediaItems[index];
      const kind = mediaKind(media);
      const item = { media, message, index };

      if (kind === 'photo') {
        items.photos.push(item);
        items.previewable.push(item);
      } else if (kind === 'video') {
        items.videos.push(item);
        items.previewable.push(item);
      } else if (kind === 'animation') {
        items.gifs.push(item);
        items.previewable.push(item);
      } else if (kind === 'file') {
        items.files.push(item);
      } else if (kind === 'audio') {
        items.audio.push(item);
      } else if (kind === 'voice') {
        items.voice.push(item);
      } else if (kind === 'link') {
        const url = String(media.url || media.path || '');
        if (!seenLinks.has(url)) {
          items.links.push(item);
          if (url) seenLinks.add(url);
        }
      }
      // Stickers intentionally remain available in the message timeline but
      // are not part of Telegram's shared-media browser.
    }

    const urlMatches = String(message.text || '').match(/https?:\/\/[^\s<]+/giu) || [];
    for (const url of urlMatches) {
      if (seenLinks.has(url)) continue;
      seenLinks.add(url);
      items.links.push({ media: { type: 'link', url, title: url }, message, index: -1 });
    }
  }

  return items;
}
