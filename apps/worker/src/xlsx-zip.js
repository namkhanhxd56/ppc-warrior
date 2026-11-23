/* xlsx-zip.js — ĐỌC / GHI ZIP CỦA FILE .xlsx (23/11/2026)
   Dùng cho Lọc Bulk: đọc thẳng từng phần trong zip thay vì để SheetJS nạp cả workbook (file bulk
   21MB = 285MB XML → SheetJS cần >1,5GB heap và nén lại rất yếu: 21,5MB thành 69MB).
   - readZip: đọc mục lục cuối file (central directory), giải nén từng phần khi cần.
   - writeZip: ghi lại zip; phần không đổi chép NGUYÊN dữ liệu nén cũ, phần mới nén bằng zlib.
   Không hỗ trợ zip64 (mỗi phần < 4GB) — file bulk Amazon không dùng. */
import zlib from "zlib";

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
/** CRC-32 của zip. Node ≥22 có sẵn zlib.crc32; Node 20 (Docker Railway) thì tự tính. */
export function crc32(buf) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buf) >>> 0;
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** → { entries:[{name, method, crc, size, comp}], has(name), buffer(name), text(name) } */
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd === -1) throw new Error("Không phải file zip");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("Mục lục zip hỏng");
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nl);
    p += 46 + nl + xl + cl;
    if (name.endsWith("/")) continue; // thư mục
    const dataAt = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    entries.push({ name, method, crc, size, comp: buf.subarray(dataAt, dataAt + compSize) });
  }
  const by = new Map(entries.map((e) => [e.name, e]));
  const buffer = (name) => {
    const e = by.get(name);
    if (!e) throw new Error(`Thiếu ${name} trong file`);
    if (e.method === 0) return e.comp;
    if (e.method === 8) return zlib.inflateRawSync(e.comp);
    throw new Error(`Kiểu nén ${e.method} không hỗ trợ`);
  };
  return { entries, has: (n) => by.has(n), buffer, text: (n) => buffer(n).toString("utf8") };
}

/** Ghi zip từ [{name, method(0|8), crc, size, comp}] — comp là dữ liệu ĐÃ nén theo method. */
export function writeZip(entries) {
  const out = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(e.method, 8);
    lh.writeUInt32LE(0x00210000, 10); // giờ/ngày DOS: 1980-01-01
    lh.writeUInt32LE(e.crc, 14); lh.writeUInt32LE(e.comp.length, 18); lh.writeUInt32LE(e.size, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(e.method, 10);
    ch.writeUInt32LE(0x00210000, 12); ch.writeUInt32LE(e.crc, 16); ch.writeUInt32LE(e.comp.length, 20); ch.writeUInt32LE(e.size, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    out.push(lh, nameBuf, e.comp);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + e.comp.length;
  }
  const cdSize = central.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...out, ...central, end]);
}
