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
export const BADGE_KEYS = ['streak7', 'words100', 'night10', 'book1', 'words1000', 'month'];
export function badgeFacts(data, today) {
  const words = Object.values(data.entries).filter(activeEntry).length;
  const nightDays = Object.values(data.hours).filter(h => h.slice(BADGE_T.nightHour).some(s => s > 0)).length;
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
export function dailyRate(dailies, today) {
  let sum = 0;
  for (let i = 0; i < 28; i++) { const d = dailies[addDays(today, -i)]; if (d) sum += d.newWords || 0; }
  return sum / 28;
}
/** 过去 4 周末的累计已学（按 firstAt 事实数）+ 按 daily 外推；daily=0 时 daysLeft=null */
export function forecast({ total, learnedN, learnedAt, daily, nowMs }) {
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
    doneDate: date ? (daysLeft > 365 ? '按现在的速度要约 ' + Math.round(daysLeft / 365) + ' 年才能' : fmtMD(date)) : (remaining === 0 ? '已经' : '多记几个词，才算得出哪天'),
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
 * ctx: {inDeck(w), entryState(w) → 'learned'|'demoted'|null, muted(w), lvOf(w), freq{w:n}, den, DEN_LV, DEN_TAKE, showEn}
 * 返回与 slots 同序的 mode 数组：'en' | 'both' | 'zh'
 *
 * 口径：
 *  · 候选 = 词表内的词 ∪ 已记下的词（W4：词单外不补）；其余词位不标注
 *  · 已记下未忘的词：所有位置 en（PRD §18「记下后正文中该词所有位置立即变为纯英文」）
 *  · 上次选「忘了」的词：所有位置 both（PRD §19 已定：退回中英对照）
 *  · 新词：lv ≤ DEN_LV[den] 且「按本书复现次数排序后的名次 % 6 < DEN_TAKE[den]」（Q10-③，排序键全是书内固定事实 → 稳定可复现）
 *          再叠 Q10-① 同一分句只留第一处、Q10-② 同章同词第二次起降回汉语
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
  const order = fresh.slice().sort((a, b) => (ctx.freq[slots[b].w] || 0) - (ctx.freq[slots[a].w] || 0) || (slots[a].w < slots[b].w ? -1 : slots[a].w > slots[b].w ? 1 : 0) || slots[a].o - slots[b].o);
  const rank = new Map(order.map((i, k) => [i, k]));
  const usedClause = new Set(), usedWord = new Set();
  for (const i of fresh) {
    const s = slots[i];
    const inDensity = ctx.lvOf(s.w) <= ctx.DEN_LV[ctx.den] && rank.get(i) % 6 < ctx.DEN_TAKE[ctx.den];
    if (!inDensity || usedWord.has(s.w) || (s.c >= 0 && usedClause.has(s.c))) { modes[i] = 'zh'; continue; }
    modes[i] = 'both';
    usedWord.add(s.w);
    if (s.c >= 0) usedClause.add(s.c);
  }
  return modes;
}

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
