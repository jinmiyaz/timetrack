// 保存データ互換性テスト
//   旧バージョン（tests/legacy/storage-v1.js）と新バージョン（index.html の <script id="tt-core">）の
//   間で、フォルダ保存・localStorage・エクスポートのデータを相互に読み書きできることを確認する。
//
// 実行: node --test tests/
process.env.TZ = 'Asia/Tokyo';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const coreSrc = /<script id="tt-core">([\s\S]*?)<\/script>/.exec(html)[1];
const connectFolderSrc = /async function connectFolder\(handle\) \{[\s\S]*?\n\}/.exec(html)[0];
const legacySrc = fs.readFileSync(new URL('./legacy/storage-v1.js', import.meta.url), 'utf8');

const loadCore = () => vm.runInContext(`${coreSrc}\n;TT`, vm.createContext({ console, setTimeout, clearTimeout, crypto: webcrypto }));
const loadLegacy = ls => vm.runInContext(`${legacySrc}\n;StorageAdapter`, vm.createContext({ console, window: {}, localStorage: ls, crypto: webcrypto }));
const TT = loadCore();

// ---------- インメモリの File System Access API ----------
let clock = 1_700_000_000_000;
class MemFileHandle {
  constructor(dir, name) { this.kind = 'file'; this.dir = dir; this.name = name; }
  async getFile() {
    const r = this.dir.files.get(this.name);
    return { name: this.name, lastModified: r.mtime, size: r.text.length, text: async () => r.text };
  }
  async createWritable() {
    const { dir, name } = this;
    let buf = '';
    return {
      write: async t => { if (dir.failOn.has(name)) throw new Error(`write failed: ${name}`); buf += t; },
      close: async () => { dir.files.set(name, { text: buf, mtime: ++clock }); },
      abort: async () => {},
    };
  }
}
class MemDir {
  constructor(name = '.timetrack') { this.kind = 'directory'; this.name = name; this.files = new Map(); this.failOn = new Set(); }
  async getFileHandle(name, opts = {}) {
    if (!this.files.has(name)) {
      if (!opts.create) { const e = new Error(`${name} not found`); e.name = 'NotFoundError'; throw e; }
      this.files.set(name, { text: '', mtime: ++clock });
    }
    return new MemFileHandle(this, name);
  }
  async *entries() { for (const name of [...this.files.keys()]) yield [name, new MemFileHandle(this, name)]; }
  [Symbol.asyncIterator]() { return this.entries(); }
  read(name) { return this.files.has(name) ? this.files.get(name).text : undefined; }
  json(name) { return JSON.parse(this.read(name)); }
  write(name, text) { this.files.set(name, { text, mtime: ++clock }); }
  names() { return [...this.files.keys()].sort(); }
}
class MemLS {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}

// ---------- ヘルパー ----------
const plain = x => JSON.parse(JSON.stringify(x));
const clone = plain;
const sortById = arr => [...arr].sort((a, b) => a.id.localeCompare(b.id));
const sameData = (actual, expected) => {
  const a = plain(actual), e = plain(expected);
  a.entries = sortById(a.entries); e.entries = sortById(e.entries);
  assert.deepEqual(a, e);
};

/** 旧バージョンが作るのと同じ形のデータ（開始時刻順） */
function fixture() {
  return {
    version: 1,
    projects: [
      { id: 'proj_aaaa1111', name: 'クライアントA案件', color: '#4CAF50', createdAt: '2026-01-05T01:00:00.000Z' },
      { id: 'proj_bbbb2222', name: '社内', color: '#3498db', createdAt: '2026-02-01T01:00:00.000Z', archived: true },
      { id: 'proj_cccc3333', name: '旧PJ "引用" <tag>', color: '#e94560', createdAt: '2026-02-01T01:00:00.000Z', archived: false },
    ],
    entries: [
      { id: 'entry_00000001', projectId: 'proj_aaaa1111', task: '設計書レビュー', startTime: '2026-01-10T01:00:00.000Z', endTime: '2026-01-10T02:30:00.000Z', duration: 5400 },
      // UTC では 1 月だが JST では 2/1 00:30 → entries_2026-02.json に入る
      { id: 'entry_00000002', projectId: null, task: '(名称なし)', startTime: '2026-01-31T15:30:00.000Z', endTime: '2026-01-31T16:00:00.000Z', duration: 1800 },
      { id: 'entry_00000003', projectId: 'proj_bbbb2222', task: 'MTG', startTime: '2026-02-03T00:00:00.000Z', endTime: '2026-02-03T01:15:00.000Z', duration: 4500 },
      { id: 'entry_00000004', projectId: 'proj_deleted0', task: '削除済みPJの作業', startTime: '2026-03-01T03:00:00.000Z', endTime: '2026-03-01T05:00:00.000Z', duration: 7200 },
      { id: 'entry_00000005', projectId: 'proj_cccc3333', task: 'テスト', startTime: '2026-03-15T23:00:00.000Z', endTime: '2026-03-16T01:00:00.000Z', duration: 7200 },
    ],
    activeTimer: { task: 'コーディング', projectId: 'proj_aaaa1111', startTime: '2026-04-03T05:00:00.000Z' },
  };
}

async function writeWithLegacy(data) {
  const Legacy = loadLegacy(new MemLS());
  const old = new Legacy();
  old.dirHandle = new MemDir();
  await old.save(clone(data));
  return old.dirHandle;
}
async function readWithLegacy(dir) {
  const Legacy = loadLegacy(new MemLS());
  const old = new Legacy();
  old.dirHandle = dir;
  return old.load();
}
function newStore(dir, opts) {
  const storage = new TT.StorageAdapter({ localStorage: new MemLS() });
  storage.dirHandle = dir || null;
  return { storage, store: new TT.Store(storage, opts) };
}
async function openFolder(dir) {
  const { storage, store } = newStore(dir);
  const res = await storage.readFolder(dir);
  storage.stamps = res.stamps;
  store.reset(res);
  await store.flush();
  return { storage, store, res };
}

/** 実際のフォルダ接続処理を実行し、確認ダイアログの選択だけを置き換える */
async function connectWithChoice(storage, store, dir, choice) {
  const dialogs = [];
  const context = vm.createContext({
    storage, store, countMissing: TT.countMissing, NO_NAME: TT.NO_NAME,
    dialog: async options => { dialogs.push(options); return choice; },
    alertDialog: async (title, message) => assert.fail(`${title}: ${message}`),
    toast() {}, reportLoad() {}, hideGate() {}, hideBanner() {}, renderStatus() {},
  });
  const connect = vm.runInContext(`${connectFolderSrc}\nconnectFolder`, context);
  const connected = await connect(dir);
  await store.flush();
  return { connected, dialogs };
}

// ============================================================
// フォルダ保存（meta.json + entries_YYYY-MM.json）
// ============================================================
test('旧バージョンが書いたフォルダを、そのまま読み込める', async () => {
  const dir = await writeWithLegacy(fixture());
  assert.deepEqual(dir.names(), ['entries_2026-01.json', 'entries_2026-02.json', 'entries_2026-03.json', 'meta.json']);
  const res = await new TT.StorageAdapter({}).readFolder(dir);
  assert.equal(res.found, true);
  assert.equal(res.legacy, false);
  assert.deepEqual([...res.dirtyMonths], [], '書き直しは発生しない');
  assert.deepEqual(plain(res.issues), []);
  sameData(res.data, fixture());
});

test('新バージョンが書くファイルは、旧バージョンが書くものとバイト単位で同一', async () => {
  const oldDir = await writeWithLegacy(fixture());
  const dir = new MemDir();
  const { store } = newStore(dir);
  store.reset({ data: clone(fixture()) });
  store.markAllDirty();
  assert.equal(await store.flush(), true);
  assert.deepEqual(dir.names(), oldDir.names());
  for (const name of dir.names()) assert.equal(dir.read(name), oldDir.read(name), name);
});

test('新バージョンが書いたフォルダを、旧バージョンが読み込める', async () => {
  const dir = new MemDir();
  const { store } = newStore(dir);
  store.reset({ data: clone(fixture()) });
  store.markAllDirty();
  await store.flush();
  // 新バージョンで編集
  store.stopTimer(new Date('2026-04-03T06:00:00.000Z'));
  const added = store.addEntry({ task: '手動', projectId: 'proj_cccc3333', startTime: '2026-04-01T00:00:00.000Z', endTime: '2026-04-01T00:45:00.000Z' });
  store.updateEntry('entry_00000003', { task: 'MTG（更新）' });
  store.deleteEntry('entry_00000004');
  await store.flush();

  const loaded = await readWithLegacy(dir);
  sameData(loaded, store.data);
  assert.equal(loaded.activeTimer, null);
  assert.equal(loaded.entries.find(e => e.id === added.id).duration, 2700);
  assert.ok(!loaded.entries.some(e => e.id === 'entry_00000004'));
});

test('旧形式 data.json を月別ファイルへ移行し、data.json は残す', async () => {
  const dir = new MemDir();
  const legacyText = JSON.stringify(fixture(), null, 2);
  dir.write('data.json', legacyText);
  const { storage, store } = newStore(dir);
  const res = await storage.readFolder(dir);
  assert.equal(res.legacy, true);
  assert.deepEqual([...res.dirtyMonths].sort(), ['2026-01', '2026-02', '2026-03']);
  store.reset(res);
  await store.flush();
  assert.equal(dir.read('data.json'), legacyText);
  assert.deepEqual(dir.names(), ['data.json', 'entries_2026-01.json', 'entries_2026-02.json', 'entries_2026-03.json', 'meta.json']);
  sameData(await readWithLegacy(dir), fixture());
  // 2 回目以降は meta.json を読む
  const again = await storage.readFolder(dir);
  assert.equal(again.legacy, false);
  sameData(again.data, fixture());
});

test('data.json からの移行が途中で止まっていたら、続きから移行を完了する', async () => {
  const done = await writeWithLegacy(fixture());
  // 一部の月だけ書いた時点 / meta.json の直前で止まった場合
  for (const written of [['entries_2026-01.json'], ['entries_2026-01.json', 'entries_2026-02.json', 'entries_2026-03.json']]) {
    const dir = new MemDir();
    const legacyText = JSON.stringify(fixture());
    dir.write('data.json', legacyText);
    for (const name of written) dir.write(name, done.read(name));
    const { res } = await openFolder(dir);
    assert.equal(res.legacy, true);
    assert.equal(res.recovered, false);
    assert.deepEqual(plain(res.issues), []);
    assert.deepEqual(dir.names(), ['data.json', 'entries_2026-01.json', 'entries_2026-02.json', 'entries_2026-03.json', 'meta.json']);
    for (const name of done.names()) assert.equal(dir.read(name), done.read(name), `${name} は旧バージョンが書くものと同一`);
    assert.equal(dir.read('data.json'), legacyText);
    sameData(await readWithLegacy(dir), fixture());
  }
});

/** data.json から移行した後もしばらく使ったフォルダ（data.json より新しい記録がある） */
async function usedAfterMigration() {
  const dir = new MemDir();
  const legacyText = JSON.stringify(fixture(), null, 2);
  dir.write('data.json', legacyText);
  const { store } = await openFolder(dir);
  const { entry: stopped } = store.stopTimer(new Date('2026-04-03T06:00:00.000Z'));
  const p = store.addProject({ name: '新規PJ', color: '#9b59b6' });
  const added = store.addEntry({ task: '新しい作業', projectId: p.id, startTime: '2026-04-05T00:00:00.000Z', endTime: '2026-04-05T01:00:00.000Z' });
  store.updateEntry('entry_00000001', { task: '設計書レビュー（修正）' });
  store.deleteEntry('entry_00000003');
  store.startTimer({ task: '計測中', projectId: p.id }, new Date('2026-04-06T00:00:00.000Z'));
  await store.flush();
  return { dir, store, legacyText, stopped, added, project: p };
}

test('meta.json が消えても（空になっても）、data.json より新しい月別ファイルの記録は失わない', async () => {
  for (const lose of [dir => dir.files.delete('meta.json'), dir => dir.write('meta.json', '')]) {
    const { dir, legacyText, stopped, added } = await usedAfterMigration();
    const months = Object.fromEntries(dir.names().filter(n => n.startsWith('entries_')).map(n => [n, dir.read(n)]));
    lose(dir);

    const { res, store } = await openFolder(dir);
    assert.equal(res.legacy, true);
    assert.equal(res.recovered, true);
    assert.equal(res.metaMissing, true);
    const ids = store.data.entries.map(e => e.id);
    for (const id of [stopped.id, added.id, 'entry_00000001', 'entry_00000002', 'entry_00000004', 'entry_00000005']) assert.ok(ids.includes(id), id);
    assert.equal(store.getEntry('entry_00000001').task, '設計書レビュー（修正）', '月別ファイルの内容を優先');
    assert.equal(store.getEntry(added.id).projectId, added.projectId, 'プロジェクト ID は残す');
    // data.json にしか無い記録は失わないよう残す（移行後に削除したものは戻る）
    assert.ok(ids.includes('entry_00000003'));
    // プロジェクトは data.json の時点のもの。古いタイマーは復活させない
    assert.deepEqual(plain(store.data.projects), fixture().projects);
    assert.equal(store.data.activeTimer, null);
    assert.ok(res.issues.some(m => m.includes('タイマー')));

    // 月別ファイルは書き換えず、data.json にしか無い記録の月と meta.json だけを書く
    assert.deepEqual([...res.dirtyMonths], ['2026-02']);
    for (const [name, text] of Object.entries(months)) if (name !== 'entries_2026-02.json') assert.equal(dir.read(name), text, name);
    assert.equal(dir.read('data.json'), legacyText);
    assert.deepEqual(dir.json('meta.json').projects, fixture().projects);
    sameData(await readWithLegacy(dir), store.data);
    const again = await new TT.StorageAdapter({}).readFolder(dir);
    assert.equal(again.legacy, false);
    assert.equal(again.metaMissing, false);
  }
});

test('使用中に meta.json が消えたら、表示中のプロジェクト設定で作り直す（data.json は使わない）', async () => {
  const { dir, store: before } = await usedAfterMigration();
  const metaText = dir.read('meta.json');
  const months = Object.fromEntries(dir.names().filter(n => n.startsWith('entries_')).map(n => [n, dir.read(n)]));
  dir.files.delete('meta.json');

  const res = await before.storage.readFolder(dir, { fallbackMeta: TT.buildMeta(before.data, before.extras) });
  assert.equal(res.legacy, false);
  assert.equal(res.metaMissing, true);
  assert.deepEqual([...res.dirtyMonths], []);
  sameData(res.data, before.data);
  before.reset(res);
  await before.flush();
  assert.equal(dir.read('meta.json'), metaText);
  for (const [name, text] of Object.entries(months)) assert.equal(dir.read(name), text, name);
});

test('meta.json も data.json も無ければ、記録だけ読み込んで meta.json を作る', async () => {
  const src = await writeWithLegacy(fixture());
  src.files.delete('meta.json');
  const months = Object.fromEntries(src.names().map(n => [n, src.read(n)]));
  const { res, store } = await openFolder(src);
  assert.equal(res.metaMissing, true);
  assert.equal(res.legacy, false);
  assert.equal(store.data.entries.length, fixture().entries.length);
  assert.deepEqual(plain(store.data.projects), []);
  assert.deepEqual(src.json('meta.json'), { version: 1, projects: [], activeTimer: null });
  for (const [name, text] of Object.entries(months)) assert.equal(src.read(name), text, name);
  sameData(await readWithLegacy(src), store.data);
});

test('未知のフィールドや新しい version は保持したまま書き戻す', async () => {
  const data = fixture();
  data.version = 2;
  data.projects[0].billable = true;
  data.entries[0].tags = ['review'];
  const dir = await writeWithLegacy(data);
  // 旧バージョンは meta の追加フィールドを書かないので手で追加
  const meta = dir.json('meta.json');
  meta.settings = { rounding: 15 };
  dir.write('meta.json', JSON.stringify(meta, null, 2));

  const { store } = await openFolder(dir);
  store.updateEntry('entry_00000001', { task: '設計書レビュー2' });
  store.updateProject('proj_aaaa1111', { name: 'A案件' });
  await store.flush();

  const meta2 = dir.json('meta.json');
  assert.deepEqual(Object.keys(meta2), ['version', 'projects', 'activeTimer', 'settings']);
  assert.equal(meta2.version, 2);
  assert.deepEqual(meta2.settings, { rounding: 15 });
  assert.equal(meta2.projects[0].billable, true);
  const jan = dir.json('entries_2026-01.json');
  assert.deepEqual(jan[0].tags, ['review']);
  assert.equal(jan[0].task, '設計書レビュー2');
});

test('時刻を変更していない編集では、時刻の文字列を書き換えない', async () => {
  const data = fixture();
  data.entries[0].startTime = '2026-01-10T10:00:00+09:00';
  data.entries[0].endTime = '2026-01-10T11:30:00+09:00';
  const dir = await writeWithLegacy(data);
  const { store } = await openFolder(dir);
  store.updateEntry('entry_00000001', { task: '別名' });
  await store.flush();
  const e = dir.json('entries_2026-01.json')[0];
  assert.equal(e.startTime, '2026-01-10T10:00:00+09:00');
  assert.equal(e.endTime, '2026-01-10T11:30:00+09:00');
  assert.equal(e.duration, 5400);
});

test('JSON が壊れているフォルダは読み込みを拒否し、何も書き込まない', async () => {
  for (const [name, text] of [['meta.json', '{"version":1,'], ['entries_2026-02.json', '[{"id":'], ['meta.json', '[]'], ['entries_2026-01.json', '{}']]) {
    const dir = await writeWithLegacy(fixture());
    dir.write(name, text);
    const before = new Map(dir.names().map(n => [n, dir.read(n)]));
    await assert.rejects(new TT.StorageAdapter({}).readFolder(dir), err => err.name === 'StorageError' && err.file === name);
    for (const n of dir.names()) assert.equal(dir.read(n), before.get(n));
  }
});

test('重複・月違いのエントリ（タイムゾーン変更など）を自動修復する', async () => {
  const dir = await writeWithLegacy(fixture());
  // entry_00000003 (2/3) の古いコピーが 1 月のファイルにも残っている状態
  const jan = dir.json('entries_2026-01.json');
  const feb = dir.json('entries_2026-02.json');
  jan.push({ ...feb.find(e => e.id === 'entry_00000003'), task: '古いコピー' });
  // entry_00000099 (2/10) が誤って 1 月のファイルにだけある状態
  jan.push({ id: 'entry_00000099', projectId: null, task: '月違い', startTime: '2026-02-10T00:00:00.000Z', endTime: '2026-02-10T01:00:00.000Z', duration: 3600 });
  dir.write('entries_2026-01.json', JSON.stringify(jan, null, 2));

  const { res } = await openFolder(dir);
  assert.deepEqual([...res.dirtyMonths].sort(), ['2026-01', '2026-02']);
  const all = [...dir.json('entries_2026-01.json'), ...dir.json('entries_2026-02.json'), ...dir.json('entries_2026-03.json')];
  assert.equal(all.filter(e => e.id === 'entry_00000003').length, 1);
  assert.equal(all.find(e => e.id === 'entry_00000003').task, 'MTG', '開始月と一致するファイルのものを採用');
  assert.ok(dir.json('entries_2026-02.json').some(e => e.id === 'entry_00000099'));
  assert.ok(!dir.json('entries_2026-01.json').some(e => e.id === 'entry_00000099'));
  const legacyView = await readWithLegacy(dir);
  assert.equal(legacyView.entries.length, new Set(legacyView.entries.map(e => e.id)).size, '旧バージョンから見ても重複なし');
});

test('エントリの月をまたぐ移動・削除・プロジェクト削除が各ファイルに正しく反映される', async () => {
  const dir = await writeWithLegacy(fixture());
  const { store } = await openFolder(dir);

  store.updateEntry('entry_00000001', { startTime: new Date('2026-03-20T00:00:00.000Z'), endTime: new Date('2026-03-20T01:00:00.000Z') });
  await store.flush();
  assert.ok(!dir.json('entries_2026-01.json').some(e => e.id === 'entry_00000001'));
  assert.ok(dir.json('entries_2026-03.json').some(e => e.id === 'entry_00000001' && e.duration === 3600));

  const snap = store.deleteProject('proj_aaaa1111');
  await store.flush();
  assert.equal(dir.json('meta.json').activeTimer.projectId, null);
  assert.equal(dir.json('entries_2026-03.json').find(e => e.id === 'entry_00000001').projectId, null);
  store.restoreProject(snap);
  await store.flush();
  assert.equal(dir.json('meta.json').projects[0].id, 'proj_aaaa1111');
  assert.equal(dir.json('meta.json').activeTimer.projectId, 'proj_aaaa1111');
  assert.equal(dir.json('entries_2026-03.json').find(e => e.id === 'entry_00000001').projectId, 'proj_aaaa1111');

  const del = store.deleteEntry('entry_00000005');
  await store.flush();
  assert.ok(!dir.json('entries_2026-03.json').some(e => e.id === 'entry_00000005'));
  store.restoreEntry(del);
  await store.flush();
  assert.ok(dir.json('entries_2026-03.json').some(e => e.id === 'entry_00000005'));
  sameData(await readWithLegacy(dir), store.data);
});

test('新しく作るデータは旧バージョンと同じ ID 形式・キー順', () => {
  const { store } = newStore(null);
  const p = store.addProject({ name: 'X', color: '#3498db' });
  assert.match(p.id, /^proj_[0-9a-f]{8}$/);
  assert.deepEqual(Object.keys(p), ['id', 'name', 'color', 'createdAt']);
  const t = store.startTimer({ task: '', projectId: p.id }, new Date('2026-05-01T00:00:00.000Z'));
  assert.deepEqual(Object.keys(t), ['task', 'projectId', 'startTime']);
  const { entry } = store.stopTimer(new Date('2026-05-01T00:10:00.000Z'));
  assert.match(entry.id, /^entry_[0-9a-f]{8}$/);
  assert.deepEqual(Object.keys(entry), ['id', 'projectId', 'task', 'startTime', 'endTime', 'duration']);
  assert.equal(entry.task, '(名称なし)');
  assert.equal(entry.duration, 600);
  const m = store.addEntry({ task: 'm', projectId: null, startTime: '2026-05-02T00:00:00.000Z', endTime: '2026-05-02T00:00:30.000Z' });
  assert.deepEqual(Object.keys(m), ['id', 'projectId', 'task', 'startTime', 'endTime', 'duration']);
  assert.equal(store.addEntry({ task: 'x', startTime: '2026-05-02T01:00:00Z', endTime: '2026-05-02T01:00:00Z' }), null, '長さ 0 は追加しない');
  store.startTimer({}, new Date('2026-05-01T00:00:00.000Z'));
  assert.equal(store.stopTimer(new Date('2026-05-01T00:00:00.400Z')).tooShort, true);
  clearTimeout(store._timer);
});

test('書き込みに失敗したら変更を保持してエラーにし、再試行で保存する', async () => {
  const dir = await writeWithLegacy(fixture());
  const { store } = await openFolder(dir);
  dir.failOn.add('entries_2026-01.json');
  store.updateEntry('entry_00000001', { task: '失敗するはず' });
  assert.equal(await store.flush(), false);
  assert.equal(store.status, 'error');
  assert.equal(store.dirty, true);
  assert.ok(store.dirtyMonths.has('2026-01'));
  assert.equal(dir.json('entries_2026-01.json')[0].task, '設計書レビュー');
  dir.failOn.clear();
  assert.equal(await store.flush(), true);
  assert.equal(store.status, 'saved');
  assert.equal(dir.json('entries_2026-01.json')[0].task, '失敗するはず');
});

test('移行中の月別保存が失敗しても、再起動後に data.json から全件を復元できる', async () => {
  const data = fixture();
  const dir = new MemDir();
  dir.write('data.json', JSON.stringify(data));
  const { storage, store } = newStore(dir);
  store.reset(await storage.readFolder());
  dir.failOn.add('entries_2026-02.json');
  try {
    assert.equal(await store.flush(), false);
    assert.ok(dir.json('entries_2026-01.json').length, '一部の月は保存済み');
    assert.equal(dir.read('meta.json'), undefined, '未完了の移行で meta.json を作らない');
  } finally {
    clearTimeout(store._timer);
    clearTimeout(store._retry); // 再起動を模擬するため、元のストアの再試行を止める
  }

  dir.failOn.clear();
  const reopened = await openFolder(dir);
  assert.equal(reopened.res.legacy, true);
  sameData(reopened.store.data, data);
  sameData((await reopened.storage.readFolder()).data, data);
  assert.deepEqual(dir.json('data.json'), data, '元のファイルも保持する');
});

test('停止したタイマーの記録に失敗したら meta.json を更新せず、再試行で完了する', async () => {
  const data = fixture();
  const dir = await writeWithLegacy(data);
  const { store } = await openFolder(dir);
  const originalMeta = dir.read('meta.json');
  const { entry } = store.stopTimer(new Date('2026-04-03T06:00:00Z'));
  dir.failOn.add('entries_2026-04.json');
  try {
    assert.equal(await store.flush(), false);
    assert.equal(dir.read('meta.json'), originalMeta, '記録できるまでは保存済みタイマーを残す');
    dir.failOn.clear();
    assert.equal(await store.flush(), true);
    assert.equal(dir.json('meta.json').activeTimer, null);
    assert.deepEqual(dir.json('entries_2026-04.json'), [plain(entry)]);
  } finally {
    clearTimeout(store._timer);
    clearTimeout(store._retry);
  }
});

test('外部（他の端末・旧バージョン）による変更を検知できる', async () => {
  const dir = await writeWithLegacy(fixture());
  const { storage, store } = await openFolder(dir);
  assert.equal(await storage.hasExternalChanges(), false);
  store.updateEntry('entry_00000001', { task: '自分の変更' });
  await store.flush();
  assert.equal(await storage.hasExternalChanges(), false, '自分の書き込みは外部変更扱いしない');
  dir.write('entries_2026-05.json', '[]');
  assert.equal(await storage.hasExternalChanges(), true);
  storage.stamps = (await storage.readFolder(dir)).stamps;
  assert.equal(await storage.hasExternalChanges(), false);
  dir.write('meta.json', dir.read('meta.json'));
  assert.equal(await storage.hasExternalChanges(), true);
});

test('空のフォルダは「データなし」として扱う', async () => {
  const res = await new TT.StorageAdapter({}).readFolder(new MemDir());
  assert.equal(res.found, false);
});

for (const choice of ['merge', 'folder', null]) {
  test(`フォルダ接続: 計測中タイマーだけが未登録でも確認する（${choice ?? 'キャンセル'}）`, async () => {
    const data = fixture();
    data.activeTimer = null;
    const dir = await writeWithLegacy(data);
    const { storage, store } = newStore(null);
    store.reset({ data: clone(data) });
    const timer = plain(store.startTimer({ task: '接続前から計測中', projectId: data.projects[0].id }, new Date('2026-04-05T00:00:00Z')));

    const { connected, dialogs } = await connectWithChoice(storage, store, dir, choice);
    assert.equal(dialogs.length, 1, '計測中タイマーだけでも確認が必要');
    assert.match(dialogs[0].message, /計測中タイマー/);
    assert.equal(connected, choice !== null);
    assert.equal(storage.dirHandle, choice === null ? null : dir);
    assert.deepEqual(plain(store.data.activeTimer), choice === 'folder' ? null : timer);
    const saved = await new TT.StorageAdapter({}).readFolder(dir);
    assert.deepEqual(plain(saved.data.activeTimer), choice === 'merge' ? timer : null);
    sameData({ ...saved.data, activeTimer: null }, data);
  });
}

test('フォルダ接続: 双方で別のタイマーを計測中なら優先される側を明示する', async () => {
  const data = fixture();
  const dir = await writeWithLegacy(data);
  const { storage, store } = newStore(null);
  store.reset({ data: clone(data) });
  store.startTimer({ task: '別の作業' }, new Date('2026-04-05T00:00:00Z'));
  const { dialogs } = await connectWithChoice(storage, store, dir, 'merge');
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0].message, /別のタイマー/);
  assert.match(dialogs[0].message, /フォルダ側のタイマーを優先/);
  assert.deepEqual(plain(store.data.activeTimer), data.activeTimer);
});

test('フォルダ接続: 同じタイマーや停止済みの古いタイマーでは確認・復活しない', async () => {
  for (const stopped of [false, true]) {
    const current = fixture();
    const data = clone(current);
    if (stopped) {
      data.entries.push({ id: 'entry_stopped1', task: 'コーディング', projectId: current.activeTimer.projectId,
        startTime: current.activeTimer.startTime, endTime: '2026-04-03T06:00:00Z', duration: 3600 });
      data.activeTimer = null;
    }
    const dir = await writeWithLegacy(data);
    const { storage, store } = newStore(null);
    store.reset({ data: current });
    const { dialogs } = await connectWithChoice(storage, store, dir, 'merge');
    assert.equal(dialogs.length, 0);
    sameData(store.data, data);
  }
});

// ============================================================
// localStorage / エクスポート
// ============================================================
test('localStorage: 旧バージョンと相互に読み書きでき、文字列も同一', async () => {
  const ls = new MemLS();
  const Legacy = loadLegacy(ls);
  await new Legacy().save(clone(fixture()));
  const oldText = ls.getItem('timetrack_data');

  const storage = new TT.StorageAdapter({ localStorage: ls });
  const norm = storage.readLocal();
  sameData(norm.data, fixture());
  storage.writeLocal(norm.data, norm.extras);
  assert.equal(ls.getItem('timetrack_data'), oldText);
  sameData(await new Legacy().load(), fixture());
});

test('JSON エクスポートは旧バージョンと同じ形式', () => {
  const data = fixture();
  const expected = JSON.stringify({ version: data.version, projects: data.projects, activeTimer: data.activeTimer, entries: data.entries }, null, 2);
  assert.equal(TT.serialize(TT.buildFlat(clone(data), {})), expected);
});

test('インポート: エクスポート形式・旧 data.json・月別ファイル単体を受け付け、ID でマージする', () => {
  const base = TT.normalizeData(clone(fixture())).data;
  assert.equal(TT.coerceImport({ foo: 1 }), null);
  const month = TT.coerceImport([{ id: 'entry_new00001', projectId: null, task: 'x', startTime: '2026-06-01T00:00:00Z', endTime: '2026-06-01T01:00:00Z' }]);
  assert.equal(month.data.entries[0].duration, 3600, 'duration が無ければ補う');
  const r = TT.mergeData(base, month.data);
  assert.equal(r.addedEntries.length, 1);
  assert.equal(r.data.entries.length, 6);
  assert.deepEqual(plain(TT.countMissing(base, TT.coerceImport(clone(fixture())).data)), { projects: 0, entries: 0, activeTimer: false });
});

test('マージ: 記録済みの古いタイマーは復活させず、未記録のタイマーは引き継ぐ', () => {
  const stale = TT.normalizeData(clone(fixture())).data;          // タイマー実行中の古い状態
  const folder = TT.normalizeData(clone(fixture())).data;
  folder.activeTimer = null;                                       // フォルダ側では停止・記録済み
  folder.entries.push({ id: 'entry_stopped1', projectId: 'proj_aaaa1111', task: 'コーディング', startTime: stale.activeTimer.startTime, endTime: '2026-04-03T06:00:00.000Z', duration: 3600 });
  assert.equal(TT.mergeData(folder, stale).data.activeTimer, null);
  const running = { task: '新しい計測', projectId: null, startTime: '2026-04-05T00:00:00.000Z' };
  assert.equal(TT.mergeData(folder, { ...stale, activeTimer: running }).data.activeTimer, running);
  assert.equal(TT.mergeData({ ...folder, activeTimer: running }, stale).data.activeTimer, running, 'base のタイマーを優先');
});

// ============================================================
// ユーティリティ
// ============================================================
test('時間の入力形式', () => {
  const cases = { '1:30': 5400, '1:30:15': 5415, '０：４５': 2700, '90m': 5400, '1.5h': 5400, '1h30m': 5400, '1時間30分': 5400, '45': 2700, '30s': 30, '2 hours': 7200 };
  for (const [s, v] of Object.entries(cases)) assert.equal(TT.parseDuration(s), v, s);
  for (const s of ['', 'abc', '1:75', '1h foo']) assert.equal(TT.parseDuration(s), null, s);
  assert.equal(TT.formatDuration(5415, 'hms'), '1:30:15');
  assert.equal(TT.formatDuration(5415, 'hm'), '1:30');
  assert.equal(TT.formatDuration(5400, 'decimal'), '1.50 h');
  // 日時の入力欄は分単位（CSV などは秒まで）
  assert.equal(TT.toLocalInput('2026-03-15T23:04:37.000Z', false), '2026-03-16T08:04');
  assert.equal(TT.toLocalInput('2026-03-15T23:04:37.000Z'), '2026-03-16T08:04:37');
  assert.equal(TT.parseLocalInput('2026-03-16T08:04').toISOString(), '2026-03-15T23:04:00.000Z');
});

test('タスク名の候補: プロジェクトを指定するとそのプロジェクトの履歴だけ', () => {
  const e = (id, task, projectId, day) => ({ id, task, projectId, startTime: `2026-04-${day}T00:00:00.000Z`, endTime: `2026-04-${day}T01:00:00.000Z`, duration: 3600 });
  const entries = [
    e('e1', '設計', 'proj_a', '01'), e('e2', 'MTG', 'proj_b', '02'), e('e3', '設計', 'proj_b', '03'),
    e('e4', 'メール', null, '04'), e('e5', 'MTG', 'proj_a', '05'), e('e6', '(名称なし)', 'proj_a', '06'),
  ];
  const tasks = list => plain(list).map(s => `${s.task}@${s.projectId}`);
  // 全履歴: タスク名ごとに最新のプロジェクト
  assert.deepEqual(tasks(TT.recentTasks(entries)), ['MTG@proj_a', 'メール@null', '設計@proj_b']);
  // プロジェクト別: 他のプロジェクトで最後に使ったタスク名も含める
  assert.deepEqual(tasks(TT.recentTasks(entries, 200, 'proj_a')), ['MTG@proj_a', '設計@proj_a']);
  assert.deepEqual(tasks(TT.recentTasks(entries, 200, 'proj_b')), ['設計@proj_b', 'MTG@proj_b']);
  assert.deepEqual(tasks(TT.recentTasks(entries, 200, null)), ['メール@null']);
});

test('CSV はエスケープと数式インジェクション対策を行う', () => {
  const csv = TT.toCSV([
    { id: 'e1', projectId: 'p1', task: '=SUM(A1)', startTime: '2026-01-10T01:00:00.000Z', endTime: '2026-01-10T02:00:00.000Z', duration: 3600 },
    { id: 'e2', projectId: null, task: 'a,"b"', startTime: '2026-01-11T01:00:00.000Z', endTime: '2026-01-11T01:30:00.000Z', duration: 1800 },
  ], [{ id: 'p1', name: 'P', color: '#fff' }]);
  const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines[0], '日付,開始,終了,時間,時間(h),プロジェクト,タスク');
  assert.equal(lines[1], "2026-01-10,2026-01-10 10:00:00,2026-01-10 11:00:00,1:00:00,1.00,P,'=SUM(A1)");
  assert.equal(lines[2], '2026-01-11,2026-01-11 10:00:00,2026-01-11 10:30:00,0:30:00,0.50,,"a,""b"""');
});

test('集計とグラフのビン', () => {
  const data = TT.normalizeData(clone(fixture())).data;
  const s = TT.summarize(data.entries);
  assert.equal(s.total, 5400 + 1800 + 4500 + 7200 + 7200);
  assert.equal(s.count, 5);
  assert.equal(s.byProject[0].duration, 7200);
  const feb = TT.entriesInRange(data.entries, new Date(2026, 1, 1), new Date(2026, 2, 1));
  assert.deepEqual(plain(feb.map(e => e.id)), ['entry_00000002', 'entry_00000003']);
  const week = TT.chartBins(data.entries, new Date(2026, 1, 1), new Date(2026, 1, 8));
  assert.equal(week.unit, 'day');
  assert.equal(week.bins.length, 7);
  assert.equal(week.bins[0].total, 1800);
  assert.equal(TT.chartBins(data.entries, null, null).unit, 'month');
});
