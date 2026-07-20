/**
 * Dependency-free full-text search for normalized Telegram exports.
 *
 * The index is deliberately UI-agnostic and works in modern browsers and Node.
 */

export const SUPPORTED_HAS_FILTERS = Object.freeze([
  "media",
  "link",
  "file",
  "photo",
  "video",
  "audio",
  "voice",
  "sticker",
  "poll",
  "location",
  "contact",
  "reaction",
]);

const HAS_FILTER_SET = new Set(SUPPORTED_HAS_FILTERS);
const HAS_ALIASES = new Map([
  ["image", "photo"],
  ["images", "photo"],
  ["photos", "photo"],
  ["videos", "video"],
  ["audios", "audio"],
  ["voices", "voice"],
  ["voice-message", "voice"],
  ["voice_message", "voice"],
  ["stickers", "sticker"],
  ["files", "file"],
  ["documents", "file"],
  ["document", "file"],
  ["links", "link"],
  ["urls", "link"],
  ["url", "link"],
  ["reactions", "reaction"],
]);

const TOKEN_SOURCE = "[\\p{L}\\p{N}_]+";
const MARKS_RE = /\p{M}+/gu;
const WHITESPACE_RE = /\s/u;
const URL_RE = /(?:https?:\/\/|tg:\/\/|www\.)[^\s<>]+/iu;
const FILTER_NAMES = new Set(["from", "in", "has", "before", "after", "on"]);

function asString(value) {
  return value == null ? "" : String(value);
}

function unique(values) {
  return [...new Set(values)];
}

function stableCompare(a, b) {
  const left = asString(a);
  const right = asString(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Accent- and case-fold text, while retaining a map back to UTF-16 offsets in
 * the source string. Runs of whitespace are collapsed for dependable phrases.
 */
function foldWithMap(value) {
  const source = asString(value);
  let text = "";
  const starts = [];
  const ends = [];

  for (let sourceOffset = 0; sourceOffset < source.length; ) {
    const codePoint = source.codePointAt(sourceOffset);
    const character = String.fromCodePoint(codePoint);
    const sourceEnd = sourceOffset + character.length;

    if (WHITESPACE_RE.test(character)) {
      if (text && text[text.length - 1] !== " ") {
        text += " ";
        starts.push(sourceOffset);
        ends.push(sourceEnd);
      } else if (text && ends.length) {
        // Make a collapsed whitespace range cover the complete source run.
        ends[ends.length - 1] = sourceEnd;
      }
      sourceOffset = sourceEnd;
      continue;
    }

    const folded = character
      .normalize("NFKD")
      .replace(MARKS_RE, "")
      .toLowerCase();

    // A decomposed accent belongs visually to the preceding source character.
    if (!folded && /\p{M}/u.test(character) && ends.length) {
      ends[ends.length - 1] = sourceEnd;
    }

    for (let index = 0; index < folded.length; index += 1) {
      text += folded[index];
      starts.push(sourceOffset);
      ends.push(sourceEnd);
    }
    sourceOffset = sourceEnd;
  }

  if (text.endsWith(" ")) {
    text = text.slice(0, -1);
    starts.pop();
    ends.pop();
  }

  return { source, text, starts, ends };
}

/** Normalize text exactly as the index does. */
export function normalizeSearchText(value) {
  return foldWithMap(value).text;
}

/** Return normalized word/number tokens. */
export function tokenizeSearchText(value) {
  const normalized = normalizeSearchText(value);
  const matches = normalized.match(new RegExp(TOKEN_SOURCE, "gu"));
  return matches || [];
}

function tokenSpans(normalizedText) {
  const result = [];
  const expression = new RegExp(TOKEN_SOURCE, "gu");
  let match;
  while ((match = expression.exec(normalizedText))) {
    result.push({ value: match[0], start: match.index, end: match.index + match[0].length });
  }
  return result;
}

function lexQuery(input) {
  const lexemes = [];
  const errors = [];
  let index = 0;

  while (index < input.length) {
    while (index < input.length && /\s/u.test(input[index])) index += 1;
    if (index >= input.length) break;

    const start = index;
    const beganWithQuote = input[index] === '"';
    let value = "";
    let inQuote = false;
    let hadQuote = false;

    while (index < input.length) {
      const character = input[index];
      if (character === "\\" && index + 1 < input.length) {
        const escaped = input[index + 1];
        if (escaped === '"' || escaped === "\\") {
          value += escaped;
          index += 2;
          continue;
        }
      }
      if (character === '"') {
        inQuote = !inQuote;
        hadQuote = true;
        index += 1;
        continue;
      }
      if (!inQuote && /\s/u.test(character)) break;
      value += character;
      index += 1;
    }

    if (inQuote) errors.push(`Unclosed quote starting at character ${start + 1}`);
    lexemes.push({ value, start, end: index, beganWithQuote, hadQuote });
  }

  return { lexemes, errors };
}

function validDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function canonicalHasFilter(value) {
  const normalized = normalizeSearchText(value).replace(/\s+/gu, "-");
  return HAS_ALIASES.get(normalized) || normalized;
}

/**
 * Parse text and Telegram-style filters. Quoted text is a required phrase.
 * Supported examples: `project update from:"Ada Lovelace" has:file after:2024-01-01`.
 */
export function parseSearchQuery(query = "") {
  const raw = asString(query);
  const { lexemes, errors } = lexQuery(raw);
  const terms = [];
  const phrases = [];
  const rawTerms = [];
  const rawPhrases = [];
  const filters = {
    from: [],
    in: [],
    has: [],
    before: null,
    after: null,
    on: null,
  };

  for (const lexeme of lexemes) {
    if (!lexeme.value) continue;
    const separator = lexeme.value.indexOf(":");
    const possibleFilter = separator > 0
      ? lexeme.value.slice(0, separator).toLowerCase()
      : "";
    const isFilter = !lexeme.beganWithQuote && FILTER_NAMES.has(possibleFilter);

    if (isFilter) {
      const value = lexeme.value.slice(separator + 1).trim();
      if (!value) {
        errors.push(`Filter ${possibleFilter}: needs a value`);
        continue;
      }

      if (possibleFilter === "from" || possibleFilter === "in") {
        filters[possibleFilter].push(value);
      } else if (possibleFilter === "has") {
        const hasValue = canonicalHasFilter(value);
        if (!HAS_FILTER_SET.has(hasValue)) {
          errors.push(`Unknown has: filter “${value}”`);
        } else {
          filters.has.push(hasValue);
        }
      } else if (!validDateKey(value)) {
        errors.push(`Filter ${possibleFilter}: expects a real date in YYYY-MM-DD format`);
      } else if (possibleFilter === "before") {
        // Repeated bounds become the most restrictive useful bound.
        filters.before = filters.before == null || value < filters.before ? value : filters.before;
      } else if (possibleFilter === "after") {
        filters.after = filters.after == null || value > filters.after ? value : filters.after;
      } else if (possibleFilter === "on") {
        if (filters.on != null && filters.on !== value) {
          errors.push("Only one on: date can be searched at a time");
        }
        filters.on = value;
      }
      continue;
    }

    if (lexeme.beganWithQuote || lexeme.hadQuote) {
      const normalized = normalizeSearchText(lexeme.value);
      if (normalized) {
        rawPhrases.push(lexeme.value);
        phrases.push(normalized);
      }
    } else {
      const normalizedTokens = tokenizeSearchText(lexeme.value);
      for (const token of normalizedTokens) {
        rawTerms.push(lexeme.value);
        terms.push(token);
      }
    }
  }

  filters.from = unique(filters.from);
  filters.in = unique(filters.in);
  filters.has = unique(filters.has);
  const normalizedTerms = unique(terms);
  const normalizedPhrases = unique(phrases);
  const filterCount = filters.from.length
    + filters.in.length
    + filters.has.length
    + Number(filters.before != null)
    + Number(filters.after != null)
    + Number(filters.on != null);

  return {
    raw,
    terms: normalizedTerms,
    phrases: normalizedPhrases,
    rawTerms,
    rawPhrases,
    filters,
    errors,
    valid: errors.length === 0,
    isEmpty: normalizedTerms.length === 0 && normalizedPhrases.length === 0 && filterCount === 0,
    stats: {
      termCount: normalizedTerms.length,
      phraseCount: normalizedPhrases.length,
      filterCount,
    },
  };
}

// Short alias for consumers that prefer the conventional name.
export const parseQuery = parseSearchQuery;

function flattenTelegramText(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(flattenTelegramText).join("");
  if (typeof value === "object") {
    if (value.text != null) return flattenTelegramText(value.text);
    if (value.value != null) return flattenTelegramText(value.value);
  }
  return "";
}

function attachmentObjects(message) {
  const values = [];
  for (const key of ["attachment", "attachments", "media", "files"]) {
    const value = message?.[key];
    if (Array.isArray(value)) values.push(...value);
    else if (value && typeof value === "object") values.push(value);
  }
  return values;
}

function supplementalMessageText(message) {
  const pieces = [];
  const add = (value) => {
    const text = flattenTelegramText(value).trim();
    if (text && !pieces.includes(text)) pieces.push(text);
  };

  add(message?.file_name);
  add(message?.filename);
  add(message?.document?.file_name);
  add(message?.poll?.question);
  add(message?.contact_information?.first_name);
  add(message?.contact_information?.last_name);
  add(message?.contact?.name);
  for (const attachment of attachmentObjects(message || {})) {
    add(attachment?.file_name);
    add(attachment?.fileName);
    add(attachment?.filename);
    add(attachment?.name);
    add(attachment?.title);
  }
  return pieces;
}

function normalizeTypeName(value) {
  return normalizeSearchText(value).replace(/[\s-]+/gu, "_");
}

function classifyType(value, has) {
  const type = normalizeTypeName(value);
  if (!type) return;

  if (/(?:photo|image|picture)/u.test(type)) has.add("photo");
  if (/(?:video|movie|animation|gif)/u.test(type)) has.add("video");
  if (/(?:voice|voice_message|round_audio)/u.test(type)) {
    has.add("voice");
    has.add("audio");
  } else if (/(?:audio|music|song)/u.test(type)) {
    has.add("audio");
  }
  if (/sticker/u.test(type)) has.add("sticker");
  if (/(?:document|file|attachment)/u.test(type)) has.add("file");
  if (/poll/u.test(type)) has.add("poll");
  if (/(?:location|venue|place)/u.test(type)) has.add("location");
  if (/(?:contact|vcard)/u.test(type)) has.add("contact");
  if (/(?:link|url)/u.test(type)) has.add("link");
}

function detectMessageFeatures(message, searchableText) {
  const has = new Set();
  const explicit = message?.has;
  const explicitValues = Array.isArray(explicit) ? explicit : explicit == null ? [] : [explicit];
  for (const value of explicitValues) {
    const canonical = canonicalHasFilter(value);
    if (HAS_FILTER_SET.has(canonical)) has.add(canonical);
  }

  for (const value of [
    message?.media_type,
    message?.mediaType,
    message?.type,
    message?.mime_type,
    message?.mimeType,
    message?.document?.mime_type,
  ]) classifyType(value, has);

  for (const attachment of attachmentObjects(message || {})) {
    const attachmentType = attachment?.type
      || attachment?.media_type
      || attachment?.mime_type
      || attachment?.mimeType;
    classifyType(attachmentType, has);
    const normalizedType = normalizeTypeName(attachmentType);
    if (
      (attachment?.file_name || attachment?.fileName || attachment?.filename || attachment?.path)
      && (!normalizedType || /(?:document|file|attachment)/u.test(normalizedType))
    ) has.add("file");
  }

  if (message?.photo || message?.photo_file || message?.image) has.add("photo");
  if (message?.video || message?.video_file || message?.video_message) has.add("video");
  if (message?.audio || message?.audio_file) has.add("audio");
  if (message?.voice || message?.voice_message) {
    has.add("voice");
    has.add("audio");
  }
  if (message?.sticker || message?.sticker_emoji) has.add("sticker");
  if (message?.file || message?.file_name || message?.document) has.add("file");
  if (message?.poll || message?.poll_question) has.add("poll");
  if (message?.location || message?.location_information || message?.venue) has.add("location");
  if (message?.contact || message?.contact_information || message?.vcard) has.add("contact");
  if ((Array.isArray(message?.reactions) && message.reactions.length) || message?.reaction) {
    has.add("reaction");
  }

  const entities = [
    ...(Array.isArray(message?.text_entities) ? message.text_entities : []),
    ...(Array.isArray(message?.textEntities) ? message.textEntities : []),
    ...(Array.isArray(message?.entities) ? message.entities : []),
  ];
  if (entities.some((entity) => /(?:^|_)(?:link|url)(?:$|_)/u.test(normalizeTypeName(entity?.type)))) {
    has.add("link");
  }
  if (URL_RE.test(searchableText)) has.add("link");

  if (["photo", "video", "audio", "voice", "sticker", "file"].some((type) => has.has(type))) {
    has.add("media");
  }
  return has;
}

function normalizeSender(message) {
  const candidate = message?.sender
    ?? message?.from
    ?? message?.author
    ?? message?.actor
    ?? message?.senderName
    ?? message?.from_name
    ?? message?.author_name;
  let name = "";
  let id = message?.sender_id ?? message?.senderId ?? message?.from_id ?? message?.author_id ?? "";
  let username = message?.username ?? message?.sender_username ?? "";

  if (candidate && typeof candidate === "object") {
    name = candidate.name ?? candidate.displayName ?? candidate.title ?? candidate.full_name ?? "";
    id = candidate.id ?? candidate.peerId ?? candidate.user_id ?? id;
    username = candidate.username ?? candidate.handle ?? username;
  } else {
    name = candidate ?? message?.from_name ?? message?.author_name ?? "";
  }

  name = asString(name);
  id = asString(id);
  username = asString(username).replace(/^@/u, "");
  const searchable = normalizeSearchText([name, username, id].filter(Boolean).join(" "));
  return { id, name, username, searchable };
}

function normalizeDate(message) {
  const raw = message?.date ?? message?.datetime ?? message?.timestamp ?? message?.date_unixtime ?? null;
  let timestamp = null;
  let day = null;

  if (typeof raw === "number" || (typeof raw === "string" && /^\d{10,13}$/u.test(raw))) {
    const numeric = Number(raw);
    const milliseconds = Math.abs(numeric) < 100_000_000_000 ? numeric * 1000 : numeric;
    const date = new Date(milliseconds);
    if (Number.isFinite(date.getTime())) {
      timestamp = date.getTime();
      day = date.toISOString().slice(0, 10);
    }
  } else if (typeof raw === "string") {
    const leadingDay = raw.match(/^(\d{4}-\d{2}-\d{2})/u)?.[1];
    if (leadingDay && validDateKey(leadingDay)) day = leadingDay;
    const date = new Date(raw);
    if (Number.isFinite(date.getTime())) {
      timestamp = date.getTime();
      if (!day) day = date.toISOString().slice(0, 10);
    }
  } else if (raw instanceof Date && Number.isFinite(raw.getTime())) {
    timestamp = raw.getTime();
    day = raw.toISOString().slice(0, 10);
  }

  return { raw, timestamp, day };
}

function hashString(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function normalizeChatInput(chat, fallbackNumber = 1) {
  const source = chat && typeof chat === "object" ? chat : { id: chat, title: chat };
  const title = asString(source.title ?? source.name ?? source.displayName ?? source.id ?? `Chat ${fallbackNumber}`);
  const rawId = source.rawId ?? source.id ?? source.chatId ?? source.chat_id ?? source.key;
  const id = asString(rawId ?? `chat:${hashString(title || String(fallbackNumber))}:${fallbackNumber}`);
  const type = asString(source.type ?? source.chatType ?? source.kind ?? "chat");
  return {
    id,
    rawId: rawId ?? id,
    title,
    type,
    searchable: normalizeSearchText([title, id].filter(Boolean).join(" ")),
    source,
  };
}

/** Convert a chat object to the stable public shape used by the index. */
export function normalizeTelegramChat(chat) {
  const normalized = normalizeChatInput(chat);
  return {
    id: normalized.rawId,
    key: normalized.id,
    rawId: normalized.rawId,
    title: normalized.title,
    type: normalized.type,
  };
}

function createMessageRecord(message, chat, fallbackIndex = 0) {
  const source = message && typeof message === "object" ? message : { text: message };
  const primaryText = flattenTelegramText(
    source.text ?? source.caption ?? source.message ?? source.content ?? source.action,
  );
  const supplemental = supplementalMessageText(source).filter((piece) => piece !== primaryText);
  const searchableText = [primaryText, ...supplemental].filter(Boolean).join("\n");
  const folded = foldWithMap(searchableText);
  const date = normalizeDate(source);
  const sender = normalizeSender(source);
  const rawId = source.id ?? source.messageId ?? source.message_id;
  const fallbackSeed = `${date.raw ?? ""}\u0000${searchableText}\u0000${fallbackIndex}`;
  const id = asString(rawId ?? `auto:${hashString(fallbackSeed)}`);
  const has = detectMessageFeatures(source, searchableText);
  const spans = tokenSpans(folded.text);
  const tokenCounts = new Map();
  const positions = new Map();
  for (const span of spans) {
    tokenCounts.set(span.value, (tokenCounts.get(span.value) || 0) + 1);
    if (!positions.has(span.value)) positions.set(span.value, []);
    positions.get(span.value).push({ start: span.start, end: span.end });
  }

  return {
    uid: `${chat.id}\u0000${id}`,
    id,
    rawId: rawId ?? id,
    chatId: chat.id,
    text: primaryText,
    searchableText,
    folded,
    sender,
    date: date.raw,
    timestamp: date.timestamp,
    day: date.day,
    has,
    tokenCounts,
    positions,
    source,
  };
}

function publicNormalizedMessage(record, chat) {
  return {
    id: record.rawId,
    key: record.id,
    rawId: record.rawId,
    chatId: chat.rawId,
    chatKey: record.chatId,
    text: record.text,
    searchText: record.searchableText,
    sender: { id: record.sender.id, name: record.sender.name, username: record.sender.username },
    date: record.date,
    timestamp: record.timestamp,
    day: record.day,
    has: [...record.has].sort(stableCompare),
  };
}

/** Normalize one message without adding it to an index. */
export function normalizeTelegramMessage(message, chat = { id: "chat", title: "Chat" }) {
  const normalizedChat = normalizeChatInput(chat);
  const record = createMessageRecord(message, normalizedChat);
  return publicNormalizedMessage(record, normalizedChat);
}

function archiveChats(archive) {
  if (Array.isArray(archive)) return archive;
  if (!archive || typeof archive !== "object") return [];
  if (Array.isArray(archive.chats)) return archive.chats;
  if (Array.isArray(archive.chats?.list)) return archive.chats.list;
  if (Array.isArray(archive.result?.chats)) return archive.result.chats;
  if (Array.isArray(archive.result?.chats?.list)) return archive.result.chats.list;
  if (Array.isArray(archive.messages)) return [archive];
  return [];
}

function publicChat(chat, messageCount = 0) {
  return {
    id: chat.rawId,
    key: chat.id,
    rawId: chat.rawId,
    title: chat.title,
    type: chat.type,
    messageCount,
  };
}

function identityMatches(searchable, rawNeedle) {
  const needle = normalizeSearchText(rawNeedle).replace(/^@/u, "");
  if (!needle) return false;
  return searchable === needle || searchable.includes(needle);
}

function intersectSets(left, right) {
  if (left == null) return new Set(right);
  const smaller = left.size <= right.size ? left : right;
  const larger = left.size <= right.size ? right : left;
  const result = new Set();
  for (const value of smaller) if (larger.has(value)) result.add(value);
  return result;
}

function foldedRangeToSource(record, start, end) {
  if (start < 0 || end <= start || start >= record.folded.starts.length) return null;
  const boundedEnd = Math.min(end, record.folded.ends.length);
  return {
    start: record.folded.starts[start],
    end: record.folded.ends[boundedEnd - 1],
  };
}

function phraseOccurrences(haystack, needle, max = 100) {
  const occurrences = [];
  if (!needle) return occurrences;
  let from = 0;
  while (occurrences.length < max) {
    const start = haystack.indexOf(needle, from);
    if (start < 0) break;
    occurrences.push({ start, end: start + needle.length });
    from = start + Math.max(needle.length, 1);
  }
  return occurrences;
}

function collectMatchRanges(record, parsed) {
  const foldedRanges = [];
  for (const phrase of parsed.phrases) {
    foldedRanges.push(...phraseOccurrences(record.folded.text, phrase));
  }
  for (const term of parsed.terms) {
    foldedRanges.push(...(record.positions.get(term) || []));
  }

  const ranges = foldedRanges
    .map((range) => foldedRangeToSource(record, range.start, range.end))
    .filter(Boolean)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function createSnippet(source, matchRanges, maximumLength) {
  const maxLength = Math.max(20, Number.isFinite(maximumLength) ? Math.floor(maximumLength) : 180);
  if (!source) {
    return { text: "", ranges: [], sourceStart: 0, sourceEnd: 0 };
  }

  let start = 0;
  let end = source.length;
  if (source.length > maxLength) {
    const focus = matchRanges[0] || { start: 0, end: 0 };
    const center = Math.floor((focus.start + focus.end) / 2);
    start = Math.max(0, Math.min(source.length - maxLength, center - Math.floor(maxLength / 2)));
    end = Math.min(source.length, start + maxLength);

    if (start > 0) {
      const nearbySpace = source.lastIndexOf(" ", start);
      if (nearbySpace >= 0 && start - nearbySpace <= 24) start = nearbySpace + 1;
    }
    if (end < source.length) {
      const nearbySpace = source.indexOf(" ", end);
      if (nearbySpace >= 0 && nearbySpace - end <= 24) end = nearbySpace;
    }
  }

  const prefix = start > 0 ? "…" : "";
  const suffix = end < source.length ? "…" : "";
  const ranges = [];
  for (const range of matchRanges) {
    if (range.end <= start || range.start >= end) continue;
    ranges.push({
      start: prefix.length + Math.max(range.start, start) - start,
      end: prefix.length + Math.min(range.end, end) - start,
    });
  }
  return {
    text: `${prefix}${source.slice(start, end)}${suffix}`,
    ranges,
    sourceStart: start,
    sourceEnd: end,
  };
}

function countPhrase(record, phrase) {
  return phraseOccurrences(record.folded.text, phrase).length;
}

function calculateScore(record, parsed, postings, messageCount) {
  let score = 0;
  const firstPositions = [];

  for (const term of parsed.terms) {
    const posting = postings.get(term);
    const documentFrequency = posting?.size || 0;
    const termFrequency = record.tokenCounts.get(term) || 0;
    const inverseFrequency = Math.log(1 + (messageCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
    score += inverseFrequency * (1 + Math.log(Math.max(1, termFrequency))) * 10;
    const first = record.positions.get(term)?.[0]?.start;
    if (first != null) firstPositions.push(first);
  }

  for (const phrase of parsed.phrases) {
    const occurrences = countPhrase(record, phrase);
    score += occurrences * (16 + Math.min(24, tokenizeSearchText(phrase).length * 4));
    if (record.folded.text === phrase) score += 20;
  }

  if (firstPositions.length > 1) {
    const distance = Math.max(...firstPositions) - Math.min(...firstPositions);
    score += 6 / (1 + distance / 20);
  }
  return Number(score.toFixed(6));
}

function emptySearchResponse(parsed, options, indexSize) {
  const limit = options.limit;
  const offset = options.offset;
  return {
    query: parsed.raw,
    parsedQuery: parsed,
    total: 0,
    offset,
    limit,
    results: [],
    stats: { indexSize, candidates: 0, matched: 0 },
  };
}

/**
 * In-memory search index. Mutations are synchronous, making it easy to build in
 * a Web Worker and transfer only search results to the UI.
 */
export class TelegramSearchIndex {
  constructor(options = {}) {
    const looksLikeArchive = Array.isArray(options)
      || (options && typeof options === "object" && (
        Array.isArray(options.messages)
        || Array.isArray(options.chats)
        || Array.isArray(options.chats?.list)
        || Array.isArray(options.result?.chats)
        || Array.isArray(options.result?.chats?.list)
      ));
    const settings = looksLikeArchive ? {} : options || {};
    this.snippetLength = Number.isFinite(settings.snippetLength) ? settings.snippetLength : 180;
    this.defaultLimit = Number.isFinite(settings.defaultLimit) ? settings.defaultLimit : 50;
    this.maxLimit = Number.isFinite(settings.maxLimit) ? settings.maxLimit : 500;
    this._chats = new Map();
    this._records = new Map();
    this._chatRecords = new Map();
    this._postings = new Map();
    this._chatSequence = 0;
    this.version = 0;
    if (looksLikeArchive) this.indexArchive(options);
  }

  clear() {
    this._chats.clear();
    this._records.clear();
    this._chatRecords.clear();
    this._postings.clear();
    this._chatSequence = 0;
    this.version += 1;
    return this;
  }

  indexArchive(archive, { clear = true } = {}) {
    if (clear) this.clear();
    for (const chat of archiveChats(archive)) this.addChat(chat);
    return this;
  }

  addChats(chats, options) {
    for (const chat of chats || []) this.addChat(chat, undefined, options);
    return this;
  }

  addChat(chat, messages, { replace = true } = {}) {
    this._chatSequence += 1;
    const normalized = normalizeChatInput(chat, this._chatSequence);
    if (replace && this._chats.has(normalized.id)) this._removeChatMessages(normalized.id);
    this._chats.set(normalized.id, normalized);
    if (!this._chatRecords.has(normalized.id)) this._chatRecords.set(normalized.id, new Set());

    const sourceMessages = messages
      ?? normalized.source.messages
      ?? normalized.source.history
      ?? [];
    this.addMessages(normalized.id, sourceMessages);
    this.version += 1;
    return publicChat(normalized, this._chatRecords.get(normalized.id)?.size || 0);
  }

  addMessages(chatId, messages) {
    const id = asString(chatId);
    if (!this._chats.has(id)) this.addChat({ id, title: id }, [], { replace: false });
    let count = 0;
    let index = 0;
    for (const message of messages || []) {
      this.addMessage(id, message, index);
      count += 1;
      index += 1;
    }
    return count;
  }

  addMessage(chatId, message, fallbackIndex = 0) {
    const id = asString(chatId);
    if (!this._chats.has(id)) this.addChat({ id, title: id }, [], { replace: false });
    const record = createMessageRecord(message, this._chats.get(id), fallbackIndex);
    if (this._records.has(record.uid)) this._removeRecord(record.uid);
    this._records.set(record.uid, record);
    if (!this._chatRecords.has(id)) this._chatRecords.set(id, new Set());
    this._chatRecords.get(id).add(record.uid);

    for (const [token, frequency] of record.tokenCounts) {
      if (!this._postings.has(token)) this._postings.set(token, new Map());
      this._postings.get(token).set(record.uid, frequency);
    }
    this.version += 1;
    return publicNormalizedMessage(record, this._chats.get(id));
  }

  _removeRecord(uid) {
    const record = this._records.get(uid);
    if (!record) return false;
    for (const token of record.tokenCounts.keys()) {
      const posting = this._postings.get(token);
      posting?.delete(uid);
      if (posting?.size === 0) this._postings.delete(token);
    }
    this._chatRecords.get(record.chatId)?.delete(uid);
    this._records.delete(uid);
    return true;
  }

  _removeChatMessages(chatId) {
    const ids = [...(this._chatRecords.get(chatId) || [])];
    for (const uid of ids) this._removeRecord(uid);
    this._chatRecords.set(chatId, new Set());
  }

  removeMessage(chatId, messageId) {
    const removed = this._removeRecord(`${asString(chatId)}\u0000${asString(messageId)}`);
    if (removed) this.version += 1;
    return removed;
  }

  removeChat(chatId) {
    const id = asString(chatId);
    if (!this._chats.has(id)) return false;
    this._removeChatMessages(id);
    this._chatRecords.delete(id);
    this._chats.delete(id);
    this.version += 1;
    return true;
  }

  getChat(chatId) {
    const id = asString(chatId);
    const chat = this._chats.get(id);
    return chat ? publicChat(chat, this._chatRecords.get(id)?.size || 0) : null;
  }

  listChats() {
    return [...this._chats.values()]
      .map((chat) => publicChat(chat, this._chatRecords.get(chat.id)?.size || 0))
      .sort((a, b) => stableCompare(normalizeSearchText(a.title), normalizeSearchText(b.title)) || stableCompare(a.id, b.id));
  }

  getStats() {
    let postingCount = 0;
    let datedMessages = 0;
    let mediaMessages = 0;
    let reactedMessages = 0;
    let earliestDay = null;
    let latestDay = null;
    const senders = new Set();

    for (const posting of this._postings.values()) postingCount += posting.size;
    for (const record of this._records.values()) {
      if (record.day) {
        datedMessages += 1;
        if (earliestDay == null || record.day < earliestDay) earliestDay = record.day;
        if (latestDay == null || record.day > latestDay) latestDay = record.day;
      }
      if (record.has.has("media")) mediaMessages += 1;
      if (record.has.has("reaction")) reactedMessages += 1;
      if (record.sender.searchable) senders.add(record.sender.searchable);
    }

    return {
      chats: this._chats.size,
      messages: this._records.size,
      uniqueTokens: this._postings.size,
      postings: postingCount,
      senders: senders.size,
      datedMessages,
      mediaMessages,
      reactedMessages,
      dateRange: earliestDay == null ? null : { from: earliestDay, to: latestDay },
      version: this.version,
    };
  }

  get stats() {
    return this.getStats();
  }

  search(query, searchOptions = {}) {
    const parsed = typeof query === "string" || query == null ? parseSearchQuery(query) : query;
    const requestedLimit = searchOptions.limit ?? this.defaultLimit;
    const limit = requestedLimit === Infinity
      ? Infinity
      : Math.max(0, Math.min(this.maxLimit, Math.floor(Number(requestedLimit) || 0)));
    const offset = Math.max(0, Math.floor(Number(searchOptions.offset) || 0));
    const options = { ...searchOptions, limit, offset };
    if (!parsed?.valid) return emptySearchResponse(parsed, options, this._records.size);

    const requiredTokens = unique([
      ...parsed.terms,
      ...parsed.phrases.flatMap((phrase) => tokenizeSearchText(phrase)),
    ]);
    let candidates = null;
    for (const token of requiredTokens) {
      const posting = this._postings.get(token);
      if (!posting) return emptySearchResponse(parsed, options, this._records.size);
      candidates = intersectSets(candidates, posting.keys());
      if (candidates.size === 0) return emptySearchResponse(parsed, options, this._records.size);
    }

    const explicitChatIds = searchOptions.chatIds != null
      ? (typeof searchOptions.chatIds === "string"
          ? [searchOptions.chatIds]
          : Array.from(searchOptions.chatIds, asString))
      : searchOptions.chatId != null
        ? [asString(searchOptions.chatId)]
        : null;
    if (explicitChatIds) {
      const scoped = new Set();
      for (const chatId of explicitChatIds) {
        for (const uid of this._chatRecords.get(chatId) || []) scoped.add(uid);
      }
      candidates = intersectSets(candidates, scoped);
    }
    if (candidates == null) candidates = new Set(this._records.keys());
    const candidateCount = candidates.size;

    const fromFilters = parsed.filters.from.map(normalizeSearchText);
    const inFilters = parsed.filters.in.map(normalizeSearchText);
    const matched = [];

    for (const uid of candidates) {
      const record = this._records.get(uid);
      const chat = this._chats.get(record.chatId);
      if (!parsed.phrases.every((phrase) => record.folded.text.includes(phrase))) continue;
      if (fromFilters.length && !fromFilters.some((value) => identityMatches(record.sender.searchable, value))) continue;
      if (inFilters.length && !inFilters.some((value) => identityMatches(chat.searchable, value))) continue;
      if (!parsed.filters.has.every((feature) => record.has.has(feature))) continue;
      if (parsed.filters.before && (!record.day || record.day >= parsed.filters.before)) continue;
      if (parsed.filters.after && (!record.day || record.day <= parsed.filters.after)) continue;
      if (parsed.filters.on && record.day !== parsed.filters.on) continue;
      if (typeof searchOptions.predicate === "function" && !searchOptions.predicate(record.source, chat.source)) continue;

      const score = calculateScore(record, parsed, this._postings, this._records.size);
      matched.push({ record, chat, score });
    }

    const sort = searchOptions.sort || "relevance";
    matched.sort((left, right) => {
      const leftTime = left.record.timestamp ?? Number.NEGATIVE_INFINITY;
      const rightTime = right.record.timestamp ?? Number.NEGATIVE_INFINITY;
      if (sort === "date-asc") {
        if (leftTime !== rightTime) return leftTime - rightTime;
      } else if (sort === "date-desc") {
        if (leftTime !== rightTime) return rightTime - leftTime;
      } else {
        if (left.score !== right.score) return right.score - left.score;
        if (leftTime !== rightTime) return rightTime - leftTime;
      }
      return stableCompare(left.record.chatId, right.record.chatId)
        || stableCompare(left.record.id, right.record.id);
    });

    const selected = matched.slice(offset, limit === Infinity ? undefined : offset + limit);
    const snippetLength = searchOptions.snippetLength ?? this.snippetLength;
    const results = selected.map(({ record, chat, score }) => {
      const matchRanges = collectMatchRanges(record, parsed);
      const snippetInfo = createSnippet(record.searchableText, matchRanges, snippetLength);
      return {
        id: record.rawId,
        key: record.id,
        rawId: record.rawId,
        chatId: chat.rawId,
        chatKey: record.chatId,
        chatTitle: chat.title,
        chat: publicChat(chat, this._chatRecords.get(chat.id)?.size || 0),
        message: record.source,
        text: record.text,
        searchText: record.searchableText,
        sender: { id: record.sender.id, name: record.sender.name, username: record.sender.username },
        date: record.date,
        timestamp: record.timestamp,
        day: record.day,
        has: [...record.has].sort(stableCompare),
        score,
        snippet: snippetInfo.text,
        highlights: snippetInfo.ranges,
        highlightRanges: snippetInfo.ranges,
        matchRanges,
        snippetInfo,
      };
    });

    return {
      query: parsed.raw,
      parsedQuery: parsed,
      total: matched.length,
      offset,
      limit,
      results,
      stats: { indexSize: this._records.size, candidates: candidateCount, matched: matched.length },
    };
  }

  searchChat(chatId, query, options = {}) {
    return this.search(query, { ...options, chatId });
  }

  searchAll(query, options = {}) {
    return this.search(query, options);
  }

  find(query, options = {}) {
    return this.search(query, options).results;
  }
}

export const SearchIndex = TelegramSearchIndex;
export default TelegramSearchIndex;
