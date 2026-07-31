// Placeholder icon generator (no dependencies): builds a 256x256 PNG
// (dark background + coral "CU" letters) and wraps it in an .ico container.
// Run: node build/make-icon.js  →  build/icon.png + build/icon.ico
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const BG = [0x1a, 0x18, 0x15, 0xff];   // #1a1815 (app background)
const FG = [0xd9, 0x77, 0x57, 0xff];   // #d97757 coral accent

// 5x7 bitmap glyphs for C and U
const GLYPHS = {
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
};

// --- CRC32 (PNG chunks) ---
const crcTable = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function buildPng() {
  const px = Buffer.alloc(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i++) Buffer.from(BG).copy(px, i * 4);

  const scale = 20, gap = 20;
  const text = 'CU';
  const glyphW = 5 * scale, glyphH = 7 * scale;
  const totalW = text.length * glyphW + (text.length - 1) * gap;
  const ox = Math.floor((SIZE - totalW) / 2);
  const oy = Math.floor((SIZE - glyphH) / 2);

  for (let gi = 0; gi < text.length; gi++) {
    const rows = GLYPHS[text[gi]];
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 5; c++) {
        if (rows[r][c] !== '1') continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const x = ox + gi * (glyphW + gap) + c * scale + dx;
            const y = oy + r * scale + dy;
            Buffer.from(FG).copy(px, (y * SIZE + x) * 4);
          }
        }
      }
    }
  }

  // scanlines, filter byte 0 per row
  const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
  for (let y = 0; y < SIZE; y++) {
    raw[y * (1 + SIZE * 4)] = 0;
    px.copy(raw, y * (1 + SIZE * 4) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function buildIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count
  const entry = Buffer.alloc(16);
  entry[0] = 0; // width byte: 0 = 256
  entry[1] = 0; // height byte: 0 = 256
  entry[2] = 0; // palette
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4);  // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(6 + 16, 12); // data offset
  return Buffer.concat([header, entry, png]);
}

const png = buildPng();
fs.writeFileSync(path.join(__dirname, 'icon.png'), png);
fs.writeFileSync(path.join(__dirname, 'icon.ico'), buildIco(png));
console.log('icon: build/icon.png + build/icon.ico', png.length, 'bytes png');
