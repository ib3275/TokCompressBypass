import {
  Input,
  Output,
  Conversion,
  ALL_FORMATS,
  BlobSource,
  Mp4OutputFormat,
  BufferTarget,
} from 'https://esm.sh/mediabunny@1.61.0';
import { patchMP4 } from './patcher.js';

const $ = (id) => document.getElementById(id);
const dropZone       = $('dropZone');
const fileInput      = $('fileInput');
const readyPreview   = $('readyPreview');
const readyName      = $('readyName');
const readySize      = $('readySize');
const readyMeta      = $('readyMeta');
const activeModeTag  = $('activeModeTag');
const pctText        = $('pctText');
const encStatus      = $('encStatus');
const encEyebrow     = $('encEyebrow');
const barFill        = $('barFill');
const doneTitle      = $('doneTitle');
const doneElapsed    = $('doneElapsed');
const doneOrigSize   = $('doneOrigSize');
const doneOutSize    = $('doneOutSize');
const doneBadge      = $('doneBadge');
const doneSaveNote   = $('doneSaveNote');
const doneOutCard    = $('doneOutCard');
const uploadTips     = $('uploadTips');
const doneOrigVid    = $('doneOrigVid');
const doneOutVid     = $('doneOutVid');
const btnDownload    = $('btnDownload');
const btnCompress    = $('btnCompress');
const btnChangeFile  = $('btnChangeFile');
const btnAgain       = $('btnAgain');
const btnRetry       = $('btnRetry');
const errMsg         = $('errMsg');
const btnContinue    = $('btnContinue');
const btnBackWizard  = $('btnBackWizard');
const advancedWarning = $('advancedWarning');

const NORMAL_BITRATE = 12_000_000;
const NORMAL_MAX_H   = 1080;

let currentBlob = null;
let sourceUrl   = null;
let outUrl      = null;
let startedAt   = 0;
let sourceH     = 0;
let sourceContainer = 'unknown';   // 'mp4-family' | 'webm' | 'unknown'
let activeMode  = null;

const humanSize = (b) => {
  const u = ['B','KB','MB','GB','TB']; let i = 0, n = Number(b) || 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${u[i]}`;
};
const fmtTime = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
};

let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 3200);
}

function showView(name) {
  document.querySelectorAll('[data-view]').forEach((v) => { v.hidden = v.dataset.view !== name; });
  const el = document.querySelector(`[data-view="${name}"]`);
  if (el) { el.classList.remove('view-in'); void el.offsetWidth; el.classList.add('view-in'); }
  document.querySelectorAll('video').forEach((v) => { if (!v.closest(`[data-view="${name}"]`)) v.pause(); });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setEngineBadge(mode) {
  const labels = { idle: 'Ready', loading: 'Working…', gpu: 'GPU encoder', patch: 'MP4 patcher' };
  $('engDot').dataset.state = mode;
  $('engText').textContent  = labels[mode] || 'Ready';
}

function resetSession() {
  if (sourceUrl) { URL.revokeObjectURL(sourceUrl); sourceUrl = null; }
  if (outUrl)    { URL.revokeObjectURL(outUrl);    outUrl = null; }
  currentBlob = null;
  sourceH = 0;
  sourceContainer = 'unknown';
  fileInput.value = '';
}

/* ── Sniff the container type from the first 12 bytes ──────────── */
async function sniffContainer(blob) {
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  if (head.length < 12) return 'unknown';

  // WebM/Matroska magic: 0x1A 0x45 0xDF 0xA3
  if (head[0] === 0x1A && head[1] === 0x45 && head[2] === 0xDF && head[3] === 0xA3) {
    return 'webm';
  }

  // QuickTime family: bytes 4..8 are one of these box types
  const type = String.fromCharCode(head[4], head[5], head[6], head[7]);
  const qtTypes = ['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip', 'pnot', 'styp'];
  if (qtTypes.includes(type)) return 'mp4-family';

  return 'unknown';
}

/* ── Wizard selection ──────────────────────────────────────────── */
document.querySelectorAll('.mode-card').forEach((card) => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.mode-card').forEach((c) => c.classList.remove('selected'));
    card.classList.add('selected');
    activeMode = card.dataset.mode;
    btnContinue.disabled = false;
    advancedWarning.hidden = activeMode !== 'advanced';
  });
});

btnContinue.addEventListener('click', () => {
  if (!activeMode) return;
  activeModeTag.className = 'active-mode-tag ' + (activeMode === 'advanced' ? 'advanced' : 'standard');
  activeModeTag.textContent = activeMode === 'advanced' ? 'Advanced Patch' : 'Standard Compression';
  showView('upload');
});

btnBackWizard.addEventListener('click', () => {
  resetSession();
  showView('wizard');
});

/* ── File reading (Android-safe) ───────────────────────────────── */
async function readFileWithRetry(file, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(file);
      });
    } catch (e) {
      console.warn(`FileReader attempt ${attempt} failed:`, e);
      if (attempt === maxRetries) throw e;
      await new Promise(r => setTimeout(r, 500 * attempt));
    }
  }
}

async function handleFile(file) {
  if (!file) return;
  if (!file.type.startsWith('video/') && !/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(file.name)) {
    toast('That does not look like a video.');
    return;
  }
  resetSession();
  readyName.textContent = file.name;
  readySize.textContent = humanSize(file.size);
  readyMeta.textContent = 'reading file…';
  showView('ready');

  let bytes;
  try {
    bytes = await readFileWithRetry(file);
  } catch (e) {
    readyMeta.textContent = 'Could not read file: ' + ((e && e.message) || String(e));
    return;
  }

  currentBlob = new Blob([bytes], { type: file.type || 'video/mp4' });
  sourceUrl = URL.createObjectURL(currentBlob);
  readyPreview.src = sourceUrl;

  sourceContainer = await sniffContainer(currentBlob);

  try {
    const input = new Input({
      source: new BlobSource(currentBlob, { useStreamReader: false }),
      formats: ALL_FORMATS,
    });
    const [duration, videoTrack] = await Promise.all([
      input.computeDuration(),
      input.getPrimaryVideoTrack(),
    ]);
    let codecInfo = '';
    if (videoTrack) {
      try { const c = await videoTrack.getCodec(); if (c) codecInfo = ' · ' + c; } catch {}
    }
    sourceH = videoTrack ? await videoTrack.getDisplayHeight() : 0;
    const sourceW = videoTrack ? await videoTrack.getDisplayWidth() : 0;
    const containerInfo = sourceContainer === 'mp4-family' ? 'MP4/MOV'
                        : sourceContainer === 'webm' ? 'WebM'
                        : 'unknown';
    readyMeta.textContent =
      (sourceW && sourceH ? `${sourceW}×${sourceH} · ` : '') + fmtTime(duration) + codecInfo +
      ' · ' + containerInfo;
  } catch (e) {
    readyMeta.textContent = 'metadata unavailable — ' + ((e && e.message) || String(e));
  }
}

/* ══════════════════════════════════════════════════════════════════
   STANDARD PATH
   ══════════════════════════════════════════════════════════════════ */
async function runStandard() {
  const input = new Input({
    source: new BlobSource(currentBlob, { useStreamReader: false }),
    formats: ALL_FORMATS,
  });
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });

  encStatus.textContent = 'Initializing encoder…';

  const videoConfig = { codec: 'avc', bitrate: NORMAL_BITRATE };
  if (sourceH > NORMAL_MAX_H) videoConfig.height = NORMAL_MAX_H;

  const conversion = await Conversion.init({ input, output, video: videoConfig });

  if (conversion.discardedTracks?.some(t =>
      (t.type || '').toLowerCase().includes('video'))) {
    throw new Error('Device cannot encode this video. Try Chrome, Edge, or Safari 16.4+.');
  }

  if (conversion.onProgress) {
    conversion.onProgress = (p) => {
      const pct = Math.max(0, Math.min(1, p));
      pctText.textContent = (pct * 100).toFixed(1) + '%';
      barFill.style.width = (pct * 100).toFixed(1) + '%';
    };
  }

  encStatus.textContent = 'Encoding with GPU…';
  await conversion.execute();

  return new Blob([output.target.buffer], { type: 'video/mp4' });
}

/* ══════════════════════════════════════════════════════════════════
   ADVANCED PATH
   ══════════════════════════════════════════════════════════════════ */
async function runAdvanced() {
  // Container compatibility gate
  if (sourceContainer !== 'mp4-family') {
    const label = sourceContainer === 'webm' ? 'WebM' : 'this container type';
    throw new Error(
      `Advanced Patch only works on MP4 or MOV files. Your file appears to be ${label}.\n\n` +
      `Options:\n` +
      `1. Run this file through Standard mode first — it will produce an MP4 you can then patch.\n` +
      `2. Or download the source video as MP4 (H.264) rather than WebM (VP9).`
    );
  }

  encStatus.textContent = 'Analyzing MP4 container…';
  pctText.textContent = '…';
  barFill.style.width = '0%';
  await new Promise(r => setTimeout(r, 50));

  const patched = await patchMP4(currentBlob, { inflationFactor: 10 });

  pctText.textContent = '100%';
  barFill.style.width = '100%';
  encStatus.textContent = 'Container patched.';
  return patched;
}

/* ══════════════════════════════════════════════════════════════════
   Dispatcher
   ══════════════════════════════════════════════════════════════════ */
async function startProcess() {
  if (!currentBlob || !activeMode) return;

  const isAdvanced = activeMode === 'advanced';

  setEngineBadge('loading');
  pctText.textContent = '—';
  encStatus.textContent = isAdvanced ? 'Reading container…' : 'Reading file…';
  barFill.style.width = '0%';
  barFill.className = isAdvanced ? 'patch' : '';
  encEyebrow.textContent = isAdvanced ? 'Patching' : 'Encoding';
  showView('encoding');
  startedAt = performance.now();

  try {
    const blob = isAdvanced ? await runAdvanced() : await runStandard();

    const elapsed = (performance.now() - startedAt) / 1000;
    const inB  = currentBlob.size;
    const outB = blob.size;
    const grew = outB >= inB;
    const pct  = inB > 0 ? Math.max(0, (1 - outB / inB) * 100) : 0;

    doneTitle.textContent = isAdvanced ? 'Patch complete' : 'Compression complete';
    doneElapsed.textContent = `${isAdvanced ? 'Patched' : 'Encoded'} in ${fmtTime(elapsed)}`;
    doneOrigSize.textContent = humanSize(inB);
    doneOutSize.textContent  = humanSize(outB);

    doneOutCard.className = 'card is-out' + (isAdvanced ? ' patch' : '');
    doneBadge.textContent = isAdvanced
      ? (grew ? `· +${humanSize(outB - inB)} metadata` : '· size unchanged')
      : (grew ? '· no size gain' : `· −${pct.toFixed(1)}%`);

    doneSaveNote.textContent = isAdvanced
      ? 'Container metadata patched. Media data is byte-identical to the source.'
      : (grew
          ? 'Source was already optimized.'
          : `Saved ${humanSize(inB - outB)} — output is ${(100 - pct).toFixed(1)}% of the original.`);

    uploadTips.hidden = !isAdvanced;

    if (outUrl) URL.revokeObjectURL(outUrl);
    outUrl = URL.createObjectURL(blob);
    doneOrigVid.src = sourceUrl || '';
    doneOutVid.src  = outUrl || '';

    const base = (readyName.textContent || 'video').replace(/\.[^.]*$/, '');
    btnDownload.href = outUrl;
    btnDownload.download = isAdvanced
      ? `${base}-patched.mp4`
      : `${base}-compressed.mp4`;

    setEngineBadge(isAdvanced ? 'patch' : 'gpu');
    showView('done');
  } catch (err) {
    console.error(err);
    setEngineBadge('idle');
    errMsg.textContent = (err && err.message) || String(err);
    showView('error');
  }
}

/* ── Wiring ────────────────────────────────────────────────────── */
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener('change', (e) => handleFile(e.target.files?.[0]));

let dragDepth = 0;
dropZone.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; dropZone.classList.add('is-drag'); });
dropZone.addEventListener('dragover',  (e) => e.preventDefault());
dropZone.addEventListener('dragleave', (e) => { e.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropZone.classList.remove('is-drag'); });
dropZone.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; dropZone.classList.remove('is-drag');
  handleFile(e.dataTransfer?.files?.[0]);
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop',     (e) => e.preventDefault());

btnCompress.addEventListener('click', startProcess);
btnChangeFile.addEventListener('click', () => { resetSession(); showView('upload'); });
btnAgain.addEventListener('click', () => {
  resetSession();
  activeMode = null;
  document.querySelectorAll('.mode-card').forEach((c) => c.classList.remove('selected'));
  btnContinue.disabled = true;
  advancedWarning.hidden = true;
  showView('wizard');
});
btnRetry.addEventListener('click', () => showView(currentBlob ? 'ready' : 'upload'));

setEngineBadge('idle');
showView('wizard');
