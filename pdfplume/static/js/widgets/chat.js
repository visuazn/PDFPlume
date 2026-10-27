// Chat with PDF: the document on the left, a conversation in the inspector.
// Answers cite pages as [p. N]; citations and sources jump to the passage.
import { ICONS } from '../icons.js';
import { esc, h } from '../ui.js';

const CITE = /\[(?:p|pp|page)\.?\s*(\d+)(?:\s*[-–,]\s*(\d+))?\]|\((?:p|page)\.\s*(\d+)\)/gi;

export function create(ctx) {
  const st = { fileId: null, info: null, pages: [], messages: [], busy: false, zoom: 1, abort: null };
  let scroll = null;
  let msgsEl = null;
  let input = null;
  let sendBtn = null;
  const views = [];
  const file = () => ctx.ready()[0];

  async function load(f) {
    if (st.fileId === f.id) return;
    const [info, { pages }] = await Promise.all([ctx.api.get(`/api/files/${f.id}/chat`), ctx.api.get(`/api/files/${f.id}/pages`)]);
    Object.assign(st, { fileId: f.id, info, pages, messages: [] });
  }

  // -------------------------------------------------------------- viewer
  function renderPages() {
    if (!scroll) return;
    scroll.innerHTML = '';
    views.length = 0;
    const viewer = h('div', { class: 'viewer' });
    const maxW = Math.max(...st.pages.map((p) => p.w), 1);
    const base = Math.max(260, Math.min((scroll.clientWidth || 900) - 48, 860)) * st.zoom;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    st.pages.forEach((p, i) => {
      const w = base * (p.w / maxW);
      const req = Math.min(2400, Math.ceil((w * dpr) / 200) * 200);
      const layer = h('div', { class: 'layer' });
      const page = h('div', { class: 'vpage', 'data-page': i, style: { width: `${w}px`, height: `${w * (p.h / p.w)}px` } },
        h('img', { src: ctx.api.thumb(st.fileId, i, req), loading: i < 2 ? 'eager' : 'lazy', alt: `Page ${i + 1}`, draggable: 'false' }),
        layer, h('div', { class: 'pno' }, `${i + 1} / ${st.pages.length}`));
      views.push({ page, layer });
      viewer.append(page);
    });
    scroll.append(viewer);
  }

  function jump(page, rect = null) {
    const v = views[page];
    if (!v) return;
    v.layer.querySelectorAll('.chat-hl').forEach((x) => x.remove());
    views.forEach((x) => x.page.classList.remove('cited'));
    if (rect) {
      const [x0, y0, x1, y1] = rect;
      const hl = h('div', { class: 'chat-hl', style: { left: `${x0 * 100}%`, top: `${y0 * 100}%`, width: `${(x1 - x0) * 100}%`, height: `${(y1 - y0) * 100}%` } });
      v.layer.append(hl);
      setTimeout(() => hl.classList.add('fade'), 2600);
      const r = v.page.getBoundingClientRect();
      const s = scroll.getBoundingClientRect();
      scroll.scrollBy({ top: r.top - s.top + y0 * r.height - 80, behavior: 'smooth' });
    } else {
      v.page.classList.add('cited');
      setTimeout(() => v.page.classList.remove('cited'), 1600);
      v.page.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  // ---------------------------------------------------------------- chat
  function citeChip(page, sources) {
    const src = sources.find((s) => s.page === page - 1);
    return h('button', { type: 'button', class: 'cite', title: src ? src.text : `Go to page ${page}`, onclick: () => jump(page - 1, src && src.rect) }, `p. ${page}`);
  }

  function richText(text, sources) {
    const el = h('div', { class: 'chat-text' });
    for (const line of String(text).split('\n')) {
      const p = h('p', { class: /^\s*[•*-]\s+/.test(line) ? 'li' : '' });
      let last = 0;
      const clean = line.replace(/^\s*[•*-]\s+/, '');
      for (const m of clean.matchAll(CITE)) {
        p.append(clean.slice(last, m.index));
        const a = Number(m[1] || m[3]);
        const b = m[2] ? Number(m[2]) : null;
        if (a >= 1 && a <= st.pages.length) p.append(citeChip(a, sources)); else p.append(m[0]);
        if (b && b >= 1 && b <= st.pages.length && b !== a) p.append(citeChip(b, sources));
        last = m.index + m[0].length;
      }
      p.append(clean.slice(last));
      if (clean.trim()) el.append(p);
    }
    return el;
  }

  function messageEl(m) {
    if (m.role === 'user') return h('div', { class: 'msg user' }, h('div', { class: 'bubble' }, m.content));
    if (m.pending) return h('div', { class: 'msg bot' }, h('div', { class: 'bubble typing', 'aria-label': 'Thinking' }, h('i'), h('i'), h('i')));
    const box = h('div', { class: `msg bot${m.error ? ' error' : ''}` });
    const bubble = h('div', { class: 'bubble' }, richText(m.content, m.sources || []));
    if (m.engine === 'offline' && !m.error && m.sources && m.sources.length) {
      bubble.prepend(h('div', { class: 'msg-kicker' }, 'Closest passages in the document'));
    }
    box.append(bubble);
    if (m.warning) box.append(h('div', { class: 'msg-note' }, m.warning));
    if (m.sources && m.sources.length) {
      const list = h('div', { class: 'sources' }, h('span', { class: 'lbl' }, 'Sources'));
      const seen = new Set();
      for (const s of m.sources) {
        if (seen.has(s.page)) continue;
        seen.add(s.page);
        list.append(h('button', { type: 'button', class: 'src', title: s.text, onclick: () => jump(s.page, s.rect) },
          h('b', {}, `p. ${s.page + 1}`), h('span', {}, s.text.slice(0, 90))));
      }
      box.append(list);
    }
    return box;
  }

  function renderMessages() {
    if (!msgsEl) return;
    msgsEl.innerHTML = '';
    if (!st.messages.length) {
      const info = st.info || {};
      msgsEl.append(h('div', { class: 'chat-empty' },
        h('div', { class: 'ce-ico', html: ICONS.sparkle }),
        h('h3', {}, 'Ask this PDF anything'),
        h('p', {}, `Answers come from the ${info.pages || ''}-page document, with the page they’re on.`),
        h('div', { class: 'chat-suggest' }, ...(info.suggestions || []).map((q) => h('button', { type: 'button', class: 'chip-btn', onclick: () => send(q) }, q)))));
    }
    for (const m of st.messages) msgsEl.append(messageEl(m));
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  async function send(text) {
    const question = String(text ?? input.value).trim();
    if (!question || st.busy || !st.fileId) return;
    input.value = '';
    autosize();
    const history = st.messages.filter((m) => !m.pending && !m.error).map((m) => ({ role: m.role, content: m.content })).slice(-6);
    st.messages.push({ role: 'user', content: question });
    const pending = { role: 'assistant', pending: true, content: '' };
    st.messages.push(pending);
    st.busy = true;
    updateComposer();
    renderMessages();
    st.abort = new AbortController();
    try {
      const res = await fetch(`/api/files/${st.fileId}/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, history }), signal: st.abort.signal });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      Object.assign(pending, { pending: false, content: data.answer, sources: data.sources, engine: data.engine, warning: data.warning });
    } catch (e) {
      if (e.name === 'AbortError') st.messages.splice(st.messages.indexOf(pending), 1);
      else Object.assign(pending, { pending: false, error: true, content: e.message });
    }
    st.busy = false;
    st.abort = null;
    updateComposer();
    renderMessages();
    input.focus();
  }

  function autosize() {
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(140, input.scrollHeight)}px`;
  }

  function updateComposer() {
    if (!sendBtn) return;
    sendBtn.innerHTML = st.busy ? `${ICONS.x}` : ICONS.arrowR;
    sendBtn.title = st.busy ? 'Stop' : 'Send (Enter)';
    sendBtn.setAttribute('aria-label', sendBtn.title);
  }

  function engineLine() {
    const llm = (st.info && st.info.llm) || {};
    if (llm.available) return h('div', { class: 'chat-engine on', html: `${ICONS.cpu}<span>Local AI · <b>${esc(llm.model)}</b> via Ollama</span>` });
    return h('div', { class: 'chat-engine', html: `${ICONS.search}<span>Offline search – answers quote the document. Run <a href="https://ollama.com" target="_blank" rel="noopener">Ollama</a> for written answers.</span>` });
  }

  return {
    flush: true,
    noRun: true,
    inspectorTitle: 'Chat',
    async render(area) {
      const f = file();
      if (!f) { area.innerHTML = '<p class="grid-hint" style="padding:40px">Uploading…</p>'; return; }
      if (area.querySelector('.editor-shell') && st.fileId === f.id) return;
      const fresh = st.fileId !== f.id;
      area.innerHTML = '<p class="grid-hint" style="padding:40px">Reading the document…</p>';
      try { await load(f); } catch (e) { area.innerHTML = ''; area.append(h('div', { class: 'callout warn', style: 'margin:24px', html: `${ICONS.alert}<span>${esc(e.message)}</span>` })); return; }
      area.innerHTML = '';
      const bar = h('div', { class: 'editor-bar' },
        h('span', { class: 'muted', style: 'padding:0 8px;font-size:14px' }, `${st.pages.length} pages · ${(st.info.words || 0).toLocaleString()} words`),
        h('span', { style: 'flex:1' }),
        h('button', { type: 'button', class: 'tool-btn', onclick: () => { st.zoom = Math.max(0.5, st.zoom / 1.2); renderPages(); }, html: `${ICONS.zoomOut}<span>Zoom</span>` }),
        h('button', { type: 'button', class: 'tool-btn', onclick: () => { st.zoom = Math.min(3, st.zoom * 1.2); renderPages(); }, html: `${ICONS.zoomIn}<span>Zoom</span>` }));
      scroll = h('div', { class: 'editor-scroll' });
      area.append(h('div', { class: 'editor-shell' }, bar, scroll));
      renderPages();
      if (fresh) ctx.refreshSidebar();
    },
    sidebar(body) {
      body.classList.add('chat-mode');
      if (!st.fileId) { body.append(h('p', { class: 'muted', style: 'font-size:13px;margin:0' }, 'Add a PDF to start asking questions.')); return; }
      msgsEl = h('div', { class: 'chat-msgs', 'aria-live': 'polite' });
      input = h('textarea', { rows: 1, placeholder: 'Ask about this PDF…', 'aria-label': 'Your question', id: 'chat-input' });
      input.addEventListener('input', autosize);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
      sendBtn = h('button', { type: 'button', class: 'chat-send', id: 'chat-send', onclick: () => (st.busy ? st.abort?.abort() : send()) });
      updateComposer();
      const clear = h('button', { type: 'button', class: 'link-btn', onclick: () => { if (!st.busy) { st.messages = []; renderMessages(); } } }, 'Clear chat');
      body.append(h('div', { class: 'chat-panel' }, engineLine(), msgsEl,
        h('div', { class: 'chat-composer' }, h('div', { class: 'chat-box' }, input, sendBtn),
          h('div', { class: 'chat-hint' }, h('span', {}, 'Enter to send · Shift+Enter for a new line'), clear))));
      renderMessages();
    },
    onFiles() { st.fileId = null; if (st.abort) st.abort.abort(); },
    canRun: () => false,
    payload() { return { files: [], options: {} }; },
  };
}
