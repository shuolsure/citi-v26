// 设计稿模板运行时：直接渲染 web/V26.1/source-shell.html（sc-if / sc-for / {{ path }} / sc-camel-on-* / ref / style-active）。
// 视觉 1:1 靠「不改模板结构」保证；数据全部来自 app.js 的 renderVals()。
// 更新策略：每次 render 生成轻量 vnode 树，按「模板位置 + 循环下标」做 key 打补丁，
// 同一个 key 永远复用同一个 DOM 节点 → 输入框焦点、滚动位置、CSS 过渡都不丢。

const SVG_NS = 'http://www.w3.org/2000/svg';
const RE = /\{\{\s*([^}]+?)\s*\}\}/g;

function parts(str) {
  if (!str.includes('{{')) return null;
  const out = []; let last = 0; let m;
  RE.lastIndex = 0;
  while ((m = RE.exec(str))) {
    if (m.index > last) out.push(str.slice(last, m.index));
    out.push({ path: m[1].split('.') });
    last = m.index + m[0].length;
  }
  if (last < str.length) out.push(str.slice(last));
  return out;
}
const camel = s => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function compileNode(n) {
  if (n.nodeType === 3) {
    const t = n.nodeValue;
    if (!t.trim() && t.includes('\n')) return null;          // 缩进空白
    return { type: 'text', text: t, parts: parts(t) };
  }
  if (n.nodeType !== 1) return null;
  const tag = n.localName;
  const kids = () => [...n.childNodes].map(compileNode).filter(Boolean);
  if (tag === 'sc-if') return { type: 'if', path: parts(n.getAttribute('value'))[0].path, children: kids() };
  if (tag === 'sc-for') return { type: 'for', path: parts(n.getAttribute('list'))[0].path, as: n.getAttribute('as'), children: kids() };
  const el = { type: 'el', tag, ns: n.namespaceURI === SVG_NS ? SVG_NS : null, attrs: [], on: [], ref: null, active: null, hover: null, children: kids() };
  for (const a of n.attributes) {
    let name = a.name;
    if (name.startsWith('hint-')) continue;
    if (name.startsWith('sc-camel-on-')) { el.on.push({ type: name.slice(12).replace(/-/g, ''), path: parts(a.value)[0].path }); continue; }
    if (name === 'ref') { el.ref = parts(a.value)[0].path; continue; }
    if (name === 'style-active') { el.active = a.value; continue; }
    if (name === 'style-hover') { el.hover = a.value; continue; }
    if (name.startsWith('sc-camel-')) name = camel(name.slice(9));
    el.attrs.push({ name, value: a.value, parts: parts(a.value) });
  }
  return el;
}

export function compile(html) {
  const doc = new DOMParser().parseFromString('<!doctype html><body>' + html + '</body>', 'text/html');
  return [...doc.body.childNodes].map(compileNode).filter(Boolean);
}

function lookup(scope, path) {
  let v = scope[path[0]];
  for (let i = 1; i < path.length && v != null; i++) v = v[path[i]];
  return v;
}
function interp(p, scope) {
  if (!p) return null;
  if (p.length === 1 && typeof p[0] !== 'string') { const v = lookup(scope, p[0].path); return v == null ? '' : v; }
  let s = '';
  for (const x of p) s += typeof x === 'string' ? x : (v => v == null ? '' : v)(lookup(scope, x.path));
  return s;
}

function build(nodes, scope, prefix, out) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i], k = prefix + '.' + i;
    if (n.type === 'text') { out.push({ k, text: n.parts ? String(interp(n.parts, scope)) : n.text }); continue; }
    if (n.type === 'if') { if (lookup(scope, n.path)) build(n.children, scope, k, out); continue; }
    if (n.type === 'for') {
      const list = lookup(scope, n.path) || [];
      for (let j = 0; j < list.length; j++) {
        const item = list[j];
        const s = Object.create(scope); s[n.as] = item;
        build(n.children, s, k + '#' + (item && item.key != null ? item.key : j), out);
      }
      continue;
    }
    const v = { k, tag: n.tag, ns: n.ns, attrs: {}, on: {}, ref: null, active: n.active, hover: n.hover, children: [] };
    for (const a of n.attrs) v.attrs[a.name] = a.parts ? String(interp(a.parts, scope)) : a.value;
    for (const e of n.on) v.on[e.type] = lookup(scope, e.path);
    if (n.ref) v.ref = lookup(scope, n.ref);
    build(n.children, scope, k, v.children);
    out.push(v);
  }
  return out;
}

function create(v) {
  if (v.text !== undefined) { const t = document.createTextNode(v.text); t.__k = v.k; return t; }
  const d = v.ns ? document.createElementNS(v.ns, v.tag) : document.createElement(v.tag);
  d.__k = v.k; d.__a = {}; d.__on = {}; d.__lt = new Set(); d.__new = true;
  return d;
}

// SVG 的 stroke/fill 属性写 var(--x) 浏览器不认（设计稿本身就这么写），改走行内 style，模板不动
const SVG_VAR_ATTRS = ['stroke', 'fill'];
function styleOf(d, v) {
  let s = v.attrs.style || '';
  if (v.ns) for (const k of SVG_VAR_ATTRS) { const x = v.attrs[k]; if (x && x.includes('var(')) s = k + ':' + x + ';' + s; }
  if (d.__hov && v.hover) s += ';' + v.hover;
  if (d.__act && v.active) s += ';' + v.active;
  return s;
}

function update(d, v) {
  if (v.text !== undefined) { if (d.nodeValue !== v.text) d.nodeValue = v.text; return; }
  d.__v = v;
  const prev = d.__a;
  for (const name in v.attrs) {
    if (name === 'style' || name === 'value') continue;
    if (prev[name] !== v.attrs[name]) d.setAttribute(name, v.attrs[name]);
  }
  for (const name in prev) if (!(name in v.attrs)) d.removeAttribute(name);
  const st = styleOf(d, v);
  if (d.__style !== st) { d.setAttribute('style', st); d.__style = st; }
  if ('value' in v.attrs) {
    const val = v.attrs.value;
    if (d.value !== val && !(document.activeElement === d && d.__typed === val)) d.value = val;
  }
  d.__a = v.attrs;
  d.__on = v.on;
  for (const type in v.on) {
    if (d.__lt.has(type)) continue;
    d.__lt.add(type);
    d.addEventListener(type, e => {
      if (type === 'input') d.__typed = d.value;
      const f = d.__on[type];
      if (typeof f === 'function') f(e);
    }, type === 'scroll' ? { passive: true } : undefined);
  }
  if ((v.active || v.hover) && !d.__press) {
    d.__press = true;
    const set = (k, on) => { if (d[k] === on) return; d[k] = on; const s = styleOf(d, d.__v); d.setAttribute('style', s); d.__style = s; };
    d.addEventListener('pointerdown', () => set('__act', true));
    for (const t of ['pointerup', 'pointercancel', 'pointerleave']) d.addEventListener(t, () => set('__act', false));
    d.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') set('__hov', true); });
    d.addEventListener('pointerleave', () => set('__hov', false));
  }
  patchChildren(d, v.children);
  if (d.__new) { d.__new = false; if (typeof v.ref === 'function') v.ref(d); }
}

export function patchChildren(parent, vs) {
  const old = parent.__kids || [];
  const byKey = new Map();
  for (const d of old) byKey.set(d.__k, d);
  const next = [];
  for (const v of vs) {
    let d = byKey.get(v.k);
    if (d && ((v.text !== undefined) !== (d.nodeType === 3) || (v.tag && d.localName !== v.tag))) d = null;
    if (d) byKey.delete(v.k); else d = create(v);
    next.push([d, v]);
  }
  for (const d of byKey.values()) d.remove();
  let cursor = parent.firstChild;
  for (const [d] of next) {
    if (d !== cursor) parent.insertBefore(d, cursor);
    else cursor = cursor.nextSibling;
  }
  parent.__kids = next.map(x => x[0]);
  for (const [d, v] of next) update(d, v);
}

/** 挂载：返回 render()。scheduleRender 合并同一轮的多次 setState。 */
export function mount(rootEl, template, getVals) {
  const tpl = compile(template);
  let queued = false;
  const render = () => {
    queued = false;
    const vals = getVals();
    patchChildren(rootEl, build(tpl, vals, 'r', []));
  };
  const schedule = () => { if (!queued) { queued = true; queueMicrotask(render); } };
  return { render, schedule };
}

export const _internal = { build, compile, lookup };
