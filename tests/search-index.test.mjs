import test from "node:test";
import assert from "node:assert/strict";

import TelegramSearchIndex, {
  SearchIndex,
  SUPPORTED_HAS_FILTERS,
  normalizeSearchText,
  normalizeTelegramMessage,
  parseQuery,
  parseSearchQuery,
  tokenizeSearchText,
} from "../src/search-index.js";

const archive = {
  chats: {
    list: [
      {
        id: 100,
        name: "Café Crew",
        type: "private_group",
        messages: [
          {
            id: 1,
            date: "2024-01-01T09:00:00",
            from: "Álice Example",
            from_id: "user1",
            text: ["Résumé ", { type: "bold", text: "planning" }, " begins today."],
          },
          {
            id: 2,
            date: "2024-01-02T09:00:00",
            from: "Bob Builder",
            from_id: "user2",
            text: "A photo from the résumé planning workshop",
            photo: "photos/photo_1.jpg",
          },
          {
            id: 3,
            date: "2024-01-03T09:00:00",
            from: "Alice Example",
            from_id: "user1",
            text: "The quarterly résumé planning guide is attached.",
            file: "files/report.pdf",
            file_name: "Quarterly Report.pdf",
            reactions: [{ emoji: "👍", count: 2 }],
          },
          {
            id: 4,
            date: "2024-01-04T09:00:00",
            from: "Voice User",
            text: "Audio update",
            media_type: "voice_message",
            voice_message: "voice/file.ogg",
          },
        ],
      },
      {
        id: 200,
        name: "Release Room",
        messages: [
          {
            id: 10,
            date: "2024-02-01T10:00:00",
            from: "Alice Example",
            text: "Planning the RESUME launch now",
            video_file: "video/launch.mp4",
          },
          {
            id: 11,
            date: "2024-02-02T10:00:00",
            from: "John Smith",
            text: "A café résumé planning workshop",
            location_information: { latitude: 48.1, longitude: 17.1 },
          },
          {
            id: 12,
            date: "2024-02-03T10:00:00",
            from: "Poll Bot",
            text: "Choose a launch day",
            poll: { question: "Which launch day?" },
          },
          {
            id: 13,
            date: "2024-02-04T10:00:00",
            from: "Contact Bot",
            text: "Here is the contact",
            contact_information: { first_name: "Grace", last_name: "Hopper" },
          },
          {
            id: 14,
            date: "2024-02-05T10:00:00",
            from: "Sticker Bot",
            text: "A sticker",
            sticker: "stickers/sticker.webp",
          },
          {
            id: 15,
            date: "2024-02-06T10:00:00",
            from: "Link Bot",
            text: "Read https://example.com/release-notes",
            audio_file: "audio/theme.mp3",
          },
        ],
      },
    ],
  },
};

test("normalization is accent/case insensitive and token based", () => {
  assert.equal(normalizeSearchText("  CAFÉ\nRésumé  "), "cafe resume");
  assert.deepEqual(tokenizeSearchText("Crème-brûlée v2.0"), ["creme", "brulee", "v2", "0"]);
  assert.equal(parseQuery, parseSearchQuery);

  const normalized = normalizeTelegramMessage(
    { id: 7, text: ["Hello ", { text: "world" }], from: "Ada" },
    { id: "chat-a", title: "A" },
  );
  assert.equal(normalized.text, "Hello world");
  assert.equal(normalized.sender.name, "Ada");
  assert.equal(normalized.chatId, "chat-a");
});

test("query parser handles phrases, quoted filters, aliases, dates, and stats", () => {
  const parsed = parseSearchQuery(
    'résumé "Quarterly Plan" from:"Álice Example" in:"Café Crew" has:images has:reaction after:2023-12-31 before:2025-01-01',
  );

  assert.equal(parsed.valid, true);
  assert.deepEqual(parsed.terms, ["resume"]);
  assert.deepEqual(parsed.phrases, ["quarterly plan"]);
  assert.deepEqual(parsed.filters.from, ["Álice Example"]);
  assert.deepEqual(parsed.filters.in, ["Café Crew"]);
  assert.deepEqual(parsed.filters.has, ["photo", "reaction"]);
  assert.equal(parsed.filters.after, "2023-12-31");
  assert.equal(parsed.filters.before, "2025-01-01");
  assert.deepEqual(parsed.stats, { termCount: 1, phraseCount: 1, filterCount: 6 });

  const quotedFilterText = parseSearchQuery('"from:alice"');
  assert.deepEqual(quotedFilterText.phrases, ["from:alice"]);
  assert.deepEqual(quotedFilterText.filters.from, []);

  assert.equal(parseSearchQuery("has:spaceship").valid, false);
  assert.equal(parseSearchQuery("on:2024-02-30").valid, false);
  assert.equal(parseSearchQuery('"unfinished').valid, false);
});

test("indexes Telegram archive shapes and finds global accent-insensitive matches", () => {
  const index = new TelegramSearchIndex(archive);
  assert.ok(index instanceof SearchIndex);
  assert.equal(index.stats.chats, 2);
  assert.equal(index.stats.messages, 10);
  assert.equal(index.stats.dateRange.from, "2024-01-01");
  assert.equal(index.stats.dateRange.to, "2024-02-06");

  const result = index.search("RESUME");
  assert.equal(result.total, 5);
  assert.equal(result.parsedQuery.terms[0], "resume");
  assert.equal(result.stats.indexSize, 10);
  assert.ok(result.results.every((item) => normalizeSearchText(item.searchText).includes("resume")));

  assert.deepEqual(index.listChats().map((chat) => chat.title), ["Café Crew", "Release Room"]);
});

test("quoted phrases are required and from/in filters are case/accent insensitive", () => {
  const index = new SearchIndex();
  index.indexArchive(archive);

  const phrase = index.search('"RÉSUMÉ planning"');
  assert.deepEqual(phrase.results.map((result) => result.id), [11, 3, 2, 1]);

  const filtered = index.search('resume from:"alice example" in:"CAFE crew"');
  assert.deepEqual(filtered.results.map((result) => result.id), [3, 1]);

  const byId = index.search("resume from:user1 in:100");
  assert.deepEqual(byId.results.map((result) => result.id), [3, 1]);
});

test("chat-scoped and global search share pagination and stable ordering", () => {
  const index = new SearchIndex(archive);
  const global = index.searchAll("planning");
  const scoped = index.searchChat(100, "planning");
  const multiScope = index.search("planning", { chatIds: [200] });

  assert.equal(global.total, 5);
  assert.deepEqual(scoped.results.map((item) => item.chatId), [100, 100, 100]);
  assert.deepEqual(multiScope.results.map((item) => item.id), [11, 10]);

  const allIds = global.results.map((item) => `${item.chatId}:${item.id}`);
  const repeatedIds = index.searchAll("planning").results.map((item) => `${item.chatId}:${item.id}`);
  assert.deepEqual(repeatedIds, allIds);

  const page = index.search("planning", { offset: 1, limit: 2 });
  assert.equal(page.total, 5);
  assert.deepEqual(
    page.results.map((item) => `${item.chatId}:${item.id}`),
    allIds.slice(1, 3),
  );
});

test("has filters recognize every supported read-only content type", () => {
  const index = new SearchIndex(archive);
  const expectations = new Map([
    ["photo", [2]],
    ["video", [10]],
    ["audio", [15]],
    ["voice", [4]],
    ["sticker", [14]],
    ["poll", [12]],
    ["location", [11]],
    ["contact", [13]],
    ["reaction", [3]],
    ["link", [15]],
  ]);

  for (const [filter, ids] of expectations) {
    assert.deepEqual(index.search(`has:${filter}`).results.map((item) => item.id), ids, filter);
  }
  assert.deepEqual(index.search("has:file").results.map((item) => item.id), [3]);
  assert.deepEqual(index.search("has:media", { sort: "date-asc" }).results.map((item) => item.id), [2, 3, 4, 10, 15]);
  assert.deepEqual(SUPPORTED_HAS_FILTERS, [
    "media", "link", "file", "photo", "video", "audio", "voice", "sticker",
    "poll", "location", "contact", "reaction",
  ]);
});

test("date filters use export calendar days with exclusive before/after bounds", () => {
  const index = new SearchIndex(archive);
  assert.deepEqual(index.search("on:2024-01-02").results.map((item) => item.id), [2]);
  assert.deepEqual(
    index.search("in:100 before:2024-01-03", { sort: "date-asc" }).results.map((item) => item.id),
    [1, 2],
  );
  assert.deepEqual(
    index.search("in:100 after:2024-01-02", { sort: "date-asc" }).results.map((item) => item.id),
    [3, 4],
  );
});

test("snippets expose source and snippet-relative highlight ranges", () => {
  const index = new SearchIndex({ snippetLength: 64 });
  const longPrefix = "Context that is intentionally long and unimportant. ".repeat(4);
  index.addChat({
    id: "long",
    title: "Long chat",
    messages: [{ id: 1, date: "2024-03-01", text: `${longPrefix}RÉSUMÉ planning happens here, followed by more context.` }],
  });

  const hit = index.search('"resume planning"').results[0];
  assert.ok(hit.snippet.startsWith("…"));
  assert.ok(hit.snippet.endsWith("…"));
  assert.ok(hit.highlights.length > 0);
  const relative = hit.highlights[0];
  assert.equal(normalizeSearchText(hit.snippet.slice(relative.start, relative.end)), "resume planning");
  const absolute = hit.matchRanges[0];
  assert.equal(normalizeSearchText(hit.searchText.slice(absolute.start, absolute.end)), "resume planning");
  assert.deepEqual(hit.highlightRanges, hit.highlights);
  assert.equal(hit.snippetInfo.text, hit.snippet);
});

test("ranking is deterministic, rewards term frequency, and has explicit date sorts", () => {
  const index = new SearchIndex();
  index.addChat({
    id: "rank",
    title: "Ranking",
    messages: [
      { id: "a", date: "2024-01-01", text: "alpha beta" },
      { id: "b", date: "2024-01-02", text: "alpha alpha alpha beta" },
      { id: "c", date: "2024-01-03", text: "alpha something beta" },
    ],
  });

  assert.deepEqual(index.find("alpha beta").map((item) => item.id), ["b", "a", "c"]);
  assert.deepEqual(index.search("alpha", { sort: "date-asc" }).results.map((item) => item.id), ["a", "b", "c"]);
  assert.deepEqual(index.search("alpha", { sort: "date-desc" }).results.map((item) => item.id), ["c", "b", "a"]);
  assert.deepEqual(index.find("alpha beta").map((item) => item.score), index.find("alpha beta").map((item) => item.score));
});

test("updates remove stale postings and stats remain accurate", () => {
  const index = new SearchIndex({ chats: [{ id: "x", name: "X", messages: [{ id: 1, text: "old token" }] }] });
  assert.equal(index.search("old").total, 1);

  index.addMessage("x", { id: 1, text: "new token", date: "2024-06-01" });
  assert.equal(index.search("old").total, 0);
  assert.equal(index.search("new").total, 1);
  assert.equal(index.stats.messages, 1);

  assert.equal(index.removeMessage("x", 1), true);
  assert.equal(index.stats.messages, 0);
  index.addMessage("x", { id: 2, text: "restored" });
  assert.equal(index.removeChat("x"), true);
  assert.equal(index.stats.chats, 0);
  assert.equal(index.stats.messages, 0);
});
