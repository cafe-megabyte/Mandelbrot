// Encode bounded RGBA strips; no full-image canvas or second fractal calculation.
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; ++n) {
  let c = n;
  for (let k = 0; k < 8; ++k) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function chunk(type, data) {
  const bytes = new Uint8Array(data.length + 12), view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; ++i) bytes[4 + i] = type.charCodeAt(i);
  bytes.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < bytes.length - 4; ++i) crc = CRC_TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  view.setUint32(bytes.length - 4, (crc ^ 0xffffffff) >>> 0);
  return bytes;
}

let width, height, nextY, parts, writer, readerDone, adlerA, adlerB;
function init(message) {
  ({width, height} = message); nextY = 0; adlerA = 1; adlerB = 0;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > 0x7fffffff || height > 0x7fffffff) throw new Error('Invalid PNG dimensions');
  const header = new Uint8Array(13), view = new DataView(header.buffer);
  view.setUint32(0, width); view.setUint32(4, height); header[8] = 8; header[9] = 6;
  parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header)];
  // The uncompressed zlib fallback also works on older SIMD-capable browsers.
  writer = null; readerDone = null;
  if (typeof CompressionStream === 'function' && message.compression !== 'store') {
    const stream = new CompressionStream('deflate');
    writer = stream.writable.getWriter();
    readerDone = (async () => {
      const reader = stream.readable.getReader();
      for (;;) {
        const {value, done} = await reader.read();
        if (done) return;
        parts.push(chunk('IDAT', value));
      }
    })();
  } else parts.push(chunk('IDAT', new Uint8Array([0x78, 0x01])));
  self.postMessage({type: 'next', y: nextY, height: Math.min(32, height)});
}
function store(bytes, final) {
  // Adler-32 with bounded intermediate sums, then byte-aligned DEFLATE blocks.
  for (let offset = 0; offset < bytes.length;) {
    const end = Math.min(offset + 4096, bytes.length);
    while (offset < end) { adlerA += bytes[offset++]; adlerB += adlerA; }
    adlerA %= 65521; adlerB %= 65521;
  }
  for (let offset = 0; offset < bytes.length; offset += 65535) {
    const size = Math.min(65535, bytes.length - offset), block = new Uint8Array(size + 5);
    block[0] = final && offset + size === bytes.length ? 1 : 0;
    block[1] = size & 255; block[2] = size >>> 8;
    block[3] = (~size) & 255; block[4] = ((~size) >>> 8) & 255;
    block.set(bytes.subarray(offset, offset + size), 5); parts.push(chunk('IDAT', block));
  }
}
async function band(message) {
  const rows = message.height, rgba = new Uint8Array(message.buffer), stride = width * 4;
  if (message.y !== nextY || !Number.isInteger(rows) || rows < 1 || rows > 32 || nextY + rows > height ||
      rgba.length !== stride * rows) throw new Error('Invalid PNG strip');
  const filtered = new Uint8Array((stride + 1) * rows);
  for (let row = 0; row < rows; ++row)
    filtered.set(rgba.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  nextY += rows;
  if (writer) await writer.write(filtered);
  else store(filtered, nextY === height);
  if (nextY < height) {
    self.postMessage({type: 'next', y: nextY, height: Math.min(32, height - nextY)}); return;
  }
  if (writer) { await writer.close(); await readerDone; }
  else {
    const adler = new Uint8Array(4);
    new DataView(adler.buffer).setUint32(0, ((adlerB << 16) | adlerA) >>> 0);
    parts.push(chunk('IDAT', adler));
  }
  parts.push(chunk('IEND', new Uint8Array(0)));
  self.postMessage({type: 'complete', blob: new Blob(parts, {type: 'image/png'})});
  parts = null;
}
self.onmessage = async ({data}) => {
  try {
    if (data.type === 'init') init(data);
    else if (data.type === 'band') await band(data);
    else throw new Error('Unknown PNG request');
  } catch (error) { self.postMessage({type: 'error', message: error.message}); }
};
