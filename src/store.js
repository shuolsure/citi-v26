// 本地存储（IndexedDB）。正文永不出本地：书的正文与词位只在 chapters 仓里。
// 不变式（docs/04 §5.1）：
//   · 装载完成前一个字都不写盘（ready 之前 save() 直接抛）
//   · 写不下必须抛，调用方弹提示；不许 catch(e){} 吞掉
//   · 一本书的所有章节一个事务写完，事务成功后才把书加进书架（半本书比没有书更坏）
//   · 攒出来的数不存：连续天数、到期数、留存都现算；这里只存事实
// 不能叫 'citi'：GitHub Pages 上旧版 citi-app 与本应用同源（shuolsure.github.io），它已占用同名库且结构不同
import { STATE_V, migrate } from './backup.js';

const DB_NAME = 'citi-v26';
const DB_VER = 1;

function req2p(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
function tx2p(t) { return new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('事务中止')); }); }

export function freshState() {
  return {
    v: STATE_V,                 // 本地结构版本；读取时缺省视为 1，升版走 backup.js 的 migrate()
    auth: null,                 // null=没选过 · 'guest'
    onboarded: false,
    quizEst: 0,
    // 事实
    entries: {},                // w → {firstAt, src, srcSentence, reviews:[{at,grade,mode}], deletedAt}
    muted: {},                  // w → {by:'user'|'feedback', at}
    dailies: {},                // YYYY-MM-DD → {mins, newWords}
    hours: {},                  // YYYY-MM-DD → [24 个小时的秒数]
    bookSecs: {},               // bookId → 阅读秒数
    feedback: [],               // 本地待抄检队列 {w, reason, bookHash, chapter, offset, at}
    badges: {},                 // key → gotAt
    customDecks: [],            // {id, name, words:[w], createdAt}
    books: [],                  // 书架（元信息，不含正文）
    pendingBooks: [],           // 从备份恢复、但本机还没有正文的书（按 hash 等重新导入时认领进度）
    backupAt: null,             // 上次导出备份的时间（本机，不进备份）
    remote: null,               // 远程配置缓存 {modelConfig}（R1 穿透，R5 起由 /v1/config 填；网页版不连后端时为空 → 用本地默认）
    // 偏好（与服务端 Prefs 同名字段）
    prefs: { deckId: 'cet4', bookDecks: {}, goal: 90, board: ['heat', 'progress', 'time', 'badges'], rvMode: 'recall',
      remind: false, remindAt: '22:30', idle: 3, bgCount: false, outlier: true, sync: true, yearGoal: 12 },
    // 本机排版（不上传）
    local: { theme: 'light', fs: 18, font: 'sys', pageMode: 'scroll', showEn: true, peekOn: true, bright: 100, autoDark: false, den: 3 },
    lastBookId: null,
    outbox: []                  // 游客态写操作的接口形状副本，登录后走 /auth/merge（本期网页版不连后端）
  };
}

export async function openStore() {
  const open = indexedDB.open(DB_NAME, DB_VER);
  open.onupgradeneeded = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    if (!db.objectStoreNames.contains('chapters')) db.createObjectStore('chapters');
  };
  const db = await req2p(open);
  let ready = false;

  async function loadState() {
    const t = db.transaction('kv', 'readonly');
    const s = await req2p(t.objectStore('kv').get('state'));
    if (!s) { ready = true; return freshState(); }
    const base = freshState();
    const m = migrate(s);                                  // 比应用新的数据在这里抛，ready 保持 false：老应用不许写回
    ready = true;
    return { ...base, ...m, prefs: { ...base.prefs, ...(m.prefs || {}) }, local: { ...base.local, ...(m.local || {}) } };
  }

  async function saveState(state) {
    if (!ready) throw new Error('装载完成前不许写盘');
    const t = db.transaction('kv', 'readwrite');
    t.objectStore('kv').put(JSON.parse(JSON.stringify(state)), 'state');
    await tx2p(t);
  }

  /** 一本书的全部章节 + 书架元信息同一事务；失败整体回滚，书架不出现半本书 */
  async function putBook(state, meta, chapters, idx) {
    const t = db.transaction(['chapters', 'kv'], 'readwrite');
    const cs = t.objectStore('chapters');
    chapters.forEach((c, i) => cs.put({ title: c.title, text: c.text, slots: c.slots }, meta.id + ':' + i));
    t.objectStore('kv').put(idx, 'bookidx:' + meta.id);
    const next = { ...state, books: state.books.filter(b => b.id !== meta.id).concat([meta]) };
    t.objectStore('kv').put(JSON.parse(JSON.stringify(next)), 'state');
    await tx2p(t);
    return next;
  }

  async function getChapter(bookId, idx) {
    const t = db.transaction('chapters', 'readonly');
    return (await req2p(t.objectStore('chapters').get(bookId + ':' + idx))) || null;
  }

  async function getBookIdx(bookId) {
    const t = db.transaction('kv', 'readonly');
    return (await req2p(t.objectStore('kv').get('bookidx:' + bookId))) || null;
  }

  async function deleteBook(state, bookId, n) {
    const t = db.transaction(['chapters', 'kv'], 'readwrite');
    for (let i = 0; i < n; i++) t.objectStore('chapters').delete(bookId + ':' + i);
    t.objectStore('kv').delete('bookidx:' + bookId);
    const next = { ...state, books: state.books.filter(b => b.id !== bookId) };
    t.objectStore('kv').put(JSON.parse(JSON.stringify(next)), 'state');
    await tx2p(t);
    return next;
  }

  async function wipe() {
    const t = db.transaction(['chapters', 'kv'], 'readwrite');
    t.objectStore('chapters').clear(); t.objectStore('kv').clear();
    await tx2p(t);
  }

  async function persist() { try { return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; } catch { return false; } }

  return { loadState, saveState, putBook, getChapter, getBookIdx, deleteBook, wipe, persist };
}
