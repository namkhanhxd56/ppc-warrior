// flex-import.js — Module DATA: đọc file xlsx/csv/tsv + ánh xạ cột linh hoạt theo alias.
//
// Tổng quát hóa cách h10-parser.js (findCol theo alias) + reader trong /api/tracking/volumes.
// Dùng cho Business Report / Inventory (định dạng đa dạng): tự nhận diện cột → UI xác nhận → map rows.

import * as XLSX from "xlsx";

export const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Chuẩn hóa số: bỏ tiền tệ/%, xử lý dấu phẩy (thập phân "0,67" vs ngăn nghìn "1,234"). */
export function num(v) {
  if (v === "" || v === null || v === undefined) return null;
  let s = String(v).trim().replace(/[$€£%\s]/g, "");
  if (s === "" || s === "-" || s === "—") return null;
  const hasComma = s.includes(","), hasDot = s.includes(".");
  if (hasComma && hasDot) s = s.replace(/,/g, "");            // 1,234.56 → 1234.56
  else if (hasComma && !hasDot) {
    // Thập phân kiểu Âu ("0,67"/"12,5") nếu 1 dấu phẩy + ≤2 chữ số cuối; còn lại là ngăn nghìn
    if (/,\d{1,2}$/.test(s) && (s.match(/,/g) || []).length === 1) s = s.replace(",", ".");
    else s = s.replace(/,/g, "");
  }
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

export const asinOf = (v) => {
  const m = String(v || "").toUpperCase().match(/B0[A-Z0-9]{8}/);
  return m ? m[0] : (/^[A-Z0-9]{10}$/.test(String(v || "").toUpperCase().trim()) ? String(v).toUpperCase().trim() : null);
};

/** Đọc file → {header, dataRows, headerRowIndex}. Bỏ qua dòng preamble (Amazon report hay có tiêu đề). */
export function readTable(buf) {
  const wb = XLSX.read(buf, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  if (!rows.length) throw new Error("File rỗng");
  let hi = 0;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const nonEmpty = rows[i].filter((c) => String(c).trim() !== "").length;
    if (nonEmpty >= 2) { hi = i; break; }
  }
  return { header: rows[hi].map(String), dataRows: rows.slice(hi + 1), headerRowIndex: hi };
}

/** Dò cột theo alias (khớp chính xác trước, rồi khớp một phần). specs: [{key,label,aliases,type}]. */
export function detectColumns(header, specs) {
  const H = header.map(norm);
  const map = {};
  for (const sp of specs) {
    let idx = -1;
    for (const a of sp.aliases) { const i = H.indexOf(norm(a)); if (i !== -1) { idx = i; break; } }
    if (idx === -1) for (const a of sp.aliases) { const i = H.findIndex((h) => h && h.includes(norm(a))); if (i !== -1) { idx = i; break; } }
    map[sp.key] = idx;
  }
  return map;
}

const coerce = (v, type) => {
  if (type === "asin") return asinOf(v);
  if (type === "int") { const n = num(v); return n === null ? null : Math.round(n); }
  if (type === "num") return num(v);
  return String(v ?? "").trim();
};

/**
 * Map dữ liệu → records theo mapping cột. mapping: {key: colIndex} (override từ UI, thiếu key dùng auto).
 * @returns {{records: Array, mapping: object, skipped: number}}
 */
export function mapRows(header, dataRows, specs, mappingOverride = {}) {
  const auto = detectColumns(header, specs);
  const mapping = { ...auto, ...mappingOverride };
  const typeOf = Object.fromEntries(specs.map((s) => [s.key, s.type || "text"]));
  const records = [];
  let skipped = 0;
  for (const r of dataRows) {
    const rec = {};
    let empty = true;
    for (const sp of specs) {
      const idx = mapping[sp.key];
      const val = idx != null && idx >= 0 ? coerce(r[idx], typeOf[sp.key]) : null;
      rec[sp.key] = val;
      if (val !== null && val !== "") empty = false;
    }
    if (empty) { skipped++; continue; }
    records.push(rec);
  }
  return { records, mapping, skipped };
}

/** Preview cho UI xác nhận ánh xạ trước khi commit. */
export function previewColumns(buf, specs, sampleN = 6) {
  const { header, dataRows, headerRowIndex } = readTable(buf);
  const mapping = detectColumns(header, specs);
  const detected = specs.map((sp) => ({
    key: sp.key, label: sp.label,
    index: mapping[sp.key],
    columnName: mapping[sp.key] >= 0 ? header[mapping[sp.key]] : null
  }));
  return { header, headerRowIndex, detected, sampleRows: dataRows.slice(0, sampleN) };
}
