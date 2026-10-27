// Fill PDF form: the page with live inputs over each form field, and a field
// list in the inspector. Values are keyed by the field widget's xref.
import { ICONS } from '../icons.js';
import { esc, h } from '../ui.js';

const humanize = (name) => {
  const s = String(name || '').replace(/[_.-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const isEmpty = (v) => v == null || v === '' || v === false || (Array.isArray(v) && !v.length);

export function create(ctx) {
  const st = { fileId: null, fields: [], pages: [], values: new Map(), touched: new Set(), flatten: false, zoom: 1, xfa: false, loading: false };
  let scroll = null;
  let sideBody = null;
  const inputs = new Map(); // xref -> element on the page
  const file = () => ctx.ready()[0];

  async function load(f) {
    if (st.fileId === f.id) return;
    st.loading = true;
    const [{ fields, xfa }, { pages }] = await Promise.all([
      ctx.api.get(`/api/files/${f.id}/fields`), ctx.api.get(`/api/files/${f.id}/pages`)]);
    Object.assign(st, { fileId: f.id, fields: sortFields(fields), xfa, pages, loading: false });
    st.values = new Map(fields.map((x) => [x.xref, x.value]));
    st.touched.clear();
  }

  function sortFields(fields) {
    return fields.slice().sort((a, b) => a.page - b.page || (Math.abs(a.rect[1] - b.rect[1]) > 0.008 ? a.rect[1] - b.rect[1] : a.rect[0] - b.rect[0]));
  }

  const label = (f) => f.label || humanize(f.name) || `${f.type} field`;
  const fillable = () => st.fields.filter((f) => !f.readonly && f.type !== 'signature');
  const isFilled = (f) => !isEmpty(st.values.get(f.xref)) || (f.type === 'radio' && radioGroup(f).some((r) => st.values.get(r.xref)));
  const radioGroup = (f) => st.fields.filter((r) => r.type === 'radio' && r.name === f.name && r.page === f.page);

  function set(f, value) {
    if (f.type === 'radio') {
      for (const r of radioGroup(f)) { st.values.set(r.xref, r.xref === f.xref ? value : false); st.touched.add(r.xref); paint(r); }
    } else {
      st.values.set(f.xref, value);
      st.touched.add(f.xref);
      paint(f);
    }
    updateSide();
    ctx.refresh();
  }

  function paint(f) {
    const el = inputs.get(f.xref);
    if (!el) return;
    const v = st.values.get(f.xref);
    if (f.type === 'checkbox' || f.type === 'radio') {
      el.classList.toggle('on', !!v);
      el.setAttribute('aria-checked', String(!!v));
    }
    el.classList.toggle('filled', isFilled(f));
  }

  // --------------------------------------------------------------- page
  function fieldEl(f, view) {
    const [x0, y0, x1, y1] = f.rect;
    const rot = ((view.info.rotation || 0) % 360 + 360) % 360;
    const sideways = rot === 90 || rot === 270;
    const w = (x1 - x0) * view.w;
    const hh = (y1 - y0) * view.h;
    const bw = sideways ? hh : w; // the field's own (unrotated) box
    const bh = sideways ? w : hh;
    const pt = view.w / view.info.w;
    const fontPx = f.font_size ? f.font_size * pt : Math.max(8, Math.min(bh * (f.multiline ? 0.3 : 0.62), 14 * pt));
    const style = {
      left: `${(x0 + x1) / 2 * 100}%`, top: `${(y0 + y1) / 2 * 100}%`, width: `${bw}px`, height: `${bh}px`,
      transform: `translate(-50%, -50%)${rot ? ` rotate(${rot}deg)` : ''}`, fontSize: `${fontPx}px`,
    };
    const common = { class: `ff-field ff-${f.type}${f.required ? ' required' : ''}`, style, title: label(f), 'data-xref': f.xref, 'aria-label': label(f) };
    const v = st.values.get(f.xref);
    let el;
    if (f.type === 'text') {
      el = f.multiline ? h('textarea', { ...common, spellcheck: 'true' }) : h('input', { ...common, type: f.password ? 'password' : 'text', autocomplete: 'off' });
      el.value = v || '';
      if (f.maxlen) el.maxLength = f.maxlen;
      el.addEventListener('input', () => set(f, el.value));
    } else if (f.type === 'checkbox' || f.type === 'radio') {
      el = h('button', { ...common, type: 'button', role: f.type === 'radio' ? 'radio' : 'checkbox', html: f.type === 'radio' ? '<i></i>' : ICONS.check });
      el.addEventListener('click', () => set(f, f.type === 'radio' ? true : !st.values.get(f.xref)));
    } else if (f.type === 'combobox' || f.type === 'listbox') {
      el = h('select', { ...common, multiple: f.multiselect || null });
      if (!f.multiselect) el.append(h('option', { value: '' }, ''));
      const chosen = new Set([].concat(v || []).map(String));
      for (const o of f.options) {
        const opt = h('option', { value: o.value }, o.label);
        opt.selected = chosen.has(o.value);
        el.append(opt);
      }
      if (f.type === 'listbox') el.size = Math.max(2, Math.min(f.options.length + (f.multiselect ? 0 : 1), Math.floor(bh / (fontPx * 1.25))));
      el.addEventListener('change', () => set(f, f.multiselect ? [...el.selectedOptions].map((o) => o.value) : el.value));
    } else if (f.type === 'signature') {
      el = h('a', { ...common, class: `${common.class} ff-sign`, href: `/sign_pdf?files=${st.fileId}`, html: `${ICONS.sign}<span>Sign</span>`, title: 'Signature field – sign it with Sign PDF' });
    }
    if (!el) return null;
    if (f.readonly) { el.disabled = true; el.classList.add('readonly'); }
    el.addEventListener('focus', () => highlightRow(f.xref));
    inputs.set(f.xref, el);
    paint(f);
    return el;
  }

  function renderPages() {
    if (!scroll) return;
    scroll.innerHTML = '';
    inputs.clear();
    const viewer = h('div', { class: 'viewer' });
    const maxW = Math.max(...st.pages.map((p) => p.w), 1);
    const avail = (scroll.clientWidth || 900) - 48;
    const base = Math.max(260, Math.min(avail, 900)) * st.zoom;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    st.pages.forEach((p, i) => {
      const w = base * (p.w / maxW);
      const hh = w * (p.h / p.w);
      const req = Math.min(2400, Math.ceil((w * dpr) / 200) * 200);
      const view = { w, h: hh, info: p };
      const layer = h('div', { class: 'layer ff-layer' });
      for (const f of st.fields.filter((x) => x.page === i)) {
        const el = fieldEl(f, view);
        if (el) layer.append(el);
      }
      viewer.append(h('div', { class: 'vpage', 'data-page': i, style: { width: `${w}px`, height: `${hh}px` } },
        h('img', { src: `${ctx.api.thumb(st.fileId, i, req)}&annots=0`, loading: i < 3 ? 'eager' : 'lazy', alt: '', draggable: 'false' }),
        layer, h('div', { class: 'pno' }, `${i + 1} / ${st.pages.length}`)));
    });
    scroll.append(viewer);
  }

  function focusField(xref) {
    const el = inputs.get(xref);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => el.focus({ preventScroll: true }), 250);
  }

  function nextEmpty() {
    const list = fillable();
    const active = Number(document.activeElement?.dataset?.xref);
    const start = Math.max(0, list.findIndex((f) => f.xref === active) + 1);
    const next = [...list.slice(start), ...list.slice(0, start)].find((f) => !isFilled(f));
    if (next) focusField(next.xref);
  }

  // ----------------------------------------------------------- inspector
  function highlightRow(xref) {
    if (!sideBody) return;
    sideBody.querySelectorAll('.ff-row.current').forEach((r) => r.classList.remove('current'));
    const row = sideBody.querySelector(`.ff-row[data-xref="${xref}"]`);
    if (row) { row.classList.add('current'); row.scrollIntoView({ block: 'nearest' }); }
  }

  function updateSide() {
    if (!sideBody) return;
    const list = fillable();
    const done = list.filter(isFilled).length;
    const reqLeft = list.filter((f) => f.required && !isFilled(f)).length;
    const meter = sideBody.querySelector('.ff-meter');
    if (meter) {
      meter.querySelector('b').textContent = `${done} of ${list.length}`;
      meter.querySelector('.bar i').style.width = `${list.length ? (done / list.length) * 100 : 0}%`;
      meter.querySelector('.req').textContent = reqLeft ? `${reqLeft} required field${reqLeft > 1 ? 's' : ''} still empty` : '';
    }
    for (const row of sideBody.querySelectorAll('.ff-row')) {
      const f = st.fields.find((x) => x.xref === Number(row.dataset.xref));
      if (f) row.classList.toggle('done', isFilled(f));
    }
  }

  function renderSide() {
    if (!sideBody) return;
    sideBody.innerHTML = '';
    if (!st.fields.length) {
      sideBody.append(h('p', { class: 'muted', style: 'font-size:13px;margin:0' }, st.loading ? 'Reading the form…' : 'No form fields found.'));
      return;
    }
    sideBody.append(h('div', { class: 'ff-meter' },
      h('div', { class: 'top' }, h('span', {}, 'Filled in'), h('b', {})),
      h('div', { class: 'bar' }, h('i')), h('div', { class: 'req' })));
    const groups = [];
    for (const f of st.fields) {
      if (f.type === 'radio' && groups.some((g) => g.type === 'radio' && g.name === f.name && g.page === f.page)) continue;
      groups.push(f);
    }
    const list = h('div', { class: 'ff-list', role: 'list' });
    let page = -1;
    for (const f of groups) {
      if (f.page !== page) { page = f.page; list.append(h('div', { class: 'ff-page' }, `Page ${page + 1}`)); }
      const kind = { text: 'Text', checkbox: 'Check box', radio: 'Choice', combobox: 'Drop-down', listbox: 'List', signature: 'Signature' }[f.type] || f.type;
      list.append(h('button', { type: 'button', class: `ff-row${f.readonly ? ' ro' : ''}`, role: 'listitem', 'data-xref': f.xref, onclick: () => focusField(f.xref) },
        h('span', { class: 'dot' }), h('span', { class: 'nm', html: `${esc(label(f))}${f.required ? ' <em>*</em>' : ''}` }), h('span', { class: 'kd' }, f.readonly ? 'Locked' : kind)));
    }
    sideBody.append(h('div', { class: 'opt' }, h('label', { class: 'lbl' }, 'Fields'), list),
      h('div', { class: 'opt' }, h('label', { class: 'check-row' },
        h('input', { type: 'checkbox', checked: st.flatten, onchange: (e) => { st.flatten = e.target.checked; } }),
        h('span', {}, 'Flatten the form', h('span', { class: 'help', style: 'display:block' }, 'Makes the answers part of the page, so they can’t be changed. Good for sending a final copy.')))),
      h('div', { class: 'opt row' },
        h('button', { type: 'button', class: 'btn', onclick: nextEmpty, html: `${ICONS.arrowR} Next empty field` }),
        h('button', { type: 'button', class: 'btn ghost', onclick: clearAll }, 'Clear all')));
    updateSide();
  }

  function clearAll() {
    for (const f of fillable()) {
      st.values.set(f.xref, f.type === 'checkbox' || f.type === 'radio' ? false : f.multiselect ? [] : '');
      st.touched.add(f.xref);
    }
    renderPages();
    updateSide();
  }

  function emptyState(area, f) {
    area.append(h('div', { class: 'error-card', style: 'margin-top:40px' },
      h('div', { class: 'eico', style: 'background:var(--accent-soft);color:var(--accent)', html: ICONS.info }),
      h('h3', {}, st.xfa ? 'This form can’t be filled here' : 'No fillable fields in this PDF'),
      h('p', {}, st.xfa ? 'It is an XFA (LiveCycle) form, which only Adobe Acrobat can fill. Print it to PDF first, or type on it with Edit PDF.'
        : 'You can still type anywhere on the page, tick boxes and add a signature with Edit PDF.'),
      h('div', { class: 'row' },
        h('a', { class: 'btn primary', href: `/edit_pdf?files=${f.id}`, html: `${ICONS.edit} Open in Edit PDF` }),
        h('button', { type: 'button', class: 'btn', onclick: () => ctx.openPicker() }, 'Choose another file'))));
  }

  return {
    flush: true,
    async render(area) {
      const f = file();
      if (!f) { area.innerHTML = '<p class="grid-hint" style="padding:40px">Uploading…</p>'; return; }
      if (area.querySelector('.editor-shell') && st.fileId === f.id) return;
      area.innerHTML = '<p class="grid-hint" style="padding:40px">Reading the form…</p>';
      try { await load(f); } catch (e) { area.innerHTML = ''; area.append(h('div', { class: 'callout warn', html: `${ICONS.alert}<span>${esc(e.message)}</span>` })); return; }
      area.innerHTML = '';
      if (!st.fields.length) { emptyState(area, f); ctx.refreshSidebar(); return; }
      const bar = h('div', { class: 'editor-bar' },
        h('span', { class: 'muted', style: 'padding:0 8px;font-size:14px' }, 'Click a field to type · Tab moves to the next one'),
        h('span', { style: 'flex:1' }),
        h('button', { type: 'button', class: 'tool-btn', onclick: nextEmpty, html: `${ICONS.arrowR}<span>Next empty</span>` }),
        h('button', { type: 'button', class: 'tool-btn', onclick: () => { st.zoom = Math.max(0.5, st.zoom / 1.2); renderPages(); }, html: `${ICONS.zoomOut}<span>Zoom</span>` }),
        h('button', { type: 'button', class: 'tool-btn', onclick: () => { st.zoom = Math.min(3, st.zoom * 1.2); renderPages(); }, html: `${ICONS.zoomIn}<span>Zoom</span>` }));
      scroll = h('div', { class: 'editor-scroll' });
      area.append(h('div', { class: 'editor-shell' }, bar, scroll));
      renderPages();
      ctx.refreshSidebar();
    },
    sidebar(body) { sideBody = body; renderSide(); },
    onFiles() { st.fileId = null; st.fields = []; },
    canRun() { return !!file() && st.fields.length > 0; },
    summary() {
      if (!st.fields.length) return file() ? 'No form fields' : 'No file yet';
      const list = fillable();
      return `<b>${list.filter(isFilled).length} of ${list.length}</b> fields filled`;
    },
    validate() { return st.fields.length ? null : 'This PDF has no fillable form fields.'; },
    payload() {
      const values = {};
      for (const x of st.touched) values[x] = st.values.get(x);
      return { files: [{ id: file().id }], options: { values, flatten: st.flatten } };
    },
  };
}
