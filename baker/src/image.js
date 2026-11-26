(function (root, factory) {
  let api;
  if (typeof module === 'object' && module.exports) {
    api = factory(require('zlib'), typeof Buffer === 'function' ? Buffer : null);
    module.exports = api;
  } else {
    // In the browser PNG encoding is unavailable; the GUI renders layers to
    // a canvas instead. The RGBA conversion helpers are still exported.
    api = factory(null, null);
    root.GeoBakerImage = api;
  }
})(typeof self !== 'undefined' ? self : this, function (zlib, Buffer) {
'use strict';

// Encode RGBA Uint8Array (width*height*4) to a PNG buffer using only the
// Node standard library. Filter type 0 (none) per scanline is sufficient
// for diagnostic textures and keeps the implementation dependency-free.
function encodePNG(width, height, rgba) {
  if (!zlib || !Buffer) {
    throw new Error('PNG encoding is only available in Node; use a canvas in the browser');
  }
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy ? rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
      : raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 6 });

  const chunks = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  chunks.push(makeChunk('IHDR', (() => {
    const b = Buffer.alloc(13);
    b.writeUInt32BE(width, 0);
    b.writeUInt32BE(height, 4);
    b[8] = 8;   // bit depth
    b[9] = 6;   // color type RGBA
    b[10] = 0; b[11] = 0; b[12] = 0;
    return b;
  })()));
  chunks.push(makeChunk('IDAT', idat));
  chunks.push(makeChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function grayscaleToRGBA(floatArray, size, opts = {}) {
  const out = new Uint8ClampedArray(size * size * 4);
  let lo = opts.min ?? Math.min(...floatArray);
  let hi = opts.max ?? Math.max(...floatArray);
  if (hi - lo < 1e-9) hi = lo + 1;
  const diverging = opts.diverging ?? false;
  for (let i = 0; i < size * size; i++) {
    const v = floatArray[i];
    let r, g, b;
    if (diverging) {
      const t = Math.max(-1, Math.min(1, v / hi));
      [r, g, b] = t >= 0 ? [Math.round(255 * t), 60, 40] : [40, 80, Math.round(255 * -t)];
    } else {
      const t = (v - lo) / (hi - lo);
      r = g = b = Math.round(255 * t);
    }
    out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = 255;
  }
  return out;
}

// Color-coded status map: hit / miss / conflict / outside / degenerate.
function statusToRGBA(status, size) {
  const palette = [
    [40, 200, 120],   // hit green
    [230, 60, 60],    // miss red
    [255, 180, 0],    // conflict amber
    [30, 30, 40],     // outside UV dark
    [180, 0, 220],    // degenerate purple
    [64, 220, 220],   // unknown correspondence cyan
  ];
  const out = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const c = palette[status[i]] ?? palette[3];
    out[i * 4] = c[0]; out[i * 4 + 1] = c[1]; out[i * 4 + 2] = c[2];
    out[i * 4 + 3] = 255;
  }
  return out;
}

function maskToRGBA(mask, size, on = [255, 255, 255], off = [0, 0, 0]) {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const c = mask[i] ? on : off;
    out[i * 4] = c[0]; out[i * 4 + 1] = c[1]; out[i * 4 + 2] = c[2];
    out[i * 4 + 3] = 255;
  }
  return out;
}

function errorToRGBA(values, size, maxDeg = 2) {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const t = Math.max(0, Math.min(1, (values[i] || 0) / maxDeg));
    out[i * 4] = Math.round(40 + 215 * t);
    out[i * 4 + 1] = Math.round(200 * (1 - t));
    out[i * 4 + 2] = Math.round(120 * (1 - t));
    out[i * 4 + 3] = values[i] > 0 ? 255 : 40;
  }
  return out;
}

return { encodePNG, grayscaleToRGBA, statusToRGBA, maskToRGBA, errorToRGBA };
});
