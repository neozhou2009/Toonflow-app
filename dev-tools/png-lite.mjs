// 极简 PNG 编码器（仅用于测试替身）：输出一张纯色 PNG 字节流
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([td, data])));
  return Buffer.concat([len, td, data, crc]);
}

export const PNG = {
  solid(w, h, [r, g, b]) {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const raw = Buffer.alloc(h * (1 + w * 3));
    let p = 0;
    for (let y = 0; y < h; y++) {
      raw[p++] = 0;
      for (let x = 0; x < w; x++) { raw[p++] = r; raw[p++] = g; raw[p++] = b; }
    }
    // 存贮模式（stored deflate blocks）
    const blocks = [];
    const max = 65535;
    for (let i = 0; i < raw.length; i += max) {
      const part = raw.subarray(i, i + max);
      const last = i + max >= raw.length;
      const header = Buffer.alloc(5);
      header[0] = last ? 1 : 0;
      header.writeUInt16LE(part.length, 1);
      header.writeUInt16LE(~part.length & 0xffff, 3);
      blocks.push(header, part);
    }
    const zlib = Buffer.concat([Buffer.from([0x78, 0x01]), ...blocks,
      (() => { const a = Buffer.alloc(4); a.writeUInt32BE(0); return a; })()]);
    return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib), chunk('IEND', Buffer.alloc(0))]);
  },
  parse(buf) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
  },
};
