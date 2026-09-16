// 纯函数：从本地事实现算界面上的数。没有 DOM、没有存储，Node 里可直接测（tests/client-smoke.mjs）。
// 记忆相关一律调用 shared/memory-model.mjs（与服务端同一份），这里只做换算与画图坐标。
import * as M from '../shared/memory-model.mjs';

export const DAY = 864e5;
export const pad = n => String(n).padStart(2, '0');
export const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
export const addDays = (date, n) => { const d = new Date(date + 'T12:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
export const fmtMD = d => (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';

// ---------- 词条 → 模型输入 ----------
export function activeEntry(e) { return !!e && !e.deletedAt; }
export function reviewsOf(e) { return (e.reviews || []).filter(r => r.at >= e.firstAt).sort((a, b) => a.at < b.at ? -1 : 1); }
export function modelEntry(w, e, muted, nowMs) {
  return { w, first: M.toDays(e.firstAt, nowMs), reviews: reviewsOf(e).map(r => ({ at: M.toDays(r.at, nowMs), grade: r.grade })), muted: !!muted };
}
export function isDemoted(e) { const r = reviewsOf(e); return r.length > 0 && r[r.length - 1].grade === 'forget'; }

// ---------- 模型参数（R1 · 01 A8）：远程配置缓存 → 本地默认；远程只带改动的键 ----------
export function modelConfigOf(remote) {
  return remote ? { ...M.DEFAULT_CONFIG, ...remote, GRADES: { ...M.DEFAULT_CONFIG.GRADES, ...(remote.GRADES || {}) } } : M.DEFAULT_CONFIG;
}
/** 三档口径（与 retentionBreakdown 同一条规则）：'due' 到期 / 'solid' 未到期且 S ≥ SOLID_S / 'ok' 其余 */
export function tierOf(e, cfg = M.DEFAULT_CONFIG, now = 0) {
  const m = M.truncateToNow(M.buildHistory(e, cfg), now);
  if (M.retentionAt(m, now) < cfg.DUE_AT) return 'due';
  return m.S[m.n - 1] >= cfg.SOLID_S ? 'solid' : 'ok';
}

// ---------- 记下 / 取消（R1 · 01 A10 · 拍板 Q5）：取消后 24 小时内再记下 = 撤销取消（与服务端 learn.mjs 同口径） ----------
export const UNDO_WINDOW_MS = 24 * 3600e3;
/** 'active' 已在词库 · 'undo' 撤销取消（原 firstAt 与复习史接着用，新词数不加）· 'new' 新记下 */
export function learnKind(prev, nowMs) {
  if (prev && !prev.deletedAt) return 'active';
  if (prev && nowMs - Date.parse(prev.deletedAt) <= UNDO_WINDOW_MS) return 'undo';
  return 'new';
}

// ---------- 复习（R1 · 01 A2 A6 A7） ----------
export const ROUND_MAX = 30;
/** 词库列表副标题：到期了才说「今日」，不足 1 天说小时，其余天数与按钮同一取整（Math.round） */
export function dueCaption(nextAt) {
  if (nextAt <= 0) return '今日复习最佳';
  if (nextAt < 0.5) return Math.ceil(nextAt * 24) + ' 小时后复习最佳';
  return Math.round(nextAt) + ' 日后复习最佳';
}                                  // 每轮最多 30 词，超出的进下一轮（队列已按留存升序）
export const keepLabel = days => days >= 1 ? '下次 +' + days + ' 天' : '今天再来';
/** 拼写 / 四选一答错（含没作答）时「记得」不可选；回想 / 回到原文没有客观对错 */
export function keepAllowed(mode, spellOk, choiceOk) {
  if (mode === 'spell') return spellOk;
  if (mode === 'choice') return choiceOk;
  return true;
}

// ---------- 异常翻页剔除（R2 · Repo-1 §12-9 · 2026-09-16 扩到滚动模式） ----------
/** 一屏停留不足这么多秒 = 「划过去了」，不是在读 */
export const OUTLIER_MIN_SECS = 4;
/** 连续第几屏起开始扣（第 1 屏可能是正常跳读，不扣） */
export const OUTLIER_FROM_PAGE = 2;
/**
 * 结算一屏：secs 这一屏停留的秒数，quickRun 之前已经连续「划过去」几屏。
 * 返回 { drop 这一屏的秒数要不要扣掉, quickRun 新的连续计数 }。
 * 抽成纯函数是为了让翻页与滚动**用同一把尺子**，并且能在 Node 里断言
 * （原来判定写在 onPageTurn 里，只有翻页模式调得到，滚动模式的设置开关是个摆设）。
 */
export function judgeQuickPage(secs, quickRun, outlierOn) {
  if (!outlierOn || secs >= OUTLIER_MIN_SECS) return { drop: false, quickRun: 0 };
  const run = (quickRun || 0) + 1;
  return { drop: run >= OUTLIER_FROM_PAGE, quickRun: run };
}

// ---------- 四选一干扰项（2026-09-16 修）----------
/**
 * 释义切成「义项集合」：按中英文标点切，只丢空串。
 * 只用来判断两条释义是不是在说同一件事，不参与任何展示。
 * ★ 单字义项**不能丢**：第一版写的是「长度 > 1 才要」，结果漏掉 gaokao 词表的
 *   man「男人, 人类, 人」撞 soul「…, 人, …」——两个选项都对。而且当时的断言用
 *   distractorOk 去验 distractorOk 挑出来的结果，是同义反复，扫全表照样 0 冲突。
 *   现在 client-smoke 用独立口径（直接切字符串比交集）复核，这一条才挡得住。
 */
export function defSenses(def) {
  const out = new Set();
  for (const t of String(def || '').split(/[；;，,、/／|｜]+/)) { const k = t.trim(); if (k) out.add(k); }
  return out;
}
/**
 * 这条释义能不能当干扰项：与正确释义共享任何一个义项就不能。
 * 旧口径只比字符串完全相等，于是放过了这一类（实测 CET-4 3791 词里有 5 个）：
 *   ceiling 正确「天花板」 干扰「经常开支, 普通用费, 天花板」—— 两个选项都对
 *   vivid   正确「生动的, 鲜明的, …」 干扰「活泼的, 鲜明的, 生动的」—— 干扰项是正确答案的真子集
 * 而干扰项是按词 hash 确定性挑的（刷新不变），所以撞上的词**每一次复习都是同一道坏题**，
 * 还会因为「选错了」把「记得」按钮置灰（keepAllowed），比单纯答错更伤。
 */
export function distractorOk(correctDef, candDef, correctSenses) {
  if (!candDef || candDef === correctDef) return false;
  const a = correctSenses || defSenses(correctDef);
  for (const x of defSenses(candDef)) if (a.has(x)) return false;
  return true;
}

// ---------- 生词来源（2026-09-16 修）----------
/**
 * 「生词来源」看板按**内容 hash** 聚合，不按书名 —— 书名能改，hash 是正文算出来的。
 * 旧口径 `const k = e.srcTitle || '其他'` 会让「改一次书名」把同一本书裂成两条记录，
 * 而同一件事在分享卡那边（app.js valsMe shareN）早就是 hash 优先，两处口径不一致。
 * 退回书名只发生在三种情况：从词库记下的（没有 srcBook）、书已从书架删掉、v1 迁移时映射不到。
 * @param entries  state.entries · @param books 书架 · @param monthKey 'YYYY-MM' · @param isActive (w)=>bool
 * @returns [{ key, title, tone, n }] 次数降序 → 标题序，最多 limit 条
 */
export function sourceRows(entries, books, monthKey, isActive, limit = 4) {
  const byHash = new Map((books || []).map(b => [b.hash, b]));
  const acc = new Map();
  for (const w of Object.keys(entries || {})) {
    const e = entries[w];
    if (!isActive(w) || !e || !e.firstAt) continue;
    if (!ymd(new Date(e.firstAt)).startsWith(monthKey)) continue;
    const b = e.srcBook ? byHash.get(e.srcBook) : null;
    const key = b ? 'h:' + b.hash : 't:' + (e.srcTitle || '其他');
    const cur = acc.get(key);
    if (cur) cur.n++;
    else acc.set(key, { key, title: b ? b.title : (e.srcTitle || '其他'), tone: b ? b.tone : null, n: 1 });
  }
  return [...acc.values()].sort((a, b) => b.n - a.n || (a.title < b.title ? -1 : 1)).slice(0, limit);
}

// ---------- 打卡 ----------
/** 从今天往前数连续 mins>0；今天没读从昨天起算（docs/00 §0） */
export function streakOf(dailies, today) {
  let d = (dailies[today] && dailies[today].mins > 0) ? today : addDays(today, -1);
  let n = 0;
  while (dailies[d] && dailies[d].mins > 0) { n++; d = addDays(d, -1); }
  return n;
}
export function bestRun(dailies, from, to) {
  let best = 0, run = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) { if (dailies[d] && dailies[d].mins > 0) { run++; best = Math.max(best, run); } else run = 0; }
  return best;
}
export function fullMonthAttended(dailies, today) {
  const months = new Set(Object.keys(dailies).map(d => d.slice(0, 7)));
  for (const ym of months) {
    const [y, m] = ym.split('-').map(Number);
    const days = new Date(y, m, 0).getDate();
    if (ym + '-' + pad(days) > today) continue;
    let ok = true;
    for (let i = 1; i <= days; i++) { const x = dailies[ym + '-' + pad(i)]; if (!(x && x.mins > 0)) { ok = false; break; } }
    if (ok) return true;
  }
  return false;
}

// ---------- 勋章（阈值与服务端 stats.mjs 同一组，Q5 推荐值） ----------
export const BADGE_T = { streak7: 7, words100: 100, night10: 10, nightHour: 22, book1: 1, words1000: 1000 };
// 夜读 = 22:00–03:59，凌晨归前一天（R1 · 01 D12；服务端 stats.mjs nightDayOf 同口径）
export const NIGHT_END_HOUR = 4;
export function nightDayOf(date, hour, startHour = BADGE_T.nightHour) {
  if (hour >= startHour) return date;
  if (hour < NIGHT_END_HOUR) return addDays(date, -1);
  return null;
}
export const BADGE_KEYS = ['streak7', 'words100', 'night10', 'book1', 'words1000', 'month'];
export function badgeFacts(data, today) {
  const words = Object.values(data.entries).filter(activeEntry).length;
  const nights = new Set();
  for (const [date, h] of Object.entries(data.hours)) h.forEach((s, hour) => { const n = s > 0 ? nightDayOf(date, hour) : null; if (n) nights.add(n); });
  const nightDays = nights.size;
  const finishedBooks = data.books.filter(b => b.finishedAt).length;
  const monthKey = today.slice(0, 7);
  const monthDays = Object.keys(data.dailies).filter(d => d.startsWith(monthKey) && data.dailies[d].mins > 0).length;
  return { streak: streakOf(data.dailies, today), words, nightDays, finishedBooks, fullMonth: fullMonthAttended(data.dailies, today), monthDays };
}
export function judgeBadges(f) {
  const got = [];
  if (f.streak >= BADGE_T.streak7) got.push('streak7');
  if (f.words >= BADGE_T.words100) got.push('words100');
  if (f.nightDays >= BADGE_T.night10) got.push('night10');
  if (f.finishedBooks >= BADGE_T.book1) got.push('book1');
  if (f.words >= BADGE_T.words1000) got.push('words1000');
  if (f.fullMonth) got.push('month');
  return got;
}

// ---------- 学习预测（PRD C3：近 28 天日均记词） ----------
// R1 · 01 D13：分母 min(28, 使用天数)，使用不足 7 天不外推
export const FORECAST_MIN_DAYS = 7;
/** 使用天数 = 最早一条有阅读或记词的日子到今天（含今天） */
export function usedDaysOf(dailies, today) {
  const first = Object.keys(dailies).filter(d => d <= today && ((dailies[d].mins || 0) > 0 || (dailies[d].newWords || 0) > 0)).sort()[0];
  if (!first) return 0;
  return Math.round((Date.parse(today + 'T12:00:00') - Date.parse(first + 'T12:00:00')) / DAY) + 1;
}
export function dailyRate(dailies, today) {
  const used = usedDaysOf(dailies, today);
  if (used < FORECAST_MIN_DAYS) return 0;
  let sum = 0;
  for (let i = 0; i < 28; i++) { const d = dailies[addDays(today, -i)]; if (d) sum += d.newWords || 0; }
  return sum / Math.min(28, used);
}
/** 过去 4 周末的累计已学（按 firstAt 事实数）+ 按 daily 外推；daily=0 时 daysLeft=null */
export function forecast({ total, learnedN, learnedAt, daily, nowMs, tooNew = false }) {
  const past = [21, 14, 7, 0].map(k => k === 0 ? learnedN : learnedAt.filter(t => t <= nowMs - k * DAY).length);
  const remaining = Math.max(0, total - learnedN);
  const daysLeft = daily > 0 ? Math.max(1, Math.ceil(remaining / daily)) : null;
  const weeks = daysLeft ? Math.max(1, Math.ceil(daysLeft / 7)) : 0;
  const future = [];
  for (let i = 1; i <= Math.max(1, Math.min(weeks, 52)); i++) future.push(Math.min(total, learnedN + (daily || 0) * 7 * i));
  const L = 10, R = 300, TOP = 24, BOT = 116;
  const NOW = L + (R - L) * 0.34;
  const n = 3 + future.length;
  const x = i => i <= 3 ? L + (NOW - L) * i / 3 : NOW + (R - NOW) * (i - 3) / (n - 3);
  const y = v => BOT - (BOT - TOP) * (total ? v / total : 0);
  const d = arr => arr.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const pastPts = past.map((v, i) => [x(i), y(v)]);
  const futurePts = [[x(3), y(learnedN)]].concat(future.map((v, i) => [x(4 + i), y(v)]));
  const end = futurePts[futurePts.length - 1];
  const date = daysLeft ? new Date(nowMs + daysLeft * DAY) : null;
  return {
    pastPath: d(pastPts), futurePath: daily > 0 ? d(futurePts) : '', areaPath: d(pastPts) + ' L' + x(3).toFixed(1) + ' ' + BOT + ' L' + L + ' ' + BOT + ' Z',
    nowX: x(3), nowY: y(learnedN), endX: daily > 0 ? end[0] : x(3), endY: daily > 0 ? end[1] : y(learnedN),
    nowLabelX: (x(3) - 14).toFixed(0) + 'px', yTop: TOP, yMid: (TOP + BOT) / 2, daysLeft, weeks,
    doneDate: date ? (daysLeft > 365 ? '按现在的速度要约 ' + Math.round(daysLeft / 365) + ' 年才能' : fmtMD(date)) : (remaining === 0 ? '已经' : tooNew ? '多用几天，才算得出哪天' : '多记几个词，才算得出哪天'),
    doneDateShort: date ? (date.getMonth() + 1) + '/' + date.getDate() : '—'
  };
}

// ---------- 记忆曲线坐标（列表缩略图与学习日志大图同一函数，PRD §11 红线二） ----------
export function ebbAt(m, t) { return M.retentionAt(m, t); }
function ebbPath(m, t0, t1, x, y) {
  if (!m.n) return '';
  let d = '';
  for (let i = 0; i < m.n; i++) {
    const st = Math.max(m.revs[i], t0);
    const en = i + 1 < m.n ? Math.min(m.revs[i + 1], t1) : t1;
    if (en < t0 || st > t1 || en < st) continue;
    for (let k = 0; k <= 14; k++) {
      const t = st + (en - st) * k / 14;
      const r = m.P[i] * Math.pow(1 + (t - m.revs[i]) / m.S[i], -0.5);
      d += (d ? ' L' : 'M') + x(t).toFixed(1) + ' ' + y(r).toFixed(1);
    }
    if (i + 1 < m.n && m.revs[i + 1] <= t1) d += ' L' + x(m.revs[i + 1]).toFixed(1) + ' ' + y(m.P[i + 1]).toFixed(1);
  }
  return d;
}
/** m = M.buildHistory(...)（时间相对 now）。只用已发生的复习画实线，未来只画纯衰减虚线 */
export function ebbChart(mFull, w, h, padX, padT, padB, lastN, cfg = M.DEFAULT_CONFIG) {
  const mp = M.truncateToNow(mFull, 0);
  const nextAt = M.nextDue(mFull, 0, cfg);
  const overdue = nextAt <= 0;
  const from = Math.max(0, mp.n - lastN);
  const t0 = mp.revs[from];
  const t1 = overdue ? 0 : nextAt;
  let low = ebbAt(mp, t1), high = 0;
  for (let i = from; i < mp.n; i++) { high = Math.max(high, mp.P[i]); if (i > from) low = Math.min(low, ebbAt(mp, mp.revs[i] - 1e-4)); }
  low = Math.min(low, ebbAt(mp, 0));
  const lo = Math.max(0, Math.min(low, 0.72) - 0.02), hi = Math.min(1, high + 0.02);
  const x = t => padX + (w - padX * 2) * (t - t0) / (t1 - t0 || 1);
  const y = r => (h - padB) - (h - padB - padT) * (r - lo) / (hi - lo || 1);
  const past = ebbPath(mp, t0, 0, x, y);
  return {
    past, future: overdue ? '' : ebbPath(mp, 0, t1, x, y),
    area: past ? past + ' L' + x(0).toFixed(1) + ' ' + (h - padB) + ' L' + x(t0).toFixed(1) + ' ' + (h - padB) + ' Z' : '',
    dots: mp.revs.slice(from).map((r, k) => ({ cx: x(r).toFixed(1), cy: y(mp.P[from + k]).toFixed(1) })),
    nowX: x(0).toFixed(1), nowY: y(ebbAt(mp, 0)).toFixed(1), thrY: y(cfg.TARGET).toFixed(1), baseY: (h - padB).toFixed(1),
    nextAt
  };
}

// ---------- 替换引擎渲染阶段（PRD §12 + 已拍板 Q10 三条软规则） ----------
/**
 * slots: 本章词位 [{o,l,w,c}]（offset 升序）
 * ctx: {inDeck(w), entryState(w) → 'learned'|'demoted'|null, muted(w), lvOf(w), freq{w:n}, den, DEN_CAP, chars, showEn}
 * 返回与 slots 同序的 mode 数组：'en' | 'both' | 'zh'
 *
 * 口径：
 *  · 候选 = 词表内的词 ∪ 已记下的词（W4：词单外不补）；其余词位不标注
 *  · 已记下未忘的词：所有位置 en（PRD §18「记下后正文中该词所有位置立即变为纯英文」）
 *  · 上次选「忘了」的词：所有位置 both（PRD §19 已定：退回中英对照）
 *  · 新词（R2 · 01 B1 · 拍板 Q6）：六档 = 每千字上限 DEN_CAP[den]，本章名额 = floor(上限 × 本章字数 / 1000)。
 *          候选按「本书复现次数降序 → lv 升序 → 字母序 → 位置」排（Q10-③；lv 只做并列次序，不再硬过滤），
 *          按这个次序逐个取：同一分句已有一处（Q10-①）或本章这个词已出过（Q10-②）就跳过，取满名额为止。
 *          排序键全是书内固定事实 → 同一本书同一状态每次打开结果一样。
 *          （旧口径是「lv 硬过滤 + 名次取模」，那是抽样率不是密度，六级「适中」在《牧神记》上只有 3.3 / 千字，见 docs/Rebuild-1/密度量尺.md）
 */
export function slotModes(slots, ctx) {
  const modes = new Array(slots.length).fill(null);
  const fresh = [];
  slots.forEach((s, i) => {
    const st = ctx.entryState(s.w);
    if (!st && !ctx.inDeck(s.w)) return;                       // 不是词位
    if (!ctx.showEn || ctx.muted(s.w)) { modes[i] = 'zh'; return; }
    if (st === 'learned') { modes[i] = 'en'; return; }
    if (st === 'demoted') { modes[i] = 'both'; return; }
    fresh.push(i);
  });
  const sw = (a, b) => (slots[a].w < slots[b].w ? -1 : slots[a].w > slots[b].w ? 1 : 0);
  const order = fresh.slice().sort((a, b) => (ctx.freq[slots[b].w] || 0) - (ctx.freq[slots[a].w] || 0) || ctx.lvOf(slots[a].w) - ctx.lvOf(slots[b].w) || sw(a, b) || slots[a].o - slots[b].o);
  let budget = Math.floor(ctx.DEN_CAP[ctx.den] * (ctx.chars || 0) / 1000);
  const usedClause = new Set(), usedWord = new Set();
  for (const i of fresh) modes[i] = 'zh';
  for (const i of order) {
    if (budget <= 0) break;
    const s = slots[i];
    if (usedWord.has(s.w) || (s.c >= 0 && usedClause.has(s.c))) continue;
    modes[i] = 'both';
    budget--;
    usedWord.add(s.w);
    if (s.c >= 0) usedClause.add(s.c);
  }
  return modes;
}

// ---------- 纠错作用域（R2 · 01 A11）：「这个词不对」只让本书暂停替换，不写全局 mute，不影响复习 ----------
/** 用户自己点的「不再替换」才是全局的；旧数据里 by:'feedback' 的全局 mute 一律不认（纠错改为书内） */
export function userMuted(muted, w) { const m = muted && muted[w]; return !!m && m.by !== 'feedback'; }
/** 某本书里被纠错暂停的词（没有被恢复的反馈） */
export function pausedSet(feedback, bookHash) {
  const set = new Set();
  if (!bookHash) return set;
  for (const f of feedback || []) if (f.bookHash === bookHash && !f.resumedAt) set.add(f.w);
  return set;
}
/**
 * 重对齐之后，这条纠错是不是已经被修好了（2026-09-16 · 07 闭环最后一步）。
 * 判据：它记下的那个位置（章 + 码点偏移）现在已经不再替成同一个词 ——
 *      桥被删掉、被判给别的英文词、或被新的否决规则挡掉，三种都算解决。
 * 没有章 / 偏移的（从书籍面板点柱报的错）返回 false：不猜，保持手工恢复。
 */
export function feedbackFixed(f, slots) {
  if (!f || f.chapter == null || f.offset == null) return false;
  return !(slots || []).some(s => s.o === f.offset && s.w === f.w);
}
/** 设置页「纠错后暂停」列表：按（书，词）去重 */
export function pausedList(feedback) {
  const seen = new Map();
  for (const f of feedback || []) { if (f.resumedAt || !f.bookHash) continue; const k = f.bookHash + ' ' + f.w; if (!seen.has(k)) seen.set(k, { w: f.w, bookHash: f.bookHash, at: f.at }); }
  return [...seen.values()];
}

// ---------- 阅读手势与连续滚动（2026-09-16 · 用户验收：翻页不跟手 → 章与章之间要无缝） ----------
/** 横向 40px 是「确实在往左右滑」的最小位移（翻页模式用） */
export const SWIPE = { x: 40 };
/**
 * 一次滑动该做什么。**纯判定**：app.js 只量位移，判据全在这里。
 * 只有翻页模式有手势；滚动模式换章靠连续滚动（下面的 flow*），不靠「到底再推一下」——
 * 那个做法第一版上线后用户反馈：到底停一下、再推、闪一下跳回顶部，视线被迫从最底挪到最顶。
 * 返回 'nextPage' | 'prevPage' | null
 */
export function swipeAction({ paged, dx, dy }) {
  if (!paged) return null;
  if (Math.abs(dx) < SWIPE.x || Math.abs(dx) <= Math.abs(dy)) return null;   // 斜着滑不算翻页
  return dx < 0 ? 'nextPage' : 'prevPage';
}
/**
 * 连续滚动。正文里同时挂着相邻几章，章与章之间只隔一行章节标题。
 *  readLine  视口从上往下 30% 那条线落在哪一章，哪一章就是「在读」—— 上一章最后几行还在屏幕上半截时不急着切
 *  above     在读章上面留几章（往回滚也是无缝的）
 *  below     下面留几章：留 2 章，接近章末时下一章早已排好版，滚不出空白
 *  idleMs    滚动停下多久才动「在读章上方」的 DOM（动上方要补偿 scrollTop，iOS 惯性滚动中改 scrollTop 会把惯性掐断）
 */
export const FLOW = { readLine: 0.3, above: 1, below: 2, idleMs: 220 };
/**
 * geo: [{chapter, top, bottom}]（正文坐标，按章顺序）；top: scrollTop；height: 视口高
 * 返回 { chapter, ratio }：ratio 与单章时代同口径 —— 章首顶到视口顶为 0，章末贴到视口底为 1
 */
export function flowLocate(geo, top, height) {
  if (!geo || !geo.length) return null;
  const line = top + height * FLOW.readLine;
  const g = geo.find(x => line < x.bottom) || geo[geo.length - 1];
  const span = g.bottom - g.top - height;
  const ratio = span > 0 ? (top - g.top) / span : (top + height - g.top) / Math.max(1, g.bottom - g.top);
  return { chapter: g.chapter, ratio: Math.min(1, Math.max(0, ratio)) };
}
/**
 * 章窗口该长什么样。have: 现在 DOM 里的章号（升序连续）；cur: 在读章；n: 总章数
 *  want    理想窗口 [cur-above, cur+below]
 *  append  在读章**下面**缺的章 —— 往下接不改上方高度，随时可以接，不用等停
 *  settled 窗口已经就是 want（停下来时就不用再动 DOM）
 */
export function flowPlan(have, cur, n) {
  const lo = Math.max(0, cur - FLOW.above), hi = Math.min(n - 1, cur + FLOW.below);
  const set = new Set(have);
  const want = [], append = [];
  for (let i = lo; i <= hi; i++) want.push(i);
  for (let i = cur + 1; i <= hi; i++) if (!set.has(i)) append.push(i);
  const settled = want.length === have.length && want.every((x, i) => x === have[i]);
  return { want, append, settled };
}

// ---------- 六档与已会线（R2 · 01 B1 B3 · 拍板 Q6 Q7；数值依据 docs/Rebuild-1/密度量尺.md） ----------
/**
 * 六档 = 每千字上限（与服务端 routes/core.mjs DEFAULT_DENSITY 同值）。
 * 2026-09-16 用户验收：原来的 3 / 5 / 7 / 9 / 11 / 13 六档整体太稀，最密一档读下来也几乎碰不到英文，
 * 拍板「每一档都乘 2」——档位关系不变，只把整条尺子拉到两倍。
 */
export const DEN_CAP = [6, 10, 14, 18, 22, 26];
/** 引导第 3 步强度预览的取样字数：600 字时六档名额 3 / 6 / 8 / 10 / 13 / 15，看得出差别 */
export const PREVIEW_CHARS = 600;
/** 已会线：词频名次 ≤ 线的词默认「已会」——不替、不进未学列表与书封柱。线随自测词汇量走，没自测按最保守的 300 */
export const KNOWN_LINE = { min: 300, max: 1500, perEst: 0.5 };
export function knownLine(quizEst) {
  if (!(quizEst > 0)) return KNOWN_LINE.min;
  return Math.round(Math.min(KNOWN_LINE.max, Math.max(KNOWN_LINE.min, quizEst * KNOWN_LINE.perEst)));
}
/** rank 缺失或 9999（词库里没有词频）不算基础词 */
export function isBasic(rank, line) { return rank > 0 && rank < 9999 && rank <= line; }

// ---------- 词频图（R2 · 01 D4 D7 D8）：书封柱 / 面板柱与图例 / 覆盖数 / 词表推荐只有这一份口径 ----------
/**
 * freq: bookidx 的 {w: 本书出现次数}
 * ctx: { isDeckWord(w) 词表内且过了已会线（app.newWordOf）· hasEntry(w) 已记下 · hidden(w) 全局不再替换或本书纠错暂停 · tier(w) 'solid'|'ok'|'due'|null }
 * 返回 { rows, hit, legend }
 *  rows   画柱用的词 [w, n]，次数降序 → 字母序（书内固定事实，每次打开顺序一样）
 *         = 词表内的新词 ∪ 已记下的词（D9：别的词表记下的也画，设计意图保留）
 *         剔掉 hidden 的词（D7：正文里已经不替换了，不该继续画在图上、也不该算进覆盖数）
 *  hit    这本书里出现过的词表词个数（含已记下的）——书封「N 个四级词」与词表推荐排序都用它（D8）
 *  legend [牢固, 学习中, 未学]，数**全书**不是只数画出来的那几根柱（D4）
 */
export function bookStats(freq, ctx) {
  const rows = [];
  const legend = [0, 0, 0];
  let hit = 0;
  for (const w in freq) {
    if (ctx.hidden(w)) continue;
    const isDeck = ctx.isDeckWord(w);
    if (!isDeck && !ctx.hasEntry(w)) continue;
    if (isDeck) hit++;
    const tr = ctx.tier(w);
    legend[!tr ? 2 : tr === 'solid' ? 0 : 1]++;
    rows.push([w, freq[w]]);
  }
  rows.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return { rows, hit, legend };
}
/** 分桶直方图（D1 · 拍板 Q10）：横轴固定，柱高 = 落在该桶的词数，按三档掌握堆叠 */
export const FREQ_BUCKETS = [[1, 1, '1'], [2, 2, '2'], [3, 5, '3–5'], [6, 10, '6–10'], [11, 20, '11–20'], [21, Infinity, '21+']];
export function freqHistogram(rows, tierOfWord) {
  const bins = FREQ_BUCKETS.map(([, , label]) => ({ label, n: 0, g: [0, 0, 0] }));
  for (const [w, n] of rows) {
    const i = FREQ_BUCKETS.findIndex(([lo, hi]) => n >= lo && n <= hi);
    if (i < 0) continue;
    const tr = tierOfWord(w);
    bins[i].n++;
    bins[i].g[!tr ? 2 : tr === 'solid' ? 0 : 1]++;
  }
  return bins;
}

/** 章节字数口径（每千字的分母）：非空白码点数，含标点。量尺脚本与阅读器同一函数 */
export function charCount(text) { let n = 0; for (const ch of text || '') if (!/\s/.test(ch)) n++; return n; }

/** 客户端自建词库归一（与服务端 customDeck.normalizeTokens 同口径） */
export function normalizeTokens(raw) {
  const out = [], seen = new Set();
  let filtered = 0;
  for (const t of raw) {
    const k = String(t).trim().toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, '');
    if (!k || !/^[a-z][a-z'-]*$/.test(k)) { if (String(t).trim()) filtered++; continue; }
    if (seen.has(k)) continue;
    seen.add(k); out.push(k);
  }
  return { words: out, filtered };
}
