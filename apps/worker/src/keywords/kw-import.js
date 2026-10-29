// kw-import.js — Đọc file keyword cho Danh mục Keyword: tự nhận dạng nguồn.
//
// Nhận mọi file csv/xlsx có cột keyword (+ tuỳ chọn cột volume):
//   - H10 (Cerebro / Magnet):  "Keyword Phrase" + "Search Volume"
//   - Amazon SQP (Brand Analytics → Search Query Performance): dòng 1 là metadata
//     ("Brand=...","Reporting Range=..."), header thật ở dòng 2: "Search Query" + "Search Query Volume"
//   - File tự làm: "Keyword"/"Search Term"/"Query" + "Volume"/"SV"…; không có header thì
//     cột 1 = keyword, cột 2 = volume (nếu là số).
// Chỉ lấy keyword + search volume — Danh mục Keyword không cần các cột khác.

import * as XLSX from "xlsx";

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const KW_ALIASES = ["keywordphrase", "searchquery", "customersearchterm", "searchterm", "keyword", "query", "keywords"];
const SV_ALIASES = ["searchqueryvolume", "searchvolume", "volume", "sv", "monthlysearchvolume", "exactsearchvolume"];

/** "1,234" → 1234 · rỗng/"-" → null */
function num(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || s === "-" || s === "–" || /^n\/?a$/i.test(s)) return null;
  const n = parseFloat(s.replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? null : n;
}
const colOf = (H, aliases) => {
  for (const a of aliases) { const i = H.indexOf(a); if (i !== -1) return i; }
  return -1;
};

/** buffer → { rows:[{kw, sv}], source:"H10"|"SQP"|"file", total } — keyword trùng trong file giữ volume lớn nhất. */
export function parseKeywordFile(buf) {
  const wb = XLSX.read(buf, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
  if (!rows.length) throw new Error("File rỗng");

  // Header có thể không nằm ở dòng 1 (SQP có dòng metadata, Cerebro đôi khi chèn tiêu đề phụ)
  let hi = -1, kwCol = -1, svCol = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const H = rows[i].map(norm);
    const k = colOf(H, KW_ALIASES);
    if (k !== -1) { hi = i; kwCol = k; svCol = colOf(H, SV_ALIASES); break; }
  }
  let source = "file";
  if (hi !== -1) {
    const H = rows[hi].map(norm);
    if (H.includes("searchqueryvolume") || H.includes("searchqueryscore")) source = "SQP";
    else if (H.includes("keywordphrase")) source = "H10";
  } else {
    // Không có header: cột 1 keyword, cột 2 volume
    hi = -1; kwCol = 0; svCol = 1;
  }

  const best = new Map();
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i];
    const kw = String(r[kwCol] ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!kw || kw.length > 200) continue;
    const sv = svCol === -1 ? null : num(r[svCol]);
    if (!best.has(kw) || (sv != null && (best.get(kw) == null || sv > best.get(kw)))) best.set(kw, sv);
  }
  if (!best.size) throw new Error("Không đọc được keyword nào — file cần cột Keyword / Keyword Phrase / Search Query");
  return { rows: [...best].map(([kw, sv]) => ({ kw, sv })), source, total: best.size, hasVolume: svCol !== -1 };
}
