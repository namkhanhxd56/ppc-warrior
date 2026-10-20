// cerebro.js — Đọc file export của Helium 10 Cerebro và áp bộ quy tắc
//
// QUYẾT ĐỊNH THIẾT KẾ: KHÔNG bấm 18 ô lọc trên giao diện Cerebro.
// Agent chỉ làm đúng hai việc trên trang H10 — nhập ASIN và bấm Export — rồi bộ lọc chạy
// bằng code ở đây. Lý do:
//   1. Mọi ô Min/Max của Cerebro chỉ thu hẹp dòng HIỂN THỊ, và các cột đó đều CÓ trong file
//      export. Lọc ở đâu cũng ra cùng kết quả.
//   2. Tự động bấm 18 ô là 18 chỗ gãy mỗi khi H10 đổi giao diện; nhập ASIN + Export là 2 chỗ.
//   3. Lọc bằng code thì tái lập được: cùng file export + cùng bộ quy tắc luôn ra cùng kết quả,
//      đối chiếu được về sau. Bấm trên giao diện thì không.
// Ngoại lệ: Exclude Variations đổi chính TẬP DỮ LIỆU Cerebro trả về nên phải đặt trên trang.

import * as XLSX from "xlsx";

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/* Tên cột Cerebro hay đổi chữ hoa/thường, dấu chấm, chữ viết tắt — khớp theo danh sách tên
   thay thế, ưu tiên khớp đúng rồi mới khớp một phần. */
const COLS = {
  keyword:          ["Keyword Phrase", "Keyword", "Search Term"],
  searchVolume:     ["Search Volume"],
  svTrend:          ["Search Volume Trend", "SV Trend"],
  wordCount:        ["Word Count"],
  competingProducts:["Competing Products"],
  cerebroIq:        ["Cerebro IQ Score", "CPR", "IQ Score"],
  titleDensity:     ["Title Density"],
  organicRank:      ["Organic Rank", "Position (Rank)"],
  sponsoredRank:    ["Sponsored Rank"],
  amazonRecRank:    ["Amazon Recommended Rank", "Amazon Rec. Rank"],
  keywordSales:     ["Keyword Sales"],
  abaClickShare:    ["ABA Total Click Share", "ABA Top 3 ASINs Total Click Share"],
  abaConvShare:     ["ABA Total Conv. Share", "ABA Top 3 ASINs Total Conv. Share"],
  suggestedBid:     ["Suggested PPC Bid", "H10 PPC Sugg. Bid", "Sugg. Bid"],
  minBid:           ["H10 PPC Sugg. Min Bid", "Min Bid"],
  maxBid:           ["H10 PPC Sugg. Max Bid", "Max Bid"],
  matchType:        ["Match Type"],
  amazonChoice:     ["Amazon Choice", "Amazon's Choice"]
};

function findCol(header, aliases) {
  const H = header.map(norm);
  for (const a of aliases) { const i = H.indexOf(norm(a)); if (i !== -1) return i; }
  for (const a of aliases) { const i = H.findIndex((h) => h.includes(norm(a))); if (i !== -1) return i; }
  return -1;
}

/** "1,234" → 1234 · "45%" → 45 · "> 100" → 100 · rỗng/“-” → null (KHÁC 0). */
export function num(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || s === "-" || s === "–" || /^n\/?a$/i.test(s)) return null;
  const n = parseFloat(s.replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? null : n;
}

/** File export Cerebro (csv/xlsx) → mảng dòng đã chuẩn hoá tên trường. */
export function parseCerebroExport(buf) {
  const wb = XLSX.read(buf, { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "" });
  if (!rows.length) throw new Error("File export rỗng");

  // Cerebro đôi khi chèn vài dòng tiêu đề phụ trước bảng — tìm dòng có cột Keyword Phrase
  let hi = rows.findIndex((r) => findCol(r.map(String), COLS.keyword) !== -1);
  if (hi === -1) throw new Error('Không tìm thấy cột "Keyword Phrase" — có đúng file export Cerebro?');
  const header = rows[hi].map(String);
  const idx = {};
  for (const [k, aliases] of Object.entries(COLS)) idx[k] = findCol(header, aliases);

  const out = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i];
    const text = String(r[idx.keyword] ?? "").trim();
    if (!text) continue;
    const row = { text };
    for (const k of Object.keys(COLS)) {
      if (k === "keyword" || idx[k] === -1) continue;
      row[k] = (k === "matchType" || k === "amazonChoice")
        ? String(r[idx[k]] ?? "").trim()
        : num(r[idx[k]]);
    }
    // Cerebro không có cột Word Count thì tự đếm
    if (row.wordCount == null) row.wordCount = text.split(/\s+/).filter(Boolean).length;
    out.push(row);
  }
  return { rows: out, header, headerRow: hi };
}

const RANGE_KEYS = ["wordCount", "searchVolume", "organicRank", "keywordSales", "cerebroIq",
  "titleDensity", "competingProducts", "svTrend", "sponsoredRank", "amazonRecRank",
  "abaClickShare", "abaConvShare", "suggestedBid"];

/**
 * Áp bộ quy tắc lên các dòng đã đọc.
 * @returns {{kept, dropped, reasons}} reasons = đếm số dòng bị loại theo TỪNG điều kiện,
 *   để biết quy tắc nào đang cắt mạnh tay — lọc ra 0 keyword thì biết ngay vì sao.
 */
export function applyRule(rows, rule = {}) {
  const f = rule.filters || {};
  const reasons = {};
  const bump = (k) => { reasons[k] = (reasons[k] || 0) + 1; };

  const phrase = String(rule.phrasesContaining?.text || "").trim().toLowerCase();
  const phraseMode = rule.phrasesContaining?.mode === "all" ? "all" : "any";
  const phraseWords = phrase ? phrase.split(/[\s,]+/).filter(Boolean) : [];
  const excludeWords = String(rule.excludeKeywords || "").trim().toLowerCase()
    .split(/[\s,]+/).filter(Boolean);

  const kept = rows.filter((r) => {
    for (const k of RANGE_KEYS) {
      const [min, max] = f[k] || [null, null];
      if (min == null && max == null) continue;
      const v = r[k];
      // Thiếu dữ liệu ở cột đang lọc → LOẠI. Giữ lại là lọt những dòng chưa chắc đạt.
      if (v == null) { bump(k + " (thiếu dữ liệu)"); return false; }
      if (min != null && v < min) { bump(k + " < min"); return false; }
      if (max != null && v > max) { bump(k + " > max"); return false; }
    }
    if (phraseWords.length) {
      const t = r.text.toLowerCase();
      const hit = phraseMode === "all" ? phraseWords.every((w) => t.includes(w))
                                       : phraseWords.some((w) => t.includes(w));
      if (!hit) { bump("phrases containing"); return false; }
    }
    if (excludeWords.length) {
      const t = r.text.toLowerCase();
      if (excludeWords.some((w) => t.includes(w))) { bump("exclude keywords"); return false; }
    }
    if (rule.matchType && r.matchType && norm(r.matchType) !== norm(rule.matchType)) {
      bump("match type"); return false;
    }
    return true;
  });
  return { kept, dropped: rows.length - kept.length, reasons };
}

/** Gộp kết quả nhiều ASIN: trùng keyword thì giữ dòng có search volume cao nhất và ghi
 *  lại nó đến từ những ASIN nào — quét từng ASIN rồi tổng hợp cần đúng thông tin này. */
export function mergeByKeyword(batches) {
  const map = new Map();
  for (const { asin, rows } of batches) {
    for (const r of rows) {
      const key = r.text.toLowerCase();
      const cur = map.get(key);
      if (!cur) { map.set(key, { ...r, asins: [asin] }); continue; }
      if (!cur.asins.includes(asin)) cur.asins.push(asin);
      if ((r.searchVolume ?? -1) > (cur.searchVolume ?? -1)) {
        map.set(key, { ...r, asins: cur.asins });
      }
    }
  }
  return [...map.values()].sort((a, b) => (b.searchVolume ?? 0) - (a.searchVolume ?? 0));
}
