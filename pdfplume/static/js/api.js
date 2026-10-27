// Thin client for the local JSON API.

async function parse(res) {
  let data = null;
  try { data = await res.json(); } catch (e) { /* not json */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  get: (url) => fetch(url).then(parse),
  post: (url, body) => fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  }).then(parse),
  del: (url) => fetch(url, { method: 'DELETE' }).then(parse),

  /** Upload one File with progress callback (0..1). */
  upload(file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const form = new FormData();
      form.append('file', file, file.name);
      xhr.open('POST', '/api/upload');
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch (e) { /* ignore */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error((data && data.error) || `Upload failed (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error('Upload failed - is the PDFPlume server running?'));
      xhr.send(form);
    });
  },

  thumb: (id, page = 0, w = 240) => `/api/files/${id}/thumb/${page}?w=${w}`,

  /** Start a job and poll until it finishes. */
  async process(slug, payload, onProgress, onStart) {
    const { job_id } = await api.post(`/api/process/${slug}`, payload);
    if (onStart) onStart(job_id);
    let delay = 350;
    for (;;) {
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(1200, delay * 1.25);
      const st = await api.get(`/api/jobs/${job_id}`);
      if (st.status === 'done') return { jobId: job_id, ...st };
      if (st.status === 'error') { const e = new Error(st.message || 'Processing failed'); e.job = true; throw e; }
      if (st.status === 'cancelled') { const e = new Error('Cancelled'); e.cancelled = true; throw e; }
      if (onProgress) onProgress(st.progress || 0, st.message || '');
    }
  },

  downloadUrl: (jobId, file) => `/api/jobs/${jobId}/download${file ? `?file=${encodeURIComponent(file)}` : ''}`,
};

let capsPromise = null;
export function capabilities() {
  if (!capsPromise) capsPromise = api.get('/api/capabilities').catch(() => ({}));
  return capsPromise;
}

export function humanSize(n) {
  if (n == null) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${i ? n.toFixed(n < 10 ? 2 : 1) : n} ${u[i]}`;
}
