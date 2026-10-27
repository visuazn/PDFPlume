// Tool page: one stable workspace (canvas + inspector) that moves through
// empty -> work -> processing -> done, instead of swapping whole pages.
import { api, capabilities, humanSize } from './api.js';
import { ICONS, toolIcon } from './icons.js';
import { defaultsFor, renderOptions } from './options.js';
import { CAT_MAP, KIND_COLOR, TOOL_MAP } from './tools.js';
import { addRecent, esc, getPins, h, makeSortable, modKey, modal, moveItem, promptPassword, renderShell, setTitle, toast, togglePin } from './ui.js';
import { renderResultCanvas, renderResultInspector } from './result.js';

const slug = location.pathname.replace(/^\/+|\/+$/g, '');
const tool = TOOL_MAP[slug];

const state = {
  files: [],
  options: {},
  caps: {},
  view: 'empty', // empty | work | processing | done | error
  pending: new Set(),
  result: null,
  error: null,
};
let widget = null;
let widgetReady = null;
const ready = new Promise((resolve) => { widgetReady = resolve; });
let uid = 0;
let canvas = null;
let inner = null;
let inspBody = null;
let inspHead = null;
let inspFoot = null;
let runBtn = null;
let summaryEl = null;

// ---------------------------------------------------------------- helpers
function acceptsFile(file) {
  const name = file.name.toLowerCase();
  return tool.acceptInfo.ext.split(',').some((e) => name.endsWith(e));
}

export function thumbUrl(f, page = 0, w = 240) {
  return f.id ? api.thumb(f.id, page, w) : '';
}

const picker = h('input', { type: 'file', class: 'hidden', accept: tool ? tool.acceptInfo.ext : '', multiple: !!(tool && tool.multiple) });
let pickerTarget = null;
picker.addEventListener('change', () => {
  const files = [...picker.files];
  picker.value = '';
  if (!files.length) return;
  if (pickerTarget) pickerTarget(files); else addFiles(files);
});
document.body.append(picker);

/** Open the file dialog. ``opts.onFiles`` receives the files instead of addFiles. */
function openPicker(opts = {}) {
  picker.multiple = opts.multiple ?? !!tool.multiple;
  picker.accept = opts.accept || tool.acceptInfo.ext;
  pickerTarget = opts.onFiles || null;
  picker.click();
}

async function unlockEntry(entry) {
  let error = null;
  for (;;) {
    const pw = await promptPassword(entry.name, { error });
    if (pw == null) { entry.locked = true; return false; }
    try {
      const meta = await api.post(`/api/files/${entry.id}/password`, { password: pw });
      Object.assign(entry, meta, { locked: false, password: pw });
      return true;
    } catch (e) { error = e.message; }
  }
}

function filesChanged() {
  if (widget && widget.onFiles) widget.onFiles();
  // Custom sidebars often depend on the file (page count, size ...).
  if (widget && widget.sidebar && state.view !== 'done') renderInspector();
  refresh();
}

async function uploadEntry(entry, file) {
  const p = (async () => {
    try {
      const meta = await api.upload(file, (x) => { entry.progress = x; updateCard(entry); });
      Object.assign(entry, meta, { uploading: false });
      if (entry.needs_password) await unlockEntry(entry);
      if (entry.damaged) entry.error = 'This PDF looks damaged – try Repair PDF';
    } catch (e) {
      entry.uploading = false;
      entry.error = e.message;
      toast(`${file.name}: ${e.message}`, 'error');
    }
  })();
  state.pending.add(p);
  await p;
  state.pending.delete(p);
  filesChanged();
}

export async function addFiles(list, { replace = false } = {}) {
  const files = [...list];
  if (!widget) await ready; // files chosen while the page is still starting
  const good = files.filter(acceptsFile);
  if (good.length < files.length) toast(`Skipped files this tool can’t use (accepts ${tool.acceptInfo.ext.replaceAll(',', ' ')})`, 'error');
  if (!good.length) return [];
  if (!tool.multiple || replace) {
    state.files.forEach((f) => f.id && api.del(`/api/files/${f.id}`).catch(() => {}));
    state.files = [];
    good.splice(1);
  }
  if (tool.maxFiles && state.files.length + good.length > tool.maxFiles) {
    good.splice(Math.max(0, tool.maxFiles - state.files.length));
    toast(`${tool.name} works with ${tool.maxFiles} files.`, 'error');
  }
  const entries = good.map((file) => ({ key: ++uid, name: file.name, size: file.size, uploading: true, progress: 0, rotation: 0, options: {} }));
  state.files.push(...entries);
  if (state.view !== 'work') setView('work'); else refresh();
  await Promise.all(entries.map((e, i) => uploadEntry(e, good[i])));
  return entries;
}

function removeFile(entry) {
  state.files = state.files.filter((f) => f !== entry);
  if (entry.id) api.del(`/api/files/${entry.id}`).catch(() => {});
  if (widget && widget.onFiles) widget.onFiles();
  if (!state.files.length && !widget.keepWork && !widget.startInWork) setView('empty'); else refresh();
}

function clearFiles() {
  state.files.forEach((f) => f.id && api.del(`/api/files/${f.id}`).catch(() => {}));
  state.files = [];
  if (widget.onClear) widget.onClear();
  if (widget.onFiles) widget.onFiles();
  setView(widget.startInWork ? 'work' : 'empty');
}

function sortFiles(dir) {
  state.files.sort((a, b) => dir * a.name.localeCompare(b.name, undefined, { numeric: true }));
  refresh();
}

// --------------------------------------------------------------- the context
const ctx = {
  tool, state, api,
  get caps() { return state.caps; },
  addFiles, removeFile, openPicker, thumbUrl, unlockEntry,
  refresh: () => refresh(),
  showWork: () => setView('work'),
  showEmpty: () => setView('empty'),
  refreshSidebar: () => renderInspector(),
  run: () => run(),
  ready: () => state.files.filter((f) => f.id && !f.uploading && !f.error),
};

// ------------------------------------------------------------------ layout
function buildLayout(page) {
  page.classList.add('tool-page');
  const pinned = getPins().includes(slug);
  const pin = h('button', { type: 'button', class: `icon-btn bordered${pinned ? ' active' : ''}`, title: pinned ? 'Unpin from sidebar' : 'Pin to sidebar',
    'aria-pressed': String(pinned), html: pinned ? ICONS.starFill : ICONS.star });
  pin.addEventListener('click', () => {
    const on = togglePin(slug);
    pin.classList.toggle('active', on);
    pin.innerHTML = on ? ICONS.starFill : ICONS.star;
    pin.title = on ? 'Unpin from sidebar' : 'Pin to sidebar';
    toast(on ? `${tool.name} pinned to the sidebar` : `${tool.name} unpinned`);
  });
  page.append(h('div', { class: 'tool-head', html: toolIcon(tool, 'lg') },
    h('div', { class: 'th-text' }, h('h1', {}, tool.name), h('p', {}, tool.desc)), pin));
  inner = h('div', { class: 'canvas-inner' });
  canvas = h('section', { class: 'canvas', 'aria-label': 'Workspace' }, inner);
  inspHead = h('div', { class: 'insp-head' });
  inspBody = h('div', { class: 'insp-body' });
  summaryEl = h('div', { class: 'insp-summary' });
  runBtn = h('button', { type: 'button', class: 'btn-run', id: 'run-btn', onclick: () => run() });
  inspFoot = h('div', { class: 'insp-foot' }, summaryEl, runBtn);
  page.append(h('div', { class: 'workspace' }, canvas, h('aside', { class: 'inspector', 'aria-label': 'Options' }, inspHead, inspBody, inspFoot)));
}

function setView(view) {
  state.view = view;
  renderCanvas();
  renderInspector();
}

function refresh() {
  if (state.view === 'work') widget.render(inner);
  if (state.view === 'empty' || state.view === 'work') updateFooter();
}

function renderCanvas() {
  canvas.classList.toggle('flush', state.view === 'work' && !!widget.flush);
  canvas.querySelector('.overlay')?.remove();
  if (state.view === 'empty') renderEmpty();
  else if (state.view === 'work') { inner.innerHTML = ''; widget.render(inner); }
  else if (state.view === 'done') { inner.innerHTML = ''; renderResultCanvas(inner, { tool, result: state.result, state }); }
  else if (state.view === 'error') renderError();
}

// ------------------------------------------------------------- empty state
function engineNotes() {
  const c = state.caps;
  const notes = [];
  if (tool.engine === 'libreoffice' && c.libreoffice === false) {
    notes.push(['info', 'LibreOffice isn’t installed, so the built-in converter is used (.docx, .xlsx, .csv, .pptx, .txt with a simpler layout). Install LibreOffice for exact results and older Office formats.']);
  }
  if (tool.needs === 'tesseract' && c.tesseract === false) {
    notes.push(['warn', 'This tool needs <b>Tesseract OCR</b>. Install it (macOS <code>brew install tesseract</code>, Windows <code>winget install UB-Mannheim.TesseractOCR</code>, Linux <code>sudo apt install tesseract-ocr</code>) and restart PDFPlume.']);
  }
  if (tool.needs === 'translation' && c.translation && !c.translation.available) {
    notes.push(['warn', 'This tool needs a translation engine: <code>pip install argostranslate</code> (offline), a LibreTranslate server or Ollama. See the README.']);
  }
  if (tool.slug === 'html_to_pdf' && c.html_engine === 'basic') {
    notes.push(['info', 'Chrome wasn’t found, so pages are rendered without JavaScript and with limited CSS. Install Chrome or Chromium for exact results.']);
  }
  if (tool.slug === 'pdf_to_pdfa' && c.ghostscript === false) {
    notes.push(['info', 'Install <b>Ghostscript</b> for fully validated PDF/A (font embedding and colour conversion).']);
  }
  return notes;
}

function callout(kind, html) {
  return h('div', { class: `callout ${kind}`, html: `${kind === 'warn' ? ICONS.alert : ICONS.info}<span>${html}</span>` });
}

function renderEmpty() {
  inner.innerHTML = '';
  const zone = h('div', { class: 'dropzone', id: 'dropzone' }, h('span', { html: toolIcon(tool, 'xl') }));
  if (widget.hero) {
    widget.hero(zone);
  } else {
    const what = { pdf: tool.multiple ? 'PDF files' : 'a PDF', image: 'images', word: 'Word documents', powerpoint: 'presentations',
      excel: 'spreadsheets', html: 'HTML files' }[tool.accept] || 'files';
    zone.append(h('h3', {}, `Drop ${what} here`),
      h('p', {}, tool.minFiles > 1 ? `Add at least ${tool.minFiles} files to get started.` : 'or choose them from your computer'),
      h('div', { class: 'actions-row' },
        h('button', { type: 'button', class: 'btn primary lg', id: 'choose-btn', onclick: () => openPicker(), html: `${ICONS.upload} Choose file${tool.multiple ? 's' : ''}` }),
        h('button', { type: 'button', class: 'btn lg', onclick: addFromUrl, html: `${ICONS.link} From URL` })),
      h('div', { class: 'formats' }, ...tool.acceptInfo.ext.split(',').slice(0, 7).map((e) => h('span', { class: 'fmt' }, e.slice(1).toUpperCase()))));
  }
  const blocking = engineNotes().filter(([k]) => k === 'warn');
  for (const [k, n] of blocking) zone.append(callout(k, n));
  inner.append(zone);
}

function renderError() {
  inner.innerHTML = '';
  inner.append(h('div', { class: 'error-card' },
    h('div', { class: 'eico', html: ICONS.alert }), h('h3', {}, 'That didn’t work'), h('p', {}, state.error || 'Unknown error'),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn', onclick: () => setView(state.files.length || widget.startInWork ? 'work' : 'empty'), html: `${ICONS.back} Back to files` }),
      h('button', { type: 'button', class: 'btn primary', onclick: () => run() }, 'Try again'))));
}

function addFromUrl() {
  const input = h('input', { type: 'url', placeholder: 'https://example.com/report.pdf' });
  const go = async () => {
    const url = input.value.trim();
    if (!url) return;
    m.close();
    const entry = { key: ++uid, name: url.split('/').pop() || 'download', size: 0, uploading: true, progress: 0.5, rotation: 0, options: {} };
    if (!tool.multiple) state.files = [];
    state.files.push(entry);
    setView('work');
    try {
      const meta = await api.post('/api/upload-url', { url });
      Object.assign(entry, meta, { uploading: false });
      if (!tool.acceptInfo.kinds.includes(meta.kind)) { removeFile(entry); toast('That file type doesn’t work with this tool.', 'error'); return; }
      if (entry.needs_password) await unlockEntry(entry);
    } catch (e) { removeFile(entry); toast(e.message, 'error'); return; }
    filesChanged();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  const m = modal({ title: 'Add a file from a link', body: h('div', {}, h('p', { style: 'margin:0 0 12px;color:var(--text-2)' }, 'Paste a direct link. The file is downloaded to this computer.'), input),
    foot: [h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn primary', type: 'button', onclick: go }, 'Add file')] });
  setTimeout(() => input.focus(), 30);
}

// --------------------------------------------------------------- inspector
function renderInspector() {
  if (!inspBody) return;
  inspHead.innerHTML = '';
  inspBody.innerHTML = '';
  inspBody.className = 'insp-body';
  inspBody.classList.toggle('insp-disabled', state.view === 'processing');
  if (state.view === 'done') {
    inspHead.append(h('h2', {}, 'Result'));
    inspFoot.classList.add('hidden');
    renderResultInspector(inspBody, {
      tool, result: state.result, state,
      onBack: () => setView('work'),
      onNew: () => { clearFiles(); state.options = defaultsFor(tool.options); renderInspector(); },
    });
    return;
  }
  inspFoot.classList.toggle('hidden', !!widget.noRun);
  const hasOptions = !!widget.sidebar || (tool.options || []).length;
  inspHead.append(h('h2', {}, widget.inspectorTitle || 'Options'));
  if (!widget.sidebar && (tool.options || []).length) {
    inspHead.append(h('button', { type: 'button', class: 'link-btn', style: 'font-size:12px', onclick: () => { state.options = defaultsFor(tool.options); renderInspector(); refresh(); } }, 'Reset'));
  }
  for (const [k, n] of engineNotes().filter(([kind]) => kind === 'info')) inspBody.append(callout(k, n));
  if (widget.sidebar) widget.sidebar(inspBody);
  else if (hasOptions) renderOptions(inspBody, tool.options || [], state.options, state.caps, onOptionChange, { sortFiles });
  else inspBody.append(h('p', { class: 'muted', style: 'font-size:13px;margin:0' }, 'No settings needed – add your files and run.'));
  updateFooter();
}

function onOptionChange(key) {
  if (widget.onOption) widget.onOption(key);
  updateFooter();
}

function summaryText() {
  if (widget.summary) return widget.summary();
  const ready = ctx.ready();
  if (!ready.length) return state.files.length ? 'Uploading…' : 'No files yet';
  const pages = ready.reduce((s, f) => s + (f.kind === 'pdf' ? f.pages || 0 : 0), 0);
  const size = ready.reduce((s, f) => s + (f.size || 0), 0);
  return `<b>${ready.length} file${ready.length > 1 ? 's' : ''}</b>${pages ? ` · ${pages} page${pages > 1 ? 's' : ''}` : ''} · ${humanSize(size)}`;
}

function updateFooter(progress = null) {
  if (!runBtn) return;
  if (state.view === 'processing') {
    const pct = Math.round((progress || 0) * 100);
    runBtn.disabled = true;
    runBtn.innerHTML = `<span class="fill" style="width:${Math.max(4, pct)}%"></span><span style="position:relative">Working… ${pct}%</span>`;
    return;
  }
  const busy = state.files.some((f) => f.uploading);
  const min = tool.minFiles ?? 1;
  const enough = widget.canRun ? widget.canRun() : ctx.ready().length >= min;
  runBtn.disabled = busy || !enough;
  runBtn.innerHTML = `<span>${esc(tool.action)}</span>${ICONS.arrowR}<span class="kbd" aria-hidden="true">${modKey}↵</span>`;
  summaryEl.innerHTML = `<span>${summaryText()}</span><span>Runs locally</span>`;
}

function updateCard(entry) {
  const bar = inner && inner.querySelector(`[data-key="${entry.key}"] .progress i`);
  if (bar) bar.style.width = `${Math.round(entry.progress * 100)}%`;
}

// ------------------------------------------------------------ files widget
function placeholder(f) {
  const ext = (f.name.split('.').pop() || '').toUpperCase().slice(0, 4);
  return h('div', { class: 'placeholder', style: { background: KIND_COLOR[f.kind] || tool.color } }, ext);
}

export function fileCard(f, { index, rotatable, onRotate, extraActions = [] } = {}) {
  const card = h('div', { class: 'file-card', 'data-key': f.key, draggable: tool.sortable ? 'true' : null });
  const thumb = h('div', { class: 'thumb' });
  if (f.id && (f.kind === 'pdf' || f.kind === 'image') && !f.needs_password && !f.locked && !f.damaged) {
    const img = h('img', { src: thumbUrl(f, 0, 300), alt: '', loading: 'lazy', draggable: 'false' });
    img.style.transform = `rotate(${f.rotation || 0}deg)`;
    img.onerror = () => img.replaceWith(placeholder(f));
    thumb.append(img);
  } else {
    thumb.append(placeholder(f));
  }
  card.append(thumb);
  if (index != null && tool.sortable && state.files.length > 1) card.append(h('span', { class: 'order' }, index + 1));
  if (f.locked || f.needs_password) {
    card.append(h('button', { type: 'button', class: 'lock', style: 'cursor:pointer', onclick: () => unlockEntry(f).then(() => filesChanged()), html: `${ICONS.lock} Locked – unlock` }));
  } else if (f.encrypted) {
    card.append(h('span', { class: 'lock', html: `${ICONS.lock} Protected` }));
  }
  const actions = h('div', { class: 'actions' });
  for (const a of extraActions) actions.append(a);
  if (rotatable) {
    actions.append(h('button', { type: 'button', title: 'Rotate', 'aria-label': 'Rotate', onclick: () => { f.rotation = ((f.rotation || 0) + 90) % 360; onRotate ? onRotate(f) : refresh(); }, html: ICONS.rotR }));
  }
  actions.append(h('button', { type: 'button', title: 'Remove', 'aria-label': `Remove ${f.name}`, onclick: () => removeFile(f), html: ICONS.trash }));
  card.append(actions);
  if (f.uploading) card.append(h('div', { class: 'progress' }, h('i', { style: { width: `${Math.round((f.progress || 0) * 100)}%` } })));
  card.append(h('div', { class: 'name', title: f.name }, f.name));
  if (f.error) card.append(h('div', { class: 'error' }, f.error));
  else card.append(h('div', { class: 'meta' }, f.uploading ? 'Uploading…' : [f.pages && f.kind === 'pdf' ? `${f.pages} page${f.pages > 1 ? 's' : ''}` : null, humanSize(f.size)].filter(Boolean).join(' · ')));
  return card;
}

/** Toolbar above the files: count, add, sort, clear. */
export function filesBar({ label } = {}) {
  const ready = ctx.ready();
  const pages = ready.reduce((s, f) => s + (f.kind === 'pdf' ? f.pages || 0 : 0), 0);
  const bar = h('div', { class: 'canvas-bar' },
    h('span', { class: 'count', html: label || `<b>${state.files.length}</b> file${state.files.length === 1 ? '' : 's'}${pages ? ` · ${pages} pages` : ''}` }));
  if (tool.sortable && state.files.length > 1) {
    bar.append(h('button', { type: 'button', class: 'btn sm', onclick: () => sortFiles(1), html: `${ICONS.sort} Sort A–Z` }));
  }
  if (tool.multiple) bar.append(h('button', { type: 'button', class: 'btn sm', id: 'add-files', onclick: () => openPicker(), html: `${ICONS.plus} Add files` }));
  else bar.append(h('button', { type: 'button', class: 'btn sm', onclick: () => openPicker(), html: `${ICONS.files} Replace file` }));
  bar.append(h('button', { type: 'button', class: 'btn sm ghost', onclick: clearFiles }, 'Clear'));
  return bar;
}

function filesWidget() {
  return {
    render(area) {
      area.innerHTML = '';
      area.append(filesBar());
      if (tool.preview) {
        const prev = previewBox();
        if (prev) area.append(prev);
      }
      const list = h('div', { class: 'files' });
      state.files.forEach((f, i) => list.append(fileCard(f, { index: i, rotatable: tool.rotatable && f.kind === 'pdf' })));
      if (tool.multiple) list.append(h('button', { type: 'button', class: 'add-card', onclick: () => openPicker(), html: `${ICONS.plus}<span>Add more</span>` }));
      area.append(list);
      if (tool.sortable) makeSortable(list, '.file-card', (from, to) => { moveItem(state.files, from, to); refresh(); });
    },
    onOption() { if (tool.preview) refresh(); },
    payload() {
      return {
        files: ctx.ready().map((f) => ({ id: f.id, options: { ...(f.options || {}), rotation: f.rotation || 0 } })),
        options: state.options,
      };
    },
  };
}

// Live preview of page numbers / watermark on the first page.
function previewBox() {
  const f = ctx.ready().find((x) => x.kind === 'pdf' && x.width);
  if (!f) return null;
  const W = 280;
  const scale = W / f.width;
  const box = h('div', { class: 'preview-page', style: { width: `${W}px`, height: `${f.height * scale}px` } },
    h('img', { src: thumbUrl(f, 0, 600), style: { width: '100%', height: '100%', boxShadow: 'var(--shadow-md)' } }));
  const o = state.options;
  const family = { helvetica: 'Helvetica, Arial, sans-serif', times: '"Times New Roman", Times, serif', courier: '"Courier New", Courier, monospace' }[o.font] || 'Arial';
  const place = (el, pos, margin) => {
    const [v, hz] = pos.split('-');
    Object.assign(el.style, {
      left: hz === 'left' ? `${margin}px` : hz === 'right' ? 'auto' : '50%',
      right: hz === 'right' ? `${margin}px` : 'auto',
      top: v === 'top' ? `${margin}px` : v === 'bottom' ? 'auto' : '50%',
      bottom: v === 'bottom' ? `${margin}px` : 'auto',
    });
    return `translate(${hz === 'center' ? '-50%' : '0'}, ${v === 'middle' ? '-50%' : '0'})`;
  };
  if (tool.preview === 'numbers') {
    const margin = { small: 18, recommended: 30, big: 54 }[o.margin] * scale;
    const fmt = o.format === 'custom' ? (o.custom_text || '{n}') : o.format;
    const mark = h('div', { class: 'preview-mark' }, String(fmt).replace('{n}', o.first_number ?? 1).replace('{p}', f.pages || 1));
    Object.assign(mark.style, { fontFamily: family, fontSize: `${(o.font_size || 12) * scale}px`, color: o.color, fontWeight: o.bold ? 700 : 400, fontStyle: o.italic ? 'italic' : 'normal' });
    mark.style.transform = place(mark, o.position || 'bottom-center', margin);
    box.append(mark);
  } else if (tool.preview === 'watermark') {
    const make = () => {
      let m;
      if (o.type === 'image') {
        if (!o.image_id) return null;
        m = h('img', { class: 'preview-mark', src: api.thumb(o.image_id, 0, 400), style: { width: `${W * (o.image_size || 40) / 100}px` } });
      } else {
        m = h('div', { class: 'preview-mark' }, o.text || '');
        Object.assign(m.style, { fontFamily: family, fontSize: `${(o.font_size || 48) * scale}px`, color: o.color, fontWeight: o.bold ? 700 : 400,
          fontStyle: o.italic ? 'italic' : 'normal', textDecoration: o.underline ? 'underline' : 'none', maxWidth: 'none' });
      }
      m.style.opacity = (o.opacity ?? 50) / 100;
      return m;
    };
    if (o.mosaic) {
      for (let r = 0; r < 4; r++) for (let c = 0; c < 2; c++) {
        const m = make(); if (!m) break;
        Object.assign(m.style, { left: `${10 + c * 50 + (r % 2) * 20}%`, top: `${8 + r * 24}%` });
        m.style.transform = `translate(-25%, 0) rotate(${-(o.rotation || 0)}deg)`;
        box.append(m);
      }
    } else {
      const m = make();
      if (m) {
        const t = place(m, o.position || 'middle-center', 24 * scale);
        m.style.transform = `${t} rotate(${-(o.rotation || 0)}deg)`;
        box.append(m);
      }
    }
  }
  return h('div', { class: 'preview-wrap' }, box, h('small', {}, 'Live preview · first page'));
}

// --------------------------------------------------------------------- run
let overlayBar = null;
let overlayMsg = null;

async function run() {
  if (state.view === 'processing') return;
  if (state.pending.size) {
    runBtn.disabled = true;
    await Promise.all([...state.pending]);
  }
  const ready = ctx.ready();
  const min = tool.minFiles ?? 1;
  if (widget.canRun ? !widget.canRun() : ready.length < min) {
    toast(min > 1 ? `Add at least ${min} files first.` : 'Add a file first.', 'error');
    return;
  }
  const locked = ready.find((f) => f.needs_password && !f.password);
  if (locked && !(await unlockEntry(locked))) return;
  if (widget.validate) {
    const err = widget.validate();
    if (err) { toast(err, 'error'); return; }
  }
  const payload = widget.payload();
  if (state.view !== 'work') setView('work');
  state.view = 'processing';
  renderInspector();
  overlayBar = h('i');
  overlayMsg = h('div', { class: 'msg' }, 'Starting…');
  const cancelBtn = h('button', { type: 'button', class: 'btn sm', id: 'cancel-btn', disabled: true, onclick: () => cancelJob() }, 'Cancel');
  canvas.append(h('div', { class: 'overlay', role: 'status', 'aria-live': 'polite' }, h('div', { class: 'overlay-card' },
    h('div', { class: 'spinner' }), h('h3', {}, `${tool.action}…`), h('div', { class: 'progress-track' }, overlayBar), overlayMsg,
    h('div', { class: 'overlay-actions' }, h('span', { class: 'note', html: `${ICONS.shield}<span>Processing on this computer</span>` }), cancelBtn))));
  updateFooter(0);
  state.jobId = null;
  try {
    const result = await api.process(slug, payload, (p, msg) => {
      overlayBar.style.width = `${Math.max(3, Math.round(p * 100))}%`;
      if (msg) overlayMsg.textContent = msg;
      updateFooter(p);
    }, (jobId) => { state.jobId = jobId; cancelBtn.disabled = false; });
    state.result = result;
    addRecent({ job: result.jobId, tool: slug, file: result.file, size: result.size, count: result.count });
    setView('done');
  } catch (e) {
    if (e.cancelled) {
      toast('Cancelled – nothing was changed');
      setView('work');
      return;
    }
    state.error = e.message;
    setView('error');
  } finally {
    state.jobId = null;
  }
}

async function cancelJob() {
  if (!state.jobId) return;
  const btn = document.getElementById('cancel-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Cancelling…'; }
  if (overlayMsg) overlayMsg.textContent = 'Stopping…';
  await api.post(`/api/jobs/${state.jobId}/cancel`).catch(() => {});
}

// -------------------------------------------------------------- drag & drop
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e) || !['empty', 'work'].includes(state.view)) return;
  dragDepth++;
  document.getElementById('drop-overlay').classList.add('show');
  document.getElementById('dropzone')?.classList.add('dragover');
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) {
    document.getElementById('drop-overlay').classList.remove('show');
    document.getElementById('dropzone')?.classList.remove('dragover');
  }
});
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.getElementById('drop-overlay').classList.remove('show');
  if (!widget || !['empty', 'work'].includes(state.view)) return;
  if (widget.onDrop) widget.onDrop([...e.dataTransfer.files]);
  else addFiles([...e.dataTransfer.files]);
});
// Paste files (screenshots, copied files) straight into the tool.
document.addEventListener('paste', (e) => {
  const target = e.target;
  if (target && (/INPUT|TEXTAREA/.test(target.tagName) || target.isContentEditable)) return;
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length || !widget || !['empty', 'work'].includes(state.view)) return;
  e.preventDefault();
  const named = files.map((f, i) => (f.name && f.name !== 'image.png' ? f
    : new File([f], `pasted_${Date.now()}_${i + 1}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type })));
  if (widget.onDrop) widget.onDrop(named); else addFiles(named);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.view === 'processing') { cancelJob(); return; }
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key === 'Enter' && ['work', 'empty', 'error'].includes(state.view) && !runBtn.disabled) { e.preventDefault(); run(); }
  else if (e.key.toLowerCase() === 'o' && ['work', 'empty'].includes(state.view)) { e.preventDefault(); openPicker(); }
});

// ------------------------------------------------------------------- init
const WIDGETS = {
  files: async () => filesWidget(),
  pages: () => import('./widgets/pages.js'),
  split: () => import('./widgets/split.js'),
  rotate: () => import('./widgets/rotate.js'),
  crop: () => import('./widgets/crop.js'),
  editor: () => import('./widgets/editor.js'),
  sign: () => import('./widgets/sign.js'),
  redact: () => import('./widgets/redact.js'),
  compare: () => import('./widgets/compare.js'),
  scan: () => import('./widgets/scan.js'),
  url: () => import('./widgets/url.js'),
  form: () => import('./widgets/form.js'),
  chat: () => import('./widgets/chat.js'),
  outline: () => import('./widgets/outline.js'),
};

async function preload(params) {
  const metas = [];
  const from = params.get('from');
  const ids = (params.get('files') || '').split(',').filter(Boolean);
  if (from || ids.length) history.replaceState(null, '', location.pathname);
  try {
    if (from) metas.push(...(await api.post(`/api/jobs/${from}/continue`)).files);
    for (const id of ids) metas.push(await api.get(`/api/files/${id}`));
  } catch (e) {
    toast('Those files have expired – please add them again.', 'error');
  }
  for (const meta of metas.filter((m) => tool.acceptInfo.kinds.includes(m.kind)).slice(0, tool.multiple ? (tool.maxFiles || 50) : 1)) {
    state.files.push({ key: ++uid, ...meta, uploading: false, rotation: 0, options: {} });
  }
}

async function init() {
  if (!tool) { location.replace('/'); return; }
  const cat = CAT_MAP[tool.cat];
  const page = renderShell({ active: slug, crumbs: [{ label: 'Tools', href: '/' }, { label: cat.name, href: '/' }, { label: tool.name }] });
  setTitle(tool.name);
  buildLayout(page);
  state.options = defaultsFor(tool.options);
  state.caps = await capabilities();
  const mod = await WIDGETS[tool.workspace || 'files']();
  widget = mod.create ? mod.create(ctx) : mod;
  if (!widget.payload) widget.payload = filesWidget().payload;
  widgetReady();
  await preload(new URLSearchParams(location.search));
  if (widget.onFiles && state.files.length) widget.onFiles();
  setView(state.files.length || widget.startInWork ? 'work' : 'empty');
  for (const f of state.files) if (f.needs_password) { await unlockEntry(f); filesChanged(); }
}

init();
