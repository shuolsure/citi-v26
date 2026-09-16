// 备份导出 / 导入 + 本地结构版本（R0 · 01 E2）。纯函数：不碰 DOM、不碰 IndexedDB，Node 冒烟直接 import。
// 不变式：
//   · 备份不含正文与词位：书只带 hash / 书名 / 章数 / 进度 / 阅读秒数
//   · 导入先整包校验，任何一处不对整包拒并说出位置；校验通过前 state 一字不动
//   · 书按 hash 认领（不按书名：书名能改，hash 是正文算的）；书架上没有的书只留元信息，重新导入同一本书时接上进度
//   · bookSecs 的键从 R3（v2）起就是 bookHash，备份里仍挂在书上（按 hash），恢复时直接对上
//   · 备份 v2 带事件仓（R3 · 01 E2 E4）：每条都要过登记表校验，带正文的事件在这里也会被拦下
import { validateEvent } from '../shared/events.mjs';

export const STATE_V = 2;
export const BACKUP_APP = 'citi-v26';

/**
 * v1 → v2（R3 · 01 C8 E5 E6）：
 *   · entries[w].src（书名字符串）→ srcBook（bookHash）+ srcTitle（显示缓存）。**同名书不猜**：两本同名时 srcBook 留 null，
 *     书名仍留在 srcTitle，界面照常显示。'词库' 这类不是书名的来源同理（映射不到就是 null）。
 *   · entries[w].senseId 补出 null 占位（真值在应用启动时按 srcExpr 回填，那里才有词典）。
 *   · bookSecs 的键 bookId → bookHash；映射不到的（书已删）丢掉——本机 id 在别处没有意义，总时长在 dailies 里不受影响。
 *   · 去掉 outbox（E6：本地事件日志自带「已上传游标」就是 outbox）。
 * 纯函数、不碰词典：迁移只能用 state 里已有的东西。
 */
function v1to2(s) {
  const books = Array.isArray(s.books) ? s.books : [];
  const dup = new Set(), seenTitle = new Set();
  for (const b of books) { if (seenTitle.has(b.title)) dup.add(b.title); seenTitle.add(b.title); }
  const byTitle = new Map();
  for (const b of books) if (b.hash && !dup.has(b.title) && !byTitle.has(b.title)) byTitle.set(b.title, b.hash);
  const entries = {};
  for (const [w, e] of Object.entries(s.entries || {})) {
    const { src, ...rest } = e;
    const title = typeof src === 'string' && src ? src : null;
    entries[w] = { ...rest, srcBook: byTitle.get(title) || null, srcTitle: title, senseId: e.senseId == null ? null : e.senseId };
  }
  const byId = new Map(books.map(b => [b.id, b.hash]));
  const bookSecs = {};
  for (const [id, secs] of Object.entries(s.bookSecs || {})) { const h = byId.get(id); if (h) bookSecs[h] = (bookSecs[h] || 0) + secs; }
  const out = { ...s, entries, bookSecs };
  delete out.outbox;
  return out;
}

// state.v 迁移表：MIGRATIONS[n] 把 v=n 的 state 变成 v=n+1。
const MIGRATIONS = { 1: v1to2 };

/** 读取时缺省视为 1；比应用新的数据直接拒（老应用写回会把新字段抹掉） */
export function migrate(s, migrations = MIGRATIONS, target = STATE_V) {
  let v = s.v == null ? 1 : s.v;
  if (!Number.isInteger(v) || v < 1) throw new Error('数据版本号不对：' + s.v);
  if (v > target) throw new Error(`数据版本 ${v} 比应用（${target}）新，先更新应用`);
  let out = s;
  while (v < target) {
    if (!migrations[v]) throw new Error(`缺少 ${v} → ${v + 1} 的迁移`);
    out = migrations[v](out);
    v++;
  }
  return { ...out, v };
}

// 备份里 state 的字段（事实 + 偏好）。正文、词位、书架原始元信息（章节标题、专名）都不在里面。
export const STATE_FIELDS = ['auth', 'onboarded', 'quizEst', 'entries', 'muted', 'feedback', 'customDecks', 'dailies', 'hours', 'badges', 'prefs', 'local'];
const clone = x => JSON.parse(JSON.stringify(x));

function bookMeta(b, secs) {
  return { hash: b.hash, title: b.title, sample: !!b.sample, chapters: typeof b.chapters === 'number' ? b.chapters : b.chapters.length,
    pos: b.pos || { chapter: 0, pct: 0 }, den: b.den == null ? null : b.den, read: b.read || [], finishedAt: b.finishedAt || null,
    createdAt: b.createdAt || null, secs };
}

export function exportBackup(state, nowIso = new Date().toISOString(), events = []) {
  const books = state.books.map(b => bookMeta(b, state.bookSecs[b.hash] || 0));
  for (const p of state.pendingBooks || []) if (!books.some(b => b.hash === p.hash)) books.push(bookMeta(p, p.secs || 0));
  const last = state.books.find(b => b.id === state.lastBookId);
  const st = {};
  for (const k of STATE_FIELDS) st[k] = state[k];
  // seq 是 IndexedDB 的本机自增键（「已上传游标」的刻度），不是事件的一部分：
  // 带出去会被登记表判成「没有登记的字段」，备份导出后永远导不回来（浏览器里真机跑一遍才发现）
  // evDropped 放顶层而不是进 STATE_FIELDS：进 STATE_FIELDS 会让「必须有这个键」的校验拒掉所有老 v2 备份
  return clone({ v: STATE_V, app: BACKUP_APP, exportedAt: nowIso, lastBookHash: last ? last.hash : null, state: st, books,
    evDropped: state.evDropped || 0,
    events: (events || []).map(({ seq, ...e }) => { void seq; return e; }) });
}

// ---------- 校验 ----------
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const isIso = x => typeof x === 'string' && ISO.test(x) && !Number.isNaN(Date.parse(x));
const isNum = x => typeof x === 'number' && Number.isFinite(x);
const GRADES = ['keep', 'fuzzy', 'forget'];
const HASH16 = /^[0-9a-f]{16}$/;
const TYPES = { auth: x => x === null || x === 'guest', onboarded: x => typeof x === 'boolean', quizEst: isNum, entries: isObj, muted: isObj,
  feedback: Array.isArray, customDecks: Array.isArray, dailies: isObj, hours: isObj, badges: isObj, prefs: isObj, local: isObj };

class Bad extends Error {}
const need = (c, where, what) => { if (!c) throw new Bad(where + ' ' + what); };

function check(bk) {
  need(isObj(bk), '文件', '不是备份（顶层不是对象）');
  need(bk.app === BACKUP_APP, 'app', '不是词替的备份文件');
  need(Number.isInteger(bk.v) && bk.v >= 1, 'v', '版本号不对');
  need(bk.v <= STATE_V, 'v', `是更新版本（${bk.v}）的备份，先更新应用`);
  need(isIso(bk.exportedAt), 'exportedAt', '不是时间');
  need(bk.lastBookHash === null || HASH16.test(bk.lastBookHash), 'lastBookHash', '格式不对');
  need(bk.evDropped === undefined || (isNum(bk.evDropped) && bk.evDropped >= 0), 'evDropped', '不是条数');   // 可选：R3 之后、这条加上之前导出的备份没有它
  need(isObj(bk.state), 'state', '缺失');
  for (const k of STATE_FIELDS) { need(k in bk.state, 'state.' + k, '缺失'); need(TYPES[k](bk.state[k]), 'state.' + k, '类型不对'); }
  const S = bk.state;
  for (const [w, e] of Object.entries(S.entries)) {
    const at = 'entries.' + w;
    need(w.length > 0 && isObj(e), at, '不是词条');
    need(isIso(e.firstAt), at + '.firstAt', '不是时间');
    need(e.deletedAt == null || isIso(e.deletedAt), at + '.deletedAt', '不是时间');
    need(Array.isArray(e.reviews), at + '.reviews', '不是列表');
    if (bk.v >= 2) {                                        // v1 的词条是 src 字符串，导入时由 migrate 转成这两个字段
      need(e.srcBook == null || HASH16.test(e.srcBook), at + '.srcBook', '不是书的内容 hash');
      need(e.srcTitle == null || typeof e.srcTitle === 'string', at + '.srcTitle', '不是书名');
      need(e.senseId == null || /^[0-9a-f]{8}$/.test(e.senseId), at + '.senseId', '不是 sense_id');
    }
    e.reviews.forEach((r, i) => { need(isObj(r) && isIso(r.at), `${at}.reviews[${i}].at`, '不是时间'); need(GRADES.includes(r.grade), `${at}.reviews[${i}].grade`, '不是 keep/fuzzy/forget'); });
  }
  for (const [w, m] of Object.entries(S.muted)) need(isObj(m) && ['user', 'feedback'].includes(m.by) && isIso(m.at), 'muted.' + w, '格式不对');
  for (const [d, x] of Object.entries(S.dailies)) need(/^\d{4}-\d{2}-\d{2}$/.test(d) && isObj(x) && isNum(x.mins || 0) && isNum(x.newWords || 0), 'dailies.' + d, '格式不对');
  for (const [d, x] of Object.entries(S.hours)) need(/^\d{4}-\d{2}-\d{2}$/.test(d) && Array.isArray(x) && x.length === 24 && x.every(isNum), 'hours.' + d, '不是 24 个小时');
  S.customDecks.forEach((c, i) => need(isObj(c) && typeof c.id === 'string' && typeof c.name === 'string' && Array.isArray(c.words), `customDecks[${i}]`, '格式不对'));
  need(Array.isArray(bk.books), 'books', '不是列表');
  const seen = new Set();
  bk.books.forEach((b, i) => {
    const at = `books[${i}]`;
    need(isObj(b), at, '不是书');
    need(typeof b.hash === 'string' && HASH16.test(b.hash), at + '.hash', '格式不对');
    need(!seen.has(b.hash), at + '.hash', '重复'); seen.add(b.hash);
    need(typeof b.title === 'string', at + '.title', '缺失');
    need(Number.isInteger(b.chapters) && b.chapters >= 0, at + '.chapters', '不是章数');
    need(isObj(b.pos) && Number.isInteger(b.pos.chapter) && b.pos.chapter >= 0 && isNum(b.pos.pct) && b.pos.pct >= 0 && b.pos.pct <= 1, at + '.pos', '格式不对');
    need(b.den === null || (Number.isInteger(b.den) && b.den >= 0 && b.den <= 5), at + '.den', '不是 0–5');
    need(Array.isArray(b.read) && b.read.every(Number.isInteger), at + '.read', '格式不对');
    need(b.finishedAt === null || isIso(b.finishedAt), at + '.finishedAt', '不是时间');
    need(isNum(b.secs) && b.secs >= 0, at + '.secs', '不是秒数');
    need(!('text' in b) && !('slots' in b), at, '带了正文或词位（备份不该有）');
  });
  // v2 起带事件仓：逐条过登记表。这同时是最后一道正文闸——没登记的字段（正文最可能藏在那里）过不去
  if (bk.v >= 2) {
    need(Array.isArray(bk.events), 'events', '不是列表');
    const ids = new Set();
    bk.events.forEach((e, i) => {
      const r = validateEvent(e);
      need(r.ok, `events[${i}]`, '不合登记表：' + (r.ok ? '' : r.reason));
      need(!ids.has(e.event_id), `events[${i}].event_id`, '重复'); ids.add(e.event_id);
    });
  } else need(!('events' in bk), 'events', `出现在 v${bk.v} 的备份里（事件仓是 v2 才有的）`);
}

/** 返回 {ok:true, backup} 或 {ok:false, reason}；不改入参 */
export function validateBackup(bk) {
  try { check(bk); } catch (e) { if (e instanceof Bad) return { ok: false, reason: e.message }; throw e; }
  return { ok: true, backup: clone(bk) };
}

export function summarize(bk, shelf) {
  const words = Object.values(bk.state.entries).filter(e => !e.deletedAt).length;
  const onShelf = bk.books.filter(b => shelf.some(x => x.hash === b.hash)).length;
  return { words, books: bk.books.length, onShelf, pending: bk.books.length - onShelf, exportedAt: bk.exportedAt };
}

/** 已校验的备份覆盖到当前 state：事实与偏好整体替换；书架上的书按 hash 认领进度，不在书架的只留元信息 */
/** 老版本的备份先按 MIGRATIONS 走一遍（书名 → hash 用的是备份自己的书单，不是本机书架） */
export function migrateBackup(bk) {
  if (bk.v >= STATE_V) return bk;
  const m = migrate({ ...bk.state, v: bk.v, books: bk.books });
  const st = {};
  for (const k of STATE_FIELDS) st[k] = m[k];
  return { ...bk, v: STATE_V, state: st, events: bk.events || [] };
}

export function applyBackup(cur, bk0) {
  const bk = migrateBackup(bk0);
  const next = { ...cur, v: STATE_V };
  for (const k of STATE_FIELDS) next[k] = clone(bk.state[k]);
  next.evDropped = bk.evDropped || 0;                                   // 缺口计数跟着数据走，不跟着设备走
  const byHash = new Map(bk.books.map(b => [b.hash, b]));
  next.bookSecs = {};
  next.books = cur.books.map(b => {
    const m = byHash.get(b.hash);
    if (!m) { if (cur.bookSecs[b.hash]) next.bookSecs[b.hash] = cur.bookSecs[b.hash]; return b; }
    if (m.secs) next.bookSecs[b.hash] = m.secs;
    return claimInto(b, m);
  });
  next.pendingBooks = bk.books.filter(b => !cur.books.some(x => x.hash === b.hash)).map(clone);
  const last = bk.lastBookHash && next.books.find(b => b.hash === bk.lastBookHash);
  next.lastBookId = last ? last.id : (next.books.some(b => b.id === cur.lastBookId) ? cur.lastBookId : null);
  return next;
}

function claimInto(b, m) {
  const n = Array.isArray(b.chapters) ? b.chapters.length : b.chapters;
  const pos = m.pos.chapter < n ? { ...m.pos } : { chapter: Math.max(0, n - 1), pct: 0 };   // 章数变了（重新分章）不能指到不存在的章
  return { ...b, title: m.title, pos, den: m.den, read: m.read.filter(i => i < n), finishedAt: m.finishedAt };
}

/** 重新导入一本书时：书架待认领里有同 hash 的 → 返回接上进度后的 meta 与秒数，并从待认领里移除 */
export function claimPending(state, meta) {
  const list = state.pendingBooks || [];
  const m = list.find(p => p.hash === meta.hash);
  if (!m) return null;
  return { meta: claimInto(meta, m), secs: m.secs || 0, pendingBooks: list.filter(p => p !== m) };
}
