// Redact PDF: mark areas by hand and/or search words and patterns.
import { ICONS } from '../icons.js';
import { debounce, esc, h, toast } from '../ui.js';
import { EditorCore } from './editor-core.js';

const PATTERNS = [
  ['email', 'Email addresses'], ['phone', 'Phone numbers'], ['url', 'Web addresses (URLs)'],
  ['date', 'Dates'], ['credit_card', 'Credit card numbers'], ['iban', 'IBAN / bank accounts'],
  ['ssn', 'Social security numbers'], ['ip', 'IP addresses'],
];

export function create(ctx) {
  const st = { terms: [], patterns: new Set(), case_sensitive: false, whole_words: false, fill: '#000000', remove_metadata: true, matches: [], counts: {} };
  let sideBody = null;
  let summary = null;
  const core = new EditorCore(ctx, {
    tools: { area: { kind: 'box', make: (p, page) => ({ type: 'area', page, x: p.x, y: p.y, w: 0, h: 0 }) } },
    onChange: () => updateSummary(),
  });
  core.tool = 'area';

  const file = () => ctx.ready()[0];

  const refreshMatches = debounce(async () => {
    const f = file();
    if (!f) return;
    if (!st.terms.length && !st.patterns.size) { st.matches = []; applyOverlays(); return; }
    try {
      const res = await ctx.api.post(`/api/files/${f.id}/search`, { terms: st.terms, patterns: [...st.patterns], case_sensitive: st.case_sensitive, whole_words: st.whole_words });
      st.matches = res.matches;
    } catch (e) { toast(e.message, 'error'); st.matches = []; }
    st.counts = {};
    for (const m of st.matches) st.counts[m.text.toLowerCase()] = (st.counts[m.text.toLowerCase()] || 0) + 1;
    applyOverlays();
    renderSide();
  }, 250);

  function applyOverlays() {
    core.overlays = {};
    for (const m of st.matches) {
      (core.overlays[m.page] = core.overlays[m.page] || []).push({ x0: m.rect[0], y0: m.rect[1], x1: m.rect[2], y1: m.rect[3] });
    }
    core.views.forEach((_, i) => core.renderLayer(i));
    updateSummary();
  }

  function updateSummary() {
    if (!summary) return;
    summary.textContent = `${core.elements.length} marked area(s) and ${st.matches.length} text match(es) will be permanently removed.`;
  }

  function renderSide() {
    if (!sideBody) return;
    sideBody.innerHTML = '';
    summary = h('div', { class: 'info-box' });
    sideBody.append(summary);
    updateSummary();
    const mark = h('button', { type: 'button', class: `btn${core.tool === 'area' ? ' active' : ''}`, style: 'width:100%;justify-content:center', html: `${ICONS.square} ${core.tool === 'area' ? 'Drawing areas - click to stop' : 'Mark areas on the page'}`,
      onclick: () => { core.setTool(core.tool === 'area' ? 'select' : 'area'); renderSide(); } });
    sideBody.append(h('div', { class: 'opt' }, h('label', { class: 'lbl' }, 'Redact areas'), mark));

    const input = h('input', { type: 'text', placeholder: 'Word or phrase, e.g. a name' });
    const add = () => {
      const v = input.value.trim();
      if (!v) return;
      if (!st.terms.includes(v)) st.terms.push(v);
      input.value = '';
      refreshMatches();
      renderSide();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    const chips = h('div', { class: 'chip-list' }, ...st.terms.map((t) => h('span', { class: 'chip' }, esc(t),
      h('span', { class: 'cnt' }, st.counts[t.toLowerCase()] || 0),
      h('button', { type: 'button', onclick: () => { st.terms = st.terms.filter((x) => x !== t); refreshMatches(); renderSide(); } }, '×'))));
    sideBody.append(h('div', { class: 'opt' }, h('label', { class: 'lbl' }, 'Search text to redact'),
      h('div', { class: 'row' }, input, h('button', { type: 'button', class: 'btn primary', style: 'flex:none', onclick: add }, 'Add')), chips,
      h('div', { style: 'display:flex;gap:16px;margin-top:10px;flex-wrap:wrap' },
        h('label', { class: 'check-row', style: 'font-size:13px' }, h('input', { type: 'checkbox', checked: st.case_sensitive, onchange: (e) => { st.case_sensitive = e.target.checked; refreshMatches(); } }), 'Match case'),
        h('label', { class: 'check-row', style: 'font-size:13px' }, h('input', { type: 'checkbox', checked: st.whole_words, onchange: (e) => { st.whole_words = e.target.checked; refreshMatches(); } }), 'Whole words'))));

    const pats = h('div', { style: 'display:grid;gap:8px' });
    for (const [key, label] of PATTERNS) {
      pats.append(h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: st.patterns.has(key), onchange: (e) => {
        if (e.target.checked) st.patterns.add(key); else st.patterns.delete(key);
        refreshMatches();
      } }), label));
    }
    sideBody.append(h('div', { class: 'opt' }, h('label', { class: 'lbl' }, 'Find sensitive data automatically'), pats));
    const sw = h('div', { class: 'swatches' }, ...['#000000', '#ffffff', '#5b5bd6', '#7a7a85'].map((c) => h('button', { type: 'button', class: st.fill === c ? 'active' : '', style: { background: c }, title: c,
      onclick: () => { st.fill = c; renderSide(); } })));
    sideBody.append(h('div', { class: 'opt' }, h('label', { class: 'lbl' }, 'Redaction color'), sw),
      h('div', { class: 'opt' }, h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: st.remove_metadata, onchange: (e) => { st.remove_metadata = e.target.checked; } }),
        'Also remove document metadata (author, title …)')));
  }

  return {
    flush: true,
    async render(area) {
      const f = file();
      if (!f) { area.innerHTML = '<p class="grid-hint" style="padding:40px">Uploading…</p>'; return; }
      if (area.querySelector('.editor-shell') && core.file && core.file.id === f.id) return;
      await core.load(f);
      area.innerHTML = '';
      const bar = h('div', { class: 'editor-bar' }, h('span', { class: 'muted', style: 'padding:0 8px;font-size:14px' }, 'Drag over the page to mark areas · search matches are highlighted'),
        h('span', { style: 'flex:1' }),
        h('button', { type: 'button', class: 'tool-btn', onclick: () => core.undo(), html: `${ICONS.undo}<span>Undo</span>` }),
        h('button', { type: 'button', class: 'tool-btn', onclick: () => core.setZoom(core.zoom / 1.2), html: `${ICONS.zoomOut}<span>Zoom</span>` }),
        h('button', { type: 'button', class: 'tool-btn', onclick: () => core.setZoom(core.zoom * 1.2), html: `${ICONS.zoomIn}<span>Zoom</span>` }));
      const scroll = h('div', { class: 'editor-scroll' });
      area.append(h('div', { class: 'editor-shell' }, bar, scroll));
      core.mount(scroll);
      core.setTool(core.tool);
      applyOverlays();
    },
    sidebar(body) { sideBody = body; renderSide(); },
    onFiles() { core.file = null; st.matches = []; },
    validate() { return core.elements.length || st.terms.length || st.patterns.size ? null : 'Mark an area or add a word to redact.'; },
    payload() {
      return {
        files: [{ id: file().id }],
        options: {
          areas: core.elements.map((e) => ({ page: e.page, x0: e.x, y0: e.y, x1: e.x + e.w, y1: e.y + e.h })),
          terms: st.terms, patterns: [...st.patterns], case_sensitive: st.case_sensitive, whole_words: st.whole_words,
          fill: st.fill, remove_metadata: st.remove_metadata,
        },
      };
    },
  };
}
