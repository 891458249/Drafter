// Drafter logo generator (no dependencies): 256x256 PNG + .ico container.
// 设计(v0.9.35 更名 Drafter):深色底 + 「层叠草稿纸」——三页错位的稿纸轮廓,
// 前页珊瑚色描边 + 三行文字线,呼应 Drafter(起草者)。旧版为像素字母 CU/DU。
// Run: node build/make-icon.js  →  build/icon.png + build/icon.ico
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const BG = [0x1a, 0x18, 0x15, 0xff];        // #1a1815 (app background)
const CORAL = [0xd9, 0x77, 0x57, 0xff];     // #d97757 coral accent
const DIM1 = [0x9a, 0x54, 0x3d, 0xff];      // coral 调暗(后页一)
const DIM2 = [0x5a, 0x30, 0x24, 0xff];      // coral 更暗(后页二)

// --- pixel buffer ---
const px = Buffer.alloc(SIZE * SIZE * 4);
for (let i = 0; i < SIZE * SIZE; i++) Buffer.from(BG).copy(px, i * 4);
function fillRect(x, y, w, h, color) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      if (xx < 0 || yy < 0 || xx >= SIZE || yy >= SIZE) continue;
      Buffer.from(color).copy(px, (yy * SIZE + xx) * 4);
    }
  }
}
// 稿纸:深色填充 + 描边
function sheet(x, y, w, h, border, t) {
  fillRect(x, y, w, h, BG);
  fillRect(x, y, w, t, border);                    // top
  fillRect(x, y + h - t, w, t, border);            // bottom
  fillRect(x, y, t, h, border);                    // left
  fillRect(x + w - t, y, t, h, border);            // right
}

function buildPng() {
  const W = 104, H = 120, T = 8;
  // 后页(左上错位,逐层变暗)
  sheet(48, 40, W, H, DIM2, T);
  sheet(66, 58, W, H, DIM1, T);
  // 前页
  sheet(84, 76, W, H, CORAL, T);
  // 前页文字线(草稿内容)
  const lineX = 84 + 18, lineW = W - 36;
  fillRect(lineX, 104, lineW, 8, CORAL);
  fillRect(lineX, 128, lineW, 8, CORAL);
  fillRect(lineX, 152, Math.round(lineW * 0.62), 8, CORAL); // 末行较短,像未写完的草稿

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
