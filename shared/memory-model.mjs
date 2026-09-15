/**
 * 词替 · 记忆模型参考实现 v2（一期拍板 Q1；二期 R1 按 docs/Rebuild-1 拍板 Q1 Q2 Q3 修正）
 * ---------------------------------------------------------------
 * 与 web/contracts/memory-model.js（v1）的唯一区别：
 *   v1 的词条只存 firstAt + n + grades，重建学习史时假定每次复习都恰好发生在
 *   留存降到 TARGET 的「理想时刻」。用户一旦逾期复习（现实里几乎总是逾期），
 *   重建出来的历史与真实不符：逾期词复习完仍留在到期队列里（见 check.mjs）。
 *   v2 把「每次复习的时间」也当事实存下来（reviews[].at），重建只用真实时刻。
 *
 * 二期 R1（2026-09-16，数字见 docs/Rebuild-1/05）：
 *   · 统一到期线 DUE_AT = TARGET = 0.75：按钮「+N 天」、列表「N 日后」、进今日队列是同一时刻（E1）
 *   · 收益按复习时留存折算 f = clamp((1 − r)/(1 − TARGET), 0, 1)：刚复习完再按几乎不拿，堵刷分；
 *     按时复习 r = TARGET → f = 1，逾期 f 夹到 1，两种情况与折算前逐位相同（E2）
 *   · 按钮允许 +0 天（逾期按模糊/忘了复习完仍到期，E4）
 *   · 「牢固」按稳定度 S ≥ SOLID_S = 21 天，不按留存（E3）
 *
 * 仍然遵守三条原则：只存事实不存曲线；只用已发生的复习；参数由服务端下发。
 * 时间单位：天，相对 now（0 = 现在，负数 = 过去）。接口层的 ISO 字符串
 * 由 toDays() 换算，模型内部不碰日期。
 */

export const DEFAULT_CONFIG = {
  P0: 0.85,            // 初始留存
  S0: 3,               // 初始稳定度（天）
  TARGET: 0.75,        // 遗忘临界线（下次复习安排在留存降到此值的时刻）
  DUE_AT: 0.75,        // 入队阈值（R1：与 TARGET 同一条线）
  SOLID_S: 21,         // 「牢固」：稳定度 ≥ 21 天（R1）
  // 三档反馈：peak = r + (1 - r) * gain；理想时刻（r = TARGET）恰好得到 0.95 / 0.88 / 0.85
  GRADES: {
    keep:   { gain: 0.80, stabilityMul: 2.25 },
    fuzzy:  { gain: 0.52, stabilityMul: 1.30 },
    forget: { gain: 0.40, stabilityMul: null }   // null = 稳定度重置为 S0
  }
};

/** ISO 时间 → 相对 now 的天数（负数为过去） */
export function toDays(iso, nowMs = Date.now()) {
  return (new Date(iso).getTime() - nowMs) / 864e5;
}

/** 单段幂律衰减 R(t) = P · (1 + Δt / S) ^ -0.5 */
function decay(P, S, dt) { return P * Math.pow(1 + Math.max(0, dt) / S, -0.5); }

/**
 * 由事实重建学习史。
 * @param {{first:number, reviews?:Array<{at:number, grade:string}>}} e
 *        first 与 reviews[].at 均为相对 now 的天数；reviews 按时间升序
 * @returns {{revs:number[], P:number[], S:number[], n:number}}
 */
export function buildHistory(e, config = DEFAULT_CONFIG) {
  const c = config;
  const revs = [e.first], P = [c.P0], S = [c.S0];
  for (const rv of (e.reviews || [])) {
    const L = revs.length - 1;
    const g = c.GRADES[rv.grade];
    if (!g) throw new Error('unknown grade: ' + rv.grade);
    const r = decay(P[L], S[L], rv.at - revs[L]);       // 复习那一刻的真实留存
    const f = Math.min(1, Math.max(0, (1 - r) / (1 - c.TARGET)));   // 收益折算：离临界线越远拿得越少
    const peak = Math.min(0.99, r + (1 - r) * g.gain * f);
    const s = g.stabilityMul === null ? c.S0 : S[L] * (1 + (g.stabilityMul - 1) * f);
    revs.push(rv.at); P.push(peak); S.push(s);
  }
  return { revs, P, S, n: revs.length };
}

/** 只保留已发生（<= now）的记录。第一条（首次记下）永远保留。 */
export function truncateToNow(m, now = 0) {
  let k = 0;
  for (let i = 0; i < m.n; i++) if (m.revs[i] <= now) k++;
  if (!k) k = 1;
  return { revs: m.revs.slice(0, k), P: m.P.slice(0, k), S: m.S.slice(0, k), n: k };
}

/** 任意时刻的留存率 0–1 */
export function retentionAt(m, t) {
  let i = -1;
  for (let k = 0; k < m.n; k++) if (m.revs[k] <= t) i = k;
  if (i < 0) return 0;
  return decay(m.P[i], m.S[i], t - m.revs[i]);
}

/** 下次复习的最佳时刻（天，相对 now；负数 = 已过期） */
export function nextDue(m, now = 0, config = DEFAULT_CONFIG) {
  const mp = truncateToNow(m, now);
  const L = mp.n - 1;
  return mp.revs[L] + mp.S[L] * (Math.pow(mp.P[L] / config.TARGET, 2) - 1);
}

export function retentionNow(e, now = 0, config = DEFAULT_CONFIG) {
  return retentionAt(truncateToNow(buildHistory(e, config), now), now);
}

export function isDue(e, now = 0, config = DEFAULT_CONFIG) {
  if (e.muted) return false;
  return retentionNow(e, now, config) < config.DUE_AT;
}

/** 今日复习队列：按留存升序。进入复习时一次性生成，中途不插队。 */
export function buildQueue(entries, now = 0, config = DEFAULT_CONFIG) {
  return entries
    .filter(e => !e.muted)
    .map(e => ({ w: e.w, r: retentionNow(e, now, config) }))
    .filter(x => x.r < config.DUE_AT)
    .sort((a, b) => a.r - b.r)
    .map(x => x.w);
}

/**
 * 预览一次反馈的结果（按钮文案「下次 +N 天」用），不改词条。
 * 真正落库的只是一条 review 事实 { at: now, grade }。
 */
export function previewGrade(e, grade, now = 0, config = DEFAULT_CONFIG) {
  const e2 = { ...e, reviews: (e.reviews || []).concat([{ at: now, grade }]) };
  const m = buildHistory(e2, config);
  const L = m.n - 1;
  const days = m.S[L] * (Math.pow(m.P[L] / config.TARGET, 2) - 1);
  return { peak: m.P[L], stability: m.S[L], days: Math.max(0, Math.round(days)), demoted: grade === 'forget' };
}

/** 留存构成：待复习 = 到期（r < DUE_AT）/ 牢固 = 未到期且稳定度 ≥ SOLID_S / 一般 = 其余未到期 */
export function retentionBreakdown(entries, now = 0, config = DEFAULT_CONFIG) {
  let solid = 0, ok = 0, due = 0;
  for (const e of entries) {
    if (e.muted) continue;
    const m = truncateToNow(buildHistory(e, config), now);
    if (retentionAt(m, now) < config.DUE_AT) due++;
    else if (m.S[m.n - 1] >= config.SOLID_S) solid++; else ok++;
  }
  return { solid, ok, due };
}

/** 理想节奏（每次都在临界线上选「记得」）的排程，只用于引导页/文档里的示意数字 */
export function idealSchedule(n, config = DEFAULT_CONFIG) {
  const e = { first: 0, reviews: [] };
  for (let i = 1; i < n; i++) {
    const m = buildHistory(e, config);
    const L = m.n - 1;
    const at = m.revs[L] + m.S[L] * (Math.pow(m.P[L] / config.TARGET, 2) - 1);
    e.reviews.push({ at, grade: 'keep' });
  }
  return buildHistory(e, config);
}
