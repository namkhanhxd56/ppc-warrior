// Lọc Bulk (src/bulk-filter.js): dựng 1 file bulk nhỏ bằng SheetJS rồi lọc, kiểm từng quy tắc giữ/bỏ.
import * as XLSX from "xlsx";
import { filterBulk } from "../src/bulk-filter.js";

let ok = 0, bad = 0;
const t = (n, c, x = "") => { c ? ok++ : bad++; console.log(`${c ? "✓" : "✗"} ${n}${x ? " — " + x : ""}`); };

const MINE = "B0MINE0001", OTHER = "B0OTHER001", MINE2 = "B0MINE0002";
const SP = [
  ["Product", "Entity", "Operation", "Campaign ID", "Portfolio ID", "Campaign Name (Informational only)", "Portfolio Name (Informational only)", "ASIN (Informational only)", "SKU", "Keyword Text"],
  // 1: có Product Ad của mình
  ["Sponsored Products", "Campaign", "", "C1", "P1", `FBA - ${MINE} - SP - a & b <x>`, `${MINE} - pf`, "", "", ""],
  ["Sponsored Products", "Product Ad", "", "C1", "", "", "", MINE, "SKU1", ""],
  ["Sponsored Products", "Keyword", "", "C1", "", "", "", "", "", "café ornament"],
  // 2: người khác, tên có ASIN mình ở cuối (PT) → bỏ
  ["Sponsored Products", "Campaign", "", "C2", "P2", `FBA - ${OTHER} - SP - ASIN - ${MINE}`, `${OTHER} - pf`, "", "", ""],
  ["Sponsored Products", "Product Targeting", "", "C2", "", "", "", "", "", ""],
  // 3: không có Product Ad, nhận theo tên
  ["Sponsored Products", "Campaign", "", "C3", "P3", `FBA - ${MINE2} - SP - Auto`, "", "", "", ""],
  ["Sponsored Products", "Ad Group", "", "C3", "", "", "", "", "", ""],
  // 4: Product Ad chỉ có SKU (ASIN trống) → tra Danh mục
  ["Sponsored Products", "Campaign", "", "C4", "", "Campaign không đặt tên chuẩn", "", "", "", ""],
  ["Sponsored Products", "Product Ad", "", "C4", "", "", "", "", "SKU-MINE", ""]
];
const PF = [["Product", "Entity", "Operation", "Portfolio ID", "Portfolio Name"],
  ["Portfolios", "Portfolio", "", "P1", `${MINE} - pf`], ["Portfolios", "Portfolio", "", "P2", `${OTHER} - pf`],
  ["Portfolios", "Portfolio", "", "P3", "Portfolio chung không mã"], ["Portfolios", "Portfolio", "", "P9", "gán trong danh mục"]];
const ST = [["Product", "Campaign ID", "Campaign Name (Informational only)", "Customer Search Term"],
  ["Sponsored Products", "C1", "", "x"], ["Sponsored Products", "C2", "", "y"], ["Sponsored Products", "CX", `FBA - ${MINE} - đã xoá`, "z"]];
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(SP), "Sponsored Products Campaigns");
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(PF), "Portfolios");
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ST), "SP Search Term Report");
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Config", "giữ nguyên"]]), "Config");
const input = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

const { buffer, report } = filterBulk(input, { asins: [MINE, MINE2, "B0NOTHERE1"], skuToAsin: { "SKU-MINE": MINE }, portfolioIds: ["P9"] });
const out = XLSX.read(buffer, { type: "buffer" });
const rows = (n) => XLSX.utils.sheet_to_json(out.Sheets[n], { header: 1, defval: "" });

const sp = rows("Sponsored Products Campaigns");
const cids = [...new Set(sp.slice(1).map((r) => r[3]))];
t("giữ campaign có Product Ad của mình", cids.includes("C1"));
t("bỏ campaign người khác dù tên có ASIN mình ở cuối", !cids.includes("C2"));
t("giữ campaign không có Product Ad nhờ ASIN đầu tên", cids.includes("C3"));
t("giữ campaign nhờ tra SKU trong Danh mục", cids.includes("C4"));
t("giữ mọi dòng con của campaign", sp.length === 1 + 3 + 2 + 2, `${sp.length - 1} dòng`);
t("header giữ nguyên", sp[0].join("|") === SP[0].join("|"));
t("ký tự đặc biệt / tiếng Việt không hỏng", sp.some((r) => r[5] === `FBA - ${MINE} - SP - a & b <x>`) && sp.some((r) => r[9] === "café ornament"));

const pf = rows("Portfolios").slice(1).map((r) => r[3]);
t("portfolio: giữ theo tên, theo danh mục, portfolio chung chứa campaign giữ", ["P1", "P3", "P9"].every((x) => pf.includes(x)) && !pf.includes("P2"), pf.join(","));

const st = rows("SP Search Term Report").slice(1).map((r) => r[1]);
t("search term: theo campaign giữ + campaign không còn trong file thì theo tên", st.join(",") === "C1,CX", st.join(","));
t("sheet khác giữ nguyên", rows("Config")[0].join("|") === "Config|giữ nguyên");
t("báo ASIN của mình không có trong file", report.mineMissing.join() === "B0NOTHERE1");
t("đếm campaign giữ", report.campaigns.kept === 3 && report.campaigns.total === 4, JSON.stringify(report.campaigns));

let threw = "";
try { filterBulk(Buffer.from("không phải zip"), { asins: [MINE] }); } catch (e) { threw = e.message; }
t("file hỏng → báo lỗi dễ hiểu", /không phải \.xlsx/.test(threw), threw);

console.log(`${ok}/${ok + bad} đạt`);
process.exit(bad ? 1 : 0);
