import {
  Input,
  Output,
  Conversion,
  ALL_FORMATS,
  BlobSource,
  Mp4OutputFormat,
  BufferTarget,
} from 'https://esm.sh/mediabunny@1.61.0';

/* ══════════════════════════════════════════════════════════════════
   Presets (Normal mode)
   ══════════════════════════════════════════════════════════════════ */
const PRESETS = {
  maxquality: {
    name: 'Max Quality',
    specs: '1080p · 30 Mbps',
    desc: 'Highest quality that still plays smoothly. Bigger files, best fidelity for high-detail footage.',
    best: 'Gaming clips, anime edits, fast motion, archiving',
    height: 1080,
    bitrate: 30_000_000,
    tiktokTips: true,
  },
  tiktok: {
    name: 'TikTok Ready',
    specs: '1080p · 12 Mbps',
    desc: 'Clean H.264 that survives TikTok\'s re-encoding while playing smoothly on every phone.',
    best: 'TikTok, Reels, YouTube Shorts',
    height: 1080,
    bitrate: 12_000_000,
    tiktokTips: true,
  },
  messaging: {
    name: 'Messaging',
    specs: '720p · 4 Mbps',
    desc: 'Small enough for WhatsApp, Discord, and email. Good enough for casual viewing.',
    best: 'Sharing on chat apps, quick uploads',
    height: 720,
    bitrate: 4_000_000,
    tiktokTips: false,
  },
  smallest: {
    name: 'Smallest File',
    specs: '480p · 1.5 Mbps',
    desc: 'Maximum compression. Use when bandwidth or storage is critical.',
    best: 'Slow connections, low-storage devices',
    height: 480,
    bitrate: 1_500_000,
    tiktokTips: false,
  },
};

let currentBlob = null;
let sourceUrl   = null;
let outUrl      = null;
let startedAt   = 0;
let sourceH     = 0;
let activeMode  = null;
let activeConfig = null;

const $ = (id) => document.getElementById(id);
const dropZone      = $('dropZone');
const fileInput     = $('fileInput');
const readyPreview  = $('readyPreview');
const readyName     = $('readyName');
const readySize     = $('readySize');
const readyMeta     = $('readyMeta');
const readyModeTag  = $('readyModeTag');
const activeSummary = $('activeConfigSummary');
const pctText       = $('pctText');
const encStatus     = $('encStatus');
const barFill       = $('barFill');
const doneElapsed   = $('doneElapsed');
const doneOrigSize  = $('doneOrigSize');
const doneOutSize   = $('doneOutSize');
const doneBadge     = $('doneBadge');
const doneSaveNote  = $('doneSaveNote');
const uploadTips    = $('uploadTips');
const doneOrigVid   = $('doneOrigVid');
const doneOutVid    = $('doneOutVid');
const btnDownload   = $('btnDownload');
const btnCompress   = $('btnCompress');
const btnChangeFile = $('btnChangeFile');
const btnAgain      = $('btnAgain');
const btnRetry      = $('btnRetry');
const errMsg        = $('errMsg');
const btnContinue   = $('btnContinue');
const presetList    = $('presetList');
const advBitrate    = $('advBitrate');

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
  const labels = { idle: 'Ready', loading: 'Working…', gpu: 'GPU encoder' };
  $('engDot').dataset.state = mode;
  $('engText').textContent  = labels[mode] || 'Ready';
}

function resetSession() {
  if (sourceUrl) { URL.revokeObjectURL(sourceUrl); sourceUrl = null; }
  if (outUrl)    { URL.revokeObjectURL(outUrl);    outUrl = null; }
  currentBlob = null;
  sourceH = 0;
  fileInput.value = '';
}

/* Mode picker */
document.querySelectorAll('.mode-card').forEach((card) => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.mode-card').forEach((c) => c.classList.remove('selected'));
    card.classList.add('selected');
    activeMode = card.dataset.mode;
    btnContinue.disabled = false;
  });
});

btnContinue.addEventListener('click', () => {
  if (!activeMode) return;
  if (activeMode === 'normal') { renderPresets(); showView('presets'); }
  else { showView('advanced'); }
});

/* Preset list */
function renderPresets() {
  presetList.innerHTML = '';
  for (const [key, p] of Object.entries(PRESETS)) {
    const el = document.createElement('button');
    el.className = 'preset';
    el.type = 'button';
    el.innerHTML = `
      <div class="preset-name">${p.name}</div>
      <div class="preset-specs">${p.specs}</div>
      <div class="preset-desc">${p.desc}</div>
      <div class="preset-best">${p.best}</div>
    `;
    el.addEventListener('click', () => {
      activeConfig = {
        height: p.height,
        bitrate: p.bitrate,
        label: 'Preset',
        sublabel: p.name,
        tiktokTips: p.tiktokTips,
      };
      updateConfigSummary();
      showView('upload');
    });
    presetList.appendChild(el);
  }
}

/* Advanced panel */
advBitrate.addEventListener('input', (e) => {
  $('advBitrateValue').textContent = e.target.value + ' Mbps';
});

$('btnAdvancedApply').addEventListener('click', () => {
  const resVal = $('advResolution').value;
  const mbps   = parseInt(advBitrate.value, 10);
  let height = 0;
  if (resVal !== 'source') height = parseInt(resVal, 10);

  activeConfig = {
    height: height || null,
    bitrate: mbps * 1_000_000,
    label: 'Custom',
    sublabel: (height ? height + 'p' : 'Source') + ' · ' + mbps + ' Mbps',
    tiktokTips: false,
  };
  updateConfigSummary();
  showView('upload');
});

$('btnPresetBack').addEventListener('click', () => showView('wizard'));
$('btnAdvancedBack').addEventListener('click', () => showView('wizard'));
$('btnBackSettings').addEventListener('click', () => {
  resetSession();
  if (activeMode === 'normal') showView('presets');
  else showView('advanced');
});

function updateConfigSummary() {
  if (!activeConfig) { activeSummary.textContent = '—'; return; }
  activeSummary.textContent = activeConfig.sublabel;
}

/* Android-safe file read */
async function readFileWithRetry(file, maxRetries = 4) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('FileReader error'));
        reader.readAsArrayBuffer(file);
      });
    } catch (e) {
      console.warn(`FileReader attempt ${attempt} failed:`, e);
      if (attempt === maxRetries) throw e;
      await new Promise(r => setTimeout(r, 100 * attempt));
    }
  }
}

async function handleFile(file) {
  if (!file) return;
  if (!file.type.startsWith('video/') && !/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(file.name)) {
    toast('That does not look like a video.');
    return;
  }

  const readPromise = readFileWithRetry(file);

  resetSession();
  readyName.textContent = file.name;
  readySize.textContent = humanSize(file.size);
  readyMeta.textContent = 'reading file…';
  showView('ready');

  let bytes;
  try {
    bytes = await readPromise;
  } catch (e) {
    console.error('File read failed:', e);
    readyMeta.textContent = 'Could not read file: ' + ((e && e.message) || String(e)) +
      '\n\nTip: make sure the video is stored locally (not in Google Photos cloud), then try again.';
    return;
  }

  currentBlob = new Blob([bytes], { type: file.type || 'video/mp4' });
  sourceUrl = URL.createObjectURL(currentBlob);
  readyPreview.src = sourceUrl;

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
    readyMeta.textContent =
      (sourceW && sourceH ? `${sourceW}×${sourceH} · ` : '') + fmtTime(duration) + codecInfo;
  } catch (e) {
    readyMeta.textContent = 'metadata unavailable — ' + ((e && e.message) || String(e));
  }

  readyModeTag.innerHTML = `${activeConfig.label} · <span class="sub">${activeConfig.sublabel}</span>`;
}

async function startCompress() {
  if (!currentBlob || !activeConfig) return;

  setEngineBadge('loading');
  pctText.textContent = '—';
  encStatus.textContent = 'Reading file…';
  barFill.style.width = '0%';
  showView('encoding');
  startedAt = performance.now();

  try {
    const input = new Input({
      source: new BlobSource(currentBlob, { useStreamReader: false }),
      formats: ALL_FORMATS,
    });
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: new BufferTarget(),
    });

    encStatus.textContent = 'Initializing encoder…';

    const videoConfig = { codec: 'avc', bitrate: activeConfig.bitrate };
    if (activeConfig.height && sourceH > activeConfig.height) {
      videoConfig.height = activeConfig.height;
    }

    console.log('Video config:', videoConfig);

    const conversion = await Conversion.init({ input, output, video: videoConfig });

    const discardedVideo = (conversion.discardedTracks || [])
      .find((t) => (t.type || '').toLowerCase().includes('video'));
    if (discardedVideo) {
      throw new Error('Device cannot encode this video. Try Chrome, Edge, or Safari 16.4+.');
    }
    if (conversion.isValid === false) {
      throw new Error('Conversion invalid — this device may not support the chosen settings.');
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
    if (blob.size < 100_000 && currentBlob.size > 1_000_000) {
      throw new Error('Output is only ' + humanSize(blob.size) + ' — video track likely dropped.');
    }

    if (outUrl) URL.revokeObjectURL(outUrl);
    outUrl = URL.createObjectURL(blob);

    const elapsed = (performance.now() - startedAt) / 1000;
    const inB  = currentBlob.size;
    const outB = blob.size;
    const grew = outB >= inB;
    const pct  = inB > 0 ? Math.max(0, (1 - outB / inB) * 100) : 0;

    doneElapsed.textContent = `Encoded in ${fmtTime(elapsed)}`;
    doneOrigSize.textContent = humanSize(inB);
    doneOutSize.textContent  = humanSize(outB);
    doneBadge.textContent    = grew ? '· no size gain' : `· −${pct.toFixed(1)}%`;
    doneSaveNote.textContent = grew
      ? 'Source was already optimized — output prioritizes compatibility.'
      : `Saved ${humanSize(inB - outB)} — output is ${(100 - pct).toFixed(1)}% of the original.`;

    uploadTips.hidden = !activeConfig.tiktokTips;

    doneOrigVid.src = sourceUrl || '';
    doneOutVid.src  = outUrl || '';

    const base = (readyName.textContent || 'video').replace(/\.[^.]*$/, '');
    btnDownload.href = outUrl;
    btnDownload.download = `${base}-compressed.mp4`;

    setEngineBadge('gpu');
    showView('done');
  } catch (err) {
    console.error('Compression failed:', err);
    setEngineBadge('idle');
    errMsg.textContent = (err && err.message) || String(err);
    showView('error');
  }
}

fileInput.addEventListener('change', (e) => handleFile(e.target.files?.[0]));
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});

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
btnAgain.addEventListener('click', () => {
  resetSession();
  activeMode = null;
  activeConfig = null;
  document.querySelectorAll('.mode-card').forEach((c) => c.classList.remove('selected'));
  btnContinue.disabled = true;
  showView('wizard');
});
btnRetry.addEventListener('click', () => showView(currentBlob ? 'ready' : 'upload'));

setEngineBadge('idle');
showView('wizard');
