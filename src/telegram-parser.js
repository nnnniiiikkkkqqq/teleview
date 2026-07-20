/**
 * Telegram Desktop export parser.
 *
 * The module deliberately has no DOM or Node dependencies. JSON and Telegram's
 * generated HTML can therefore be parsed in a browser worker as well as in the
 * main browser thread.
 */

export const TELEGRAM_EXPORT_MODEL_VERSION = 1;

const MEDIA_EXTENSIONS = {
  photo: /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|webp)$/i,
  video: /\.(?:m4v|mkv|mov|mp4|webm)$/i,
  audio: /\.(?:aac|flac|m4a|mp3|oga|ogg|opus|wav)$/i,
};

const HTML_ENTITY_MAP = {
  amp: '&', apos: "'", cent: '¢', copy: '©', euro: '€', gt: '>', hellip: '…',
  laquo: '«', ldquo: '“', lsquo: '‘', lt: '<', mdash: '—', middot: '·',
  nbsp: '\u00a0', ndash: '–', pound: '£', quot: '"', raquo: '»', rdquo: '”',
  reg: '®', rsquo: '’', trade: '™', yen: '¥',
};

const VOID_HTML_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

const BLOCKED_COPY_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class TelegramExportParseError extends Error {
  constructor(message, code = 'INVALID_TELEGRAM_EXPORT') {
    super(message);
    this.name = 'TelegramExportParseError';
    this.code = code;
  }
}

function stringOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

function idOrNull(value) {
  const result = stringOrNull(value);
  return result === null ? null : result;
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function booleanOrUndefined(value) {
  return typeof value === 'boolean' ? value : undefined;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

function serializableCopy(value, depth = 0) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (depth > 12) return null;
  if (Array.isArray(value)) return value.map((item) => serializableCopy(item, depth + 1));
  if (typeof value !== 'object') return String(value);
  const copy = {};
  for (const [key, item] of Object.entries(value)) {
    if (BLOCKED_COPY_KEYS.has(key) || typeof item === 'function' || item === undefined) continue;
    copy[key] = serializableCopy(item, depth + 1);
  }
  return copy;
}

function normalizePath(path) {
  const pieces = String(path || '').replace(/\\/g, '/').replace(/^file:\/\//i, '').split('/');
  const normalized = [];
  for (const piece of pieces) {
    if (!piece || piece === '.') continue;
    if (piece === '..') normalized.pop();
    else normalized.push(piece);
  }
  return normalized.join('/');
}

function dirname(path) {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf('/');
  return index < 0 ? '' : normalized.slice(0, index);
}

function basename(path) {
  return normalizePath(path).split('/').pop() || '';
}

function joinPath(base, relative) {
  return normalizePath(base ? `${base}/${relative}` : relative);
}

function decodePath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function unavailablePath(path) {
  return /^\(?\s*(?:file|photo|media)\s+not\s+included/i.test(String(path || ''));
}

function fileNameFromPath(path) {
  return unavailablePath(path) ? null : basename(String(path || '').split(/[?#]/)[0]);
}

function stableSlug(value) {
  const source = String(value || '');
  const slug = source
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '');
  let hash = 2166136261;
  for (const character of source) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${slug || 'user'}-${(hash >>> 0).toString(36)}`;
}

function naturalCompare(left, right) {
  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' });
}

function timestampFromUnix(value) {
  const seconds = numberOrNull(value);
  if (seconds === null) return null;
  const milliseconds = Math.abs(seconds) > 100_000_000_000 ? seconds : seconds * 1000;
  return Number.isFinite(new Date(milliseconds).getTime()) ? milliseconds : null;
}

function dateResult(rawDate, unixValue) {
  let timestamp = timestampFromUnix(unixValue);
  if (timestamp === null && rawDate) {
    const parsed = parseTelegramDate(rawDate);
    timestamp = parsed.timestamp;
  }
  return {
    date: timestamp === null ? (stringOrNull(rawDate) || '') : new Date(timestamp).toISOString(),
    timestamp,
    rawDate: stringOrNull(rawDate),
  };
}

function parseTelegramDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return { date: '', timestamp: null };
  // Telegram's HTML export uses day.month.year. Parse it before Date.parse,
  // which otherwise interprets ambiguous dates such as 02.01 as month.day.
  const match = raw.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})[, ]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s+(?:(?:UTC|GMT)\s*)?([+-]\d{2}:?\d{2}|Z)|(\s+(?:UTC|GMT)))?$/i);
  if (match) {
    const [, day, month, year, hour, minute, second = '00', rawZone, utcOnly] = match;
    let zone = rawZone || (utcOnly ? 'Z' : '');
    if (zone && zone !== 'Z' && !zone.includes(':')) zone = `${zone.slice(0, 3)}:${zone.slice(3)}`;
    const iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute}:${second}${zone}`;
    const timestamp = Date.parse(iso);
    return Number.isFinite(timestamp)
      ? { date: new Date(timestamp).toISOString(), timestamp }
      : { date: raw, timestamp: null };
  }

  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp)
    ? { date: new Date(timestamp).toISOString(), timestamp }
    : { date: raw, timestamp: null };
}

function normalizeEntity(entity, fallbackOffset = 0) {
  if (typeof entity === 'string') {
    return { type: 'plain', text: entity, offset: fallbackOffset, length: entity.length };
  }
  const copy = serializableCopy(entity || {});
  const text = String(copy.text ?? '');
  const offset = numberOrNull(copy.offset) ?? fallbackOffset;
  const length = numberOrNull(copy.length) ?? text.length;
  return { ...copy, type: String(copy.type || 'plain'), text, offset, length };
}

/** Normalizes Telegram's string-or-rich-segment text representation. */
export function normalizeTelegramText(textValue, entityValue) {
  const textSegments = Array.isArray(textValue) ? textValue : null;
  const sourceEntities = Array.isArray(entityValue)
    ? entityValue
    : (textSegments ? textSegments : []);

  let text;
  if (textSegments) {
    text = textSegments.map((segment) => typeof segment === 'string' ? segment : String(segment?.text ?? '')).join('');
  } else {
    text = String(textValue ?? '');
  }

  let cursor = 0;
  const textEntities = sourceEntities.map((entity) => {
    const normalized = normalizeEntity(entity, cursor);
    if (numberOrNull(entity?.offset) === null) normalized.offset = cursor;
    cursor = normalized.offset + normalized.length;
    return normalized;
  });

  // A few older exports contain entities but omit the top-level text field.
  if (!text && textEntities.length) text = textEntities.map((entity) => entity.text).join('');
  return { text, textEntities };
}

function normalizeOwner(root) {
  const info = root?.personal_information;
  if (!info || typeof info !== 'object') return null;
  const name = [info.first_name, info.last_name].filter(Boolean).join(' ').trim()
    || stringOrNull(info.name)
    || stringOrNull(info.username)
    || 'Telegram user';
  const rawId = info.user_id ?? info.id;
  return compactObject({
    id: idOrNull(rawId),
    name,
    phone: stringOrNull(info.phone_number ?? info.phone),
    username: stringOrNull(info.username),
    bio: stringOrNull(info.bio),
  });
}

function ownerMatches(owner, senderId) {
  if (!owner?.id || senderId === undefined || senderId === null) return false;
  const clean = (value) => String(value).toLocaleLowerCase().replace(/^user/, '').replace(/^[-+]/, '');
  return clean(owner.id) === clean(senderId);
}

function normalizeReactions(reactions) {
  if (!Array.isArray(reactions)) return [];
  return reactions.map((reaction) => {
    if (typeof reaction === 'string') return { emoji: reaction, count: 1 };
    const raw = serializableCopy(reaction || {});
    const emoji = raw.emoji ?? raw.emoticon ?? raw.document_id;
    return compactObject({
      ...raw,
      emoji: stringOrNull(emoji),
      count: numberOrNull(raw.count) ?? 1,
      chosen: booleanOrUndefined(raw.chosen),
      recent: Array.isArray(raw.recent) ? raw.recent.map((item) => serializableCopy(item)) : undefined,
    });
  });
}

function normalizePoll(poll) {
  if (!poll || typeof poll !== 'object') return null;
  const rawOptions = poll.answers ?? poll.options ?? [];
  return compactObject({
    question: String(poll.question ?? poll.title ?? ''),
    closed: booleanOrUndefined(poll.closed ?? poll.is_closed),
    anonymous: booleanOrUndefined(poll.anonymous ?? poll.is_anonymous),
    quiz: booleanOrUndefined(poll.quiz ?? poll.is_quiz),
    totalVoters: numberOrNull(poll.total_voters ?? poll.totalVoters),
    options: Array.isArray(rawOptions) ? rawOptions.map((answer) => compactObject({
      text: String(answer?.text ?? answer?.option ?? ''),
      votes: numberOrNull(answer?.voters ?? answer?.votes ?? answer?.voter_count) ?? 0,
      chosen: booleanOrUndefined(answer?.chosen),
      correct: booleanOrUndefined(answer?.correct),
    })) : [],
    explanation: stringOrNull(poll.explanation),
    raw: serializableCopy(poll),
  });
}

function normalizeContact(message) {
  const contact = message.contact_information ?? message.contact ?? null;
  if (!contact || typeof contact !== 'object') return null;
  const firstName = contact.first_name ?? contact.firstName;
  const lastName = contact.last_name ?? contact.lastName;
  return compactObject({
    firstName: stringOrNull(firstName),
    lastName: stringOrNull(lastName),
    name: stringOrNull(contact.name) || [firstName, lastName].filter(Boolean).join(' ') || null,
    phoneNumber: stringOrNull(contact.phone_number ?? contact.phone),
    userId: idOrNull(contact.user_id ?? contact.userId),
    vcard: stringOrNull(contact.vcard),
    raw: serializableCopy(contact),
  });
}

function normalizeLocation(message) {
  const location = message.location_information ?? message.location ?? message.venue_information ?? message.venue ?? null;
  if (!location || typeof location !== 'object') return null;
  return compactObject({
    latitude: numberOrNull(location.latitude ?? location.lat),
    longitude: numberOrNull(location.longitude ?? location.lon ?? location.lng),
    placeName: stringOrNull(location.place_name ?? location.placeName ?? location.title),
    address: stringOrNull(location.address),
    livePeriodSeconds: numberOrNull(location.live_period_seconds ?? location.live_period ?? location.livePeriodSeconds),
    raw: serializableCopy(location),
  });
}

function mediaTypeFromJson(message, path, isPhoto = false) {
  if (isPhoto) return 'photo';
  const type = String(message.media_type || '').toLocaleLowerCase();
  if (type.includes('voice')) return 'voice';
  if (type.includes('video_message') || type.includes('round')) return 'video_message';
  if (type.includes('video')) return 'video';
  if (type.includes('animation') || type.includes('gif')) return 'animation';
  if (type.includes('sticker')) return 'sticker';
  if (type.includes('audio')) return 'audio';
  const mime = String(message.mime_type || '').toLocaleLowerCase();
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (MEDIA_EXTENSIONS.photo.test(path || '')) return 'photo';
  return 'file';
}

function jsonMediaItem(message, rawPath, isPhoto = false) {
  const included = !unavailablePath(rawPath);
  const path = included ? normalizePath(rawPath) : null;
  return compactObject({
    type: mediaTypeFromJson(message, path, isPhoto),
    path,
    unavailable: !included || undefined,
    unavailableReason: !included ? String(rawPath) : null,
    fileName: stringOrNull(message.file_name) || fileNameFromPath(path),
    mimeType: stringOrNull(message.mime_type),
    size: numberOrNull(message.file_size ?? message.size),
    width: numberOrNull(message.width),
    height: numberOrNull(message.height),
    duration: numberOrNull(message.duration_seconds ?? message.duration),
    thumbnailPath: unavailablePath(message.thumbnail) ? null : stringOrNull(message.thumbnail) && normalizePath(message.thumbnail),
    performer: stringOrNull(message.performer),
    title: stringOrNull(message.title),
    emoji: stringOrNull(message.sticker_emoji ?? message.emoji),
  });
}

function normalizeJsonMedia(message) {
  const media = [];
  if (message.photo) media.push(jsonMediaItem(message, message.photo, true));
  if (message.file) media.push(jsonMediaItem(message, message.file, false));
  if (Array.isArray(message.media)) {
    for (const item of message.media) {
      if (!item || typeof item !== 'object') continue;
      const path = item.path ?? item.file ?? item.photo;
      media.push(compactObject({
        ...serializableCopy(item),
        type: String(item.type ?? item.media_type ?? mediaTypeFromJson(item, path, Boolean(item.photo))),
        path: unavailablePath(path) ? null : (path ? normalizePath(path) : null),
      }));
    }
  }
  return media;
}

function forwardedInfo(message) {
  const name = message.forwarded_from ?? message.forwarded_from_name ?? message.saved_from;
  const id = message.forwarded_from_id ?? message.saved_from_id;
  if (!name && !id && !message.forwarded_from_message_id) return null;
  const date = dateResult(message.forwarded_date, message.forwarded_date_unixtime);
  return compactObject({
    name: stringOrNull(name),
    id: idOrNull(id),
    messageId: idOrNull(message.forwarded_from_message_id),
    chat: stringOrNull(message.forwarded_from_chat),
    date: date.date || null,
    timestamp: date.timestamp,
  });
}

const CORE_MESSAGE_KEYS = new Set([
  'id', 'type', 'date', 'date_unixtime', 'edited', 'edited_unixtime', 'from', 'from_id',
  'actor', 'actor_id', 'text', 'text_entities', 'reply_to_message_id', 'forwarded_from',
  'forwarded_from_name', 'forwarded_from_id', 'forwarded_from_message_id', 'forwarded_from_chat',
  'forwarded_date', 'forwarded_date_unixtime', 'saved_from', 'saved_from_id', 'via_bot',
  'media_type', 'photo', 'file', 'file_name', 'file_size', 'thumbnail', 'mime_type', 'width',
  'height', 'duration_seconds', 'performer', 'title', 'sticker_emoji', 'reactions', 'poll',
  'contact_information', 'contact', 'location_information', 'location', 'venue_information',
  'venue', 'media',
]);

function serviceDetails(message) {
  const details = {};
  for (const [key, value] of Object.entries(message)) {
    if (!CORE_MESSAGE_KEYS.has(key)) details[key] = serializableCopy(value);
  }
  return details;
}

/** Normalizes one message from a Telegram JSON export. */
export function normalizeTelegramMessage(message, context = {}) {
  const { owner = null, chatId = null, sequence = 0 } = context;
  const isService = message?.type === 'service';
  const senderName = stringOrNull(message?.from ?? message?.actor);
  const senderId = idOrNull(message?.from_id ?? message?.actor_id);
  const date = dateResult(message?.date, message?.date_unixtime);
  const edited = dateResult(message?.edited, message?.edited_unixtime);
  const richText = normalizeTelegramText(message?.text, message?.text_entities);
  const forwarded = forwardedInfo(message || {});
  const rawId = message?.id ?? `${chatId || 'chat'}-${sequence + 1}`;

  const normalized = compactObject({
    id: String(rawId),
    chatId: idOrNull(chatId),
    type: isService ? 'service' : 'message',
    date: date.date,
    timestamp: date.timestamp,
    rawDate: date.rawDate,
    editedDate: edited.date || null,
    editedTimestamp: edited.timestamp,
    senderId,
    senderName,
    isOutgoing: owner ? ownerMatches(owner, senderId) : undefined,
    text: richText.text,
    textEntities: richText.textEntities,
    replyToId: idOrNull(message?.reply_to_message_id),
    forwardedFrom: forwarded?.name ?? forwarded?.id ?? null,
    forwarded,
    viaBot: stringOrNull(message?.via_bot),
    media: normalizeJsonMedia(message || {}),
    reactions: normalizeReactions(message?.reactions),
    poll: normalizePoll(message?.poll),
    contact: normalizeContact(message || {}),
    location: normalizeLocation(message || {}),
    service: isService ? compactObject({
      action: stringOrNull(message?.action) || 'service',
      text: richText.text,
      details: serviceDetails(message || {}),
    }) : null,
  });
  return normalized;
}

function normalizeJsonChat(chat, owner, index = 0) {
  const rawId = chat.id ?? `chat-${index + 1}`;
  const id = String(rawId);
  const name = String(chat.name ?? chat.title ?? `Chat ${index + 1}`);
  const messages = Array.isArray(chat.messages)
    ? chat.messages.map((message, sequence) => normalizeTelegramMessage(message, { owner, chatId: id, sequence }))
    : [];
  return compactObject({
    id,
    name,
    type: stringOrNull(chat.type) || 'unknown',
    messages,
    messageCount: messages.length,
    sourcePath: stringOrNull(chat.sourcePath),
  });
}

function makeStats(chats, sourceFiles = 0) {
  const messages = chats.reduce((sum, chat) => sum + chat.messages.length, 0);
  const serviceMessages = chats.reduce((sum, chat) => sum + chat.messages.filter((message) => message.type === 'service').length, 0);
  const media = chats.reduce((sum, chat) => sum + chat.messages.reduce((count, message) => count + (message.media?.length || 0), 0), 0);
  return { chats: chats.length, messages, serviceMessages, media, sourceFiles };
}

/** Parses an already-loaded Telegram JSON object or JSON string. */
export function parseTelegramJson(input, options = {}) {
  let root = input;
  if (typeof input === 'string') {
    try {
      root = JSON.parse(input.replace(/^\uFEFF/, ''));
    } catch (error) {
      throw new TelegramExportParseError(`Telegram JSON could not be read: ${error.message}`, 'INVALID_JSON');
    }
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    throw new TelegramExportParseError('The selected JSON file is not a Telegram export.', 'UNRECOGNIZED_JSON');
  }

  const owner = normalizeOwner(root);
  let rawChats;
  if (Array.isArray(root.chats?.list)) rawChats = root.chats.list;
  else if (Array.isArray(root.messages)) rawChats = [root];
  else throw new TelegramExportParseError('No Telegram chats were found in the JSON export.', 'NO_CHATS');

  const chats = rawChats.map((chat, index) => normalizeJsonChat(chat, owner, index));
  const fullAccount = Array.isArray(root.chats?.list);
  const title = options.title
    || (!fullAccount ? stringOrNull(root.name) : null)
    || (owner?.name ? `${owner.name}’s Telegram archive` : 'Telegram export');

  return compactObject({
    modelVersion: TELEGRAM_EXPORT_MODEL_VERSION,
    format: 'json',
    title,
    sourceName: stringOrNull(options.sourceName),
    owner,
    chats,
    warnings: [],
    stats: makeStats(chats, numberOrNull(options.sourceFiles) ?? 1),
  });
}

function decodeHtmlEntities(value) {
  return String(value || '').replace(/&(#x[\da-f]+|#\d+|[a-z][\da-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1]?.toLocaleLowerCase() === 'x';
      const codePoint = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      try { return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match; } catch { return match; }
    }
    return HTML_ENTITY_MAP[entity.toLocaleLowerCase()] ?? match;
  });
}

function parseHtmlAttributes(raw) {
  const attributes = {};
  const expression = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = expression.exec(raw))) {
    const key = match[1].toLocaleLowerCase();
    if (BLOCKED_COPY_KEYS.has(key)) continue;
    attributes[key] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

function findTagEnd(html, start) {
  let quote = '';
  for (let index = start + 1; index < html.length; index += 1) {
    const char = html[index];
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '>') return index;
  }
  return html.length - 1;
}

function parseHtmlTree(html) {
  const root = { kind: 'element', tag: '#document', attrs: {}, children: [], parent: null };
  const stack = [root];
  let cursor = 0;
  const source = String(html || '');

  while (cursor < source.length) {
    const open = source.indexOf('<', cursor);
    if (open < 0) {
      stack.at(-1).children.push({ kind: 'text', value: decodeHtmlEntities(source.slice(cursor)), parent: stack.at(-1) });
      break;
    }
    if (open > cursor) {
      stack.at(-1).children.push({ kind: 'text', value: decodeHtmlEntities(source.slice(cursor, open)), parent: stack.at(-1) });
    }
    if (source.startsWith('<!--', open)) {
      const end = source.indexOf('-->', open + 4);
      cursor = end < 0 ? source.length : end + 3;
      continue;
    }
    const end = findTagEnd(source, open);
    const token = source.slice(open + 1, end).trim();
    cursor = end + 1;
    if (!token || token[0] === '!' || token[0] === '?') continue;

    if (token[0] === '/') {
      const closingTag = token.slice(1).trim().split(/\s/)[0].toLocaleLowerCase();
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index].tag === closingTag) {
          stack.length = index;
          break;
        }
      }
      continue;
    }

    const selfClosing = token.endsWith('/');
    const firstSpace = token.search(/\s/);
    const tag = (firstSpace < 0 ? token.replace(/\/$/, '') : token.slice(0, firstSpace)).toLocaleLowerCase();
    if (!/^[a-z][\w:-]*$/.test(tag)) continue;
    const attributeSource = firstSpace < 0 ? '' : token.slice(firstSpace + 1).replace(/\/$/, '');
    const node = { kind: 'element', tag, attrs: parseHtmlAttributes(attributeSource), children: [], parent: stack.at(-1) };
    stack.at(-1).children.push(node);
    if (!selfClosing && !VOID_HTML_TAGS.has(tag)) stack.push(node);
  }
  return root;
}

function walkElements(node, output = []) {
  if (!node?.children) return output;
  for (const child of node.children) {
    if (child.kind !== 'element') continue;
    output.push(child);
    walkElements(child, output);
  }
  return output;
}

function classes(node) {
  return new Set(String(node?.attrs?.class || '').split(/\s+/).filter(Boolean));
}

function hasClass(node, name) {
  return classes(node).has(name);
}

function hasAnyClass(node, names) {
  const nodeClasses = classes(node);
  return names.some((name) => nodeClasses.has(name));
}

function firstElement(node, predicate) {
  return walkElements(node, []).find(predicate) || null;
}

function elements(node, predicate) {
  return walkElements(node, []).filter(predicate);
}

function isInside(node, predicate, stopAt = null) {
  let current = node?.parent;
  while (current && current !== stopAt) {
    if (predicate(current)) return true;
    current = current.parent;
  }
  return false;
}

function basicText(node) {
  if (!node) return '';
  if (node.kind === 'text') return node.value;
  if (node.tag === 'br') return '\n';
  if (node.tag === 'script' || node.tag === 'style') return '';
  return node.children.map(basicText).join('');
}

function cleanBasicText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/[\t\f ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function entityTypeForHtml(node) {
  if (node.tag === 'a') {
    const href = node.attrs.href || '';
    if (/^mailto:/i.test(href)) return 'email';
    if (/^tg:\/\/user|^https?:\/\/(?:t\.me|telegram\.me)\//i.test(href)) return 'mention';
    return 'link';
  }
  if (node.tag === 'strong' || node.tag === 'b') return 'bold';
  if (node.tag === 'em' || node.tag === 'i') return 'italic';
  if (node.tag === 'u') return 'underline';
  if (node.tag === 's' || node.tag === 'strike' || node.tag === 'del') return 'strikethrough';
  if (node.tag === 'code') return 'code';
  if (node.tag === 'pre') return 'pre';
  if (hasClass(node, 'spoiler')) return 'spoiler';
  return null;
}

function richHtmlText(container) {
  if (!container) return { text: '', textEntities: [] };
  let rawText = '';
  const ranges = [];
  const append = (node) => {
    if (node.kind === 'text') {
      rawText += node.value;
      return;
    }
    if (node.tag === 'br') {
      rawText += '\u0000';
      return;
    }
    if (node.tag === 'script' || node.tag === 'style') return;
    const type = entityTypeForHtml(node);
    const start = rawText.length;
    node.children.forEach(append);
    const end = rawText.length;
    if (type && end > start) {
      const entity = { type, offset: start, length: end - start };
      if (node.tag === 'a') entity.href = node.attrs.href || '';
      if (node.tag === 'pre' && node.attrs['data-language']) entity.language = node.attrs['data-language'];
      ranges.push(entity);
    }
  };
  container.children.forEach(append);

  const boundaryMap = new Array(rawText.length + 1).fill(0);
  let normalized = '';
  let index = 0;
  while (index < rawText.length) {
    boundaryMap[index] = normalized.length;
    const char = rawText[index];
    if (char === '\u0000') {
      normalized = normalized.replace(/ +$/, '');
      if (normalized && !normalized.endsWith('\n')) normalized += '\n';
      index += 1;
      boundaryMap[index] = normalized.length;
      while (index < rawText.length && /\s/.test(rawText[index])) {
        index += 1;
        boundaryMap[index] = normalized.length;
      }
      continue;
    }
    if (/\s/.test(char)) {
      let end = index + 1;
      while (end < rawText.length && rawText[end] !== '\u0000' && /\s/.test(rawText[end])) end += 1;
      if (normalized && !/[ \n]$/.test(normalized)) normalized += ' ';
      for (let cursor = index + 1; cursor <= end; cursor += 1) boundaryMap[cursor] = normalized.length;
      index = end;
      continue;
    }
    normalized += char;
    index += 1;
    boundaryMap[index] = normalized.length;
  }

  const leading = normalized.match(/^[ \n]+/)?.[0].length || 0;
  const trailing = normalized.match(/[ \n]+$/)?.[0].length || 0;
  const text = normalized.slice(leading, trailing ? -trailing : undefined);
  const textEntities = ranges.map((range) => {
    let start = Math.max(0, (boundaryMap[range.offset] ?? 0) - leading);
    let end = Math.max(start, (boundaryMap[range.offset + range.length] ?? start) - leading);
    start = Math.min(start, text.length);
    end = Math.min(end, text.length);
    while (start < end && /\s/.test(text[start])) start += 1;
    while (end > start && /\s/.test(text[end - 1])) end -= 1;
    return { ...range, offset: start, length: end - start, text: text.slice(start, end) };
  }).filter((entity) => entity.length > 0);
  return { text, textEntities };
}

function pageTitle(root) {
  const header = firstElement(root, (node) => hasClass(node, 'page_header'));
  if (header) {
    const preferred = firstElement(header, (node) => hasClass(node, 'text') && hasClass(node, 'bold'));
    const text = cleanBasicText(basicText(preferred || header));
    if (text) return text;
  }
  const title = firstElement(root, (node) => node.tag === 'title');
  const text = cleanBasicText(basicText(title));
  return /exported data/i.test(text) ? '' : text;
}

function directOrFirstBody(messageNode) {
  return messageNode.children.find((node) => node.kind === 'element' && hasClass(node, 'body'))
    || firstElement(messageNode, (node) => hasClass(node, 'body'))
    || messageNode;
}

function parseReplyId(replyNode) {
  if (!replyNode) return null;
  const link = firstElement(replyNode, (node) => node.tag === 'a' && node.attrs.href);
  const match = String(link?.attrs?.href || '').match(/(?:go_to_message|message)(-?\d+)/i);
  return match ? match[1] : null;
}

function parseForwarded(messageNode) {
  const forwardedNode = firstElement(messageNode, (node) => hasClass(node, 'forwarded'));
  if (!forwardedNode) return null;
  const fromNode = firstElement(forwardedNode, (node) => hasClass(node, 'from_name'));
  const name = cleanBasicText(basicText(fromNode)).replace(/^forwarded from\s*/i, '').trim();
  const dateNode = firstElement(forwardedNode, (node) => hasClass(node, 'date'));
  const parsedDate = parseTelegramDate(dateNode?.attrs?.title || basicText(dateNode));
  const link = firstElement(fromNode, (node) => node.tag === 'a' && node.attrs.href);
  return compactObject({ name: name || null, href: stringOrNull(link?.attrs?.href), date: parsedDate.date || null, timestamp: parsedDate.timestamp });
}

function resolveMediaPath(pagePath, href) {
  const cleanHref = decodePath(String(href || '').split(/[?#]/)[0]);
  if (!cleanHref || /^(?:data:|https?:|mailto:|tg:|javascript:)/i.test(cleanHref)) return null;
  return cleanHref.startsWith('/') ? normalizePath(cleanHref) : joinPath(dirname(pagePath), cleanHref);
}

function mediaTypeFromHtml(node, href) {
  const classText = String(node.attrs.class || '').toLocaleLowerCase();
  const path = String(href || '').toLocaleLowerCase();
  if (/sticker/.test(classText) || /(?:^|\/)stickers?\//.test(path)) return 'sticker';
  if (/voice/.test(classText) || /(?:^|\/)voice_messages?\//.test(path)) return 'voice';
  if (/video_message|round_video/.test(classText) || /(?:^|\/)round_video_messages?\//.test(path)) return 'video_message';
  if (/animation|gif/.test(classText) || /(?:^|\/)animations?\//.test(path)) return 'animation';
  if (/video/.test(classText) || /(?:^|\/)video_files?\//.test(path) || MEDIA_EXTENSIONS.video.test(path)) return 'video';
  if (/audio/.test(classText) || /(?:^|\/)audio_files?\//.test(path) || MEDIA_EXTENSIONS.audio.test(path)) return 'audio';
  if (/photo|image/.test(classText) || /(?:^|\/)photos?\//.test(path) || MEDIA_EXTENSIONS.photo.test(path)) return 'photo';
  if (/document|file|media/.test(classText) || /(?:^|\/)files?\//.test(path)) return 'file';
  return null;
}

function dimensionFromStyle(style, property) {
  const match = String(style || '').match(new RegExp(`${property}\\s*:\\s*(\\d+(?:\\.\\d+)?)px`, 'i'));
  return match ? numberOrNull(match[1]) : null;
}

function htmlMedia(messageNode, pagePath) {
  const output = [];
  const seen = new Set();
  const links = elements(messageNode, (node) => node.tag === 'a' && node.attrs.href);
  for (const link of links) {
    if (isInside(link, (node) => hasClass(node, 'userpic_wrap'), messageNode)) continue;
    const href = link.attrs.href;
    const type = mediaTypeFromHtml(link, href);
    if (!type) continue;
    const path = resolveMediaPath(pagePath, href);
    if (!path || seen.has(`${type}:${path}`)) continue;
    seen.add(`${type}:${path}`);
    const image = firstElement(link, (node) => node.tag === 'img');
    const titleNode = firstElement(link, (node) => hasAnyClass(node, ['title', 'name']) && !hasClass(node, 'details'));
    const statusNode = firstElement(link, (node) => hasAnyClass(node, ['status', 'details']));
    const status = cleanBasicText(basicText(statusNode));
    const durationMatch = status.match(/(?:(\d+):)?(\d{1,2}):(\d{2})/);
    const duration = durationMatch
      ? (Number(durationMatch[1] || 0) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]))
      : null;
    output.push(compactObject({
      type,
      path,
      fileName: cleanBasicText(basicText(titleNode)) || fileNameFromPath(path),
      thumbnailPath: image?.attrs?.src ? resolveMediaPath(pagePath, image.attrs.src) : null,
      width: numberOrNull(image?.attrs?.width) ?? dimensionFromStyle(image?.attrs?.style, 'width'),
      height: numberOrNull(image?.attrs?.height) ?? dimensionFromStyle(image?.attrs?.style, 'height'),
      duration,
      status: status || null,
    }));
  }

  // Some Telegram versions use <audio>/<video> without an enclosing download link.
  for (const element of elements(messageNode, (node) => ['audio', 'video', 'source', 'img'].includes(node.tag) && node.attrs.src)) {
    if (isInside(element, (node) => hasClass(node, 'userpic_wrap'), messageNode)) continue;
    if (isInside(element, (node) => node.tag === 'a' && Boolean(mediaTypeFromHtml(node, node.attrs.href)), messageNode)) continue;
    const type = element.tag === 'video' ? 'video' : element.tag === 'audio' ? 'audio' : mediaTypeFromHtml(element, element.attrs.src);
    if (!type) continue;
    const path = resolveMediaPath(pagePath, element.attrs.src);
    if (!path || seen.has(`${type}:${path}`)) continue;
    seen.add(`${type}:${path}`);
    output.push(compactObject({ type, path, fileName: fileNameFromPath(path) }));
  }
  return output;
}

function htmlLocation(messageNode) {
  const link = elements(messageNode, (node) => node.tag === 'a' && node.attrs.href)
    .find((node) => /(?:maps\.google|google\.[^/]+\/maps|openstreetmap|geo:)/i.test(node.attrs.href));
  if (!link) return null;
  const href = decodeHtmlEntities(link.attrs.href);
  const coordinates = href.match(/[?&](?:q|query|ll)=(-?\d+(?:\.\d+)?)[,%20+ ]+(-?\d+(?:\.\d+)?)/i)
    || href.match(/geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i)
    || href.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  const title = firstElement(link, (node) => hasAnyClass(node, ['title', 'name']));
  const address = firstElement(link, (node) => hasAnyClass(node, ['address', 'details']));
  return compactObject({
    latitude: numberOrNull(coordinates?.[1]),
    longitude: numberOrNull(coordinates?.[2]),
    placeName: cleanBasicText(basicText(title)) || null,
    address: cleanBasicText(basicText(address)) || null,
    url: href,
  });
}

function htmlContact(messageNode) {
  const contactNode = firstElement(messageNode, (node) => hasAnyClass(node, ['media_contact', 'contact', 'contact_wrap']));
  if (!contactNode) return null;
  const text = cleanBasicText(basicText(contactNode));
  const phone = text.match(/(?:\+?[\d][\d ()-]{5,}\d)/)?.[0]?.trim() || null;
  const nameNode = firstElement(contactNode, (node) => hasAnyClass(node, ['name', 'title']));
  return compactObject({ name: cleanBasicText(basicText(nameNode)) || text.replace(phone || '', '').trim() || null, phoneNumber: phone });
}

function htmlPoll(messageNode) {
  const pollNode = firstElement(messageNode, (node) => hasAnyClass(node, ['poll', 'media_poll', 'poll_wrap']));
  if (!pollNode) return null;
  const questionNode = firstElement(pollNode, (node) => hasAnyClass(node, ['question', 'poll_question', 'title']));
  const optionNodes = elements(pollNode, (node) => hasAnyClass(node, ['poll_option', 'option']));
  const options = optionNodes.map((node) => {
    const textNode = firstElement(node, (child) => hasAnyClass(child, ['text', 'label', 'answer'])) || node;
    const value = cleanBasicText(basicText(textNode));
    const votesMatch = cleanBasicText(basicText(node)).match(/(\d+)\s*(?:votes?|voters?)|\b(\d+)%/i);
    return { text: value.replace(/\s*(?:\d+\s*(?:votes?|voters?)|\d+%)\s*$/i, ''), votes: numberOrNull(votesMatch?.[1] ?? votesMatch?.[2]) ?? 0 };
  });
  const allText = cleanBasicText(basicText(pollNode));
  const total = allText.match(/(\d+)\s+(?:votes?|voters?)/i);
  return compactObject({ question: cleanBasicText(basicText(questionNode)) || '', options, totalVoters: numberOrNull(total?.[1]) });
}

function htmlReactions(messageNode) {
  const nodes = elements(messageNode, (node) => hasClass(node, 'reaction') && !hasClass(node, 'reactions'));
  const output = [];
  for (const node of nodes) {
    const text = cleanBasicText(basicText(node));
    if (!text) continue;
    const emojiNode = firstElement(node, (child) => hasAnyClass(child, ['emoji', 'emoticon']));
    const countNode = firstElement(node, (child) => hasAnyClass(child, ['count', 'reaction_count']));
    const match = text.match(/^(.+?)\s*[×x]?\s*(\d+)$/u);
    output.push({
      emoji: cleanBasicText(basicText(emojiNode)) || (match?.[1] || text).trim(),
      count: numberOrNull(cleanBasicText(basicText(countNode))) ?? numberOrNull(match?.[2]) ?? 1,
    });
  }
  return output;
}

function inferServiceAction(text) {
  const value = String(text || '').toLocaleLowerCase();
  if (/joined|added/.test(value)) return 'join';
  if (/left|removed/.test(value)) return 'leave';
  if (/created/.test(value)) return 'create';
  if (/pinned/.test(value)) return 'pin_message';
  if (/photo/.test(value) && /changed|updated|removed/.test(value)) return 'edit_photo';
  if (/title|name/.test(value) && /changed|updated/.test(value)) return 'edit_title';
  if (/call/.test(value)) return 'phone_call';
  return 'service';
}

function parseHtmlMessage(messageNode, pagePath, context) {
  const body = directOrFirstBody(messageNode);
  const classList = classes(messageNode);
  const isService = classList.has('service');
  const rawId = messageNode.attrs.id || `message-${context.sequence + 1}`;
  const id = String(rawId).replace(/^message/i, '') || String(context.sequence + 1);
  const dateNode = firstElement(body, (node) => hasClass(node, 'date') && !isInside(node, (parent) => hasClass(parent, 'forwarded'), body));
  const rawDate = dateNode?.attrs?.title || cleanBasicText(basicText(dateNode));
  const date = parseTelegramDate(rawDate);
  const fromNode = firstElement(body, (node) => hasClass(node, 'from_name') && !isInside(node, (parent) => hasClass(parent, 'forwarded'), body));
  let senderName = cleanBasicText(basicText(fromNode)) || null;
  if (!senderName && !isService) senderName = context.previousSenderName || null;
  const senderId = senderName ? `html-user:${stableSlug(senderName)}` : null;
  const replyNode = firstElement(body, (node) => hasClass(node, 'reply_to'));
  const textNode = firstElement(body, (node) => hasClass(node, 'text'));
  let richText = richHtmlText(textNode);
  if (isService && !richText.text) richText = { text: cleanBasicText(basicText(body)), textEntities: [] };
  const forwarded = parseForwarded(body);

  return compactObject({
    id,
    chatId: context.chatId,
    type: isService ? 'service' : 'message',
    date: date.date,
    timestamp: date.timestamp,
    rawDate: rawDate || null,
    senderId,
    senderName,
    text: richText.text,
    textEntities: richText.textEntities,
    replyToId: parseReplyId(replyNode),
    forwardedFrom: forwarded?.name || null,
    forwarded,
    media: htmlMedia(messageNode, pagePath),
    reactions: htmlReactions(messageNode),
    poll: htmlPoll(messageNode),
    contact: htmlContact(messageNode),
    location: htmlLocation(messageNode),
    service: isService ? { action: inferServiceAction(richText.text), text: richText.text, details: {} } : null,
    sourcePath: pagePath,
  });
}

function pageIndex(path) {
  const match = basename(path).match(/^messages(\d*)\.html?$/i);
  return match ? Number(match[1] || 1) : Number.MAX_SAFE_INTEGER;
}

/** Parses already-loaded Telegram HTML message pages. */
export function parseTelegramHtml(pages, options = {}) {
  let normalizedPages;
  if (typeof pages === 'string') normalizedPages = [{ path: 'messages.html', content: pages }];
  else if (Array.isArray(pages)) normalizedPages = pages.map((page, index) => ({
    path: normalizePath(page.path || page.name || `messages${index || ''}.html`),
    content: String(page.content ?? page.textContent ?? ''),
  }));
  else throw new TelegramExportParseError('No Telegram HTML message pages were supplied.', 'NO_HTML_PAGES');

  normalizedPages = normalizedPages
    .filter((page) => /^messages\d*\.html?$/i.test(basename(page.path)) || options.acceptAnyHtml)
    .sort((left, right) => naturalCompare(dirname(left.path), dirname(right.path)) || pageIndex(left.path) - pageIndex(right.path));
  if (!normalizedPages.length) throw new TelegramExportParseError('No Telegram messages.html pages were found.', 'NO_HTML_PAGES');

  const groups = new Map();
  for (const page of normalizedPages) {
    const directory = dirname(page.path);
    if (!groups.has(directory)) groups.set(directory, []);
    groups.get(directory).push(page);
  }

  const warnings = [];
  const chats = [];
  let chatNumber = 0;
  for (const [directory, chatPages] of groups) {
    chatNumber += 1;
    const chatId = directory ? `html:${directory}` : `html:chat-${chatNumber}`;
    let name = '';
    let previousSenderName = null;
    const messages = [];
    const seenIds = new Set();
    for (const page of chatPages) {
      const root = parseHtmlTree(page.content);
      name ||= pageTitle(root);
      const nodes = elements(root, (node) => hasClass(node, 'message'));
      for (const node of nodes) {
        const message = parseHtmlMessage(node, page.path, { chatId, sequence: messages.length, previousSenderName });
        if (seenIds.has(message.id)) {
          warnings.push(`Skipped duplicate message ${message.id} in ${page.path}.`);
          continue;
        }
        seenIds.add(message.id);
        messages.push(message);
        if (message.senderName && message.type !== 'service') previousSenderName = message.senderName;
      }
    }
    name ||= basename(directory).replace(/^chat[_ -]*/i, '').replace(/[_-]+/g, ' ') || `Chat ${chatNumber}`;
    const lowerName = name.toLocaleLowerCase();
    const type = lowerName === 'saved messages' ? 'saved_messages' : 'unknown';
    chats.push({ id: chatId, name, type, messages, messageCount: messages.length, sourcePath: directory || null });
  }

  const title = options.title || (chats.length === 1 ? chats[0].name : 'Telegram export');
  return compactObject({
    modelVersion: TELEGRAM_EXPORT_MODEL_VERSION,
    format: 'html',
    title,
    sourceName: stringOrNull(options.sourceName),
    chats,
    warnings,
    stats: makeStats(chats, normalizedPages.length),
  });
}

function looksLikeRawTelegramJson(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && (Array.isArray(value.messages) || Array.isArray(value.chats?.list)));
}

function isTextCandidate(path) {
  const name = basename(path);
  return /^result\.json$/i.test(name) || /^messages\d*\.html?$/i.test(name);
}

async function readEntryText(entry) {
  if (typeof entry === 'string') return entry;
  if (typeof entry?.content === 'string') return entry.content;
  if (entry?.content instanceof ArrayBuffer || ArrayBuffer.isView(entry?.content)) {
    const bytes = entry.content instanceof ArrayBuffer ? new Uint8Array(entry.content) : entry.content;
    return new TextDecoder('utf-8').decode(bytes);
  }
  if (typeof entry?.text === 'function') return entry.text();
  let file = entry?.file;
  if (file && typeof file.then === 'function') file = await file;
  if (!file && typeof entry?.getFile === 'function') file = await entry.getFile();
  if (typeof file === 'string') return file;
  if (typeof file?.text === 'function') return file.text();
  if (typeof file?.arrayBuffer === 'function') return new TextDecoder('utf-8').decode(await file.arrayBuffer());
  throw new TelegramExportParseError(`Could not read ${entry?.path || entry?.name || 'an export file'}.`, 'UNREADABLE_FILE');
}

function entryPath(entry, index) {
  if (typeof entry === 'string') return `entry-${index + 1}`;
  return normalizePath(entry?.path || entry?.webkitRelativePath || entry?.name || `entry-${index + 1}`);
}

async function materializeEntries(input) {
  let entries = input?.entries && !Array.isArray(input) ? input.entries : input;
  if (entries && typeof entries[Symbol.asyncIterator] === 'function') {
    const collected = [];
    for await (const entry of entries) collected.push(entry);
    entries = collected;
  } else if (entries && !Array.isArray(entries) && typeof entries[Symbol.iterator] === 'function') {
    entries = Array.from(entries);
  } else if (!Array.isArray(entries)) entries = entries ? [entries] : [];

  const candidates = entries
    .map((entry, index) => ({ entry, path: entryPath(entry, index) }))
    .filter(({ entry, path }) => isTextCandidate(path) || typeof entry === 'string');
  const loaded = [];
  for (const candidate of candidates) {
    loaded.push({ path: candidate.path, content: await readEntryText(candidate.entry) });
  }
  return loaded;
}

/**
 * Primary parser. Accepts a raw JSON object/string, FileList, iterable of File
 * objects, or archive entries shaped like { path, file/getFile/text/content }.
 */
export async function parseTelegramExport(entries, options = {}) {
  if (looksLikeRawTelegramJson(entries)) return parseTelegramJson(entries, options);
  if (typeof entries === 'string') {
    const trimmed = entries.replace(/^\uFEFF/, '').trimStart();
    return trimmed.startsWith('<')
      ? parseTelegramHtml(trimmed, options)
      : parseTelegramJson(trimmed, options);
  }

  const sourceName = options.sourceName || (entries?.entries ? stringOrNull(entries.name) : null);
  const loaded = await materializeEntries(entries);
  if (!loaded.length) {
    throw new TelegramExportParseError('Choose a Telegram Desktop export folder containing result.json or messages.html.', 'NO_SUPPORTED_FILES');
  }

  const jsonFiles = loaded.filter((entry) => /^result\.json$/i.test(basename(entry.path)))
    .sort((left, right) => left.path.length - right.path.length || naturalCompare(left.path, right.path));
  const jsonErrors = [];
  for (const file of jsonFiles) {
    try {
      return parseTelegramJson(file.content, { ...options, sourceName, sourceFiles: 1 });
    } catch (error) {
      jsonErrors.push(`${file.path}: ${error.message}`);
    }
  }

  const htmlFiles = loaded.filter((entry) => /^messages\d*\.html?$/i.test(basename(entry.path)));
  if (htmlFiles.length) {
    const result = parseTelegramHtml(htmlFiles, { ...options, sourceName });
    if (jsonErrors.length) result.warnings.unshift(...jsonErrors.map((message) => `Ignored unreadable JSON (${message})`));
    return result;
  }

  throw new TelegramExportParseError(
    jsonErrors.length ? `Telegram JSON could not be parsed. ${jsonErrors[0]}` : 'No Telegram messages were found in the selected folder.',
    jsonErrors.length ? 'INVALID_JSON' : 'NO_CHATS',
  );
}

export default parseTelegramExport;
