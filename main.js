import {
  Input,
  Output,
  Conversion,
  ALL_FORMATS,
  BlobSource,
  Mp4OutputFormat,
  BufferTarget,
  Quality,
} from 'https://esm.sh/mediabunny@1.61.0';

const $ = (id) => document.getElementById(id);
const dropZone       = $('dropZone');
const fileInput      = $('fileInput');
const readyPreview   = $('readyPreview');
const readyName      = $('readyName');
const readySize      = $('readySize');
const readyMeta      = $('readyMeta');
const pctText        = $('pctText');
const encStatus      = $('encStatus');
const barFill        = $('barFill');
const doneElapsed    = $('doneElapsed');
const doneOrigSize   = $('doneOrigSize');
const doneOutSize    = $('doneOutSize');
const doneBadge      = $('doneBadge');
const doneSaveNote   = $('doneSaveNote');
const doneOrigVid    = $('doneOrigVid');
const doneOutVid     = $('doneOutVid');
const btnDownload    = $('btnDownload');
const btnCompress    = $('btnCompress');
const btnChangeFile  = $('btnChangeFile');
const btnAgain       = $('btnAgain');
const btnRetry       = $('btnRetry');
const errMsg         = $('errMsg');

/* WebCodecs capability check */
if (typeof window.VideoEncoder === 'undefined') {
  alert(
    'Your browser does not support WebCodecs VideoEncoder. ' +
    'Please use Chrome, Edge, or Safari 16.4+. ' +
    'Firefox is not supported.'
  );
  throw new Error('VideoEncoder not supported');
}

const VIDEO_QUALITY = new Quality({ quantizer: 22, bitrate: 12_000_000 });
const TARGET_WIDTH  = 1920;
const TARGET_HEIGHT = 1080;

let currentFile = null;
let sourceUrl   = null;
let outUrl      = null;
let startedAt   = 0;

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
  const labels = { idle: 'Ready', loading: 'Encoding…', gpu: 'GPU encoder', cpu: 'CPU encoder' };
  $('engDot').dataset.state = mode;
  $('engText').textContent  = labels[mode] || 'Ready';
}

function resetSession() {
  if (sourceUrl) { URL.revokeObjectURL(sourceUrl); sourceUrl = null; }
  if (outUrl)    { URL.revokeObjectURL(outUrl);    outUrl = null; }
  currentFile = null;
  fileInput.value = '';
}

async function handleFile(file) {
  if (!file) return;
  if (!file.type.startsWith('video/') && !/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(file.name)) {
    toast('That does not look like a video.');
    return;
  }
  resetSession();
  currentFile = file;
  sourceUrl = URL.createObjectURL(file);
  readyName.textContent = file.name;
  readySize.textContent = humanSize(file.size) + ' · type=' + (file.type || 'unknown');
  readyPreview.src = sourceUrl;
  showView('ready');

  // Metadata probe (errors visible)
  try {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const [duration, videoTrack] = await Promise.all([
      input.computeDuration(),
      input.getPrimaryVideoTrack(),
    ]);
    let codecInfo = '';
    if (videoTrack) {
      try {
        const c = await videoTrack.getCodec();
        if (c) codecInfo = ' · ' + c;
      } catch {}
    }
    const w = videoTrack ? await videoTrack.getDisplayWidth()  : 0;
    const h = videoTrack ? await videoTrack.getDisplayHeight() : 0;
    readyMeta.textContent = (w && h ? `${w}×${h} · ` : '') + fmtTime(duration) + codecInfo;
  } catch (e) {
    console.error('Metadata probe failed:', e);
    readyMeta.textContent = 'metadata unavailable — ' + ((e && e.message) || String(e));
  }
}

async function startCompress() {
  if (!currentFile) return;
  setEngineBadge('loading');
  pctText.textContent = '—';
  encStatus.textContent = 'Reading file…';
  barFill.style.width = '0%';
  showView('encoding');
  startedAt = performance.now();

  try {
    const input = new Input({
      source: new BlobSource(currentFile),
      formats: ALL_FORMATS,
    });
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: new BufferTarget(),
    });

    encStatus.textContent = 'Initializing encoder…';

    const conversion = await Conversion.init({
      input,
      output,
      video: {
        codec: 'avc',
        bitrate: VIDEO_QUALITY,
        hardwareAcceleration: 'prefer-hardware',
        resize: { width: TARGET_WIDTH, height: TARGET_HEIGHT },
      },
    });

    console.log('=== Conversion diagnostics ===');
    console.log('isValid:', conversion.isValid);
    console.log('discardedTracks:', conversion.discardedTracks);

    const discarded = conversion.discardedTracks || [];
    const discardedVideo = discarded.find((t) =>
      (t.type || t.trackType || '').toLowerCase().includes('video')
    );

    if (discardedVideo) {
      const reason = discardedVideo.reason || discardedVideo.message || JSON.stringify(discardedVideo);
      throw new Error('Video track discarded: ' + reason);
    }

    if (conversion.isValid === false) {
      throw new Error(
        'Conversion invalid. Discarded: ' +
        discarded.map((t) => `${t.type || '?'} (${t.reason || 'unknown'})`).join('; ')
      );
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

    encStatus.textContent = 'Finalizing…';
    const buffer = output.target.buffer;
    if (!buffer) throw new Error('No output buffer produced.');

    const blob = new Blob([buffer], { type: 'video/mp4' });

    if (blob.size < 100_000 && currentFile.size > 1_000_000) {
      throw new Error(
        'Output is only ' + humanSize(blob.size) + ' — video track likely dropped. ' +
        'Check console for discardedTracks.'
      );
    }

    if (outUrl) URL.revokeObjectURL(outUrl);
    outUrl = URL.createObjectURL(blob);

    const elapsed = (performance.now() - startedAt) / 1000;
    const inB  = currentFile.size;
    const outB = blob.size;
    const grew = outB >= inB;
    const pct  = inB > 0 ? Math.max(0, (1 - outB / inB) * 100) : 0;

    doneElapsed.textContent = `Encoded in ${fmtTime(elapsed)}`;
    doneOrigSize.textContent = humanSize(inB);
    doneOutSize.textContent  = humanSize(outB);
    doneBadge.textContent    = grew ? '· no size gain' : `· −${pct.toFixed(1)}%`;
    doneSaveNote.textContent = grew
      ? 'Source was already optimized — output prioritizes platform compatibility.'
      : `Saved ${humanSize(inB - outB)} — output is ${(100 - pct).toFixed(1)}% of the original.`;

    doneOrigVid.src = sourceUrl || '';
    doneOutVid.src  = outUrl || '';

    const base = (currentFile.name || 'video').replace(/\.[^.]*$/, '');
    btnDownload.href = outUrl;
    btnDownload.download = `${base}-compressed.mp4`;

    setEngineBadge('gpu');
    showView('done');
  } catch (err) {
    console.error('Compression failed:', err);
    setEngineBadge('idle');
    const msg = (err && err.message) || String(err);
    const stack = (err && err.stack) ? '\n\n' + err.stack : '';
    errMsg.textContent = msg + stack;
    showView('error');
  }
}

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

btnCompress.addEventListener('click', startCompress);
btnChangeFile.addEventListener('click', () => { resetSession(); showView('upload'); });
btnAgain.addEventListener('click', () => { resetSession(); showView('upload'); });
btnRetry.addEventListener('click', () => showView(currentFile ? 'ready' : 'upload'));

setEngineBadge('idle');
showView('upload');
