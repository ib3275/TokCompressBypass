/* ════════════════════════════════════════════════════════════════════
   patcher.js — MP4 container patcher.
   Fixes: filler sizing + valid NAL type.
   ════════════════════════════════════════════════════════════════════ */

const readU32 = (d, o) =>
  ((d[o] << 24) | (d[o+1] << 16) | (d[o+2] << 8) | d[o+3]) >>> 0;

const writeU32 = (d, o, v) => {
  d[o]   = (v >>> 24) & 0xff;
  d[o+1] = (v >>> 16) & 0xff;
  d[o+2] = (v >>>  8) & 0xff;
  d[o+3] =  v         & 0xff;
};

const readU64 = (d, o) => readU32(d, o) * 0x100000000 + readU32(d, o + 4);

const writeU64 = (d, o, v) => {
  writeU32(d, o,     Math.floor(v / 0x100000000));
  writeU32(d, o + 4, v >>> 0);
};

const readType = (d, o) =>
  String.fromCharCode(d[o], d[o+1], d[o+2], d[o+3]);

const writeType = (d, o, t) => {
  for (let i = 0; i < 4; i++) d[o + i] = t.charCodeAt(i);
};

function parseBoxes(data, start, end) {
  const boxes = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = readU32(data, pos);
    const type = readType(data, pos + 4);
    let headerSize = 8;
    if (size === 1) {
      if (pos + 16 > end) break;
      size = readU64(data, pos + 8);
      headerSize = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < headerSize || pos + size > end) break;
    boxes.push({
      type, start: pos, end: pos + size, headerSize,
      payloadStart: pos + headerSize, payloadEnd: pos + size,
    });
    pos += size;
  }
  return boxes;
}

function findBox(data, parent, type) {
  return parseBoxes(data, parent.payloadStart, parent.payloadEnd)
    .find(b => b.type === type);
}

function findAllBoxes(data, parent, type) {
  return parseBoxes(data, parent.payloadStart, parent.payloadEnd)
    .filter(b => b.type === type);
}

function getCodec(data, stsd) {
  if (stsd.payloadStart + 12 > stsd.payloadEnd) return null;
  return readType(data, stsd.payloadStart + 8);
}

function inflateStts(data, stts, ghostCount) {
  const src = data.subarray(stts.payloadStart, stts.payloadEnd);
  const entryCount = readU32(src, 4);
  const origBytes = entryCount * 8;
  const out = new Uint8Array(8 + origBytes + 8);
  out.set(src.subarray(0, 4), 0);
  writeU32(out, 4, entryCount + 1);
  out.set(src.subarray(8, 8 + origBytes), 8);
  writeU32(out, 8 + origBytes, ghostCount);
  writeU32(out, 8 + origBytes + 4, 1);
  return out;
}

function inflateStsz(data, stsz, ghostCount, dummySize) {
  const src = data.subarray(stsz.payloadStart, stsz.payloadEnd);
  const sampleSize = readU32(src, 4);
  const count = readU32(src, 8);
  if (sampleSize !== 0) throw new Error('Constant-size stsz not supported');
  const out = new Uint8Array(12 + (count + ghostCount) * 4);
  out.set(src.subarray(0, 8), 0);
  writeU32(out, 8, count + ghostCount);
  out.set(src.subarray(12, 12 + count * 4), 12);
  for (let i = 0; i < ghostCount; i++) {
    writeU32(out, 12 + (count + i) * 4, dummySize);
  }
  return out;
}

function inflateStsc(data, stsc, ghostCount) {
  const src = data.subarray(stsc.payloadStart, stsc.payloadEnd);
  const entryCount = readU32(src, 4);
  const origBytes = entryCount * 12;
  const lastFirstChunk = readU32(src, 8 + (entryCount - 1) * 12);
  const out = new Uint8Array(8 + origBytes + 12);
  out.set(src.subarray(0, 4), 0);
  writeU32(out, 4, entryCount + 1);
  out.set(src.subarray(8, 8 + origBytes), 8);
  writeU32(out, 8 + origBytes,     lastFirstChunk + 1);
  writeU32(out, 8 + origBytes + 4, ghostCount);
  writeU32(out, 8 + origBytes + 8, 1);
  return out;
}

function inflateStco(data, stco, ghostOffset, is64) {
  const src = data.subarray(stco.payloadStart, stco.payloadEnd);
  const entryCount = readU32(src, 4);
  const entrySize = is64 ? 8 : 4;
  const origBytes = entryCount * entrySize;
  const out = new Uint8Array(8 + origBytes + entrySize);
  out.set(src.subarray(0, 4), 0);
  writeU32(out, 4, entryCount + 1);
  out.set(src.subarray(8, 8 + origBytes), 8);
  if (is64) writeU64(out, 8 + origBytes, ghostOffset);
  else      writeU32(out, 8 + origBytes, ghostOffset);
  return out;
}

function rebuildBox(data, box, replacements) {
  if (replacements.has(box.start)) return replacements.get(box.start);
  const children = parseBoxes(data, box.payloadStart, box.payloadEnd);
  const anyDirty = children.some(c => replacements.has(c.start)) ||
                   children.some(c => hasDirtyDescendant(data, c, replacements));
  if (!anyDirty) return data.subarray(box.start, box.end);
  const childBufs = children.map(c => rebuildBox(data, c, replacements));
  const payloadSize = childBufs.reduce((s, b) => s + b.length, 0);
  const totalSize = box.headerSize + payloadSize;
  const out = new Uint8Array(totalSize);
  if (box.headerSize === 16) {
    writeU32(out, 0, 1);
    writeType(out, 4, box.type);
    writeU64(out, 8, totalSize);
  } else {
    writeU32(out, 0, totalSize);
    writeType(out, 4, box.type);
  }
  let pos = box.headerSize;
  for (const buf of childBufs) { out.set(buf, pos); pos += buf.length; }
  return out;
}

function hasDirtyDescendant(data, box, replacements) {
  const children = parseBoxes(data, box.payloadStart, box.payloadEnd);
  return children.some(c =>
    replacements.has(c.start) || hasDirtyDescendant(data, c, replacements)
  );
}

export async function patchMP4(blob, { inflationFactor = 10 } = {}) {
  const buf = await blob.arrayBuffer();
  const data = new Uint8Array(buf);

  const top = parseBoxes(data, 0, data.length);
  const moov = top.find(b => b.type === 'moov');
  const mdat = top.find(b => b.type === 'mdat');
  const ftyp = top.find(b => b.type === 'ftyp');

  if (!moov) throw new Error('No moov box found — not a valid MP4');
  if (!ftyp) throw new Error('No ftyp box found');
  if (!mdat) throw new Error('No mdat box found');

  const traks = findAllBoxes(data, moov, 'trak');
  let videoTrak = null;
  for (const trak of traks) {
    const mdia = findBox(data, trak, 'mdia');
    if (!mdia) continue;
    const hdlr = findBox(data, mdia, 'hdlr');
    if (!hdlr) continue;
    const handlerType = readType(data, hdlr.payloadStart + 8);
    if (handlerType === 'vide') { videoTrak = trak; break; }
  }
  if (!videoTrak) throw new Error('No video track found');

  const mdia = findBox(data, videoTrak, 'mdia');
  const minf = findBox(data, mdia, 'minf');
  const stbl = findBox(data, minf, 'stbl');
  const stsd = findBox(data, stbl, 'stsd');
  const stts = findBox(data, stbl, 'stts');
  const stsz = findBox(data, stbl, 'stsz');
  const stsc = findBox(data, stbl, 'stsc');
  const stco = findBox(data, stbl, 'stco');
  const co64 = findBox(data, stbl, 'co64');
  const offsetBox = stco || co64;
  const is64 = !!co64;

  if (!stts || !stsz || !stsc || !offsetBox) {
    throw new Error('Missing required sample table boxes');
  }

  const codec = getCodec(data, stsd);
  const dummySize = (codec === 'hvc1' || codec === 'hev1') ? 16 : 8;

  const origCount = readU32(data, stsz.payloadStart + 8);
  const ghostCount = Math.max(1, origCount * (inflationFactor - 1));

  /* ── BUGFIX 1: filler needs dummySize * ghostCount bytes, not just dummySize. ──
     Otherwise the inflated sample table points past EOF → players reject the file. */
  const totalFillerSize = dummySize * ghostCount;
  const filler = new Uint8Array(totalFillerSize);
  for (let i = 0; i < ghostCount; i++) {
    const off = i * dummySize;
    writeU32(filler, off, dummySize - 4);  // NAL length prefix (4 bytes)
    /* BUGFIX 2: NAL byte 0x0C = nal_unit_type 12 ("filler data").
       Was 0x00 before, which strict parsers rejected. */
    filler[off + 4] = 0x0C;
  }

  const moovBeforeMdat = moov.start < mdat.start;
  const outputParts = [];
  let fillerOffset = 0;

  function buildMoovWithOffset(shift) {
    const replacements = new Map();
    replacements.set(stts.start, inflateStts(data, stts, ghostCount));
    replacements.set(stsz.start, inflateStsz(data, stsz, ghostCount, dummySize));
    replacements.set(stsc.start, inflateStsc(data, stsc, ghostCount));
    replacements.set(offsetBox.start, inflateStco(data, offsetBox, shift, is64));
    return rebuildBox(data, moov, replacements);
  }

  const provMoov = buildMoovWithOffset(0);
  const moovDelta = provMoov.length - (moov.end - moov.start);

  let realMoov;
  if (moovBeforeMdat) {
    const ftypSize = ftyp.end - ftyp.start;
    const mdatSize = mdat.end - mdat.start;
    fillerOffset = ftypSize + provMoov.length + mdatSize;
    realMoov = buildMoovWithOffset(moovDelta);
    outputParts.push(data.subarray(ftyp.start, ftyp.end));
    outputParts.push(realMoov);
    outputParts.push(data.subarray(mdat.start, mdat.end));
    outputParts.push(filler);
  } else {
    const ftypSize = ftyp.end - ftyp.start;
    const preMoovSize = moov.start - ftyp.end;
    const mdatSize = mdat.end - mdat.start;
    fillerOffset = ftypSize + preMoovSize + mdatSize + provMoov.length;
    realMoov = buildMoovWithOffset(0);
    outputParts.push(data.subarray(ftyp.start, ftyp.end));
    outputParts.push(data.subarray(ftyp.end, moov.start));
    outputParts.push(realMoov);
    outputParts.push(data.subarray(moov.end, mdat.end));
    outputParts.push(filler);
  }

  const totalSize = outputParts.reduce((s, p) => s + p.length, 0);
  const result = new Uint8Array(totalSize);
  let pos = 0;
  for (const part of outputParts) { result.set(part, pos); pos += part.length; }

  console.log(`Patched: origFrames=${origCount} ghostFrames=${ghostCount} filler=${totalFillerSize}B`);
  return new Blob([result], { type: 'video/mp4' });
}
