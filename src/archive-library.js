const LOCAL_MEDIA_PATH_KEYS = ['path', 'file', 'filePath', 'photo', 'thumbnail', 'thumbnailPath'];

function safeSourceKey(value) {
  return String(value || 'source').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'source';
}

function namespacePath(value, prefix) {
  if (typeof value !== 'string' || !value || /^(?:[a-z]+:|\/\/)/iu.test(value)) return value;
  const clean = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  return clean ? `${prefix}/${clean}` : value;
}

function namespaceEntry(entry, prefix) {
  const wrapped = Object.create(entry || null);
  Object.defineProperty(wrapped, 'path', {
    value: namespacePath(entry?.path, prefix),
    enumerable: true,
    configurable: true,
  });
  return wrapped;
}

/**
 * Keep files from independently exported folders in separate virtual paths.
 * Telegram commonly reuses names such as photos/photo_1.jpg in every export.
 */
export function namespaceArchiveSource(archive, entries, sourceKey) {
  const prefix = `__teleview_sources/${safeSourceKey(sourceKey)}`;
  for (const chat of archive?.chats || []) {
    for (const message of chat?.messages || []) {
      for (const media of message?.media || []) {
        for (const key of LOCAL_MEDIA_PATH_KEYS) {
          if (key in media) media[key] = namespacePath(media[key], prefix);
        }
      }
    }
  }
  return {
    archive,
    entries: Array.from(entries || [], (entry) => namespaceEntry(entry, prefix)),
    prefix,
  };
}

function chatIdentity(chat) {
  const originalId = String(chat?._telegramId ?? chat?.id ?? '');
  const name = String(chat?.name ?? chat?.title ?? '').trim().toLocaleLowerCase();
  return `${originalId}\u0000${name}`;
}

function uniqueChatId(candidate, usedIds, sourceKey) {
  let next = String(candidate || 'chat');
  if (!usedIds.has(next)) return next;
  const suffix = safeSourceKey(sourceKey);
  next = `${next}@${suffix}`;
  let counter = 2;
  while (usedIds.has(next)) next = `${candidate}@${suffix}-${counter++}`;
  return next;
}

/** Merge new exports without replacing existing chats or duplicating messages. */
export function mergeArchiveChats(existingChats, incomingChats, sourceKey = 'added') {
  const chats = Array.from(existingChats || []);
  const usedIds = new Set(chats.map((chat) => String(chat.id)));
  const byIdentity = new Map(chats.map((chat) => [chatIdentity(chat), chat]));
  const added = [];
  const updated = [];

  for (const incoming of incomingChats || []) {
    incoming._telegramId ??= String(incoming.id);
    const match = byIdentity.get(chatIdentity(incoming));
    if (match) {
      const positions = new Map(match.messages.map((message, index) => [String(message.id), index]));
      const messages = [...match.messages];
      for (const message of incoming.messages || []) {
        const position = positions.get(String(message.id));
        if (position == null) {
          positions.set(String(message.id), messages.length);
          messages.push(message);
        } else {
          messages[position] = message;
        }
      }
      Object.assign(match, incoming, {
        id: match.id,
        _telegramId: match._telegramId ?? incoming._telegramId,
        messages,
      });
      updated.push(match);
      continue;
    }

    incoming.id = uniqueChatId(incoming.id, usedIds, sourceKey);
    usedIds.add(String(incoming.id));
    chats.push(incoming);
    byIdentity.set(chatIdentity(incoming), incoming);
    added.push(incoming);
  }

  const selected = added[0] || updated[0] || null;
  return {
    chats,
    added,
    updated,
    selectedChatId: selected?.id ?? null,
  };
}
