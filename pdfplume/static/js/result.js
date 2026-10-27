// Result state: previews in the canvas, download and next steps in the inspector.
import { api, humanSize } from './api.js';
import { ICONS, toolIcon } from './icons.js';
import { TOOL_MAP } from './tools.js';
import { esc, h, toast } from './ui.js';

const EXT_COLOR = { pdf: '#5b5bd6', docx: '#2b579a', pptx: '#c4441c', xlsx: '#1e7145', zip: '#5b6577', jpg: '#c97a00', png: '#c97a00', txt: '#5b6577', md: '#0a8fb3' };
const extOf = (name) => (name.split('.').pop() || '').toLowerCase();
const previewable = (name) => ['pdf', 'jpg', 'jpeg', 'png'].includes(extOf(name));
const thumb = (jobId, name, w = 440) => `/api/jobs/${jobId}/thumb?file=${encodeURIComponent(name)}&w=${w}`;

function glyph(name) {
  const ext = extOf(name);
  return h('div', { class: 'file-glyph', style: { '--c': EXT_COLOR[ext] || 'var(--accent)' } }, h('b', {}, ext.toUpperCase()));
}

function resultTitle(tool, result) {
  const x = result.extra || {};
  if (tool.slug === 'compare_pdf') return x.identical ? 'No differences found' : 'Differences found';
  if (tool.slug === 'compress_pdf' && !x.saved_percent) return 'Already well optimized';
  return tool.done;
}

function notesFor(tool, result) {
  const x = result.extra || {};
  const notes = [];
  if (x.note) notes.push(x.note);
  if (tool.slug === 'ocr_pdf' && x.pages_recognized) notes.push(`Text recognized on ${x.pages_recognized} page${x.pages_recognized > 1 ? 's' : ''}.`);
  if (tool.slug === 'split_pdf' && result.count > 1) notes.push(`${result.count} PDF files, packed in one ZIP archive.`);
  if (tool.slug === 'redact_pdf') notes.push(`${x.redactions} area${x.redactions === 1 ? '' : 's'} permanently removed – the hidden text is gone, not just covered.`);
  if (tool.slug === 'pdf_to_excel' && x.tables_found === 0) notes.push('No ruled tables found, so text was split into columns automatically.');
  if (x.engine === 'basic' && tool.slug === 'html_to_pdf') notes.push('Rendered with the basic engine. Install Chrome for full CSS and JavaScript.');
  if (x.engine === 'basic' && tool.engine === 'libreoffice') notes.push('Converted with the built-in converter. Install LibreOffice for an exact layout.');
  if (tool.slug === 'repair_pdf' && x.files) {
    const fixed = x.files.filter((f) => f.had_errors).length;
    notes.push(fixed ? `${fixed} file${fixed > 1 ? 's' : ''} had structural errors and were rebuilt.` : 'No structural errors found – the file was rebuilt and tidied anyway.');
  }
  if (tool.slug === 'translate_pdf') notes.push(`Translated to ${x.target} with ${x.engine}.`);
  if (x.digital) {
    const who = String(x.digital.signer || '').replace(/^.*Common Name: /, '');
    const ok = (x.digital.signatures || []).every((sg) => sg.intact && sg.valid);
    notes.push(ok ? `Digitally signed by ${who}. Any change to the file from now on will show up as a broken signature.`
      : 'The file was signed, but the signature could not be verified.');
  }
  if (x.warning) notes.push(x.warning);
  return notes;
}

function savingsCard(x) {
  const before = x.before || 1;
  const after = x.after || 0;
  return h('div', { class: 'savings' },
    h('div', { class: 'big' }, x.saved_percent ? `−${x.saved_percent}%` : '0%'),
    h('div', { class: 'muted', style: 'font-size:13px' }, x.saved_percent ? `Saved ${humanSize(before - after)}` : 'No smaller version could be made'),
    h('div', { class: 'bars' },
      h('div', { class: 'bar' }, h('span', {}, 'Before'), h('i', { style: { width: '100%' } }), h('span', {}, humanSize(before))),
      h('div', { class: 'bar' }, h('span', {}, 'After'), h('i', { class: 'after', style: { width: `${Math.max(2, (after / before) * 100)}%` } }), h('span', {}, humanSize(after)))));
}

function textPanel(result) {
  const x = result.extra || {};
  const text = x.preview || '';
  const panel = h('div', { class: 'result-panel' },
    h('div', { class: 'stats' }, h('span', {}, x.format === 'md' ? 'Markdown' : 'Plain text'), h('span', {}, `${(x.words || 0).toLocaleString()} words`),
      text.length >= 8000 ? h('span', {}, 'Preview of the beginning') : null),
    h('pre', { class: 'text-preview' }, text),
    h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:12px' }, h('span'),
      h('button', { type: 'button', class: 'btn sm', style: 'flex:none', html: `${ICONS.copy} Copy all`, onclick: async () => {
        try {
          const full = await fetch(api.downloadUrl(result.jobId, result.outputs[0].name)).then((r) => r.text());
          await navigator.clipboard.writeText(full);
          toast('Copied to the clipboard');
        } catch (e) { toast('Copy failed', 'error'); }
      } })));
  return panel;
}

function summaryPanel(result, state) {
  const x = result.extra || {};
  const st = x.stats || {};
  const src = state && state.files && state.files[0] && state.files[0].id;
  const pageLink = (page) => (src
    ? h('a', { class: 'pref', href: `/api/files/${src}/download?inline=1#page=${page}`, target: '_blank', rel: 'noopener', title: `Open the original at page ${page}` }, `p. ${page}`)
    : h('span', { class: 'pref' }, `p. ${page}`));
  const pointList = (points) => h('ul', {}, ...points.map((pt) => h('li', {}, pt.text, ' ', pageLink(pt.page))));
  const panel = h('div', { class: 'result-panel' });
  panel.append(h('div', { class: 'stats' },
    h('span', {}, `${st.pages} pages`), h('span', {}, `${(st.words || 0).toLocaleString()} words`),
    h('span', {}, `~${st.reading_minutes} min read`), h('span', {}, x.engine === 'ollama' ? 'Written by your local model' : 'Built-in summarizer')));
  const points = x.points || (x.summary || []).map((t) => ({ text: t }));
  let text;
  if (x.ai_summary) {
    text = x.ai_summary;
    const body = h('div', { style: 'white-space:pre-wrap;line-height:1.65;color:var(--text-2)' });
    let last = 0;
    for (const m of x.ai_summary.matchAll(/\((?:p|page)\.\s*(\d+)\)|\[(?:p|page)\.?\s*(\d+)\]/gi)) {
      body.append(x.ai_summary.slice(last, m.index), pageLink(Number(m[1] || m[2])));
      last = m.index + m[0].length;
    }
    body.append(x.ai_summary.slice(last));
    panel.append(h('h3', {}, 'Summary'), body);
  } else {
    text = points.map((p) => `• ${p.text}${p.page ? ` (p. ${p.page})` : ''}`).join('\n');
    panel.append(h('h3', {}, 'Key points'), pointList(points.filter((p) => p.page)), points.some((p) => !p.page) ? h('ul', {}, ...points.filter((p) => !p.page).map((p) => h('li', {}, p.text))) : null);
  }
  if (x.keywords && x.keywords.length) {
    panel.append(h('h3', { style: 'margin-top:18px' }, 'Key terms'), h('div', { class: 'chip-list' }, ...x.keywords.map((k) => h('span', { class: 'chip', style: 'padding-right:10px' }, k))));
  }
  const sections = x.sections || [];
  if (sections.length) {
    text += `\n\nSection by section\n${sections.map((sec) => `\n${sec.title} (p. ${sec.page})${sec.points.map((p) => `\n• ${p.text} (p. ${p.page})`).join('')}`).join('')}`;
    const list = h('div', { class: 'sections' });
    sections.forEach((sec, i) => {
      const d = h('details', { class: sec.level > 1 ? 'sub' : '', open: i < 3 || null },
        h('summary', {}, h('span', { class: 't' }, sec.title), pageLink(sec.page)),
        sec.points.length ? pointList(sec.points) : h('p', { class: 'none' }, 'Short section – nothing to summarize.'));
      list.append(d);
    });
    panel.append(h('h3', { style: 'margin-top:20px' }, `Section by section · ${sections.length}`), list);
  }
  panel.append(h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:18px;gap:8px' }, h('span'),
    src ? h('a', { class: 'btn sm', style: 'flex:none', href: `/chat_pdf?files=${src}`, html: `${ICONS.sparkle} Ask questions` }) : null,
    h('button', { type: 'button', class: 'btn sm', style: 'flex:none', html: `${ICONS.copy} Copy`, onclick: async () => {
      try { await navigator.clipboard.writeText(text); toast('Summary copied'); } catch (e) { toast('Copy failed', 'error'); }
    } }),
    h('button', { type: 'button', class: 'btn sm', style: 'flex:none', html: `${ICONS.download} .txt`, onclick: () => {
      const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: 'summary.txt' });
      document.body.append(a); a.click(); a.remove();
    } })));
  return panel;
}

export function renderResultCanvas(root, { tool, result, state }) {
  const x = result.extra || {};
  const wrap = h('div', { class: `result${tool.slug === 'compare_pdf' ? ' wide' : ''}` });
  wrap.append(h('span', { class: 'result-badge', html: `${ICONS.checkCircle}<span>Done in ${result.elapsed < 1 ? '<1' : result.elapsed.toFixed(1)} s · on this computer</span>` }),
    h('h2', {}, resultTitle(tool, result)));

  if (tool.slug === 'compress_pdf') wrap.append(savingsCard(x));
  if (tool.slug === 'summarize_pdf') {
    wrap.append(summaryPanel(result, state));
  } else if (tool.slug === 'pdf_to_text') {
    wrap.append(textPanel(result));
  } else if (tool.slug === 'compare_pdf') {
    const slot = h('div', { style: 'width:100%;display:flex;flex-direction:column;gap:14px' });
    wrap.append(slot);
    import('./widgets/compare.js').then((m) => m.renderComparison(slot, result));
  } else {
    const outputs = result.outputs || [];
    const shown = outputs.slice(0, outputs.length > 4 ? 3 : 4);
    const previews = h('div', { class: 'result-previews' });
    for (const o of shown) {
      const cell = h('div', { class: `rp${outputs.length > 1 ? ' small' : ''}` });
      if (previewable(o.name) && tool.slug !== 'protect_pdf') { // encrypted output cannot be rendered
        const img = h('img', { src: thumb(result.jobId, o.name, outputs.length > 1 ? 260 : 440), alt: o.name });
        img.onerror = () => img.replaceWith(glyph(o.name));
        cell.append(img);
      } else {
        cell.append(glyph(o.name));
      }
      if (outputs.length > 1) cell.append(h('span', { title: o.name }, o.name));
      previews.append(cell);
    }
    if (outputs.length > shown.length) previews.append(h('div', { class: 'rp small' }, h('div', { class: 'more' }, `+${outputs.length - shown.length}`), h('span', {}, 'more in the ZIP')));
    wrap.append(previews);
  }
  for (const n of notesFor(tool, result)) {
    wrap.append(h('div', { class: 'callout info', style: 'width:min(560px,100%);margin:0', html: `${ICONS.info}<span>${esc(n)}</span>` }));
  }
  root.append(wrap);
}

export function renderResultInspector(body, { tool, result, state, onBack, onNew }) {
  const url = api.downloadUrl(result.jobId);
  const ext = extOf(result.file);
  body.append(h('div', { class: 'res-file' },
    h('span', { class: 'fi-ext', style: { '--c': EXT_COLOR[ext] || 'var(--accent)' } }, ext.toUpperCase()),
    h('div', { style: 'min-width:0' }, h('b', {}, result.file),
      h('small', {}, `${humanSize(result.size)}${result.count > 1 ? ` · ${result.count} files inside` : ''}`))));
  body.append(h('a', { class: 'btn-run', id: 'download-btn', href: url, download: result.file, style: 'margin-bottom:10px',
    html: `${ICONS.download}<span>Download${result.count > 1 ? ' ZIP' : ''}</span>` }));
  const actions = h('div', { class: 'res-actions' });
  if (ext === 'pdf') actions.append(h('a', { class: 'btn', href: `${url}?inline=1`, target: '_blank', rel: 'noopener', html: `${ICONS.eye} Open` }));
  actions.append(
    h('button', { type: 'button', class: 'btn', onclick: onBack, html: `${ICONS.back} Adjust` }),
    h('button', { type: 'button', class: 'btn', onclick: onNew, html: `${ICONS.plus} New task` }),
    h('button', { type: 'button', class: 'btn danger', title: 'Delete the result and your uploads now', html: `${ICONS.trash} Delete`, onclick: async () => {
      await api.del(`/api/jobs/${result.jobId}`).catch(() => {});
      for (const f of state.files) if (f.id) api.del(`/api/files/${f.id}`).catch(() => {});
      toast('Deleted from this computer');
      onNew();
    } }));
  body.append(actions);

  const outputs = result.outputs || [];
  const kind = outputs.every((o) => o.name.toLowerCase().endsWith('.pdf')) ? 'pdf'
    : outputs.every((o) => /\.(jpe?g|png)$/i.test(o.name)) ? 'image' : null;
  const next = (tool.next || []).map((s) => TOOL_MAP[s]).filter((t) => t && t.accept === kind);
  if (next.length) {
    body.append(h('div', { class: 'next-title' }, 'Continue with this file'));
    const list = h('div', { class: 'next-list' });
    for (const t of next) list.append(h('a', { href: `${t.url}?from=${result.jobId}`, html: `${toolIcon(t)}<span>${esc(t.name)}</span>${ICONS.chevR.replace('<svg', '<svg class="arr"')}` }));
    body.append(list);
  }
  body.append(h('p', { class: 'muted', style: 'font-size:12px;margin:18px 0 0;line-height:1.5' },
    'Results are kept for two hours, then deleted automatically. They also appear under “Recent results” on the home screen.'));
}
