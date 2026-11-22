/* xlsx-zip.js — GHI .xlsx NÉN CHẶT (23/11/2026)
   SheetJS 0.18.5 nén zip bằng bộ deflate viết tay rất yếu: file bulk 285MB XML, Amazon nén còn
   21,5MB (92%), SheetJS chỉ còn 69MB (68%) → file "Lọc Bulk" nặng gấp 3 file gốc dù ít dòng hơn.
   Cách làm: để SheetJS ghi zip KHÔNG nén, đọc lại từng phần bằng XLSX.CFB, rồi tự đóng zip với
   zlib của Node (deflate mức 6, như Excel). Node 20 (Docker Railway) chưa có zlib.crc32 → tự tính. */
import zlib from "zlib";
import * as XLSX from "xlsx";
import { createRequire } from "module";
// Bản ESM (xlsx.mjs) không export CFB → mượn bản CommonJS chỉ để đọc lại zip không nén.
const CFB = createRequire(import.meta.url)("xlsx").CFB;

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Đóng gói [{name, data:Buffer}] thành zip (deflate). Không hỗ trợ zip64 — mỗi phần < 4GB. */
export function zipEntries(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const comp = zlib.deflateRawSync(data, { level: 6 });
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(0, 10); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(0, 12); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, comp);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cdSize = central.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

/** Như XLSX.write(wb, {type:"buffer", bookType:"xlsx", ...opts}) nhưng nén bằng zlib. */
export function writeXlsxCompact(wb, opts = {}) {
  const raw = XLSX.write(wb, { ...opts, type: "buffer", bookType: "xlsx", compression: false });
  const cfb = CFB.read(raw, { type: "buffer" });
  const entries = [];
  cfb.FileIndex.forEach((f, i) => {
    if (f.type !== 2 || !f.content || f.name.startsWith("\u0001")) return; // bỏ thư mục gốc + mục giữ chỗ của SheetJS
    entries.push({ name: cfb.FullPaths[i].replace(/^Root Entry\//, ""), data: Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content) });
  });
  entries.sort((a, b) => (b.name === "[Content_Types].xml") - (a.name === "[Content_Types].xml")); // Excel quen thấy file này đầu tiên
  return zipEntries(entries);
}
