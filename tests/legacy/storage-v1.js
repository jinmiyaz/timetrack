// 旧バージョン (commit 739cc0e) の index.html から StorageAdapter と monthKey をそのまま抜き出したもの。
// 互換性テストで「旧バージョンが書いたファイル / 旧バージョンが読むファイル」を再現するための参照実装。
// 変更しないこと。

class StorageAdapter {
  constructor() {
    this.dirHandle = null;
    this._pendingHandle = null; // stored handle awaiting permission re-grant
    this.supportsFS = typeof window.showDirectoryPicker === 'function';
  }

  get mode() {
    return this.dirHandle ? 'file' : (this.supportsFS ? 'none' : 'local');
  }

  async pickDirectory() {
    if (!this.supportsFS) return false;
    try {
      this.dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      await this._saveHandle(this.dirHandle);
      this._pendingHandle = null;
      return true;
    } catch {
      return false;
    }
  }

  // ---- File helpers ----
  async _readFile(name) {
    if (!this.dirHandle) return null;
    try {
      const fh = await this.dirHandle.getFileHandle(name);
      const file = await fh.getFile();
      const text = await file.text();
      return text.trim() ? JSON.parse(text) : null;
    } catch { return null; }
  }

  async _writeFile(name, obj) {
    if (!this.dirHandle) return false;
    try {
      const fh = await this.dirHandle.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(JSON.stringify(obj, null, 2));
      await w.close();
      return true;
    } catch { return false; }
  }

  async _listEntryFiles() {
    if (!this.dirHandle) return [];
    const names = [];
    for await (const [name] of this.dirHandle) {
      if (/^entries_\d{4}-\d{2}\.json$/.test(name)) names.push(name);
    }
    return names.sort();
  }

  // ---- IndexedDB handle persistence ----
  async _saveHandle(handle) {
    return new Promise((resolve) => {
      const req = indexedDB.open('timetrack_meta', 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore('kv');
      req.onsuccess = e => {
        const tx = e.target.result.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(handle, 'dirHandle');
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      };
      req.onerror = () => resolve(false);
    });
  }

  async _loadHandle() {
    return new Promise((resolve) => {
      const req = indexedDB.open('timetrack_meta', 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore('kv');
      req.onsuccess = e => {
        const tx = e.target.result.transaction('kv', 'readonly');
        const get = tx.objectStore('kv').get('dirHandle');
        get.onsuccess = () => resolve(get.result || null);
        get.onerror = () => resolve(null);
      };
      req.onerror = () => resolve(null);
    });
  }

  // Tries to restore the previously selected directory on startup.
  // Returns: 'restored' | 'prompt' | 'none' | 'unsupported'
  async restoreDirectory() {
    if (!this.supportsFS) return 'unsupported';
    try {
      const handle = await this._loadHandle();
      if (!handle) return 'none';
      const perm = await handle.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        this.dirHandle = handle;
        return 'restored';
      }
      // Permission requires a user gesture to re-grant
      this._pendingHandle = handle;
      return 'prompt';
    } catch { return 'error'; }
  }

  // Re-requests permission for a stored handle (requires user gesture).
  async reconnectDirectory() {
    if (!this._pendingHandle) return false;
    try {
      const perm = await this._pendingHandle.requestPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        this.dirHandle = this._pendingHandle;
        this._pendingHandle = null;
        return true;
      }
      return false;
    } catch { return false; }
  }

  // ---- Public API ----
  async save(data) {
    // Build meta (everything except entries)
    const meta = {
      version: data.version,
      projects: data.projects,
      activeTimer: data.activeTimer
    };

    // Group entries by month
    const byMonth = {};
    data.entries.forEach(e => {
      const mk = monthKey(e.startTime);
      if (!byMonth[mk]) byMonth[mk] = [];
      byMonth[mk].push(e);
    });

    if (this.dirHandle) {
      try {
        // Write meta
        await this._writeFile('meta.json', meta);
        // Write only dirty months
        const dirtyMonths = data._dirtyMonths || Object.keys(byMonth);
        for (const mk of dirtyMonths) {
          await this._writeFile(`entries_${mk}.json`, byMonth[mk] || []);
        }
        data._dirtyMonths = [];
        return 'file';
      } catch { /* fall through */ }
    }

    // localStorage fallback — store everything together
    const flat = { ...meta, entries: data.entries };
    localStorage.setItem('timetrack_data', JSON.stringify(flat));
    return 'local';
  }

  async load() {
    if (this.dirHandle) {
      // Try new monthly format first
      const meta = await this._readFile('meta.json');
      if (meta) {
        const entryFiles = await this._listEntryFiles();
        let entries = [];
        for (const name of entryFiles) {
          const arr = await this._readFile(name);
          if (Array.isArray(arr)) entries = entries.concat(arr);
        }
        return { ...meta, entries };
      }
      // Legacy migration: single data.json
      const legacy = await this._readFile('data.json');
      if (legacy && legacy.version) {
        return legacy;  // caller will save in new format via commit()
      }
    }
    const raw = localStorage.getItem('timetrack_data');
    return raw ? JSON.parse(raw) : null;
  }

  exportJSON(data) {
    const flat = {
      version: data.version,
      projects: data.projects,
      activeTimer: data.activeTimer,
      entries: data.entries
    };
    const blob = new Blob([JSON.stringify(flat, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'timetrack-data.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  importJSON() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = async () => {
        if (!input.files[0]) return resolve(null);
        const text = await input.files[0].text();
        try { resolve(JSON.parse(text)); } catch { resolve(null); }
      };
      input.click();
    });
  }
}

function monthKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
