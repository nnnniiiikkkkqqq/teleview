const DB_NAME = 'teleview-local';
const DB_VERSION = 1;
const STORE_NAME = 'handles';
const LAST_HANDLE_KEY = 'last-directory';

function normalizePath(path) {
  return String(path || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .split('/')
    .filter((part) => part && part !== '.')
    .join('/');
}

function asArchiveEntry(path, fileOrGetter) {
  let filePromise;
  const getFile = async () => {
    if (!filePromise) {
      filePromise = typeof fileOrGetter === 'function' ? fileOrGetter() : Promise.resolve(fileOrGetter);
    }
    return filePromise;
  };
  return {
    path: normalizePath(path),
    name: normalizePath(path).split('/').pop() || '',
    get file() {
      return getFile();
    },
    getFile,
    async text() {
      return (await getFile()).text();
    },
  };
}

async function walkDirectory(directoryHandle, prefix = '') {
  const entries = [];
  for await (const [name, handle] of directoryHandle.entries()) {
    const path = normalizePath(prefix ? `${prefix}/${name}` : name);
    if (handle.kind === 'directory') {
      entries.push(...(await walkDirectory(handle, path)));
    } else {
      entries.push(asArchiveEntry(path, () => handle.getFile()));
    }
  }
  return entries;
}

export async function chooseArchiveFolder() {
  if (!window.showDirectoryPicker) return null;
  const handle = await window.showDirectoryPicker({ id: 'telegram-export', mode: 'read' });
  return {
    name: handle.name,
    kind: 'directory-handle',
    handle,
    entries: await walkDirectory(handle),
  };
}

export function entriesFromFileList(fileList) {
  const files = Array.from(fileList || []);
  const rootName = files[0]?.webkitRelativePath?.split('/')[0] || 'Telegram export';
  return {
    name: rootName,
    kind: 'file-list',
    entries: files.map((file) => {
      const relative = file.webkitRelativePath || file.name;
      const pieces = normalizePath(relative).split('/');
      const path = pieces[0] === rootName ? pieces.slice(1).join('/') : relative;
      return asArchiveEntry(path, file);
    }),
  };
}

async function walkDroppedEntry(entry, prefix = '') {
  const path = normalizePath(prefix ? `${prefix}/${entry.name}` : entry.name);
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    return [asArchiveEntry(path, file)];
  }
  if (!entry.isDirectory) return [];
  const reader = entry.createReader();
  const children = [];
  while (true) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    children.push(...batch);
  }
  const nested = await Promise.all(children.map((child) => walkDroppedEntry(child, path)));
  return nested.flat();
}

export async function entriesFromDrop(dataTransfer) {
  const items = Array.from(dataTransfer?.items || []);
  const roots = items.map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  if (!roots.length) return entriesFromFileList(dataTransfer?.files);
  const groups = await Promise.all(roots.map((entry) => walkDroppedEntry(entry)));
  const allEntries = groups.flat();
  const rootName = roots.length === 1 ? roots[0].name : 'Telegram export';
  const stripped = allEntries.map((entry) => {
    const parts = entry.path.split('/');
    if (roots.length === 1 && parts[0] === rootName) entry.path = parts.slice(1).join('/');
    return entry;
  });
  return { name: rootName, kind: 'drop', entries: stripped };
}

export class AssetResolver {
  constructor(entries = []) {
    this.entries = [];
    this.byPath = new Map();
    this.byBasename = new Map();
    this.urls = new Map();
    this.addEntries(entries);
  }

  addEntries(entries = []) {
    for (const entry of entries) {
      this.entries.push(entry);
      const normalized = normalizePath(entry.path);
      this.byPath.set(normalized.toLocaleLowerCase(), entry);
      const basename = normalized.split('/').pop()?.toLocaleLowerCase();
      if (!basename) continue;
      if (!this.byBasename.has(basename)) this.byBasename.set(basename, []);
      this.byBasename.get(basename).push(entry);
    }
    return this;
  }

  find(path) {
    if (!path || /^\(?file not included/i.test(path)) return null;
    let decoded = String(path);
    try { decoded = decodeURIComponent(decoded); } catch {}
    const clean = normalizePath(decoded.replace(/^file:\/\//i, '').split(/[?#]/)[0]);
    const direct = this.byPath.get(clean.toLocaleLowerCase());
    if (direct) return direct;
    const withoutRoot = clean.split('/').slice(1).join('/');
    if (withoutRoot && this.byPath.has(withoutRoot.toLocaleLowerCase())) {
      return this.byPath.get(withoutRoot.toLocaleLowerCase());
    }
    const matches = this.byBasename.get(clean.split('/').pop()?.toLocaleLowerCase());
    return matches?.length === 1 ? matches[0] : null;
  }

  async getUrl(path) {
    const entry = this.find(path);
    if (!entry) return null;
    if (this.urls.has(entry.path)) return this.urls.get(entry.path);
    const file = await entry.getFile();
    const url = URL.createObjectURL(file);
    this.urls.set(entry.path, url);
    return url;
  }

  async getFile(path) {
    return this.find(path)?.getFile() || null;
  }

  revokeAll() {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
  }
}

function openDb() {
  if (!('indexedDB' in window)) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function rememberDirectoryHandle(handle) {
  try {
    const db = await openDb();
    if (!db) return;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(handle, LAST_HANDLE_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Some private browsing modes cannot persist file handles.
  }
}

export async function getRememberedDirectory() {
  try {
    const db = await openDb();
    if (!db) return null;
    const handle = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get(LAST_HANDLE_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return handle;
  } catch {
    return null;
  }
}

export async function forgetRememberedDirectory() {
  try {
    const db = await openDb();
    if (!db) return;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(LAST_HANDLE_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Forgetting an unavailable private-mode database is already effectively complete.
  }
}

export async function reopenRememberedDirectory(handle) {
  if (!handle) return null;
  let permission = await handle.queryPermission?.({ mode: 'read' });
  if (permission !== 'granted') permission = await handle.requestPermission?.({ mode: 'read' });
  if (permission !== 'granted') return null;
  return {
    name: handle.name,
    kind: 'directory-handle',
    handle,
    entries: await walkDirectory(handle),
  };
}

export function supportsDirectoryPicker() {
  return Boolean(window.showDirectoryPicker) && !new URLSearchParams(window.location.search).has('folderInput');
}
