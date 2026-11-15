const listEl = document.getElementById('list');
const goBtn = document.getElementById('go');
const allBox = document.getElementById('all');
const statusEl = document.getElementById('status');
let pdfTabs = [];

function hasPdfExtension(url) {
  try { return new URL(url).pathname.toLowerCase().endsWith('.pdf'); }
  catch { return false; }
}

// Detect PDF tabs: by .pdf extension, or by asking the page for its content type
// (works for streamed PDFs such as /certificate with no extension).
async function detectPdfTabs() {
  const tabs = await chrome.tabs.query({});
  const found = [];
  await Promise.all(tabs.map(async (t) => {
    if (!t.url || !/^(https?|file|ftp):/i.test(t.url)) return;
    if (hasPdfExtension(t.url)) { found.push(t); return; }
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: t.id },
        func: () => document.contentType
      });
      if (r && r.result === 'application/pdf') found.push(t);
    } catch { /* restricted, discarded, or not-yet-loaded tab: skip */ }
  }));
  return found.sort((a, b) => a.windowId - b.windowId || a.index - b.index);
}

function filenameFromDisposition(header) {
  if (!header) return null;
  let m = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (m) { try { return decodeURIComponent(m[1].trim()); } catch {} }
  m = /filename\s*=\s*"([^"]+)"/.exec(header) || /filename\s*=\s*([^;]+)/.exec(header);
  return m ? m[1].trim() : null;
}

function baseNameFor(url, disposition) {
  const fromHeader = filenameFromDisposition(disposition);
  if (fromHeader) return fromHeader;
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const last = parts[parts.length - 1] || 'document';
    // No extension (e.g. ".../<id>/certificate"): include the previous segment so names stay unique.
    if (!/\.\w{2,5}$/.test(last) && parts.length > 1) return parts[parts.length - 2] + '_' + last;
    return last;
  } catch { return 'document'; }
}

function uniqueName(base, used) {
  let name = base.replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'document';
  let candidate = name + '.pdf', i = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${name} (${i++}).pdf`;
  used.add(candidate.toLowerCase());
  return candidate;
}

function isPdfBytes(bytes) {
  // "%PDF" may be preceded by a little junk, so look in the first 1 KB
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return head.includes('%PDF-');
}

async function init() {
  statusEl.textContent = 'Scanning tabs…';
  pdfTabs = await detectPdfTabs();
  statusEl.textContent = '';
  if (!pdfTabs.length) {
    listEl.innerHTML = '<div class="muted">No PDF tabs found in this browser.</div>';
    goBtn.disabled = true;
    return;
  }
  pdfTabs.forEach((t, i) => {
    const label = document.createElement('label');
    label.innerHTML = '<input type="checkbox" checked><span></span>';
    label.querySelector('input').dataset.index = i;
    label.querySelector('span').textContent = t.title || t.url;
    label.title = t.url;
    listEl.appendChild(label);
  });
}

allBox.addEventListener('change', () => {
  listEl.querySelectorAll('input').forEach(c => (c.checked = allBox.checked));
});

goBtn.addEventListener('click', async () => {
  const selected = [...listEl.querySelectorAll('input:checked')].map(c => pdfTabs[+c.dataset.index]);
  if (!selected.length) return;
  goBtn.disabled = true;

  const used = new Set();
  const files = [];
  const failed = [];
  for (let i = 0; i < selected.length; i++) {
    const tab = selected[i];
    statusEl.textContent = `Fetching ${i + 1} of ${selected.length}…`;
    try {
      const res = await fetch(tab.url, { credentials: 'include' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = new Uint8Array(await res.arrayBuffer());
      if (!isPdfBytes(data)) throw new Error('Not a PDF');
      const base = baseNameFor(tab.url, res.headers.get('content-disposition'));
      files.push({ name: uniqueName(base, used), data });
    } catch (e) {
      failed.push(tab.title || tab.url);
    }
  }

  if (!files.length) {
    statusEl.textContent = 'Could not download any file.' +
      (selected.some(t => t.url.startsWith('file:')) ? ' For local files, enable "Allow access to file URLs" in the extension settings.' : '');
    goBtn.disabled = false;
    return;
  }

  const blob = makeZip(files);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `pdfs-${new Date().toISOString().slice(0, 10)}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);

  statusEl.textContent = `Saved ${files.length} PDF(s).` + (failed.length ? ` Failed: ${failed.length}.` : '');
  goBtn.disabled = false;
});

init();
