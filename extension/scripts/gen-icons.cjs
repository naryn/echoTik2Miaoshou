/**
 * 生成简单纯色占位 PNG 图标（16/48/128），不依赖第三方库
 * 输出到 public/icons/
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/**
 * 构造一个 RGBA 纯色 PNG Buffer
 * @param {number} size 边长
 * @param {[number, number, number, number]} rgba 颜色
 * @returns {Buffer} PNG 文件内容
 */
function makePng(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const p = rowStart + 1 + x * 4;
      raw[p] = rgba[0];
      raw[p + 1] = rgba[1];
      raw[p + 2] = rgba[2];
      raw[p + 3] = rgba[3];
    }
  }
  const idat = zlib.deflateSync(raw);

  /**
   * 生成 PNG chunk（含 CRC）
   * @param {string} type chunk 类型
   * @param {Buffer} data chunk 数据
   * @returns {Buffer} chunk 字节
   */
  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type, 'ascii');
    const body = Buffer.concat([typeBuf, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) : crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  }

  /**
   * 标准 CRC32 实现（Node 版本无 zlib.crc32 时的回退）
   * @param {Buffer} buf 输入
   * @returns {number} CRC32 值
   */
  function crc32(buf) {
    let table = crc32.table;
    if (!table) {
      table = crc32.table = new Int32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
      }
    }
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });
// 品牌蓝 #2563eb
for (const size of [16, 48, 128]) {
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), makePng(size, [37, 99, 235, 255]));
}
console.log('icons generated:', fs.readdirSync(outDir).join(', '));
