import {
  AssetResolver,
  chooseArchiveFolder,
  entriesFromDrop,
  entriesFromFileList,
  forgetRememberedDirectory,
  getRememberedDirectory,
  rememberDirectoryHandle,
  reopenRememberedDirectory,
  supportsDirectoryPicker,
} from './archive-source.js';
import { createDemoArchive } from './demo-data.js';
import { icon } from './icons.js';
import TelegramSearchIndex from './search-index.js';
import { parseTelegramExport } from './telegram-parser.js';

const app = document.getElementById('app');
const folderInput = document.getElementById('folder-input');
const MESSAGE_BATCH = 180;
const compactNumber = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

const state = {
  screen: 'welcome',
  archive: null,
  source: null,
  resolver: null,
  searchIndex: null,
  recentHandle: null,
  rememberFolder: localStorage.getItem('teleview:remember-folder') === 'true',
  selectedChatId: null,
  mobileChatOpen: false,
  chatFilter: 'all',
  globalQuery: '',
  globalSearchResponse: null,
  inChatSearchOpen: false,
  inChatQuery: '',
  inChatResults: [],
  inChatCursor: -1,
  visibleRanges: new Map(),
  scrollPositions: new Map(),
  highlightedMessageId: null,
  infoOpen: false,
  sharedTab: 'media',
  overlay: null,
  contextMenu: null,
  theme: localStorage.getItem('teleview:theme') || 'system',
  textSize: localStorage.getItem('teleview:text-size') || 'comfortable',
  twelveHour: localStorage.getItem('teleview:time-format') === '12',
  loadingToken: 0,
  toastId: 0,
};

const avatarPalettes = [
  ['#5ab6e8', '#168acd'],
  ['#6cc58b', '#32a15b'],
  ['#d98b68', '#bf5d49'],
  ['#a989df', '#7758bd'],
  ['#e1a54e', '#c47a28'],
  ['#ee7c9b', '#c54e76'],
  ['#54bfb4', '#218f89'],
];

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, '&#096;');
}

function safeId(value) {
  return String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function hashString(value) {
  let hash = 2166136261;
  for (const character of String(value || '')) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function avatarStyle(value) {
  const [start, end] = avatarPalettes[hashString(value) % avatarPalettes.length];
  return `--avatar:linear-gradient(145deg,${start},${end})`;
}

function initials(name) {
  const words = String(name || '?').trim().split(/\s+/u).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return ([...words[0]][0] || '?').toLocaleUpperCase();
  return `${[...words[0]][0] || ''}${[...words.at(-1)][0] || ''}`.toLocaleUpperCase();
}

function renderAvatar(name, size = '', extra = '', identityKey = name) {
  return `<span class="avatar${size ? ` avatar-${size}` : ''} ${extra}" style="${avatarStyle(identityKey)}" aria-hidden="true">${escapeHtml(initials(name))}</span>`;
}

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value || 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatTime(value) {
  const date = toDate(value);
  if (!date) return '';
  return date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    hour12: state.twelveHour,
  });
}

function formatFullDate(value) {
  const date = toDate(value);
  if (!date) return 'Unknown date';
  return date.toLocaleString([], {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: state.twelveHour,
  });
}

function calendarDay(value) {
  const date = toDate(value);
  if (!date) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatDayLabel(value) {
  const date = toDate(value);
  if (!date) return 'Unknown date';
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (calendarDay(date) === calendarDay(today)) return 'Today';
  if (calendarDay(date) === calendarDay(yesterday)) return 'Yesterday';
  const sameYear = date.getFullYear() === today.getFullYear();
  return date.toLocaleDateString([], {
    weekday: 'short',
    month: 'long',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

function formatListDate(value) {
  const date = toDate(value);
  if (!date) return '';
  const today = new Date();
  if (calendarDay(date) === calendarDay(today)) return formatTime(date);
  const days = Math.round((today - date) / 86400000);
  if (days < 7) return date.toLocaleDateString([], { weekday: 'short' });
  if (date.getFullYear() === today.getFullYear()) return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return date.toLocaleDateString([], { year: '2-digit', month: 'numeric', day: 'numeric' });
}

function formatDuration(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(total / 60);
  const remainder = Math.floor(total % 60);
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  const position = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const size = bytes / (1024 ** position);
  return `${size >= 10 || position === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[position]}`;
}

function plural(value, word) {
  return `${compactNumber.format(value || 0)} ${word}${Number(value) === 1 ? '' : 's'}`;
}

function getChat(chatId = state.selectedChatId) {
  return state.archive?.chats?.find((chat) => String(chat.id) === String(chatId)) || null;
}

function lastMessage(chat) {
  return chat?.messages?.at(-1) || null;
}

function messageSummary(message) {
  if (!message) return 'No messages';
  if (message.text) return String(message.text).replace(/\s+/gu, ' ').trim();
  if (message.poll) return `Poll: ${message.poll.question || ''}`.trim();
  if (message.location) return 'Location';
  if (message.contact) return 'Contact';
  const type = message.media?.[0]?.type;
  const labels = { photo: 'Photo', video: 'Video', voice: 'Voice message', audio: 'Audio', sticker: 'Sticker', file: 'File', animation: 'Animation', link: 'Link' };
  if (type) return labels[type] || 'Attachment';
  if (message.type === 'service') return message.service?.text || message.action || 'Service message';
  return 'Message';
}

function chatKind(chat) {
  const type = String(chat?.type || '').toLocaleLowerCase();
  if (type.includes('saved')) return 'saved';
  if (type.includes('bot')) return 'bot';
  if (type.includes('channel')) return 'channel';
  if (type.includes('group')) return 'group';
  return 'private';
}

function chatKindLabel(chat) {
  return ({ saved: 'Saved messages', bot: 'Bot', channel: 'Channel', group: 'Group', private: 'Private chat' })[chatKind(chat)];
}

function mediaKind(media) {
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

function applyPreferences() {
  const resolvedTheme = state.theme === 'system'
    ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : state.theme;
  document.documentElement.dataset.theme = resolvedTheme;
  const sizes = { compact: '13.5px', comfortable: '15px', large: '17px' };
  document.documentElement.style.setProperty('--font-size', sizes[state.textSize] || sizes.comfortable);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolvedTheme === 'dark' ? '#17212b' : '#ffffff');
}

function setTheme(theme) {
  state.theme = ['system', 'light', 'dark'].includes(theme) ? theme : 'system';
  localStorage.setItem('teleview:theme', state.theme);
  applyPreferences();
}

function setTextSize(size) {
  state.textSize = ['compact', 'comfortable', 'large'].includes(size) ? size : 'comfortable';
  localStorage.setItem('teleview:text-size', state.textSize);
  applyPreferences();
}

function toast(message) {
  const id = ++state.toastId;
  let stack = document.querySelector('.toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.className = 'toast-stack';
    stack.setAttribute('aria-live', 'polite');
    document.body.append(stack);
  }
  const item = document.createElement('div');
  item.className = 'toast';
  item.dataset.toastId = id;
  item.textContent = message;
  stack.append(item);
  setTimeout(() => item.remove(), 2800);
}

function renderWelcome(error = '') {
  state.screen = 'welcome';
  state.overlay = null;
  const pickerCopy = supportsDirectoryPicker() ? 'Choose export folder' : 'Select export folder';
  app.innerHTML = `
    <main class="welcome-screen">
      <div class="welcome-shell">
        <section class="welcome-copy">
          <div class="brand-lockup">
            <span class="brand-mark">${icon('channel')}</span>
            <span class="brand-name">Teleview</span>
          </div>
          <h1>Your Telegram history, beautifully readable.</h1>
          <p>Open a Telegram Desktop export and browse every conversation, attachment, and memory in one familiar, searchable place.</p>
          <ul class="privacy-points">
            <li>${icon('shield')} Stays on this device</li>
            <li>${icon('lock')} Read-only access</li>
            <li>${icon('globe')} No account or upload</li>
          </ul>
        </section>
        <section class="folder-card" aria-label="Open archive">
          ${error ? `<div class="error-box" role="alert">${escapeHtml(error)}</div>` : ''}
          <div class="drop-zone" data-drop-zone>
            <span class="folder-illustration">${icon('folder')}</span>
            <h2>Open an export folder</h2>
            <p>Drop it here, or choose the folder containing <strong>result.json</strong> or <strong>messages.html</strong>.</p>
            <div class="folder-actions">
              <button class="primary-button" type="button" data-action="open-folder">${icon('folder')} ${pickerCopy}</button>
              <button class="secondary-button" type="button" data-action="open-demo">${icon('play')} Explore a demo</button>
            </div>
          </div>
          ${supportsDirectoryPicker() ? `
            <label class="settings-row" style="margin-top:10px;min-height:38px;cursor:pointer">
              <input type="checkbox" data-action="remember-choice" ${state.rememberFolder ? 'checked' : ''} />
              <span class="settings-copy"><strong>Remember this folder</strong><span>Lets you reopen it quickly on this browser.</span></span>
            </label>
          ` : ''}
          ${state.recentHandle ? `
            <button class="recent-folder" type="button" data-action="open-recent">
              ${icon('archive')}
              <span class="recent-copy"><strong>${escapeHtml(state.recentHandle.name)}</strong><span>Recently opened archive</span></span>
              ${icon('chevronRight')}
            </button>
          ` : ''}
          <p class="welcome-footnote">Supports JSON and HTML exports from Telegram Desktop. Nothing is sent anywhere.</p>
        </section>
      </div>
    </main>`;
}

function renderLoading(label = 'Reading export files…', progress = 12) {
  state.screen = 'loading';
  app.innerHTML = `
    <main class="loading-screen">
      <section class="loading-card">
        <div class="spinner" aria-hidden="true"></div>
        <h2>Opening your archive</h2>
        <p data-loading-label>${escapeHtml(label)}</p>
        <div class="loading-progress" aria-hidden="true"><span style="--progress:${Math.max(3, Math.min(100, progress))}%"></span></div>
        <button class="quiet-button" type="button" data-action="cancel-loading" style="margin-top:16px">Cancel</button>
      </section>
    </main>`;
}

function updateLoading(label, progress) {
  const text = document.querySelector('[data-loading-label]');
  const bar = document.querySelector('.loading-progress span');
  if (text) text.textContent = label;
  if (bar) bar.style.setProperty('--progress', `${Math.max(3, Math.min(100, progress))}%`);
}

function prepareArchive(archive, sourceName) {
  const normalized = archive && typeof archive === 'object' ? archive : {};
  normalized.chats = Array.isArray(normalized.chats) ? normalized.chats : [];
  normalized.sourceName ||= sourceName || 'Telegram export';
  normalized.title ||= normalized.owner?.name ? `${normalized.owner.name}'s Telegram` : normalized.sourceName;
  normalized.warnings = Array.isArray(normalized.warnings) ? normalized.warnings : [];

  normalized.chats.forEach((chat, chatPosition) => {
    chat.id = String(chat.id ?? `chat-${chatPosition + 1}`);
    chat.name ||= `Chat ${chatPosition + 1}`;
    chat.messages = Array.isArray(chat.messages) ? chat.messages : [];
    chat.messages.forEach((message, messagePosition) => {
      message.id = String(message.id ?? `message-${messagePosition + 1}`);
      message.chatId = chat.id;
      message._sourcePosition = message._sourcePosition ?? messagePosition;
      if (message.isOutgoing == null && normalized.owner?.id != null && message.senderId != null) {
        const ownerId = String(normalized.owner.id).replace(/^user/i, '');
        const senderId = String(message.senderId).replace(/^user/i, '');
        message.isOutgoing = ownerId === senderId;
      }
    });
    chat.messages.sort((a, b) => {
      const aTime = toDate(a.date)?.getTime() ?? 0;
      const bTime = toDate(b.date)?.getTime() ?? 0;
      return aTime - bTime || a._sourcePosition - b._sourcePosition;
    });
    chat._exportPosition = chatPosition;
    chat._lastTimestamp = toDate(lastMessage(chat)?.date)?.getTime() || 0;
  });

  normalized.chats.sort((a, b) => b._lastTimestamp - a._lastTimestamp || a._exportPosition - b._exportPosition);
  const allMessages = normalized.chats.flatMap((chat) => chat.messages);
  const dates = allMessages.map((message) => toDate(message.date)?.getTime()).filter(Number.isFinite);
  normalized.stats = {
    ...(normalized.stats || {}),
    chats: normalized.chats.length,
    messages: allMessages.length,
    firstDate: dates.length ? new Date(Math.min(...dates)).toISOString() : null,
    lastDate: dates.length ? new Date(Math.max(...dates)).toISOString() : null,
  };
  return normalized;
}

async function openArchiveSource(source) {
  if (!source?.entries?.length) {
    renderWelcome('That folder is empty. Choose the folder created by Telegram Desktop.');
    return;
  }
  const token = ++state.loadingToken;
  renderLoading('Checking the export format…', 10);
  await new Promise((resolve) => setTimeout(resolve, 40));
  try {
    updateLoading(`Reading ${source.entries.length.toLocaleString()} files…`, 24);
    const parsed = await parseTelegramExport(source.entries, {
      sourceName: source.name,
      onProgress(progress) {
        if (token !== state.loadingToken) return;
        const value = typeof progress === 'number' ? progress : progress?.progress;
        const label = typeof progress === 'object' ? progress.label : null;
        updateLoading(label || 'Parsing conversations…', 24 + (Number(value) || 0) * 0.46);
      },
    });
    if (token !== state.loadingToken) return;
    updateLoading('Building the search index…', 76);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const archive = prepareArchive(parsed, source.name);
    if (!archive.chats.length) {
      throw new Error('No Telegram chats were found. Choose the export folder containing result.json or messages.html.');
    }
    const searchIndex = new TelegramSearchIndex({ snippetLength: 180, defaultLimit: 80 });
    searchIndex.indexArchive(archive);
    if (token !== state.loadingToken) return;

    state.resolver?.revokeAll();
    state.archive = archive;
    state.source = source;
    state.resolver = new AssetResolver(source.entries);
    state.searchIndex = searchIndex;
    state.selectedChatId = archive.chats[0]?.id || null;
    state.chatFilter = 'all';
    state.globalQuery = '';
    state.globalSearchResponse = null;
    state.inChatSearchOpen = false;
    state.inChatQuery = '';
    state.inChatResults = [];
    state.visibleRanges.clear();
    state.scrollPositions.clear();
    state.infoOpen = false;
    state.mobileChatOpen = false;
    state.overlay = null;
    state.screen = 'viewer';

    if (state.rememberFolder && source.handle) {
      await rememberDirectoryHandle(source.handle);
      state.recentHandle = source.handle;
    }
    updateLoading('Ready', 100);
    renderViewer();
    requestAnimationFrame(() => scrollToLatest(false));
    if (archive.warnings.length) {
      toast(`Opened with ${plural(archive.warnings.length, 'import warning')}. Details are in Settings.`);
    }
  } catch (error) {
    if (token !== state.loadingToken) return;
    console.error('Unable to open Telegram export:', error?.message || error);
    renderWelcome(error?.message || 'This does not look like a supported Telegram export.');
  }
}

function openDemo() {
  ++state.loadingToken;
  state.resolver?.revokeAll();
  const archive = prepareArchive(createDemoArchive(), 'Demo archive');
  state.archive = archive;
  state.source = { name: 'Demo archive', kind: 'demo', entries: [] };
  state.resolver = new AssetResolver();
  state.searchIndex = new TelegramSearchIndex({ snippetLength: 180, defaultLimit: 80 });
  state.searchIndex.indexArchive(archive);
  state.selectedChatId = archive.chats[0]?.id || null;
  state.globalQuery = '';
  state.globalSearchResponse = null;
  state.visibleRanges.clear();
  state.mobileChatOpen = false;
  state.screen = 'viewer';
  renderViewer();
  requestAnimationFrame(() => scrollToLatest(false));
}

function visibleChats() {
  const chats = state.archive?.chats || [];
  if (state.chatFilter === 'all') return chats;
  return chats.filter((chat) => chatKind(chat) === state.chatFilter);
}

function renderSidebarList() {
  if (state.globalQuery.trim()) return renderGlobalResults();
  const chats = visibleChats();
  if (!chats.length) {
    return `<div class="list-empty">${icon('message')}No chats match this filter.</div>`;
  }
  return `<div class="chat-list" role="list" aria-label="Chats">${chats.map((chat) => {
    const last = lastMessage(chat);
    const selected = String(chat.id) === String(state.selectedChatId);
    const prefix = last?.senderName && chatKind(chat) === 'group' && !last.isOutgoing
      ? `<span class="sender-prefix">${escapeHtml(last.senderName)}: </span>`
      : '';
    return `
      <button class="chat-row ${selected ? 'is-selected' : ''}" type="button" role="listitem" data-action="select-chat" data-chat-id="${escapeAttribute(chat.id)}" aria-current="${selected ? 'true' : 'false'}">
        ${renderAvatar(chat.name)}
        <span class="chat-name">${escapeHtml(chat.name)}</span>
        <time class="chat-date" datetime="${escapeAttribute(last?.date || '')}">${escapeHtml(formatListDate(last?.date))}</time>
        <span class="chat-preview">${prefix}${escapeHtml(messageSummary(last))}</span>
        <span class="chat-meta">${compactNumber.format(chat.messages.length)}</span>
      </button>`;
  }).join('')}</div>`;
}

function searchHighlight(snippet, ranges = []) {
  if (!ranges.length) return escapeHtml(snippet);
  const ordered = [...ranges].sort((a, b) => a.start - b.start);
  let cursor = 0;
  let html = '';
  for (const range of ordered) {
    const start = Math.max(cursor, Number(range.start) || 0);
    const end = Math.max(start, Number(range.end) || start);
    html += escapeHtml(snippet.slice(cursor, start));
    html += `<mark class="search-mark">${escapeHtml(snippet.slice(start, end))}</mark>`;
    cursor = end;
  }
  html += escapeHtml(snippet.slice(cursor));
  return html;
}

function renderGlobalResults() {
  const response = state.globalSearchResponse;
  if (!response) return `<div class="search-summary">Searching…</div>`;
  if (response.parsedQuery?.errors?.length) {
    return `<div class="search-help">${escapeHtml(response.parsedQuery.errors[0])}<br />Try words, <code>"an exact phrase"</code>, <code>from:name</code>, <code>in:chat</code>, <code>has:photo</code>, or <code>after:2024-01-01</code>.</div>`;
  }
  if (!response.results.length) {
    return `<div class="no-results">${icon('search')}No messages found.<br /><span>Try fewer words or remove a filter.</span></div>
      <div class="search-help">Power filters: <code>from:Alex</code> <code>in:Family</code> <code>has:file</code> <code>before:2024-01-01</code></div>`;
  }
  return `
    <div class="search-results" role="listbox" aria-label="Search results">
      <div class="search-summary">${response.total.toLocaleString()} result${response.total === 1 ? '' : 's'} across all chats</div>
      ${response.results.map((result, position) => `
        <button class="search-result ${position === state.globalResultCursor ? 'is-active' : ''}" type="button" role="option" data-action="open-search-result" data-chat-id="${escapeAttribute(result.chatId)}" data-message-id="${escapeAttribute(result.id)}">
          ${renderAvatar(result.chatTitle)}
          <span class="result-title">${escapeHtml(result.chatTitle)}${result.sender?.name ? ` · ${escapeHtml(result.sender.name)}` : ''}</span>
          <time class="result-date">${escapeHtml(formatListDate(result.date))}</time>
          <span class="result-snippet">${searchHighlight(result.snippet, result.highlights)}</span>
        </button>
      `).join('')}
    </div>`;
}

function renderSidebar() {
  const filterCounts = (state.archive?.chats || []).reduce((counts, chat) => {
    const kind = chatKind(chat);
    counts[kind] = (counts[kind] || 0) + 1;
    return counts;
  }, {});
  const filters = [
    ['all', 'All'],
    ['private', 'Private'],
    ['group', 'Groups'],
    ['channel', 'Channels'],
    ['bot', 'Bots'],
    ['saved', 'Saved'],
  ].filter(([key]) => key === 'all' || filterCounts[key]);
  const messageCount = state.archive?.stats?.messages || 0;
  return `
    <aside class="sidebar" aria-label="Archive navigation">
      <div class="sidebar-top">
        <div class="sidebar-title-row">
          <button class="icon-button" type="button" aria-label="Settings" data-action="open-settings">${icon('menu')}</button>
          <div class="sidebar-brand">
            <strong>${escapeHtml(state.archive?.title || 'Telegram archive')}</strong>
            <span>${plural(state.archive?.stats?.chats || 0, 'chat')} · ${plural(messageCount, 'message')}</span>
          </div>
          <button class="icon-button" type="button" aria-label="Open another archive" data-action="open-another">${icon('folder')}</button>
        </div>
        <label class="search-field">
          <span class="search-icon">${icon('search')}</span>
          <span class="sr-only">Search all chats</span>
          <input type="search" value="${escapeAttribute(state.globalQuery)}" placeholder="Search all messages" autocomplete="off" spellcheck="false" data-global-search />
          <button class="search-clear" type="button" aria-label="Clear search" data-action="clear-global-search" ${state.globalQuery ? '' : 'hidden'}>${icon('close', 'icon-sm')}</button>
        </label>
        <div class="filter-tabs" aria-label="Chat filters" data-filter-tabs ${state.globalQuery ? 'hidden' : ''}>${filters.map(([key, label]) => `
          <button class="filter-tab ${state.chatFilter === key ? 'is-active' : ''}" type="button" data-action="filter-chats" data-filter="${key}">${label}</button>
        `).join('')}</div>
      </div>
      <div class="sidebar-content" data-sidebar-content>${renderSidebarList()}</div>
      <div class="sidebar-footer">${icon('shield')} Local archive · read-only</div>
    </aside>`;
}

function extractSearchTerms(query) {
  const terms = [];
  const expression = /"([^"]+)"|(?:^|\s)(?!-)([^\s:]+)(?=\s|$)/gu;
  let match;
  while ((match = expression.exec(query || ''))) {
    const term = (match[1] || match[2] || '').trim();
    if (term && !/^(from|in|has|before|after|on)$/iu.test(term)) terms.push(term);
  }
  return terms.slice(0, 8);
}

function highlightPlainText(value) {
  const text = String(value || '');
  const terms = state.inChatSearchOpen ? extractSearchTerms(state.inChatQuery) : [];
  if (!terms.length) return escapeHtml(text);
  const pattern = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).filter(Boolean).join('|');
  if (!pattern) return escapeHtml(text);
  const expression = new RegExp(pattern, 'giu');
  let cursor = 0;
  let html = '';
  let match;
  while ((match = expression.exec(text))) {
    html += escapeHtml(text.slice(cursor, match.index));
    html += `<mark class="search-mark">${escapeHtml(match[0])}</mark>`;
    cursor = match.index + match[0].length;
    if (!match[0].length) expression.lastIndex += 1;
  }
  html += escapeHtml(text.slice(cursor));
  return html;
}

function safeHref(value, kind = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (kind === 'email' && !raw.startsWith('mailto:')) return `mailto:${raw}`;
  if (kind === 'phone' && !raw.startsWith('tel:')) return `tel:${raw}`;
  if (raw.startsWith('@')) return `https://t.me/${raw.slice(1)}`;
  if (/^www\./i.test(raw)) return `https://${raw}`;
  try {
    const url = new URL(raw, location.href);
    if (['http:', 'https:', 'mailto:', 'tel:', 'tg:'].includes(url.protocol)) return url.href;
  } catch {}
  return '';
}

function renderTextEntity(entity) {
  const text = String(entity?.text ?? entity?.value ?? '');
  const content = highlightPlainText(text);
  const type = String(entity?.type || 'plain').toLocaleLowerCase();
  if (['bold', 'strong'].includes(type)) return `<strong>${content}</strong>`;
  if (['italic', 'emphasis'].includes(type)) return `<em>${content}</em>`;
  if (['underline'].includes(type)) return `<u>${content}</u>`;
  if (['strikethrough', 'strike'].includes(type)) return `<s>${content}</s>`;
  if (['code', 'pre', 'preformatted'].includes(type)) return `<code>${content}</code>`;
  if (['spoiler'].includes(type)) return `<button class="spoiler" type="button" data-action="reveal-spoiler" aria-label="Reveal hidden text">${content}</button>`;
  const href = entity?.href || entity?.url || (type === 'text_link' ? entity?.text : '');
  if (['link', 'text_link', 'url', 'mention', 'email', 'phone'].includes(type) || href) {
    const safe = safeHref(href || text, type);
    return safe ? `<a href="${escapeAttribute(safe)}" target="_blank" rel="noopener noreferrer">${content}</a>` : content;
  }
  if (type === 'hashtag') {
    return `<span class="hashtag">${content}</span>`;
  }
  return content;
}

function linkifyText(value) {
  const text = String(value || '');
  const expression = /((?:https?:\/\/|tg:\/\/|www\.)[^\s<]+|[\w.+-]+@[\w.-]+\.[\p{L}]{2,})/giu;
  let cursor = 0;
  let html = '';
  let match;
  while ((match = expression.exec(text))) {
    html += highlightPlainText(text.slice(cursor, match.index));
    const raw = match[0];
    const email = !raw.includes('://') && !raw.startsWith('www.') && raw.includes('@');
    const href = safeHref(raw, email ? 'email' : '');
    html += href
      ? `<a href="${escapeAttribute(href)}" target="_blank" rel="noopener noreferrer">${highlightPlainText(raw)}</a>`
      : highlightPlainText(raw);
    cursor = match.index + raw.length;
  }
  html += highlightPlainText(text.slice(cursor));
  return html;
}

function renderMessageText(message) {
  const entities = Array.isArray(message.textEntities) ? message.textEntities : Array.isArray(message.entities) ? message.entities : null;
  let html;
  if (entities?.length && entities.some((entity) => entity && typeof entity === 'object' && 'text' in entity)) {
    html = entities.map(renderTextEntity).join('');
  } else {
    html = linkifyText(message.text || '');
  }
  return html ? `<p class="message-text" dir="auto">${html}</p>` : '';
}

function renderMediaUnavailable(label, path = '') {
  return `<div class="media-unavailable">${icon('image')}<strong>${escapeHtml(label)}</strong>${path ? `<span>${escapeHtml(path)}</span>` : ''}</div>`;
}

function renderWaveform() {
  const heights = [8, 14, 6, 17, 11, 21, 13, 9, 19, 7, 15, 22, 10, 18, 6, 13, 20, 9, 16, 11, 7, 18, 13, 20, 8, 14, 6, 17, 11, 19, 8, 13];
  return heights.map((height) => `<i style="--wave-height:${height}px"></i>`).join('');
}

function renderSingleMedia(media, message, index) {
  const kind = mediaKind(media);
  const path = media.path || media.file || media.filePath || media.photo || media.thumbnail || '';
  const attrs = `data-chat-id="${escapeAttribute(message.chatId)}" data-message-id="${escapeAttribute(message.id)}" data-media-index="${index}"`;
  if (kind === 'photo' || kind === 'sticker' || kind === 'animation') {
    if (media.demoGradient) {
      return `<div class="media-block"><button class="media-photo is-placeholder" type="button" data-action="open-media" ${attrs} aria-label="Open demo photo">${icon('image')}</button></div>`;
    }
    if (!path) return `<div class="media-block">${renderMediaUnavailable(`${kind[0].toUpperCase()}${kind.slice(1)} was not included`)}</div>`;
    return `<div class="media-block"><button class="media-photo" type="button" data-action="open-media" ${attrs} aria-label="Open ${kind}"><img data-asset-path="${escapeAttribute(path)}" alt="${escapeAttribute(media.fileName || `${kind} attachment`)}" loading="lazy" /></button></div>`;
  }
  if (kind === 'video') {
    if (!path) return `<div class="media-block">${renderMediaUnavailable('Video was not included')}</div>`;
    return `<div class="media-block"><div class="media-photo"><video controls preload="metadata" data-asset-path="${escapeAttribute(path)}" ${attrs}>Your browser cannot preview this video.</video></div></div>`;
  }
  if (kind === 'voice' || kind === 'audio') {
    const title = media.fileName || (kind === 'voice' ? 'Voice message' : media.title || 'Audio');
    return `<div class="voice-card">
      <span class="voice-play">${icon(kind === 'voice' ? 'mic' : 'play')}</span>
      <span class="voice-track"><strong>${escapeHtml(title)}</strong><span class="voice-wave" aria-hidden="true">${renderWaveform()}</span><span class="voice-time">${escapeHtml(formatDuration(media.duration))}${media.performer ? ` · ${escapeHtml(media.performer)}` : ''}</span>${path ? `<audio controls preload="none" data-asset-path="${escapeAttribute(path)}" aria-label="${escapeAttribute(title)}"></audio>` : ''}</span>
    </div>`;
  }
  if (kind === 'link') {
    const href = safeHref(media.url || path);
    return href ? `<a class="link-preview" href="${escapeAttribute(href)}" target="_blank" rel="noopener noreferrer"><small>${escapeHtml(media.siteName || new URL(href).hostname)}</small><strong>${escapeHtml(media.title || media.url || 'Open link')}</strong>${media.description ? `<span>${escapeHtml(media.description)}</span>` : ''}</a>` : '';
  }
  const name = media.fileName || path.split('/').pop() || 'Attachment';
  const details = [formatBytes(media.size), media.mimeType].filter(Boolean).join(' · ') || (path ? 'Included file' : 'File not included');
  return `<div class="file-card">
    <span class="file-icon">${icon('file')}</span>
    <span class="file-copy"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(details)}</span></span>
    ${path ? `<a class="download-file" data-asset-path="${escapeAttribute(path)}" data-asset-link download="${escapeAttribute(name)}" aria-label="Download ${escapeAttribute(name)}">${icon('download')}</a>` : ''}
  </div>`;
}

function renderPoll(poll) {
  const options = Array.isArray(poll?.options) ? poll.options : [];
  const total = Number(poll?.totalVoters ?? poll?.total_voters ?? options.reduce((sum, option) => sum + (Number(option.votes) || 0), 0)) || 0;
  return `<div class="poll-card">
    <div class="poll-question">${escapeHtml(poll?.question || 'Poll')}</div>
    <div class="poll-label">Final results</div>
    ${options.map((option) => {
      const votes = Number(option.votes) || 0;
      const percent = total ? Math.round((votes / total) * 100) : Number(option.percent) || 0;
      return `<div class="poll-option"><div class="poll-option-head"><span>${option.chosen ? '✓ ' : ''}${escapeHtml(option.text || option.option || '')}</span><strong>${percent}%</strong></div><div class="poll-option-bar"><span style="--poll-width:${Math.min(100, percent)}%"></span></div></div>`;
    }).join('')}
    <div class="poll-total">${plural(total, 'vote')}</div>
  </div>`;
}

function renderContact(contact) {
  const name = contact?.name || [contact?.firstName || contact?.first_name, contact?.lastName || contact?.last_name].filter(Boolean).join(' ') || 'Contact';
  const phone = contact?.phoneNumber || contact?.phone_number || '';
  return `<div class="contact-card"><span class="contact-icon">${icon('person')}</span><span class="contact-copy"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(phone || 'Contact card')}</span></span></div>`;
}

function renderLocation(locationData) {
  const latitude = Number(locationData?.latitude ?? locationData?.lat);
  const longitude = Number(locationData?.longitude ?? locationData?.lon ?? locationData?.lng);
  const valid = Number.isFinite(latitude) && Number.isFinite(longitude);
  const href = valid ? `https://www.google.com/maps?q=${latitude},${longitude}` : '';
  const name = locationData?.placeName || locationData?.name || locationData?.address || 'Shared location';
  const content = `<span class="location-icon">${icon('location')}</span><span class="location-copy"><strong>${escapeHtml(name)}</strong><span>${valid ? `${latitude.toFixed(5)}, ${longitude.toFixed(5)}` : 'Coordinates unavailable'}</span></span>`;
  return valid ? `<a class="location-card" href="${escapeAttribute(href)}" target="_blank" rel="noopener noreferrer">${content}</a>` : `<div class="location-card">${content}</div>`;
}

function renderReplyPreview(message, messageMap) {
  if (!message.replyToId) return '';
  const original = messageMap.get(String(message.replyToId));
  const sender = original?.senderName || 'Original message';
  const summary = original ? messageSummary(original) : 'Message was not included in this export';
  return `<button class="reply-preview" type="button" data-action="jump-to-reply" data-message-id="${escapeAttribute(message.replyToId)}"><strong>${escapeHtml(sender)}</strong><span>${escapeHtml(summary)}</span></button>`;
}

function renderMessage(message, chat, context) {
  if (message.type === 'service' || message.service || message.action) {
    const serviceText = message.service?.text || message.service?.title || message.action || message.text || 'Service event';
    return `<div class="service-message" id="message-${safeId(message.id)}" data-message-id="${escapeAttribute(message.id)}" role="note">${escapeHtml(serviceText)}${message.date ? ` · ${escapeHtml(formatTime(message.date))}` : ''}</div>`;
  }
  const media = Array.isArray(message.media) ? message.media : [];
  const reply = renderReplyPreview(message, context.messageMap);
  const outgoing = message.isOutgoing === true;
  const isHighlighted = String(state.highlightedMessageId) === String(message.id);
  const senderLabel = outgoing ? 'You' : (message.senderName || chat.name || 'Unknown sender');
  const senderKey = message.senderId || message.senderName || senderLabel;
  const senderColor = avatarPalettes[hashString(senderKey) % avatarPalettes.length][0];
  const showIdentity = chatKind(chat) !== 'saved';
  const ariaParts = [senderLabel, formatFullDate(message.date), message.forwardedFrom ? `forwarded from ${message.forwardedFrom}` : '', messageSummary(message)].filter(Boolean).join(', ');
  const reactions = Array.isArray(message.reactions) && message.reactions.length
    ? `<div class="reactions" aria-label="Reactions">${message.reactions.map((reaction) => `<span class="reaction">${escapeHtml(reaction.emoji || reaction.reaction || '❤')} ${Number(reaction.count) > 1 ? escapeHtml(reaction.count) : ''}</span>`).join('')}</div>`
    : '';
  const showAvatarSlot = showIdentity && !outgoing;
  const showAvatar = showAvatarSlot && context.isLastInGroup;
  const showSenderName = showIdentity && !context.joined;
  return `<article class="message-row ${outgoing ? 'is-outgoing' : ''} ${showIdentity ? 'has-sender-identity' : ''} ${context.joined ? 'is-joined' : ''} ${context.isLastInGroup ? 'is-last-in-group' : ''} ${isHighlighted ? 'is-highlighted' : ''}" style="--sender-color:${senderColor}" id="message-${safeId(message.id)}" data-message-id="${escapeAttribute(message.id)}" aria-label="${escapeAttribute(ariaParts)}">
    ${showAvatarSlot ? `<span class="message-avatar-slot">${showAvatar ? renderAvatar(senderLabel, 'xs', '', senderKey) : ''}</span>` : ''}
    <div class="message-bubble" data-message-bubble data-message-id="${escapeAttribute(message.id)}">
      ${showSenderName ? `<div class="sender-name"><span class="sender-dot" aria-hidden="true"></span>${escapeHtml(senderLabel)}</div>` : ''}
      ${message.forwardedFrom ? `<div class="forward-label">Forwarded from<span>${escapeHtml(typeof message.forwardedFrom === 'object' ? message.forwardedFrom.name || message.forwardedFrom.from || 'Unknown' : message.forwardedFrom)}</span></div>` : ''}
      ${reply}
      ${media.map((item, index) => renderSingleMedia(item, message, index)).join('')}
      ${message.poll ? renderPoll(message.poll) : ''}
      ${message.contact ? renderContact(message.contact) : ''}
      ${message.location ? renderLocation(message.location) : ''}
      ${renderMessageText(message)}
      <span class="message-footer"><span class="edited-label">${message.editedAt || message.edited ? 'edited ' : ''}</span>${message.views != null ? `${escapeHtml(compactNumber.format(message.views))} · ` : ''}<time datetime="${escapeAttribute(message.date || '')}">${escapeHtml(formatTime(message.date))}</time>${outgoing ? icon('checks', 'icon-sm') : ''}</span>
      ${reactions}
    </div>
  </article>`;
}

function rangeForChat(chat, reset = false) {
  const key = String(chat.id);
  if (reset || !state.visibleRanges.has(key)) {
    state.visibleRanges.set(key, { start: Math.max(0, chat.messages.length - MESSAGE_BATCH), end: chat.messages.length });
  }
  const range = state.visibleRanges.get(key);
  range.start = Math.max(0, Math.min(range.start, chat.messages.length));
  range.end = Math.max(range.start, Math.min(range.end, chat.messages.length));
  return range;
}

function renderMessageList(chat) {
  if (!chat.messages.length) {
    return `<div class="empty-conversation-card">This chat has no messages in the export.</div>`;
  }
  const range = rangeForChat(chat);
  const visible = chat.messages.slice(range.start, range.end);
  const messageMap = new Map(chat.messages.map((message) => [String(message.id), message]));
  let lastDay = '';
  let html = '';
  if (range.start > 0) {
    html += `<div class="load-earlier-wrap"><button class="load-earlier" type="button" data-action="load-earlier">Load ${Math.min(MESSAGE_BATCH, range.start).toLocaleString()} earlier messages</button></div>`;
  }
  visible.forEach((message, index) => {
    const currentDay = calendarDay(message.date);
    if (currentDay !== lastDay) {
      html += `<time class="date-separator" datetime="${escapeAttribute(currentDay)}">${escapeHtml(formatDayLabel(message.date))}</time>`;
      lastDay = currentDay;
    }
    const previous = visible[index - 1];
    const next = visible[index + 1];
    const joins = (left, right) => {
      if (!left || !right || left.type === 'service' || right.type === 'service') return false;
      const sameSender = String(left.senderId ?? left.senderName ?? '') === String(right.senderId ?? right.senderName ?? '');
      const sameSide = Boolean(left.isOutgoing) === Boolean(right.isOutgoing);
      const leftTime = toDate(left.date)?.getTime() || 0;
      const rightTime = toDate(right.date)?.getTime() || 0;
      return sameSender && sameSide && Math.abs(rightTime - leftTime) <= 5 * 60 * 1000 && calendarDay(left.date) === calendarDay(right.date);
    };
    html += renderMessage(message, chat, {
      messageMap,
      joined: joins(previous, message),
      isLastInGroup: !joins(message, next),
    });
  });
  if (range.end < chat.messages.length) {
    html += `<div class="load-earlier-wrap"><button class="load-earlier" type="button" data-action="load-later">Load later messages</button></div>`;
  }
  return html;
}

function renderInChatSearch() {
  if (!state.inChatSearchOpen) return '';
  const count = state.inChatResults.length;
  const position = count && state.inChatCursor >= 0 ? state.inChatCursor + 1 : 0;
  return `<div class="in-chat-search" role="search">
    <input type="search" placeholder="Search in this chat" value="${escapeAttribute(state.inChatQuery)}" data-in-chat-search autocomplete="off" spellcheck="false" aria-label="Search in this chat" />
    <span class="search-counter" data-chat-search-counter>${position}/${count}</span>
    <button class="icon-button" type="button" aria-label="Previous result" data-action="previous-chat-result" data-chat-search-nav ${count ? '' : 'disabled'}>${icon('arrowUp', 'icon-sm')}</button>
    <button class="icon-button" type="button" aria-label="Next result" data-action="next-chat-result" data-chat-search-nav ${count ? '' : 'disabled'}>${icon('arrowDown', 'icon-sm')}</button>
    <button class="icon-button" type="button" aria-label="Close search" data-action="close-chat-search">${icon('close', 'icon-sm')}</button>
  </div>`;
}

function renderConversation() {
  const chat = getChat();
  if (!chat) {
    return `<section class="conversation empty-conversation"><div class="empty-conversation-card">Choose a conversation from the archive.</div></section>`;
  }
  const first = chat.messages[0];
  const last = lastMessage(chat);
  const detail = chat.messages.length
    ? `${plural(chat.messages.length, 'message')} · ${formatDayLabel(first?.date)} – ${formatDayLabel(last?.date)}`
    : chatKindLabel(chat);
  return `
    <section class="conversation" aria-label="Conversation with ${escapeAttribute(chat.name)}">
      <header class="conversation-header">
        <button class="icon-button mobile-back" type="button" aria-label="Back to chats" data-action="mobile-back">${icon('arrowLeft')}</button>
        ${renderAvatar(chat.name, 'sm')}
        <button class="chat-heading" type="button" data-action="toggle-info" aria-label="Open chat details">
          <strong>${escapeHtml(chat.name)}</strong>
          <span>${escapeHtml(detail)}</span>
        </button>
        <div class="conversation-actions">
          <button class="icon-button" type="button" aria-label="Search this chat" data-action="open-chat-search" aria-pressed="${state.inChatSearchOpen}">${icon('search')}</button>
          <button class="icon-button" type="button" aria-label="Jump to date" data-action="open-date-jump">${icon('calendar')}</button>
          <button class="icon-button" type="button" aria-label="Chat details" data-action="toggle-info" aria-pressed="${state.infoOpen}">${icon('info')}</button>
        </div>
      </header>
      ${renderInChatSearch()}
      <div class="message-scroller" data-message-scroller>
        <div class="message-stage">${renderMessageList(chat)}</div>
      </div>
      <footer class="archive-bar"><div class="read-only-field">${icon('lock')} Read-only archive · messages cannot be sent or changed</div></footer>
      <button class="jump-latest" type="button" aria-label="Jump to latest message" data-action="jump-latest" hidden>${icon('arrowDown')}</button>
    </section>`;
}

function collectShared(chat) {
  const items = { media: [], files: [], links: [], audio: [] };
  for (const message of chat?.messages || []) {
    for (let index = 0; index < (message.media || []).length; index += 1) {
      const media = message.media[index];
      const kind = mediaKind(media);
      const item = { media, message, index };
      if (['photo', 'video', 'sticker', 'animation'].includes(kind)) items.media.push(item);
      if (kind === 'file') items.files.push(item);
      if (['link'].includes(kind)) items.links.push(item);
      if (['voice', 'audio'].includes(kind)) items.audio.push(item);
    }
    const urlMatches = String(message.text || '').match(/https?:\/\/[^\s<]+/giu) || [];
    for (const url of urlMatches) {
      if (!items.links.some((item) => item.media?.url === url)) {
        items.links.push({ media: { type: 'link', url, title: url }, message, index: -1 });
      }
    }
  }
  return items;
}

function renderSharedContent(chat) {
  const shared = collectShared(chat);
  const selected = shared[state.sharedTab] || [];
  if (state.sharedTab === 'media') {
    if (!selected.length) return `<div class="shared-empty">No photos or videos were included in this export.</div>`;
    return `<div class="shared-grid">${selected.slice(-30).reverse().map(({ media, message, index }) => {
      const path = media.path || media.file || media.filePath || media.photo || media.thumbnail || '';
      if (media.demoGradient) return `<button class="media-photo is-placeholder" type="button" data-action="open-media" data-chat-id="${escapeAttribute(chat.id)}" data-message-id="${escapeAttribute(message.id)}" data-media-index="${index}" aria-label="Open media">${icon('image')}</button>`;
      return path
        ? `<button type="button" data-action="open-media" data-chat-id="${escapeAttribute(chat.id)}" data-message-id="${escapeAttribute(message.id)}" data-media-index="${index}" aria-label="Open media"><img data-asset-path="${escapeAttribute(path)}" alt="Shared media" loading="lazy" /></button>`
        : `<button type="button" data-action="jump-message" data-message-id="${escapeAttribute(message.id)}" aria-label="Missing media">${icon('image')}</button>`;
    }).join('')}</div>`;
  }
  if (!selected.length) return `<div class="shared-empty">No ${state.sharedTab} were included in this export.</div>`;
  return `<div class="shared-list">${selected.slice(-40).reverse().map(({ media, message }) => {
    if (state.sharedTab === 'links') {
      const href = safeHref(media.url || media.path);
      return `<a class="shared-list-row" href="${escapeAttribute(href)}" target="_blank" rel="noopener noreferrer">${icon('link')}<span><strong>${escapeHtml(media.title || media.url || 'Link')}</strong><small>${escapeHtml(formatFullDate(message.date))}</small></span></a>`;
    }
    const path = media.path || media.file || media.filePath || '';
    const name = media.fileName || path.split('/').pop() || (state.sharedTab === 'audio' ? 'Audio' : 'File');
    return `<button class="shared-list-row" type="button" data-action="jump-message" data-message-id="${escapeAttribute(message.id)}">${icon(state.sharedTab === 'audio' ? 'mic' : 'file')}<span><strong>${escapeHtml(name)}</strong><small>${escapeHtml([formatBytes(media.size), formatFullDate(message.date)].filter(Boolean).join(' · '))}</small></span></button>`;
  }).join('')}</div>`;
}

function renderInfoPanel() {
  if (!state.infoOpen) return '';
  const chat = getChat();
  if (!chat) return '';
  const shared = collectShared(chat);
  const participants = new Set(chat.messages.map((message) => message.senderId || message.senderName).filter(Boolean));
  const first = chat.messages[0];
  const last = lastMessage(chat);
  return `<aside class="info-panel" aria-label="Chat details">
    <header class="info-header"><strong>Chat info</strong><button class="icon-button" type="button" aria-label="Close chat details" data-action="close-info">${icon('close')}</button></header>
    <div class="info-scroll">
      <section class="info-profile">${renderAvatar(chat.name)}<h2>${escapeHtml(chat.name)}</h2><p>${escapeHtml(chatKindLabel(chat))}</p></section>
      <section class="info-section">
        <h3>Archive summary</h3>
        <div class="stat-row">${icon('message')}<span>Messages</span><strong>${chat.messages.length.toLocaleString()}</strong></div>
        ${chatKind(chat) === 'group' ? `<div class="stat-row">${icon('group')}<span>Visible senders</span><strong>${participants.size.toLocaleString()}</strong></div>` : ''}
        <div class="stat-row">${icon('calendar')}<span>First message</span><strong>${escapeHtml(first ? formatListDate(first.date) : '—')}</strong></div>
        <div class="stat-row">${icon('calendar')}<span>Latest message</span><strong>${escapeHtml(last ? formatListDate(last.date) : '—')}</strong></div>
      </section>
      <section class="info-section">
        <h3>Shared content</h3>
        <div class="shared-tabs">
          ${[['media', `Media ${shared.media.length}`], ['files', `Files ${shared.files.length}`], ['links', `Links ${shared.links.length}`], ['audio', `Audio ${shared.audio.length}`]].map(([key, label]) => `<button class="shared-tab ${state.sharedTab === key ? 'is-active' : ''}" type="button" data-action="set-shared-tab" data-tab="${key}">${label}</button>`).join('')}
        </div>
        ${renderSharedContent(chat)}
      </section>
    </div>
  </aside>`;
}

function renderSettingsModal() {
  const stats = state.archive?.stats || {};
  const warningHtml = state.archive?.warnings?.length
    ? `<div class="warning-box"><strong>${plural(state.archive.warnings.length, 'import warning')}</strong><br />${state.archive.warnings.slice(0, 4).map((warning) => escapeHtml(typeof warning === 'string' ? warning : warning.message || JSON.stringify(warning))).join('<br />')}</div>`
    : '';
  return `<div class="modal-backdrop" data-action="close-overlay" role="presentation">
    <section class="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" data-modal>
      <header class="modal-header"><h2 id="settings-title">Archive settings</h2><button class="icon-button" type="button" aria-label="Close settings" data-action="close-overlay">${icon('close')}</button></header>
      <div class="modal-body">
        ${warningHtml}
        <div class="settings-row">${icon('moon')}<span class="settings-copy"><strong>Appearance</strong><span>Use your system theme or choose one.</span></span><span class="segmented">${['system', 'light', 'dark'].map((theme) => `<button class="${state.theme === theme ? 'is-active' : ''}" type="button" data-action="set-theme" data-theme="${theme}">${theme[0].toUpperCase() + theme.slice(1)}</button>`).join('')}</span></div>
        <div class="settings-row">${icon('text')}<span class="settings-copy"><strong>Text size</strong><span>Change chat and interface size.</span></span><span class="segmented">${[['compact', 'S'], ['comfortable', 'M'], ['large', 'L']].map(([size, label]) => `<button class="${state.textSize === size ? 'is-active' : ''}" type="button" data-action="set-text-size" data-size="${size}">${label}</button>`).join('')}</span></div>
        <div class="settings-row">${icon('calendar')}<span class="settings-copy"><strong>Time format</strong><span>Display exported message times.</span></span><span class="segmented"><button class="${!state.twelveHour ? 'is-active' : ''}" type="button" data-action="set-time-format" data-format="24">24h</button><button class="${state.twelveHour ? 'is-active' : ''}" type="button" data-action="set-time-format" data-format="12">12h</button></span></div>
        <div class="modal-divider"></div>
        <div class="archive-summary"><strong>${escapeHtml(state.archive?.title || 'Telegram archive')}</strong><br />${plural(stats.chats || 0, 'chat')} · ${plural(stats.messages || 0, 'message')}<br />${stats.firstDate ? `${escapeHtml(formatFullDate(stats.firstDate))} → ${escapeHtml(formatFullDate(stats.lastDate))}` : 'No dated messages'}<br />Format: ${escapeHtml(state.archive?.format || 'Telegram export')}</div>
        <div class="modal-actions"><button class="secondary-button" type="button" data-action="show-shortcuts">${icon('keyboard')} Shortcuts</button><button class="primary-button" type="button" data-action="open-another">${icon('folder')} Open another</button></div>
        ${state.recentHandle ? `<div class="modal-actions"><button class="quiet-button" type="button" data-action="forget-archive">Forget remembered folder</button></div>` : ''}
      </div>
    </section>
  </div>`;
}

function renderDateModal() {
  const chat = getChat();
  const first = chat?.messages?.[0]?.date;
  const last = chat?.messages?.at(-1)?.date;
  return `<div class="modal-backdrop" data-action="close-overlay"><section class="modal modal-small" role="dialog" aria-modal="true" aria-labelledby="date-title" data-modal>
    <header class="modal-header"><h2 id="date-title">Jump to date</h2><button class="icon-button" type="button" aria-label="Close" data-action="close-overlay">${icon('close')}</button></header>
    <div class="modal-body"><p class="modal-copy">Choose a date in this exported conversation.</p><input class="date-input" type="date" data-jump-date min="${escapeAttribute(calendarDay(first))}" max="${escapeAttribute(calendarDay(last))}" value="${escapeAttribute(calendarDay(last))}" /><div class="modal-actions"><button class="secondary-button" type="button" data-action="close-overlay">Cancel</button><button class="primary-button" type="button" data-action="jump-to-date">Jump</button></div></div>
  </section></div>`;
}

function renderShortcutsModal() {
  const shortcuts = [
    ['⌘ / Ctrl + K', 'Search all chats'],
    ['/', 'Search the open chat'],
    ['Alt + ↑ / ↓', 'Previous or next chat'],
    ['End', 'Jump to latest message'],
    ['[ / ]', 'Previous or next open media'],
    ['Esc', 'Close or clear the current view'],
    ['?', 'Show this shortcut list'],
  ];
  return `<div class="modal-backdrop" data-action="close-overlay"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title" data-modal><header class="modal-header"><h2 id="shortcuts-title">Keyboard shortcuts</h2><button class="icon-button" type="button" aria-label="Close" data-action="close-overlay">${icon('close')}</button></header><div class="modal-body"><div class="shortcut-list">${shortcuts.map(([keys, label]) => `<div class="shortcut-row"><kbd>${escapeHtml(keys)}</kbd><span>${escapeHtml(label)}</span></div>`).join('')}</div></div></section></div>`;
}

function renderRawModal(message) {
  return `<div class="modal-backdrop" data-action="close-overlay"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="raw-title" data-modal><header class="modal-header"><h2 id="raw-title">Message details</h2><button class="icon-button" type="button" aria-label="Close" data-action="close-overlay">${icon('close')}</button></header><div class="modal-body"><pre class="raw-details"><code>${escapeHtml(JSON.stringify(message, (key, value) => key.startsWith('_') ? undefined : value, 2))}</code></pre></div></section></div>`;
}

function renderLightbox() {
  const item = state.overlay;
  if (!item?.message) return '';
  const media = item.media;
  const kind = mediaKind(media);
  const content = media.demoGradient
    ? `<div class="lightbox-demo">${icon('image', 'icon-lg')}<span>Demo photo</span></div>`
    : item.url
      ? (kind === 'video' ? `<video src="${escapeAttribute(item.url)}" controls autoplay="false"></video>` : `<img src="${escapeAttribute(item.url)}" alt="${escapeAttribute(media.fileName || 'Media preview')}" />`)
      : renderMediaUnavailable('This media was not included in the export', media.path || '');
  return `<div class="lightbox" role="dialog" aria-modal="true" aria-label="Media viewer">
    <header class="lightbox-header"><div class="lightbox-title"><strong>${escapeHtml(item.message.senderName || getChat(item.chatId)?.name || 'Media')}</strong><span>${escapeHtml(formatFullDate(item.message.date))}</span></div>${item.url ? `<a class="icon-button" href="${escapeAttribute(item.url)}" download="${escapeAttribute(media.fileName || 'telegram-media')}" aria-label="Download media">${icon('download')}</a>` : ''}<button class="icon-button" type="button" data-action="close-overlay" aria-label="Close media">${icon('close')}</button></header>
    <div class="lightbox-content">${content}<button class="lightbox-nav previous" type="button" aria-label="Previous media" data-action="previous-media">${icon('chevronLeft', 'icon-lg')}</button><button class="lightbox-nav next" type="button" aria-label="Next media" data-action="next-media">${icon('chevronRight', 'icon-lg')}</button></div>
    <footer class="lightbox-footer"><button class="quiet-button" type="button" data-action="lightbox-jump">Jump to message</button>${item.message.text ? `<span>${escapeHtml(messageSummary(item.message))}</span>` : ''}</footer>
  </div>`;
}

function renderOverlay() {
  if (!state.overlay) return '';
  if (state.overlay.kind === 'settings') return renderSettingsModal();
  if (state.overlay.kind === 'date') return renderDateModal();
  if (state.overlay.kind === 'shortcuts') return renderShortcutsModal();
  if (state.overlay.kind === 'raw') return renderRawModal(state.overlay.message);
  if (state.overlay.kind === 'lightbox') return renderLightbox();
  return '';
}

function renderContextMenu() {
  if (!state.contextMenu) return '';
  const { x, y, messageId } = state.contextMenu;
  return `<div class="message-context-menu" style="left:${x}px;top:${y}px" role="menu" data-context-menu>
    <button class="context-action" type="button" role="menuitem" data-action="copy-message" data-message-id="${escapeAttribute(messageId)}">${icon('copy', 'icon-sm')} Copy text</button>
    <button class="context-action" type="button" role="menuitem" data-action="copy-timestamp" data-message-id="${escapeAttribute(messageId)}">${icon('calendar', 'icon-sm')} Copy date & time</button>
    <button class="context-action" type="button" role="menuitem" data-action="copy-message-link" data-message-id="${escapeAttribute(messageId)}">${icon('link', 'icon-sm')} Copy local link</button>
    <button class="context-action" type="button" role="menuitem" data-action="show-message-details" data-message-id="${escapeAttribute(messageId)}">${icon('info', 'icon-sm')} Message details</button>
  </div>`;
}

function renderViewer(options = {}) {
  if (!state.archive) return renderWelcome();
  state.screen = 'viewer';
  const previousScroller = document.querySelector('[data-message-scroller]');
  const previousScroll = options.preserveScroll && previousScroller
    ? { top: previousScroller.scrollTop, height: previousScroller.scrollHeight }
    : null;
  app.innerHTML = `<main class="app-shell ${state.infoOpen ? 'info-open' : ''} ${state.mobileChatOpen ? 'mobile-chat-open' : ''}">${renderSidebar()}${renderConversation()}${renderInfoPanel()}</main>${renderOverlay()}${renderContextMenu()}`;
  hydrateMedia();
  attachScroller(previousScroll, options.preserveFromTop);
  if (state.inChatSearchOpen && options.focusChatSearch) {
    requestAnimationFrame(() => document.querySelector('[data-in-chat-search]')?.focus());
  }
  if (options.focusGlobalSearch) {
    requestAnimationFrame(() => document.querySelector('[data-global-search]')?.focus());
  }
}

async function hydrateMedia() {
  if (!state.resolver) return;
  const targets = Array.from(document.querySelectorAll('[data-asset-path]:not([data-asset-state])'));
  await Promise.all(targets.map(async (element) => {
    element.dataset.assetState = 'loading';
    const path = element.dataset.assetPath;
    try {
      const url = await state.resolver.getUrl(path);
      if (!element.isConnected) return;
      if (!url) {
        element.dataset.assetState = 'missing';
        if (element.matches('img')) {
          const container = element.closest('.media-block, .shared-grid button');
          if (container?.classList.contains('media-block')) container.innerHTML = renderMediaUnavailable('Media was not included', path);
          else element.alt = 'Media not included';
        }
        return;
      }
      if (element.matches('a')) element.href = url;
      else element.src = url;
      element.dataset.assetState = 'ready';
    } catch {
      if (element.isConnected) element.dataset.assetState = 'missing';
    }
  }));
}

function attachScroller(previousScroll = null, preserveFromTop = false) {
  const scroller = document.querySelector('[data-message-scroller]');
  if (!scroller) return;
  if (previousScroll) {
    if (preserveFromTop) scroller.scrollTop = scroller.scrollHeight - previousScroll.height + previousScroll.top;
    else scroller.scrollTop = previousScroll.top;
  } else {
    const saved = state.scrollPositions.get(String(state.selectedChatId));
    if (saved != null) scroller.scrollTop = saved;
  }
  const updateJumpButton = () => {
    const distance = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
    const jump = document.querySelector('.jump-latest');
    if (jump) jump.hidden = distance < 320;
    state.scrollPositions.set(String(state.selectedChatId), scroller.scrollTop);
  };
  scroller.addEventListener('scroll', updateJumpButton, { passive: true });
  requestAnimationFrame(updateJumpButton);
}

function scrollToLatest(smooth = true) {
  const chat = getChat();
  if (!chat) return;
  state.visibleRanges.set(String(chat.id), { start: Math.max(0, chat.messages.length - MESSAGE_BATCH), end: chat.messages.length });
  const currentRange = rangeForChat(chat);
  const alreadyLatest = currentRange.end === chat.messages.length && document.querySelector(`[data-message-id="${CSS.escape(String(lastMessage(chat)?.id || ''))}"]`);
  if (!alreadyLatest) renderViewer();
  requestAnimationFrame(() => {
    const scroller = document.querySelector('[data-message-scroller]');
    scroller?.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  });
}

function rememberCurrentScroll() {
  const scroller = document.querySelector('[data-message-scroller]');
  if (scroller && state.selectedChatId != null) state.scrollPositions.set(String(state.selectedChatId), scroller.scrollTop);
}

function selectChat(chatId, options = {}) {
  const chat = getChat(chatId);
  if (!chat) return;
  rememberCurrentScroll();
  const changed = String(state.selectedChatId) !== String(chat.id);
  state.selectedChatId = chat.id;
  state.mobileChatOpen = true;
  state.infoOpen = false;
  state.sharedTab = 'media';
  state.contextMenu = null;
  if (changed) {
    state.inChatSearchOpen = false;
    state.inChatQuery = '';
    state.inChatResults = [];
    state.inChatCursor = -1;
  }
  renderViewer();
  const saved = state.scrollPositions.get(String(chat.id));
  if (saved == null || options.latest) requestAnimationFrame(() => scrollToLatest(false));
}

function runGlobalSearch(query, { fromInput = false } = {}) {
  const input = document.querySelector('[data-global-search]');
  if (fromInput && input && input.value !== query) return;
  if (!fromInput && input && input.value !== query) input.value = query;
  state.globalQuery = query;
  state.globalResultCursor = -1;
  if (!query.trim()) {
    state.globalSearchResponse = null;
  } else {
    try {
      state.globalSearchResponse = state.searchIndex.search(query, { limit: 240, sort: 'relevance' });
    } catch (error) {
      state.globalSearchResponse = { total: 0, results: [], parsedQuery: { errors: [error.message] } };
    }
  }
  const sidebarContent = document.querySelector('[data-sidebar-content]');
  if (sidebarContent) {
    sidebarContent.innerHTML = renderSidebarList();
    const filterTabs = document.querySelector('[data-filter-tabs]');
    const clearButton = document.querySelector('[data-action="clear-global-search"]');
    if (filterTabs) filterTabs.hidden = Boolean(query.trim());
    if (clearButton) clearButton.hidden = !query;
  } else {
    renderViewer({ focusGlobalSearch: true });
  }
}

function runInChatSearch(query, jump = false) {
  const input = document.querySelector('[data-in-chat-search]');
  if (input && input.value !== query) return;
  state.inChatQuery = query;
  if (!query.trim() || !state.selectedChatId) {
    state.inChatResults = [];
    state.inChatCursor = -1;
  } else {
    try {
      const response = state.searchIndex.searchChat(state.selectedChatId, query, { limit: 2000, sort: 'date-desc' });
      state.inChatResults = response.results;
      state.inChatCursor = response.results.length ? 0 : -1;
    } catch {
      state.inChatResults = [];
      state.inChatCursor = -1;
    }
  }
  updateInChatSearchChrome();
  if (jump && state.inChatCursor >= 0) openCurrentChatResult();
  else refreshMessageStage({ preserveScroll: true });
}

function openCurrentChatResult() {
  const result = state.inChatResults[state.inChatCursor];
  if (result) revealMessageInPlace(result.id);
}

function moveChatSearchResult(direction) {
  if (!state.inChatResults.length) return;
  state.inChatCursor = (state.inChatCursor + direction + state.inChatResults.length) % state.inChatResults.length;
  const result = state.inChatResults[state.inChatCursor];
  updateInChatSearchChrome();
  revealMessageInPlace(result.id);
}

function updateInChatSearchChrome() {
  const count = state.inChatResults.length;
  const position = count && state.inChatCursor >= 0 ? state.inChatCursor + 1 : 0;
  const counter = document.querySelector('[data-chat-search-counter]');
  if (counter) counter.textContent = `${position}/${count}`;
  document.querySelectorAll('[data-chat-search-nav]').forEach((button) => {
    button.disabled = !count;
  });
}

function refreshMessageStage({ preserveScroll = false } = {}) {
  const stage = document.querySelector('.message-stage');
  const scroller = document.querySelector('[data-message-scroller]');
  const chat = getChat();
  if (!stage || !chat) return false;
  const previousTop = scroller?.scrollTop || 0;
  stage.innerHTML = renderMessageList(chat);
  if (preserveScroll && scroller) scroller.scrollTop = previousTop;
  hydrateMedia();
  return true;
}

function revealMessageInPlace(messageId) {
  const chat = getChat();
  if (!chat) return;
  const index = chat.messages.findIndex((message) => String(message.id) === String(messageId));
  if (index < 0) return;
  state.visibleRanges.set(String(chat.id), {
    start: Math.max(0, index - 65),
    end: Math.min(chat.messages.length, index + 115),
  });
  state.highlightedMessageId = String(messageId);
  if (!refreshMessageStage()) {
    jumpToMessage(messageId, { keepSearchFocus: true });
    return;
  }
  requestAnimationFrame(() => {
    document.getElementById(`message-${safeId(messageId)}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => {
      if (String(state.highlightedMessageId) === String(messageId)) state.highlightedMessageId = null;
    }, 1800);
  });
}

function findMessage(messageId, chat = getChat()) {
  return chat?.messages?.find((message) => String(message.id) === String(messageId)) || null;
}

function jumpToMessage(messageId, options = {}) {
  const chat = getChat();
  if (!chat) return;
  const index = chat.messages.findIndex((message) => String(message.id) === String(messageId));
  if (index < 0) {
    toast('The referenced message was not included in this export.');
    return;
  }
  state.visibleRanges.set(String(chat.id), {
    start: Math.max(0, index - 65),
    end: Math.min(chat.messages.length, index + 115),
  });
  state.highlightedMessageId = String(messageId);
  renderViewer({ focusChatSearch: options.keepSearchFocus });
  requestAnimationFrame(() => {
    document.getElementById(`message-${safeId(messageId)}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => {
      if (String(state.highlightedMessageId) === String(messageId)) state.highlightedMessageId = null;
    }, 1800);
  });
}

function openSearchResult(chatId, messageId) {
  const chat = getChat(chatId);
  if (!chat) return;
  state.selectedChatId = chat.id;
  state.mobileChatOpen = true;
  state.infoOpen = false;
  const index = chat.messages.findIndex((message) => String(message.id) === String(messageId));
  if (index >= 0) {
    state.visibleRanges.set(String(chat.id), { start: Math.max(0, index - 65), end: Math.min(chat.messages.length, index + 115) });
    state.highlightedMessageId = String(messageId);
  }
  renderViewer();
  requestAnimationFrame(() => document.getElementById(`message-${safeId(messageId)}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
}

function jumpToDate(dateValue) {
  const chat = getChat();
  if (!chat || !dateValue) return;
  const target = new Date(`${dateValue}T00:00:00`);
  const index = chat.messages.findIndex((message) => (toDate(message.date)?.getTime() || 0) >= target.getTime());
  state.overlay = null;
  if (index < 0) {
    scrollToLatest();
    return;
  }
  jumpToMessage(chat.messages[index].id);
}

function loadEarlier() {
  const chat = getChat();
  if (!chat) return;
  const range = rangeForChat(chat);
  range.start = Math.max(0, range.start - MESSAGE_BATCH);
  renderViewer({ preserveScroll: true, preserveFromTop: true });
}

function loadLater() {
  const chat = getChat();
  if (!chat) return;
  const range = rangeForChat(chat);
  range.end = Math.min(chat.messages.length, range.end + MESSAGE_BATCH);
  renderViewer({ preserveScroll: true });
}

async function openMedia(chatId, messageId, mediaIndex) {
  const chat = getChat(chatId);
  const message = findMessage(messageId, chat);
  const media = message?.media?.[Number(mediaIndex)];
  if (!chat || !message || !media) return;
  state.overlay = { kind: 'lightbox', chatId: chat.id, message, media, mediaIndex: Number(mediaIndex), url: null };
  renderViewer();
  const path = media.path || media.file || media.filePath || media.photo || '';
  if (path && state.resolver) {
    const url = await state.resolver.getUrl(path);
    if (state.overlay?.kind === 'lightbox' && String(state.overlay.message.id) === String(message.id) && state.overlay.mediaIndex === Number(mediaIndex)) {
      state.overlay.url = url;
      renderViewer();
    }
  }
}

function allPreviewableMedia(chat = getChat()) {
  return collectShared(chat).media;
}

function moveLightbox(direction) {
  if (state.overlay?.kind !== 'lightbox') return;
  const chat = getChat(state.overlay.chatId);
  const items = allPreviewableMedia(chat);
  const current = items.findIndex(({ message, index }) => String(message.id) === String(state.overlay.message.id) && index === state.overlay.mediaIndex);
  if (!items.length || current < 0) return;
  const next = items[(current + direction + items.length) % items.length];
  openMedia(chat.id, next.message.id, next.index);
}

async function copyText(text, confirmation = 'Copied') {
  try {
    await navigator.clipboard.writeText(String(text || ''));
    toast(confirmation);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = String(text || '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
    toast(confirmation);
  }
}

function openFolderPicker() {
  if (!supportsDirectoryPicker()) {
    folderInput.click();
    return;
  }
  chooseArchiveFolder()
    .then((source) => source && openArchiveSource(source))
    .catch((error) => {
      if (error?.name !== 'AbortError') toast(error?.message || 'The folder could not be opened.');
    });
}

function refreshPreferenceModal() {
  if (state.overlay) renderViewer();
}

async function handleAction(target, event) {
  const action = target.dataset.action;
  if (!action) return;
  if (action === 'close-overlay' && event.target.closest('[data-modal]') && !event.target.closest('button[data-action="close-overlay"]')) return;
  if (action !== 'reveal-spoiler') event.preventDefault();

  switch (action) {
    case 'open-folder':
    case 'open-another':
      state.overlay = null;
      openFolderPicker();
      break;
    case 'open-demo': openDemo(); break;
    case 'open-recent': {
      renderLoading('Requesting access to the remembered folder…', 12);
      try {
        const source = await reopenRememberedDirectory(state.recentHandle);
        if (source) await openArchiveSource(source);
        else renderWelcome('Folder access was not granted. You can choose it again.');
      } catch (error) {
        renderWelcome(error?.message || 'The remembered folder is no longer available.');
      }
      break;
    }
    case 'cancel-loading':
      ++state.loadingToken;
      renderWelcome();
      break;
    case 'select-chat': selectChat(target.dataset.chatId); break;
    case 'mobile-back':
      rememberCurrentScroll();
      state.mobileChatOpen = false;
      state.infoOpen = false;
      renderViewer();
      break;
    case 'filter-chats':
      state.chatFilter = target.dataset.filter || 'all';
      renderViewer();
      break;
    case 'clear-global-search':
      runGlobalSearch('');
      document.querySelector('[data-global-search]')?.focus();
      break;
    case 'open-search-result': openSearchResult(target.dataset.chatId, target.dataset.messageId); break;
    case 'open-chat-search':
      state.inChatSearchOpen = true;
      renderViewer({ focusChatSearch: true, preserveScroll: true });
      break;
    case 'close-chat-search':
      state.inChatSearchOpen = false;
      state.inChatQuery = '';
      state.inChatResults = [];
      state.inChatCursor = -1;
      renderViewer({ preserveScroll: true });
      break;
    case 'previous-chat-result': moveChatSearchResult(1); break;
    case 'next-chat-result': moveChatSearchResult(-1); break;
    case 'jump-to-reply':
    case 'jump-message': jumpToMessage(target.dataset.messageId); break;
    case 'load-earlier': loadEarlier(); break;
    case 'load-later': loadLater(); break;
    case 'jump-latest': scrollToLatest(); break;
    case 'toggle-info':
      state.infoOpen = !state.infoOpen;
      renderViewer({ preserveScroll: true });
      break;
    case 'close-info':
      state.infoOpen = false;
      renderViewer({ preserveScroll: true });
      break;
    case 'set-shared-tab':
      state.sharedTab = target.dataset.tab || 'media';
      renderViewer({ preserveScroll: true });
      break;
    case 'open-settings':
      state.overlay = { kind: 'settings' };
      renderViewer({ preserveScroll: true });
      break;
    case 'open-date-jump':
      state.overlay = { kind: 'date' };
      renderViewer({ preserveScroll: true });
      requestAnimationFrame(() => document.querySelector('[data-jump-date]')?.focus());
      break;
    case 'jump-to-date': jumpToDate(document.querySelector('[data-jump-date]')?.value); break;
    case 'close-overlay':
      state.overlay = null;
      renderViewer({ preserveScroll: true });
      break;
    case 'set-theme': setTheme(target.dataset.theme); refreshPreferenceModal(); break;
    case 'set-text-size': setTextSize(target.dataset.size); refreshPreferenceModal(); break;
    case 'set-time-format':
      state.twelveHour = target.dataset.format === '12';
      localStorage.setItem('teleview:time-format', state.twelveHour ? '12' : '24');
      refreshPreferenceModal();
      break;
    case 'show-shortcuts':
      state.overlay = { kind: 'shortcuts' };
      renderViewer({ preserveScroll: true });
      break;
    case 'forget-archive':
      await forgetRememberedDirectory();
      state.recentHandle = null;
      state.rememberFolder = false;
      localStorage.setItem('teleview:remember-folder', 'false');
      toast('Remembered folder removed. The export itself was untouched.');
      refreshPreferenceModal();
      break;
    case 'open-media': openMedia(target.dataset.chatId, target.dataset.messageId, target.dataset.mediaIndex); break;
    case 'previous-media': moveLightbox(-1); break;
    case 'next-media': moveLightbox(1); break;
    case 'lightbox-jump': {
      const overlay = state.overlay;
      state.overlay = null;
      if (overlay?.chatId) {
        state.selectedChatId = overlay.chatId;
        state.mobileChatOpen = true;
        jumpToMessage(overlay.message.id);
      }
      break;
    }
    case 'reveal-spoiler':
      target.classList.toggle('is-revealed');
      target.setAttribute('aria-label', target.classList.contains('is-revealed') ? 'Hide spoiler text' : 'Reveal hidden text');
      break;
    case 'copy-message': {
      const message = findMessage(target.dataset.messageId);
      copyText(message?.text || messageSummary(message), 'Message copied');
      state.contextMenu = null;
      renderViewer({ preserveScroll: true });
      break;
    }
    case 'copy-timestamp': {
      const message = findMessage(target.dataset.messageId);
      copyText(formatFullDate(message?.date), 'Timestamp copied');
      state.contextMenu = null;
      renderViewer({ preserveScroll: true });
      break;
    }
    case 'copy-message-link': {
      const link = `${location.href.split('#')[0]}#chat=${encodeURIComponent(state.selectedChatId)}&message=${encodeURIComponent(target.dataset.messageId)}`;
      copyText(link, 'Local message link copied');
      state.contextMenu = null;
      renderViewer({ preserveScroll: true });
      break;
    }
    case 'show-message-details': {
      const message = findMessage(target.dataset.messageId);
      state.contextMenu = null;
      state.overlay = { kind: 'raw', message };
      renderViewer({ preserveScroll: true });
      break;
    }
  }
}

let globalSearchTimer;
let chatSearchTimer;

app.addEventListener('click', (event) => {
  const actionTarget = event.target.closest('[data-action]');
  if (actionTarget) handleAction(actionTarget, event);
  else if (state.contextMenu) {
    state.contextMenu = null;
    renderViewer({ preserveScroll: true });
  }
});

app.addEventListener('input', (event) => {
  if (event.target.matches('[data-global-search]')) {
    if (event.isComposing) return;
    clearTimeout(globalSearchTimer);
    const query = event.target.value;
    globalSearchTimer = setTimeout(() => runGlobalSearch(query, { fromInput: true }), 90);
  }
  if (event.target.matches('[data-in-chat-search]')) {
    if (event.isComposing) return;
    clearTimeout(chatSearchTimer);
    const query = event.target.value;
    chatSearchTimer = setTimeout(() => runInChatSearch(query, true), 100);
  }
});

app.addEventListener('change', (event) => {
  if (event.target.matches('[data-action="remember-choice"]')) {
    state.rememberFolder = event.target.checked;
    localStorage.setItem('teleview:remember-folder', String(state.rememberFolder));
  }
});

app.addEventListener('keydown', (event) => {
  if (event.target.matches('[data-in-chat-search]') && event.key === 'Enter') {
    event.preventDefault();
    moveChatSearchResult(event.shiftKey ? 1 : -1);
  }
});

app.addEventListener('contextmenu', (event) => {
  const bubble = event.target.closest('[data-message-bubble]');
  if (!bubble || state.screen !== 'viewer') return;
  event.preventDefault();
  const width = 190;
  const height = 176;
  state.contextMenu = {
    messageId: bubble.dataset.messageId,
    x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
    y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)),
  };
  renderViewer({ preserveScroll: true });
});

folderInput.addEventListener('change', () => {
  if (!folderInput.files?.length) return;
  const source = entriesFromFileList(folderInput.files);
  folderInput.value = '';
  openArchiveSource(source);
});

let dragDepth = 0;
document.addEventListener('dragenter', (event) => {
  if (!event.dataTransfer?.types?.includes('Files') || state.screen !== 'welcome') return;
  event.preventDefault();
  dragDepth += 1;
  document.querySelector('[data-drop-zone]')?.classList.add('is-dragging');
});

document.addEventListener('dragover', (event) => {
  if (event.dataTransfer?.types?.includes('Files') && state.screen === 'welcome') event.preventDefault();
});

document.addEventListener('dragleave', (event) => {
  if (state.screen !== 'welcome') return;
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.querySelector('[data-drop-zone]')?.classList.remove('is-dragging');
});

document.addEventListener('drop', async (event) => {
  if (state.screen !== 'welcome') return;
  event.preventDefault();
  dragDepth = 0;
  document.querySelector('[data-drop-zone]')?.classList.remove('is-dragging');
  try {
    const source = await entriesFromDrop(event.dataTransfer);
    await openArchiveSource(source);
  } catch (error) {
    renderWelcome(error?.message || 'That folder could not be read.');
  }
});

document.addEventListener('keydown', (event) => {
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
  if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k') {
    event.preventDefault();
    if (state.screen === 'viewer') {
      state.mobileChatOpen = false;
      renderViewer({ focusGlobalSearch: true, preserveScroll: true });
    }
    return;
  }
  if (event.key === 'Escape') {
    if (state.overlay) {
      state.overlay = null;
      renderViewer({ preserveScroll: true });
    } else if (state.contextMenu) {
      state.contextMenu = null;
      renderViewer({ preserveScroll: true });
    } else if (state.inChatSearchOpen) {
      state.inChatSearchOpen = false;
      state.inChatQuery = '';
      state.inChatResults = [];
      renderViewer({ preserveScroll: true });
    } else if (state.globalQuery) {
      runGlobalSearch('');
    } else if (state.mobileChatOpen && matchMedia('(max-width: 820px)').matches) {
      state.mobileChatOpen = false;
      renderViewer();
    }
    return;
  }
  if (typing || state.screen !== 'viewer') return;
  if (event.key === '/') {
    event.preventDefault();
    state.inChatSearchOpen = true;
    renderViewer({ focusChatSearch: true, preserveScroll: true });
  } else if (event.key === '?') {
    event.preventDefault();
    state.overlay = { kind: 'shortcuts' };
    renderViewer({ preserveScroll: true });
  } else if (event.key === 'End') {
    event.preventDefault();
    scrollToLatest();
  } else if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
    event.preventDefault();
    const chats = visibleChats();
    const current = chats.findIndex((chat) => String(chat.id) === String(state.selectedChatId));
    const next = event.key === 'ArrowDown' ? Math.min(chats.length - 1, current + 1) : Math.max(0, current - 1);
    if (chats[next]) selectChat(chats[next].id);
  } else if (state.overlay?.kind === 'lightbox' && event.key === '[') {
    moveLightbox(-1);
  } else if (state.overlay?.kind === 'lightbox' && event.key === ']') {
    moveLightbox(1);
  }
});

matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  if (state.theme === 'system') applyPreferences();
});

async function initialize() {
  applyPreferences();
  renderWelcome();
  state.recentHandle = await getRememberedDirectory();
  if (state.screen === 'welcome') renderWelcome();
}

initialize();
