// Đường đi của DỮ LIỆU sau khi agent tải được file Export về:
// chờ tải xong → đọc file → áp bộ quy tắc → gộp nhiều ASIN.
import fs from "fs";
import path from "path";
import os from "os";
import * as XLSX from "xlsx";
import { parseCerebroExport, applyRule, mergeByKeyword } from "../src/keywords/cerebro.js";
import { waitDownload } from "../agent.js";

let ok = 0, bad = 0;
const t = (n, c, x = "") => { c ? ok++ : bad++; console.log(`${c ? "✓" : "✗"} ${n}${x ? " — " + x : ""}`); };

/* ===== 1. Chờ file tải xong ===== */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppcw-dl-"));
fs.writeFileSync(path.join(dir, "cu.csv"), "file của lượt trước");  // có TRƯỚC → không được nhặt
const p1 = waitDownload(dir, 20000);
setTimeout(() => fs.writeFileSync(path.join(dir, "new.csv.crdownload"), "x".repeat(10)), 400);
setTimeout(() => {
  fs.unlinkSync(path.join(dir, "new.csv.crdownload"));
  fs.writeFileSync(path.join(dir, "new.csv"), "y".repeat(50));
}, 1600);
const got = await p1;
t("trả về file đã tải XONG", got === path.join(dir, "new.csv"), String(got));
t("không nhặt nhầm file của lượt trước", !String(got).includes("cu.csv"));
t("hết hạn thì trả null, không treo mãi", (await waitDownload(dir, 2500)) === null);
fs.rmSync(dir, { recursive: true, force: true });

/* ===== 2. Đọc file export ===== */
const header = ["Keyword Phrase", "Search Volume", "Search Volume Trend", "Word Count", "Competing Products",
  "Cerebro IQ Score", "Title Density", "Organic Rank", "Sponsored Rank", "Keyword Sales", "Suggested PPC Bid", "Match Type"];
const rows = [
  ["christmas ornament", "14,171", "12", "2", "2,345", "880", "3", "15", "-", "420", "$0.78", "Organic"],
  ["glass ornament", "1,200", "-5", "2", "900", "300", "1", "40", "12", "60", "$0.55", "Organic"],
  ["cheap ornament", "300", "0", "2", "100", "50", "0", "80", "-", "5", "$0.21", "Organic"],
  ["ornament hooks", "2,000", "3", "2", "700", "210", "2", "-", "8", "90", "$0.40", "Sponsored"],
  ["", "", "", "", "", "", "", "", "", "", "", ""]
];
const ws = XLSX.utils.aoa_to_sheet([["Cerebro Export"], [], header, ...rows]); // 2 dòng rác đầu bảng
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "Cerebro");
const parsed = parseCerebroExport(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
t("bỏ qua dòng rác trước bảng", parsed.headerRow === 2, "headerRow=" + parsed.headerRow);
t("bỏ dòng rỗng", parsed.rows.length === 4, String(parsed.rows.length));
t('"14,171" → 14171', parsed.rows[0].searchVolume === 14171);
t('"$0.78" → 0.78', parsed.rows[0].suggestedBid === 0.78);
t('"-" → null chứ KHÔNG phải 0', parsed.rows[0].sponsoredRank === null);
t("giữ dấu âm", parsed.rows[1].svTrend === -5, String(parsed.rows[1].svTrend));

/* ===== 3. Áp bộ quy tắc ===== */
const r = applyRule(parsed.rows, { filters: { searchVolume: [1000, null], organicRank: [null, 50] }, excludeKeywords: "cheap" });
t("lọc đúng SV≥1000 và Organic Rank≤50", r.kept.map((x) => x.text).join(",") === "christmas ornament,glass ornament",
  r.kept.map((x) => x.text).join(","));
t("thiếu dữ liệu ở cột ĐANG LỌC → loại, không coi như 0", !!r.reasons["organicRank (thiếu dữ liệu)"], JSON.stringify(r.reasons));

/* ===== 4. Gộp nhiều ASIN ===== */
const merged = mergeByKeyword([
  { asin: "B0991NYY1P", rows: [{ text: "christmas ornament", searchVolume: 14171 }, { text: "glass ornament", searchVolume: 900 }] },
  { asin: "B0FLJY181J", rows: [{ text: "christmas ornament", searchVolume: 9000 }, { text: "wood ornament", searchVolume: 5000 }] }
]);
const xmas = merged.find((x) => x.text === "christmas ornament");
t("bỏ trùng keyword", merged.length === 3, String(merged.length));
t("trùng thì giữ search volume cao nhất", xmas.searchVolume === 14171);
t("nhớ keyword đến từ ASIN nào", xmas.asins.join(",") === "B0991NYY1P,B0FLJY181J", xmas.asins.join(","));
t("xếp theo search volume giảm dần", merged[0].searchVolume >= merged[1].searchVolume);

console.log(`${ok}/${ok + bad} đạt`);
process.exit(bad ? 1 : 0);
