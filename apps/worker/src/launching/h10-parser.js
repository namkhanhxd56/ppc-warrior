// h10-parser.js — Import keyword từ file Helium10 (Cerebro/Magnet, csv hoặc xlsx)
//
// Header thật đã verify từ US_AMAZON_cerebro_B0FLJY181J_2026-07-14.xlsx:
//   Keyword Phrase | ... | Search Volume | H10 PPC Sugg. Bid | H10 PPC Sugg. Min Bid |
//   H10 PPC Sugg. Max Bid | ... | Organic Rank | Sponsored Rank
// ⚠️ Bid của H10 có thể dùng DẤU PHẨY thập phân ("0,67") — parseBid xử lý.

import * as XLSX from "xlsx";
import { parseBid } from "./bulk-builder.js";

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");

/** Tìm cột theo nhiều alias (H10 đổi tên cột giữa các bản). */
function findCol(header, aliases) {
  const H = header.map(norm);
  for (const a of aliases) {
    const i = H.indexOf(norm(a));
    if (i !== -1) return i;
  }
  // khớp một phần (VD "H10 PPC Sugg. Max Bid" ~ "suggmaxbid")
  for (const a of aliases) {
    const i = H.findIndex((h) => h.includes(norm(a)));
    if (i !== -1) return i;
  }
  return -1;
}

/**
 * @param {Buffer} buf - nội dung file csv/xlsx
 * @returns {{keywords: Array<{text, suggBid, minBid, maxBid, searchVolume}>, skipped: number}}
 */
export function parseH10(buf) {
  const wb = XLSX.read(buf, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  if (!rows.length) throw new Error("File rỗng");

  const header = rows[0];
  const iKw = findCol(header, ["Keyword Phrase", "Keyword", "Search Term"]);
  if (iKw === -1) throw new Error('Không tìm thấy cột "Keyword Phrase" — có đúng file Helium10?');
  const iSugg = findCol(header, ["H10 PPC Sugg. Bid", "Suggested PPC Bid", "PPC Sugg Bid", "Sugg. Bid"]);
  const iMin = findCol(header, ["H10 PPC Sugg. Min Bid", "Min Bid"]);
  const iMax = findCol(header, ["H10 PPC Sugg. Max Bid", "Max Bid"]);
  const iVol = findCol(header, ["Search Volume"]);

  const keywords = [];
  let skipped = 0;
  const seen = new Set();
  for (const r of rows.slice(1)) {
    const text = String(r[iKw] || "").trim().toLowerCase();
    if (!text || seen.has(text)) { if (text) skipped++; continue; }
    seen.add(text);
    keywords.push({
      text,
      suggBid: iSugg !== -1 ? parseBid(r[iSugg]) : null,
      minBid: iMin !== -1 ? parseBid(r[iMin]) : null,
      maxBid: iMax !== -1 ? parseBid(r[iMax]) : null,
      searchVolume: iVol !== -1 ? Number(String(r[iVol]).replace(/[^0-9]/g, "")) || null : null
    });
  }
  return { keywords, skipped };
}
