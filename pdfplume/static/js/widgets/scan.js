// Scan to PDF: capture pages with a webcam / phone camera or upload photos.
import { ICONS } from '../icons.js';
import { renderOptions } from '../options.js';
import { fileCard, filesBar } from '../tool.js';
import { h, makeSortable, modal, moveItem, toast } from '../ui.js';

const FULL = [[0, 0], [1, 0], [1, 1], [0, 1]];
const SVGNS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};
const quadPoints = (pts) => pts.map(([x, y]) => `${x},${y}`).join(' ');

export function create(ctx) {
  let stream = null;
  let video = null;
  let camBox = null;
  let shots = 0;

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('Camera access needs a secure page: open PDFPlume at http://localhost on this device.', 'error');
      return false;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false });
      return true;
    } catch (e) {
      toast(`Could not start the camera: ${e.message}`, 'error');
      return false;
    }
  }

  function stopCamera() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  function capture(flash) {
    if (!video || !video.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0);
    flash.style.opacity = '0.8';
    setTimeout(() => { flash.style.opacity = '0'; }, 120);
    c.toBlob((blob) => {
      shots += 1;
      ctx.addFiles([new File([blob], `scan_${String(shots).padStart(2, '0')}.jpg`, { type: 'image/jpeg' })]);
    }, 'image/jpeg', 0.92);
  }

  // ------------------------------------------------------------ auto-crop
  const autoCrop = () => ctx.state.options.auto_crop !== false;
  const cropOf = (f) => (f.nocrop ? null : f.corners || (autoCrop() && f.detect && f.detect.found ? f.detect.corners : null));

  async function detect(f, area) {
    if (f.detect || f.detecting || !f.id) return;
    f.detecting = true;
    try { f.detect = await ctx.api.get(`/api/files/${f.id}/detect`); } catch (e) { f.detect = { found: false, corners: FULL }; }
    f.detecting = false;
    if (area && area.isConnected) self.render(area);
  }

  function decorate(card, f) {
    const img = card.querySelector('.thumb img');
    const quad = cropOf(f);
    if (!img) return;
    const wrap = h('span', { class: 'quad-prev' });
    img.replaceWith(wrap);
    wrap.append(img);
    if (quad) {
      const s = svg('svg', { viewBox: '0 0 1 1', preserveAspectRatio: 'none', class: 'quad-svg' });
      s.append(svg('path', { d: `M0 0H1V1H0Z M${quadPoints(quad).replaceAll(' ', 'L')}Z`, 'fill-rule': 'evenodd', class: 'shade' }),
        svg('polygon', { points: quadPoints(quad), class: 'edge' }));
      wrap.append(s);
    }
    const label = f.nocrop ? 'Whole photo' : f.corners ? 'Cropped by you' : quad ? 'Page found' : (f.detect && autoCrop() ? 'No page edges found' : '');
    if (label) card.querySelector('.meta')?.replaceChildren(label);
  }

  function openCropper(f, area) {
    let pts = (f.corners || (f.detect && f.detect.found ? f.detect.corners : FULL)).map((p) => [...p]);
    const img = h('img', { src: ctx.thumbUrl(f, 0, 1400), alt: '', draggable: 'false' });
    const s = svg('svg', { viewBox: '0 0 1 1', preserveAspectRatio: 'none', class: 'quad-svg' });
    const shade = svg('path', { 'fill-rule': 'evenodd', class: 'shade' });
    const edge = svg('polygon', { class: 'edge' });
    s.append(shade, edge);
    const stage = h('div', { class: 'quad-stage' }, img, s);
    img.onload = () => stage.classList.add('ready');
    const handles = pts.map((_, i) => {
      const hd = h('span', { class: 'quad-handle', role: 'slider', tabindex: '0', 'aria-label': ['Top left', 'Top right', 'Bottom right', 'Bottom left'][i] + ' corner' });
      hd.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        hd.setPointerCapture(e.pointerId);
        const move = (ev) => {
          const r = stage.getBoundingClientRect();
          pts[i] = [Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height))];
          draw();
        };
        const up = () => { hd.removeEventListener('pointermove', move); hd.removeEventListener('pointerup', up); };
        hd.addEventListener('pointermove', move);
        hd.addEventListener('pointerup', up);
      });
      hd.addEventListener('keydown', (e) => {
        const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
        if (!d) return;
        e.preventDefault();
        const step = e.shiftKey ? 0.02 : 0.004;
        pts[i] = [Math.max(0, Math.min(1, pts[i][0] + d[0] * step)), Math.max(0, Math.min(1, pts[i][1] + d[1] * step))];
        draw();
      });
      stage.append(hd);
      return hd;
    });
    function draw() {
      shade.setAttribute('d', `M0 0H1V1H0Z M${quadPoints(pts).replaceAll(' ', 'L')}Z`);
      edge.setAttribute('points', quadPoints(pts));
      handles.forEach((hd, i) => Object.assign(hd.style, { left: `${pts[i][0] * 100}%`, top: `${pts[i][1] * 100}%` }));
    }
    draw();
    const done = (fn) => () => { fn(); m.close(); self.render(area); ctx.refresh(); };
    const foot = [
      f.detect && f.detect.found ? h('button', { type: 'button', class: 'btn', style: 'margin-right:auto', onclick: () => { pts = f.detect.corners.map((p) => [...p]); draw(); } }, 'Auto-detect') : h('span', { style: 'margin-right:auto' }),
      h('button', { type: 'button', class: 'btn', onclick: done(() => { f.corners = null; f.nocrop = true; }) }, 'Use whole photo'),
      h('button', { type: 'button', class: 'btn primary', id: 'crop-apply', onclick: done(() => { f.corners = pts; f.nocrop = false; }) }, 'Apply crop')];
    const m = modal({ title: 'Adjust the page edges', wide: true, foot,
      body: h('div', { class: 'quad-wrap' }, h('p', { class: 'muted', style: 'margin:0 0 12px;font-size:13px' }, 'Drag the corners onto the corners of the paper. The page is straightened when the PDF is made.'), stage) });
  }

  const self = {
    keepWork: true,
    hero(zone) {
      zone.append(h('h3', {}, 'Scan paper documents'),
        h('p', {}, 'Use your webcam or phone camera, or add photos you already took.'),
        h('div', { class: 'actions-row' },
          h('button', { type: 'button', class: 'btn primary lg', html: `${ICONS.camera} Start camera`, onclick: async () => { if (await startCamera()) ctx.showWork(); } }),
          h('button', { type: 'button', class: 'btn lg', html: `${ICONS.upload} Add photos`, onclick: () => ctx.openPicker() })));
    },
    render(area) {
      area.innerHTML = '';
      area.append(filesBar({ label: `<b>${ctx.state.files.length}</b> page${ctx.state.files.length === 1 ? '' : 's'} captured` }));
      const wrap = h('div', { class: 'scan-wrap' });
      if (stream) {
        // Keep one camera element alive across re-renders (re-inserting pauses it).
        if (!camBox || video.srcObject !== stream) {
          video = h('video', { autoplay: true, playsinline: true, muted: true });
          video.srcObject = stream;
          const flash = h('div', { class: 'flash' });
          camBox = h('div', { class: 'camera' }, video, flash,
            h('button', { type: 'button', class: 'shutter', title: 'Capture page (Space)', 'aria-label': 'Capture', onclick: () => capture(flash) }));
          document.onkeydown = (e) => { if (e.code === 'Space' && stream && document.activeElement === document.body) { e.preventDefault(); capture(flash); } };
        }
        wrap.append(camBox);
        video.play().catch(() => {});
      }
      wrap.append(h('div', { class: 'scan-actions' },
        stream ? h('button', { type: 'button', class: 'btn', onclick: () => { stopCamera(); self.render(area); } }, 'Stop camera')
          : h('button', { type: 'button', class: 'btn primary', html: `${ICONS.camera} Start camera`, onclick: async () => { if (await startCamera()) self.render(area); } }),
        h('button', { type: 'button', class: 'btn', html: `${ICONS.upload} Add photos`, onclick: () => ctx.openPicker() })));
      area.append(wrap);
      if (ctx.state.files.length) {
        area.append(h('p', { class: 'grid-hint', style: 'margin-top:24px' }, 'Drag pages to change their order.'));
        const list = h('div', { class: 'files' });
        ctx.state.files.forEach((f, i) => {
          const adjust = h('button', { type: 'button', title: 'Adjust page edges', 'aria-label': `Adjust page edges of ${f.name}`, html: ICONS.crop,
            onclick: () => openCropper(f, area) });
          const card = fileCard(f, { index: i, extraActions: f.id ? [adjust] : [] });
          if (f.id && !f.error) {
            decorate(card, f);
            if (autoCrop() || f.corners) detect(f, area);
          }
          list.append(card);
        });
        makeSortable(list, '.file-card', (from, to) => { moveItem(ctx.state.files, from, to); self.render(area); });
        area.append(list);
      } else {
        area.append(h('p', { class: 'grid-hint', style: 'margin-top:26px' }, stream ? 'Hold the page in front of the camera and press the shutter (or Space).' : 'Start the camera or add photos.'));
      }
    },
    sidebar(body) { renderOptions(body, ctx.tool.options, ctx.state.options, ctx.caps, (key) => { if (key === 'auto_crop') ctx.refresh(); }); },
    validate() { return ctx.ready().length ? null : 'Capture or add at least one page.'; },
    payload() {
      stopCamera();
      return {
        files: ctx.ready().map((f) => ({ id: f.id, options: f.nocrop ? { crop: false } : f.corners ? { corners: f.corners } : {} })),
        options: ctx.state.options,
      };
    },
  };
  return self;
}
