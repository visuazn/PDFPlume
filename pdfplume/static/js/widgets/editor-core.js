// Page viewer + object editor shared by Edit PDF, Sign PDF and Redact PDF.
// Element positions are stored as fractions (0..1) of the visible page, sizes
// of text and strokes in PDF points, so the server can redraw them exactly.
import { api } from '../api.js';
import { h } from '../ui.js';

export const FAMILY = {
  helvetica: 'Helvetica, Arial, "Liberation Sans", sans-serif',
  times: '"Times New Roman", Times, "Liberation Serif", serif',
  courier: '"Courier New", Courier, "Liberation Mono", monospace',
};
const SVGNS = 'http://www.w3.org/2000/svg';
const BOX_TYPES = new Set(['rect', 'ellipse', 'highlight', 'whiteout', 'area', 'image', 'text']);
const clone = (o) => JSON.parse(JSON.stringify(o));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
let nextId = 1;

function svg(tag, attrs = {}) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  return el;
}

export class EditorCore {
  /**
   * opts.tools: { name: { kind: 'box'|'line'|'path'|'click', make(p, page) -> element } }
   * opts.onSelect(el|null), opts.onChange(), opts.onDropField(type, p, page)
   */
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.opts = opts;
    this.elements = [];
    this.selected = null;
    this.editingId = null;
    this.tool = 'select';
    this.zoom = 1;
    this.history = [];
    this.pageInfo = [];
    this.views = [];
    this.overlays = {}; // page -> extra decorations (e.g. search matches)
    this.onKey = this.onKey.bind(this);
    document.addEventListener('keydown', this.onKey);
  }

  async load(file) {
    if (this.file && this.file.id === file.id && this.pageInfo.length) return;
    this.file = file;
    const { pages } = await api.get(`/api/files/${file.id}/pages`);
    this.pageInfo = pages;
    this.elements = [];
    this.history = [];
  }

  // -------------------------------------------------------------- layout
  mount(scroll) {
    this.scroll = scroll;
    this.renderPages();
  }

  baseWidth() {
    const avail = (this.scroll && this.scroll.clientWidth) || 900;
    return Math.max(240, Math.min(avail - 48, 920)) * this.zoom;
  }

  renderPages() {
    if (!this.scroll) return;
    const keep = this.scroll.scrollTop / Math.max(1, this.scroll.scrollHeight);
    this.scroll.innerHTML = '';
    const viewer = h('div', { class: 'viewer' });
    const maxW = Math.max(...this.pageInfo.map((p) => p.w), 1);
    const base = this.baseWidth();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.views = this.pageInfo.map((p, i) => {
      const w = base * (p.w / maxW);
      const hgt = w * (p.h / p.w);
      const req = Math.min(2400, Math.ceil((w * dpr) / 200) * 200);
      const img = h('img', { src: api.thumb(this.file.id, i, req), loading: i < 3 ? 'eager' : 'lazy', alt: '', draggable: 'false' });
      const layer = h('div', { class: 'layer' });
      const page = h('div', { class: 'vpage', 'data-page': i, style: { width: `${w}px`, height: `${hgt}px` } }, img, layer,
        h('div', { class: 'pno' }, `${i + 1} / ${this.pageInfo.length}`));
      layer.addEventListener('pointerdown', (e) => this.onDown(e, i));
      page.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('application/x-pdfplume-field')) { e.preventDefault(); page.classList.add('drop-target'); } });
      page.addEventListener('dragleave', () => page.classList.remove('drop-target'));
      page.addEventListener('drop', (e) => {
        page.classList.remove('drop-target');
        const type = e.dataTransfer.getData('application/x-pdfplume-field');
        if (!type || !this.opts.onDropField) return;
        e.preventDefault();
        this.opts.onDropField(type, this.frac(e, i), i);
      });
      viewer.append(page);
      return { page, layer, w, h: hgt, scale: w / p.w, info: p };
    });
    this.scroll.append(viewer);
    this.views.forEach((_, i) => this.renderLayer(i));
    this.scroll.scrollTop = keep * this.scroll.scrollHeight;
  }

  setZoom(z) {
    this.zoom = clamp(z, 0.4, 3);
    this.renderPages();
  }

  currentPage() {
    if (!this.scroll) return 0;
    const top = this.scroll.getBoundingClientRect().top;
    let best = 0;
    let bestVis = -1;
    this.views.forEach((v, i) => {
      const r = v.page.getBoundingClientRect();
      const vis = Math.min(r.bottom, top + this.scroll.clientHeight) - Math.max(r.top, top);
      if (vis > bestVis) { bestVis = vis; best = i; }
    });
    return best;
  }

  /** Centre of the part of page ``i`` that is currently scrolled into view. */
  visibleCenter(i) {
    const v = this.views[i];
    if (!v || !this.scroll) return { x: 0.5, y: 0.5 };
    const r = v.page.getBoundingClientRect();
    const s = this.scroll.getBoundingClientRect();
    const top = Math.max(r.top, s.top);
    const bottom = Math.min(r.bottom, s.bottom);
    const cy = bottom > top ? ((top + bottom) / 2 - r.top) / r.height : 0.5;
    return { x: 0.5, y: clamp(cy, 0.05, 0.95) };
  }

  frac(e, i) {
    const r = this.views[i].layer.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) };
  }

  // ------------------------------------------------------------ elements
  find(id) { return this.elements.find((e) => String(e.id) === String(id)); }

  snapshot() {
    this.history.push(JSON.stringify(this.elements));
    if (this.history.length > 60) this.history.shift();
  }

  undo() {
    if (!this.history.length) return;
    this.elements = JSON.parse(this.history.pop());
    this.selected = null;
    this.editingId = null;
    this.views.forEach((_, i) => this.renderLayer(i));
    this.changed();
  }

  add(el, { select = true, edit = false } = {}) {
    this.snapshot();
    el.id = nextId++;
    this.elements.push(el);
    if (select) this.selected = el;
    if (edit) this.editingId = el.id;
    this.renderLayer(el.page);
    if (edit) this.focusEditing();
    this.selectChanged();
    this.changed();
    return el;
  }

  remove(el) {
    if (!el) return;
    this.snapshot();
    this.elements = this.elements.filter((x) => x !== el);
    if (this.selected === el) this.selected = null;
    if (this.editingId === el.id) this.editingId = null;
    this.renderLayer(el.page);
    this.selectChanged();
    this.changed();
  }

  update(props) {
    const el = this.selected;
    if (!el) return;
    this.snapshot();
    Object.assign(el, props);
    this.renderLayer(el.page);
    if (this.editingId === el.id) this.focusEditing(false);
    this.changed();
  }

  select(el) {
    const prev = this.selected;
    this.selected = el;
    if (prev && prev.page !== (el && el.page)) this.renderLayer(prev.page);
    if (el) this.renderLayer(el.page);
    this.selectChanged();
  }

  selectChanged() { if (this.opts.onSelect) this.opts.onSelect(this.selected); }
  changed() { if (this.opts.onChange) this.opts.onChange(); }

  setTool(name, { keepEditing = false } = {}) {
    this.tool = name;
    if (!keepEditing) this.stopEditing();
    this.views.forEach((v) => v.layer.classList.toggle('drawing', name !== 'select'));
  }

  payload() {
    return this.elements.map(({ id, keepRatio, ...rest }) => rest);
  }

  // ----------------------------------------------------------- rendering
  renderLayer(i) {
    const v = this.views[i];
    if (!v) return;
    const { layer, scale } = v;
    const W = v.info.w;
    const H = v.info.h;
    layer.innerHTML = '';
    const shapes = svg('svg', { class: 'svg-layer', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' });
    layer.append(shapes);
    const items = this.elements.filter((e) => e.page === i);
    for (const el of items) {
      if (!el.replace) continue; // edited original text: hide the old line
      const [x0, y0, x1, y1] = el.replace;
      shapes.append(svg('rect', { x: x0 * W - 1, y: y0 * H - 0.5, width: (x1 - x0) * W + 2, height: (y1 - y0) * H + 1, fill: '#fff', 'pointer-events': 'none' }));
    }
    for (const el of items) {
      if (el.type === 'text') layer.append(this.textNode(el, scale));
      else if (el.type === 'image') {
        layer.append(h('div', { class: 'el', 'data-id': el.id, style: {
          left: `${el.x * 100}%`, top: `${el.y * 100}%`, width: `${el.w * 100}%`, height: `${el.h * 100}%`, opacity: el.opacity ?? 1 } },
        h('img', { src: el.src, alt: '', draggable: 'false' })));
      } else this.shapeNode(shapes, el, W, H, scale);
    }
    for (const deco of this.overlays[i] || []) {
      shapes.append(svg('rect', { x: deco.x0 * W, y: deco.y0 * H, width: (deco.x1 - deco.x0) * W, height: (deco.y1 - deco.y0) * H,
        fill: deco.fill || 'rgba(91,91,214,.28)', stroke: deco.stroke || '#5b5bd6', 'stroke-width': 1 / scale, 'pointer-events': 'none' }));
    }
    // Measure text boxes (their size depends on the font).
    for (const node of layer.querySelectorAll('.el.text')) {
      const el = this.find(node.dataset.id);
      if (el) { el.w = node.offsetWidth / v.w; el.h = node.offsetHeight / v.h; }
    }
    if (this.selected && this.selected.page === i) this.decorate(layer, this.selected, W, H, scale);
  }

  textNode(el, scale) {
    const editing = this.editingId === el.id;
    const d = h('div', { class: 'el text', 'data-id': el.id, contenteditable: editing ? 'true' : null, spellcheck: 'false' });
    Object.assign(d.style, {
      left: `${el.x * 100}%`, top: `${el.y * 100}%`, fontSize: `${el.size * scale}px`, color: el.color || '#000',
      fontFamily: FAMILY[el.font] || FAMILY.helvetica, fontWeight: el.bold ? '700' : '400', fontStyle: el.italic ? 'italic' : 'normal',
      textDecoration: el.underline ? 'underline' : 'none', textAlign: el.align || 'left', opacity: el.opacity ?? 1,
    });
    d.textContent = el.text;
    if (editing) {
      d.addEventListener('input', () => {
        el.text = d.innerText.replace(/\n$/, '');
        const v = this.views[el.page];
        el.w = d.offsetWidth / v.w;
        el.h = d.offsetHeight / v.h;
      });
      d.addEventListener('blur', () => setTimeout(() => { if (this.editingId === el.id) this.stopEditing(); }, 120));
      d.addEventListener('paste', (e) => {
        e.preventDefault();
        document.execCommand('insertText', false, (e.clipboardData || window.clipboardData).getData('text'));
      });
    }
    return d;
  }

  shapeNode(root, el, W, H, scale) {
    const op = el.opacity ?? 1;
    const sw = el.width ?? 2;
    const common = { 'data-id': el.id, class: 'shape' };
    if (BOX_TYPES.has(el.type)) {
      const x = el.x * W; const y = el.y * H; const w = el.w * W; const hh = el.h * H;
      let fill = el.fill || 'none';
      let stroke = el.stroke || 'none';
      let fillOpacity = op;
      let strokeWidth = sw;
      if (el.type === 'highlight') { fill = el.fill || '#ffeb3b'; stroke = 'none'; fillOpacity = el.opacity ?? 0.4; }
      if (el.type === 'whiteout') { fill = el.fill || '#ffffff'; stroke = '#c9c9d3'; strokeWidth = 0.6 / scale; fillOpacity = 1; }
      if (el.type === 'area') { fill = el.fill || '#000'; stroke = 'none'; fillOpacity = 0.72; }
      const attrs = { ...common, fill, stroke: stroke === 'none' ? null : stroke, 'stroke-width': stroke === 'none' ? null : strokeWidth,
        'fill-opacity': fill === 'none' ? null : fillOpacity, 'stroke-opacity': op, 'pointer-events': 'all',
        'stroke-dasharray': el.type === 'whiteout' ? `${3 / scale} ${3 / scale}` : null };
      if (el.type === 'ellipse') root.append(svg('ellipse', { ...attrs, cx: x + w / 2, cy: y + hh / 2, rx: Math.abs(w / 2), ry: Math.abs(hh / 2) }));
      else root.append(svg('rect', { ...attrs, x, y, width: Math.abs(w), height: Math.abs(hh) }));
      return;
    }
    const stroke = el.stroke || '#000';
    if (el.type === 'line' || el.type === 'arrow') {
      const x1 = el.x1 * W; const y1 = el.y1 * H; const x2 = el.x2 * W; const y2 = el.y2 * H;
      const g = svg('g', common);
      g.append(svg('line', { x1, y1, x2, y2, stroke: 'transparent', 'stroke-width': Math.max(12 / scale, sw), 'pointer-events': 'stroke' }));
      g.append(svg('line', { x1, y1, x2, y2, stroke, 'stroke-width': sw, 'stroke-linecap': 'round', 'stroke-opacity': op, 'pointer-events': 'none' }));
      if (el.type === 'arrow') {
        const ang = Math.atan2(y2 - y1, x2 - x1);
        const head = Math.max(8, sw * 4);
        const a = [x2 - head * Math.cos(ang - 0.45), y2 - head * Math.sin(ang - 0.45)];
        const b = [x2 - head * Math.cos(ang + 0.45), y2 - head * Math.sin(ang + 0.45)];
        g.append(svg('polygon', { points: `${a} ${x2},${y2} ${b}`, fill: stroke, 'fill-opacity': op, stroke, 'stroke-width': sw, 'stroke-linejoin': 'round', 'pointer-events': 'none' }));
      }
      root.append(g);
    } else if (el.type === 'path') {
      const pts = el.points.map(([px, py]) => `${px * W},${py * H}`).join(' ');
      const g = svg('g', common);
      g.append(svg('polyline', { points: pts, fill: 'none', stroke: 'transparent', 'stroke-width': Math.max(12 / scale, sw), 'pointer-events': 'stroke' }));
      g.append(svg('polyline', { points: pts, fill: 'none', stroke, 'stroke-width': sw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-opacity': op, 'pointer-events': 'none' }));
      root.append(g);
    }
  }

  bbox(el) {
    if (el.type === 'line' || el.type === 'arrow') return { x: Math.min(el.x1, el.x2), y: Math.min(el.y1, el.y2), w: Math.abs(el.x2 - el.x1), h: Math.abs(el.y2 - el.y1) };
    if (el.type === 'path') {
      const xs = el.points.map((p) => p[0]); const ys = el.points.map((p) => p[1]);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    }
    return { x: el.x, y: el.y, w: el.w || 0, h: el.h || 0 };
  }

  decorate(layer, el, W, H, scale) {
    const over = svg('svg', { class: 'svg-layer', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', style: 'pointer-events:none' });
    const b = this.bbox(el);
    const pad = 3 / scale;
    over.append(svg('rect', { x: b.x * W - pad, y: b.y * H - pad, width: b.w * W + 2 * pad, height: b.h * H + 2 * pad, fill: 'none',
      style: 'stroke:var(--accent)', 'stroke-width': 1.3 / scale, 'stroke-dasharray': `${4 / scale} ${3 / scale}` }));
    const r = 6 / scale;
    const handle = (name, cx, cy, cursor) => over.append(svg('circle', { cx, cy, r, fill: '#fff', 'stroke-width': 2 / scale,
      'data-handle': name, style: `pointer-events:all;cursor:${cursor};stroke:var(--accent)` }));
    if (el.type === 'line' || el.type === 'arrow') {
      handle('p1', el.x1 * W, el.y1 * H, 'move');
      handle('p2', el.x2 * W, el.y2 * H, 'move');
    } else if (el.type !== 'path') {
      handle('se', (b.x + b.w) * W + pad, (b.y + b.h) * H + pad, 'nwse-resize');
    }
    layer.append(over);
    const del = h('button', { type: 'button', class: 'el-del', title: 'Delete', html: '&times;',
      style: { position: 'absolute', left: `calc(${(b.x + b.w) * 100}% + 4px)`, top: `calc(${b.y * 100}% - 26px)`, width: '22px', height: '22px',
        borderRadius: '50%', border: '0', background: 'var(--accent)', color: '#fff', fontSize: '15px', lineHeight: '22px', padding: '0', cursor: 'pointer' } });
    del.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.remove(el); });
    layer.append(del);
  }

  // --------------------------------------------------------- interaction
  focusEditing(selectAll = true) {
    const el = this.find(this.editingId);
    if (!el) return;
    const node = this.views[el.page].layer.querySelector(`.el.text[data-id="${el.id}"]`);
    if (!node) return;
    node.focus();
    const range = document.createRange();
    range.selectNodeContents(node);
    if (!selectAll) range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  startEditing(el) {
    this.editingId = el.id;
    this.selected = el;
    this.renderLayer(el.page);
    this.focusEditing();
    this.selectChanged();
  }

  stopEditing() {
    if (this.editingId == null) return;
    const el = this.find(this.editingId);
    this.editingId = null;
    if (el) {
      if (!String(el.text || '').trim() && !el.replace) this.remove(el); // an emptied original line means "delete it"
      else this.renderLayer(el.page);
    }
    this.changed();
  }

  onDown(e, i) {
    if (e.button !== 0) return;
    const p = this.frac(e, i);
    const handle = e.target.closest('[data-handle]');
    const hit = e.target.closest('[data-id]');
    if (handle && this.selected) {
      e.preventDefault();
      this.snapshot();
      return this.drag(e, i, { mode: 'resize', handle: handle.dataset.handle, el: this.selected, orig: clone(this.selected), start: p });
    }
    if (hit) {
      const el = this.find(hit.dataset.id);
      if (!el) return;
      if (this.editingId === el.id) return; // caret placement inside the text
      if (this.editingId != null) this.stopEditing();
      if (el.type === 'text' && (e.detail >= 2 || ((this.tool === 'text' || this.tool === 'edittext') && this.selected === el))) {
        e.preventDefault();
        return this.startEditing(el);
      }
      e.preventDefault();
      this.select(el);
      this.snapshot();
      return this.drag(e, i, { mode: 'move', el, orig: clone(el), start: p, moved: false });
    }
    const wasEditing = this.editingId != null;
    this.stopEditing();
    const tool = this.opts.tools && this.opts.tools[this.tool];
    if (!tool) { this.select(null); return; }
    e.preventDefault();
    if (tool.kind === 'click') {
      if (wasEditing && this.tool !== 'edittext') { this.select(null); return; }
      const el = tool.make(p, i);
      if (el) this.add(el, { edit: el.type === 'text' });
      if (this.opts.afterCreate) this.opts.afterCreate(el);
      return;
    }
    const el = tool.make(p, i);
    this.snapshot();
    el.id = nextId++;
    this.elements.push(el);
    this.selected = el;
    this.drag(e, i, { mode: `create-${tool.kind}`, el, start: p, creating: true });
  }

  drag(e, i, st) {
    const move = (ev) => {
      const p = this.frac(ev, i);
      const dx = p.x - st.start.x;
      const dy = p.y - st.start.y;
      const el = st.el;
      const o = st.orig;
      if (st.mode === 'move') {
        if (Math.abs(dx) + Math.abs(dy) > 0.001) st.moved = true;
        if (el.type === 'line' || el.type === 'arrow') {
          Object.assign(el, { x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy });
        } else if (el.type === 'path') {
          el.points = o.points.map(([px, py]) => [px + dx, py + dy]);
        } else {
          el.x = clamp(o.x + dx, -o.w * 0.9, 1 - o.w * 0.1);
          el.y = clamp(o.y + dy, -o.h * 0.9, 1 - o.h * 0.1);
        }
      } else if (st.mode === 'resize') {
        if (st.handle === 'p1') Object.assign(el, { x1: p.x, y1: p.y });
        else if (st.handle === 'p2') Object.assign(el, { x2: p.x, y2: p.y });
        else if (el.type === 'text') {
          const k = Math.max(0.2, (o.w + dx) / Math.max(o.w, 0.001));
          el.size = clamp(Math.round(o.size * k * 10) / 10, 4, 300);
        } else {
          el.w = Math.max(0.01, o.w + dx);
          el.h = el.keepRatio ? o.h * (el.w / o.w) : Math.max(0.006, o.h + dy);
        }
      } else if (st.mode === 'create-box') {
        el.x = Math.min(st.start.x, p.x); el.y = Math.min(st.start.y, p.y);
        el.w = Math.abs(dx); el.h = Math.abs(dy);
      } else if (st.mode === 'create-line') {
        el.x2 = p.x; el.y2 = p.y;
      } else if (st.mode === 'create-path') {
        const last = el.points[el.points.length - 1];
        if (Math.hypot(p.x - last[0], p.y - last[1]) > 0.0025) el.points.push([p.x, p.y]);
      }
      this.renderLayer(i);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const el = st.el;
      if (st.mode === 'move' && !st.moved) this.history.pop();
      if (st.mode === 'create-box' && el.w < 0.01 && el.h < 0.01) {
        const dw = el.type === 'highlight' ? 0.3 : 0.2;
        const dh = el.type === 'highlight' ? 0.025 : 0.1;
        Object.assign(el, { x: clamp(st.start.x - dw / 2, 0, 1 - dw), y: clamp(st.start.y - dh / 2, 0, 1 - dh), w: dw, h: dh });
      }
      if (st.mode === 'create-line' && Math.hypot(el.x2 - el.x1, el.y2 - el.y1) < 0.01) { el.x2 = Math.min(1, el.x1 + 0.2); el.y2 = el.y1; }
      if (st.mode === 'create-path' && el.points.length < 2) {
        this.elements = this.elements.filter((x) => x !== el);
        this.selected = null;
        this.history.pop();
      }
      this.renderLayer(i);
      this.selectChanged();
      this.changed();
      if (st.creating && this.opts.afterCreate) this.opts.afterCreate(el);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  onKey(e) {
    if (!this.scroll || !document.body.contains(this.scroll)) return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || this.editingId != null;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); this.undo(); return; }
    if (typing) { if (e.key === 'Escape') this.stopEditing(); return; }
    if (!this.selected) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.remove(this.selected); }
    else if (e.key === 'Escape') this.select(null);
    else if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      const step = e.shiftKey ? 0.01 : 0.002;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      const el = this.selected;
      if (el.type === 'line' || el.type === 'arrow') { el.x1 += d[0]; el.x2 += d[0]; el.y1 += d[1]; el.y2 += d[1]; }
      else if (el.type === 'path') el.points = el.points.map(([x, y]) => [x + d[0], y + d[1]]);
      else { el.x += d[0]; el.y += d[1]; }
      this.renderLayer(el.page);
    }
  }

  destroy() { document.removeEventListener('keydown', this.onKey); }
}
