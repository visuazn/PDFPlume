// Home: universal drop area with tool suggestions, quick actions, the tool
// directory, recent results and the local engine status.
import { api, capabilities, humanSize } from './api.js';
import { ICONS, toolIcon } from './icons.js';
import { CATEGORIES, KIND_COLOR, POPULAR, TOOLS, TOOL_MAP } from './tools.js';
import { clearRecent, esc, getRecent, h, isMac, modKey, relativeTime, renderShell, setTitle, toast } from './ui.js';

const page = renderShell({ active: null, crumbs: [] });
setTitle('');

const ALL_EXT = [...new Set(TOOLS.flatMap((t) => t.acceptInfo.ext.split(',')))].join(',');
const KIND_LABEL = { pdf: 'PDF', image: 'image', word: 'Word document', powerpoint: 'presentation', excel: 'spreadsheet', html: 'HTML file' };
const SUGGEST = {
  pdf1: ['compress_pdf', 'edit_pdf', 'sign_pdf', 'pdf_to_word', 'split_pdf', 'organize_pdf', 'add_watermark', 'protect_pdf',
    'pdf_to_jpg', 'summarize_pdf', 'ocr_pdf', 'redact_pdf', 'add_page_numbers', 'rotate_pdf', 'crop_pdf', 'pdf_to_excel'],
  pdfN: ['merge_pdf', 'compare_pdf', 'compress_pdf', 'organize_pdf', 'add_page_numbers', 'add_watermark', 'protect_pdf', 'rotate_pdf', 'pdf_to_jpg', 'pdf_to_word'],
  image: ['jpg_to_pdf', 'scan_to_pdf'], word: ['word_to_pdf'], powerpoint: ['powerpoint_to_pdf'], excel: ['excel_to_pdf'], html: ['html_to_pdf'],
};
const greeting = () => { const hr = new Date().getHours(); return hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening'; };

let intakeFiles = [];
let filter = 'all';
let query = '';

// ------------------------------------------------------------------ layout
const main = h('div', { class: 'home-main' });
const aside = h('aside', { class: 'home-aside' });
page.append(h('div', { class: 'home' }, main, aside));

main.append(h('div', { class: 'greet' }, h('h1', {}, `${greeting()} — what are we working on?`),
  h('p', {}, 'Drop files to see what you can do with them, or pick a tool. Nothing leaves this computer.')));

const intake = h('section', { class: 'intake', 'aria-label': 'Add files' });
const picker = h('input', { type: 'file', multiple: true, accept: ALL_EXT, class: 'hidden' });
picker.addEventListener('change', () => { if (picker.files.length) addIntake([...picker.files]); picker.value = ''; });
main.append(intake, picker);

// ------------------------------------------------------------------ intake
function renderIntake() {
  intake.innerHTML = '';
  if (!intakeFiles.length) {
    const drop = h('div', { class: 'intake-drop', role: 'button', tabindex: '0', onclick: () => picker.click(),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); picker.click(); } } },
    h('div', { class: 'intake-art', html: ICONS.upload }),
    h('div', { class: 'intake-text' },
      h('h3', {}, 'Drop files here'),
      h('p', {}, 'We’ll suggest the right tools for them.'),
      h('div', { class: 'intake-formats' }, ...['PDF', 'DOCX', 'XLSX', 'PPTX', 'JPG', 'PNG', 'HEIC', 'HTML'].map((f) => h('span', { class: 'fmt' }, f)))),
    h('button', { type: 'button', class: 'btn primary lg', onclick: (e) => { e.stopPropagation(); picker.click(); } }, 'Choose files'));
    intake.append(drop, h('div', { class: 'intake-privacy', html: `${ICONS.shield}<span>Processed on this computer · files are deleted automatically after 2 hours</span>` }));
    return;
  }
  const box = h('div', { class: 'suggest' });
  const pills = h('div', { class: 'suggest-files' });
  for (const f of intakeFiles) {
    const ext = (f.name.split('.').pop() || '').toUpperCase().slice(0, 4);
    const color = KIND_COLOR[f.kind] || '#84848f';
    pills.append(h('span', { class: `file-pill${f.uploading ? ' busy' : ''}`, title: f.name },
      h('span', { class: 'ext', style: { background: color } }, ext), h('span', {}, f.name)));
  }
  pills.append(h('button', { type: 'button', class: 'btn ghost sm', onclick: () => picker.click(), html: `${ICONS.plus} Add` }),
    h('button', { type: 'button', class: 'btn ghost sm', onclick: () => { intakeFiles.forEach((f) => f.id && api.del(`/api/files/${f.id}`).catch(() => {})); intakeFiles = []; renderIntake(); } }, 'Clear'));
  box.append(pills);
  const ready = intakeFiles.filter((f) => f.id);
  if (intakeFiles.some((f) => f.uploading)) {
    box.append(h('p', { class: 'muted', style: 'margin:0' }, 'Reading files…'));
  }
  const groups = {};
  for (const f of ready) (groups[f.kind] = groups[f.kind] || []).push(f);
  for (const [kind, files] of Object.entries(groups)) {
    let slugs = kind === 'pdf' ? (files.length > 1 ? SUGGEST.pdfN : SUGGEST.pdf1) : (SUGGEST[kind] || []);
    if (kind === 'pdf' && files.length !== 2) slugs = slugs.filter((s) => s !== 'compare_pdf');
    if (kind === 'pdf' && files.some((f) => f.needs_password || f.encrypted)) slugs = ['unlock_pdf', ...slugs];
    if (!slugs.length) continue;
    const label = `${files.length} ${KIND_LABEL[kind] || 'file'}${files.length > 1 ? 's' : ''}`;
    box.append(h('h3', {}, Object.keys(groups).length > 1 ? `For your ${label}` : `Suggested for your ${label}`));
    const grid = h('div', { class: 'suggest-grid', style: 'margin-bottom:16px' });
    slugs.slice(0, 9).forEach((slug, i) => {
      const t = TOOL_MAP[slug];
      const ids = files.slice(0, t.multiple ? 50 : 1).map((f) => f.id).join(',');
      grid.append(h('a', { class: `suggest-item${i === 0 ? ' best' : ''}`, href: `${t.url}?files=${ids}`,
        html: `${toolIcon(t)}<span><b>${esc(t.name)}</b><small>${i === 0 ? 'Best match' : esc(t.desc)}</small></span>` }));
    });
    box.append(grid);
  }
  if (!ready.length && !intakeFiles.some((f) => f.uploading)) box.append(h('p', { class: 'muted' }, 'These files are not supported.'));
  intake.append(box);
}

async function addIntake(list) {
  const accepted = list.filter((f) => ALL_EXT.split(',').some((e) => f.name.toLowerCase().endsWith(e)));
  if (accepted.length < list.length) toast('Some files were skipped (unsupported type).', 'error');
  const entries = accepted.map((file) => ({ name: file.name, uploading: true, file }));
  intakeFiles.push(...entries);
  renderIntake();
  await Promise.all(entries.map(async (e) => {
    try {
      Object.assign(e, await api.upload(e.file), { uploading: false });
    } catch (err) {
      toast(`${e.name}: ${err.message}`, 'error');
      intakeFiles = intakeFiles.filter((x) => x !== e);
    }
    renderIntake();
  }));
}

// whole-page drag & drop feeds the intake
let depth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth++; intake.classList.add('dragover'); } });
window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) intake.classList.remove('dragover'); });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  depth = 0;
  intake.classList.remove('dragover');
  addIntake([...e.dataTransfer.files]);
});

document.addEventListener('paste', (e) => {
  if (/INPUT|TEXTAREA/.test(e.target?.tagName || '')) return;
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  addIntake(files.map((f, i) => (f.name && f.name !== 'image.png' ? f
    : new File([f], `pasted_${Date.now()}_${i + 1}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type }))));
});

// ------------------------------------------------------------ quick actions
main.append(h('section', {}, h('div', { class: 'section-head' }, h('h2', {}, 'Quick actions')),
  h('div', { class: 'quick' }, ...POPULAR.map((s) => { const t = TOOL_MAP[s]; return h('a', { href: t.url, html: `${toolIcon(t)}<b>${esc(t.name)}</b>` }); }))));

// ------------------------------------------------------------ directory
const dirSection = h('section', {});
const filterBar = h('div', { class: 'cat-filter', role: 'tablist' });
const find = h('label', { class: 'find', html: ICONS.search },
  h('input', { type: 'search', placeholder: 'Filter tools', 'aria-label': 'Filter tools', oninput: (e) => { query = e.target.value.trim().toLowerCase(); renderDirectory(); } }));
const directory = h('div', { class: 'directory' });
dirSection.append(h('div', { class: 'section-head' }, h('h2', {}, `All tools`), h('span', { class: 'muted', style: 'font-size:13px' }, `${TOOLS.length}`),
  h('span', { class: 'spacer' }), find), filterBar, h('div', { style: 'height:16px' }), directory);
main.append(dirSection);

function renderFilters() {
  filterBar.innerHTML = '';
  for (const c of [{ id: 'all', name: 'All' }, ...CATEGORIES]) {
    filterBar.append(h('button', { type: 'button', role: 'tab', 'aria-selected': String(filter === c.id), class: filter === c.id ? 'active' : '',
      onclick: () => { filter = c.id; renderFilters(); renderDirectory(); } }, c.name));
  }
}

function renderDirectory() {
  directory.innerHTML = '';
  let shown = 0;
  for (const c of CATEGORIES) {
    if (filter !== 'all' && filter !== c.id) continue;
    const tools = TOOLS.filter((t) => t.cat === c.id && (!query || `${t.name} ${t.desc} ${t.keywords}`.toLowerCase().includes(query)));
    if (!tools.length) continue;
    shown += tools.length;
    directory.append(h('div', { class: 'dir-cat' },
      h('h3', {}, h('i', { style: { background: c.color } }), c.name, h('span', { style: 'font-weight:500;text-transform:none;letter-spacing:0' }, `· ${c.blurb}`)),
      h('div', { class: 'dir-grid' }, ...tools.map((t) => h('a', { class: 'tool-row', href: t.url,
        html: `${toolIcon(t)}<span><b>${esc(t.name)}</b><span class="desc">${esc(t.desc)}</span></span>${t.tag ? `<span class="tag">${esc(t.tag)}</span>` : ''}` })))));
  }
  if (!shown) directory.append(h('div', { class: 'empty-note' }, `No tool matches “${query}”.`));
}

// --------------------------------------------------------------- aside
function renderRecent() {
  const items = getRecent();
  const card = h('div', { class: 'card' }, h('h4', { html: `${ICONS.clock}<span>Recent results</span><span class="spacer"></span>` }));
  if (items.length) {
    card.firstChild.append(h('button', { type: 'button', class: 'link-btn', style: 'font-size:12px', onclick: () => { clearRecent(); card.replaceWith(renderRecent()); } }, 'Clear'));
    const list = h('div', { class: 'recent-list' });
    for (const r of items.slice(0, 8)) {
      const t = TOOL_MAP[r.tool];
      list.append(h('div', { class: 'recent-item' }, h('span', { html: toolIcon(t) }),
        h('div', { class: 'ri' }, h('b', { title: r.file }, r.file), h('small', {}, `${t.name} · ${relativeTime(r.t)} · ${humanSize(r.size)}`)),
        h('a', { class: 'icon-btn', href: api.downloadUrl(r.job), title: 'Download', html: ICONS.download })));
    }
    card.append(list);
  } else {
    card.append(h('p', { class: 'muted', style: 'margin:0;font-size:13px' }, 'Files you create appear here for two hours, then they are deleted.'));
  }
  return card;
}

const OS = isMac ? 'mac' : /Win/.test(navigator.platform || navigator.userAgent) ? 'win' : 'linux';
const INSTALL = {
  libreoffice: { mac: 'brew install --cask libreoffice', win: 'winget install TheDocumentFoundation.LibreOffice', linux: 'sudo apt install libreoffice' },
  tesseract: { mac: 'brew install tesseract', win: 'winget install UB-Mannheim.TesseractOCR', linux: 'sudo apt install tesseract-ocr' },
  ghostscript: { mac: 'brew install ghostscript', win: 'winget install ArtifexSoftware.GhostScript', linux: 'sudo apt install ghostscript' },
};

async function renderEngines(card) {
  const caps = await capabilities();
  const rows = [
    ['libreoffice', 'LibreOffice', 'Exact Office → PDF conversion', caps.libreoffice],
    ['tesseract', 'Tesseract OCR', 'Text recognition in scans', caps.tesseract],
    ['ghostscript', 'Ghostscript', 'Stronger compression, PDF/A', caps.ghostscript],
    ['html', 'Web renderer', caps.html_engine === 'basic' ? 'Install Chrome for full web pages' : `Using ${caps.html_engine}`, caps.html_engine !== 'basic'],
    ['translate', 'Translation engine', 'argos-translate, LibreTranslate or Ollama', caps.translation && caps.translation.available],
  ];
  const list = h('ul', { class: 'engine-list' });
  for (const [key, name, note, on] of rows) {
    const cmd = !on && INSTALL[key] ? INSTALL[key][OS] : null;
    list.append(h('li', {}, h('span', { class: `st ${on ? 'on' : 'off'}`, html: on ? ICONS.check : ICONS.x }),
      h('div', {}, h('span', {}, name), h('small', { html: cmd ? `${esc(note)} · <code>${esc(cmd)}</code>` : esc(note) }))));
  }
  card.append(list);
}

aside.append(renderRecent());
const engines = h('div', { class: 'card' }, h('h4', { html: `${ICONS.cpu}<span>Local engines</span>` }));
aside.append(engines);
renderEngines(engines);
aside.append(h('div', { class: 'card' }, h('h4', { html: `${ICONS.keyboard}<span>Shortcuts</span>` }),
  h('div', { class: 'shortcut-list', html: `
    <span>Find any tool</span><span><kbd>${modKey}</kbd><kbd>K</kbd></span>
    <span>Quick search</span><span><kbd>/</kbd></span>
    <span>Run the current tool</span><span><kbd>${modKey}</kbd><kbd>↵</kbd></span>
    <span>Add files</span><span><kbd>${modKey}</kbd><kbd>O</kbd></span>` })));

renderIntake();
renderFilters();
renderDirectory();
