// Edit PDF: add text, images, shapes, freehand drawings, highlights, whiteout.
import { ICONS } from '../icons.js';
import { h, loadImage, toast } from '../ui.js';
import { EditorCore } from './editor-core.js';

const TOOLBAR = [
  ['select', 'Select', ICONS.cursor], ['edittext', 'Edit text', ICONS.textEdit], ['text', 'Add text', ICONS.text], ['image', 'Image', ICONS.image],
  ['rect', 'Rectangle', ICONS.square], ['ellipse', 'Ellipse', ICONS.circle], ['line', 'Line', ICONS.line],
  ['arrow', 'Arrow', ICONS.arrow], ['draw', 'Draw', ICONS.pen], ['highlight', 'Highlight', ICONS.highlight],
  ['whiteout', 'Whiteout', ICONS.eraser],
];
const HINTS = {
  select: 'Click an object to select it. Drag to move, use the round handle to resize. Double-click text to edit it.',
  text: 'Click anywhere on a page to add text.',
  edittext: 'Click a line of the PDF’s own text to change it. Clear a line to delete it. Changed lines use a standard font in the original size and colour.',
  image: 'Choose an image - it will be placed on the current page.',
  rect: 'Click and drag on a page to draw a rectangle.', ellipse: 'Click and drag to draw an ellipse.',
  line: 'Click and drag to draw a line.', arrow: 'Click and drag to draw an arrow.',
  draw: 'Draw freehand on the page with your mouse, pen or finger.',
  highlight: 'Drag over text to highlight it.', whiteout: 'Drag over content to hide it with a white box.',
};

/** Downscale an image file to a data URL (max side ``max`` px). */
export async function imageToDataUrl(file, max = 2000) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const png = /png|gif|webp|svg/.test(file.type);
    return { src: c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.92), w: c.width, h: c.height };
  } finally { URL.revokeObjectURL(url); }
}

export function create(ctx) {
  const defaults = {
    text: { font: 'helvetica', size: 16, color: '#000000', bold: false, italic: false, underline: false, align: 'left' },
    rect: { stroke: '#5b5bd6', fill: null, width: 2, opacity: 1 },
    ellipse: { stroke: '#2b6cd8', fill: null, width: 2, opacity: 1 },
    line: { stroke: '#000000', width: 2, opacity: 1 },
    arrow: { stroke: '#d6409f', width: 2, opacity: 1 },
    path: { stroke: '#2b6cd8', width: 2.5, opacity: 1 },
    highlight: { fill: '#ffeb3b', opacity: 0.4 },
    image: { opacity: 1 },
    whiteout: {},
  };
  let toolbar = null;
  let sideBody = null;
  const imageInput = h('input', { type: 'file', accept: 'image/*', class: 'hidden' });
  document.body.append(imageInput);

  // Existing text lines per page, for "Edit text".
  const lines = {};
  const loading = new Set();
  async function loadLines(i) {
    if (lines[i] || loading.has(i) || !core.file) return;
    loading.add(i);
    try { lines[i] = (await ctx.api.get(`/api/files/${core.file.id}/textlines/${i}`)).lines; } catch (e) { lines[i] = []; }
    loading.delete(i);
    showLines();
  }
  function nearbyLines() {
    const c = core.currentPage();
    for (let i = Math.max(0, c - 1); i <= Math.min(core.pageInfo.length - 1, c + 2); i++) loadLines(i);
  }
  function showLines() {
    const on = core.tool === 'edittext';
    core.overlays = {};
    if (on) {
      for (const [i, list] of Object.entries(lines)) {
        const taken = core.elements.filter((e) => e.replace && e.page === Number(i)).map((e) => e.replace.join());
        core.overlays[i] = list.filter((l) => !taken.includes(l.rect.join())).map((l) => ({ x0: l.rect[0], y0: l.rect[1], x1: l.rect[2], y1: l.rect[3],
          fill: 'rgba(91,91,214,.07)', stroke: 'rgba(91,91,214,.55)' }));
      }
    }
    core.views.forEach((_, i) => core.renderLayer(i));
  }
  function lineAt(p, page) {
    const list = lines[page] || [];
    const pad = 0.004;
    return list.find((l) => p.x >= l.rect[0] - pad && p.x <= l.rect[2] + pad && p.y >= l.rect[1] - pad && p.y <= l.rect[3] + pad);
  }

  const core = new EditorCore(ctx, {
    tools: {
      edittext: { kind: 'click', make: (p, page) => {
        const l = lineAt(p, page);
        if (!l) { toast(lines[page] ? 'Click on a line of text in the PDF.' : 'Reading the page’s text…'); loadLines(page); return null; }
        if (core.elements.some((e) => e.replace && e.page === page && e.replace.join() === l.rect.join())) return null;
        core.overlays[page] = (core.overlays[page] || []).filter((o) => !(o.x0 === l.rect[0] && o.y0 === l.rect[1]));
        return { type: 'text', page, x: l.rect[0], y: l.rect[1], text: l.text, size: l.size, color: l.color, font: l.font,
          bold: l.bold, italic: l.italic, underline: false, align: 'left', opacity: 1, replace: l.rect };
      } },
      text: { kind: 'click', make: (p, page) => ({ type: 'text', page, x: p.x, y: Math.max(0, p.y - 0.01), text: 'Your text', ...defaults.text }) },
      rect: { kind: 'box', make: (p, page) => ({ type: 'rect', page, x: p.x, y: p.y, w: 0, h: 0, ...defaults.rect }) },
      ellipse: { kind: 'box', make: (p, page) => ({ type: 'ellipse', page, x: p.x, y: p.y, w: 0, h: 0, ...defaults.ellipse }) },
      highlight: { kind: 'box', make: (p, page) => ({ type: 'highlight', page, x: p.x, y: p.y, w: 0, h: 0, ...defaults.highlight }) },
      whiteout: { kind: 'box', make: (p, page) => ({ type: 'whiteout', page, x: p.x, y: p.y, w: 0, h: 0 }) },
      line: { kind: 'line', make: (p, page) => ({ type: 'line', page, x1: p.x, y1: p.y, x2: p.x, y2: p.y, ...defaults.line }) },
      arrow: { kind: 'line', make: (p, page) => ({ type: 'arrow', page, x1: p.x, y1: p.y, x2: p.x, y2: p.y, ...defaults.arrow }) },
      draw: { kind: 'path', make: (p, page) => ({ type: 'path', page, points: [[p.x, p.y]], ...defaults.path }) },
    },
    onSelect: () => renderProps(),
    onChange: () => { if (core.tool === 'edittext' && core.editingId == null) showLines(); },
    afterCreate: (el) => { if (el && el.type !== 'path' && !el.replace) setTool('select', { keepEditing: true }); },
  });

  function setTool(name, opts) {
    if (name === 'image') { imageInput.click(); return; }
    core.setTool(name, opts);
    if (toolbar) toolbar.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === name));
    if (name === 'edittext') nearbyLines();
    showLines();
    renderProps();
  }

  imageInput.addEventListener('change', async () => {
    const file = imageInput.files[0];
    imageInput.value = '';
    if (!file) return;
    try {
      const { src, w, h: ih } = await imageToDataUrl(file);
      const page = core.currentPage();
      const info = core.pageInfo[page];
      const fw = 0.35;
      const fh = fw * (ih / w) * (info.w / info.h);
      const c = core.visibleCenter(page);
      core.add({ type: 'image', page, x: (1 - fw) / 2, y: Math.max(0, Math.min(1 - fh, c.y - fh / 2)), w: fw, h: fh, src, keepRatio: true, opacity: defaults.image.opacity });
      setTool('select');
    } catch (e) { toast('This image could not be read.', 'error'); }
  });

  function typeKey(t) { return t === 'draw' ? 'path' : t; }

  function renderProps() {
    if (!sideBody) return;
    sideBody.innerHTML = '';
    const el = core.selected;
    const type = el ? el.type : typeKey(core.tool);
    const target = el || defaults[type];
    sideBody.append(h('div', { class: 'info-box' }, el ? `Selected: ${type}. Press Delete to remove it, Ctrl+Z to undo.` : HINTS[core.tool] || HINTS.select));
    if (!target) return;
    const set = (props) => {
      Object.assign(defaults[type] || {}, props);
      if (el) core.update(props);
      renderProps();
    };
    const props = h('div', { class: 'props' });
    const colorInput = (key, label, allowNone = false) => {
      const on = target[key] != null;
      const input = h('input', { type: 'color', value: target[key] || '#000000', disabled: !on, oninput: (e) => { Object.assign(defaults[type] || {}, { [key]: e.target.value }); if (el) core.update({ [key]: e.target.value }); } });
      return h('div', { class: 'row' }, h('label', {}, label), h('span', { style: 'flex:none;display:flex;gap:10px;align-items:center' }, input,
        allowNone ? h('label', { class: 'check-row', style: 'font-size:13px' }, h('input', { type: 'checkbox', checked: !on, onchange: (e) => set({ [key]: e.target.checked ? null : (key === 'fill' ? '#ffeb3b' : '#000000') }) }), 'None') : null));
    };
    const number = (key, label, min, max, step = 1) => h('div', { class: 'row' }, h('label', {}, label),
      h('input', { type: 'number', min, max, step, value: target[key], style: 'width:90px;flex:none;border:1px solid var(--border);border-radius:8px;padding:8px',
        onchange: (e) => set({ [key]: Number(e.target.value) }) }));
    const opacity = () => h('div', {}, h('label', { style: 'font-size:13px;color:var(--muted)' }, `Opacity ${Math.round((target.opacity ?? 1) * 100)}%`),
      h('input', { type: 'range', min: 5, max: 100, value: Math.round((target.opacity ?? 1) * 100), style: 'width:100%;accent-color:var(--accent)',
        onchange: (e) => set({ opacity: Number(e.target.value) / 100 }) }));
    if (type === 'text') {
      const font = h('select', { style: 'border:1px solid var(--border);border-radius:8px;padding:8px', onchange: (e) => set({ font: e.target.value }) },
        ...[['helvetica', 'Helvetica / Arial'], ['times', 'Times New Roman'], ['courier', 'Courier']].map(([v, l]) => h('option', { value: v, selected: target.font === v }, l)));
      const tg = (key, txt, style) => h('button', { type: 'button', class: target[key] ? 'active' : '', style, onclick: () => set({ [key]: !target[key] }) }, txt);
      const align = h('div', { class: 'seg' }, ...['left', 'center', 'right'].map((a) => h('button', { type: 'button', class: (target.align || 'left') === a ? 'active' : '', onclick: () => set({ align: a }) }, a[0].toUpperCase() + a.slice(1))));
      props.append(h('div', { class: 'row' }, h('label', {}, 'Font'), font), number('size', 'Size (pt)', 4, 300, 0.5), colorInput('color', 'Color'),
        h('div', { class: 'row' }, h('label', {}, 'Style'), h('div', { class: 'toggle-group', style: 'flex:none' }, tg('bold', 'B', 'font-weight:800'), tg('italic', 'I', 'font-style:italic;font-family:serif'), tg('underline', 'U', 'text-decoration:underline'))),
        align, opacity());
    } else if (type === 'rect' || type === 'ellipse') {
      props.append(colorInput('stroke', 'Border', true), colorInput('fill', 'Fill', true), number('width', 'Border width', 0, 40, 0.5), opacity());
    } else if (type === 'line' || type === 'arrow' || type === 'path') {
      props.append(colorInput('stroke', 'Color'), number('width', 'Width', 0.5, 40, 0.5), opacity());
    } else if (type === 'highlight') {
      props.append(colorInput('fill', 'Color'), opacity());
    } else if (type === 'image') {
      props.append(opacity());
    }
    sideBody.append(props);
    if (el) {
      sideBody.append(h('div', { style: 'margin-top:18px;display:flex;gap:8px' },
        h('button', { type: 'button', class: 'btn', html: `${ICONS.copy} Duplicate`, onclick: () => {
          const copy = JSON.parse(JSON.stringify(el));
          delete copy.id;
          const d = 0.02;
          if ('x' in copy) { copy.x += d; copy.y += d; }
          if ('x1' in copy) { copy.x1 += d; copy.x2 += d; copy.y1 += d; copy.y2 += d; }
          if (copy.points) copy.points = copy.points.map(([x, y]) => [x + d, y + d]);
          core.add(copy);
        } }),
        h('button', { type: 'button', class: 'btn', html: `${ICONS.trash} Delete`, onclick: () => core.remove(el) })));
    }
  }

  return {
    flush: true,
    async render(area) {
      const f = ctx.ready()[0];
      if (!f) { area.innerHTML = '<p class="grid-hint" style="padding:40px">Uploading…</p>'; return; }
      if (area.querySelector('.editor-shell') && core.file && core.file.id === f.id) return;
      await core.load(f);
      area.innerHTML = '';
      toolbar = h('div', { class: 'editor-bar' });
      for (const [name, label, icon] of TOOLBAR) {
        toolbar.append(h('button', { type: 'button', class: `tool-btn${core.tool === name ? ' active' : ''}`, 'data-tool': name, title: label, onclick: () => setTool(name), html: `${icon}<span>${label}</span>` }));
      }
      toolbar.append(h('span', { class: 'sep' }),
        h('button', { type: 'button', class: 'tool-btn', title: 'Undo (Ctrl+Z)', onclick: () => core.undo(), html: `${ICONS.undo}<span>Undo</span>` }),
        h('button', { type: 'button', class: 'tool-btn', title: 'Zoom out', onclick: () => core.setZoom(core.zoom / 1.2), html: `${ICONS.zoomOut}<span>Zoom</span>` }),
        h('button', { type: 'button', class: 'tool-btn', title: 'Zoom in', onclick: () => core.setZoom(core.zoom * 1.2), html: `${ICONS.zoomIn}<span>Zoom</span>` }));
      const scroll = h('div', { class: 'editor-scroll' });
      let timer = null;
      scroll.addEventListener('scroll', () => { clearTimeout(timer); timer = setTimeout(() => { if (core.tool === 'edittext') nearbyLines(); }, 150); });
      area.append(h('div', { class: 'editor-shell' }, toolbar, scroll));
      core.mount(scroll);
      showLines();
    },
    sidebar(body) { sideBody = body; renderProps(); },
    onFiles() { core.file = null; for (const k of Object.keys(lines)) delete lines[k]; },
    validate() { return core.elements.length ? null : 'Add some text, an image or a shape first.'; },
    payload() {
      core.stopEditing();
      return { files: [{ id: ctx.ready()[0].id }], options: { elements: core.payload() } };
    },
  };
}
