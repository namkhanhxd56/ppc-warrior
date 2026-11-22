/* bulk-filter.js — LỌC FILE BULK THEO ASIN MÌNH QUẢN LÝ (22/11/2026)
   File bulk Amazon tải về chứa campaign của MỌI người trong acc. Trước khi chỉnh hàng loạt,
   người dùng muốn file chỉ còn ASIN của mình. Tool giữ nguyên cấu trúc file (thứ tự sheet,
   header, kiểu ô — copy thẳng object ô, không dựng lại) và chỉ BỎ DÒNG:

   1. Sheet campaign (có cột Entity + Campaign ID: SP, SB, SB Multi, SD):
      gom theo Campaign ID → ASIN của campaign, theo thứ tự tin cậy:
        a) ASIN/SKU ở dòng Product Ad (+ Creative/Landing Page ASINs của SB)  — chắc chắn nhất
        b) mã B0… ĐẦU TIÊN trong TÊN campaign (quy ước đặt tên "FBA - B0XXXX - SP - …")
        c) mã B0… trong tên portfolio / Portfolio ID đã gán trong Danh mục
      Giữ cả campaign (mọi dòng con) nếu có ≥1 ASIN mình quản lý. Campaign nhiều ASIN mà
      chỉ một phần là của mình vẫn giữ trọn — không thể chỉnh nửa campaign.
   2. Portfolios: giữ nếu tên chứa ASIN của mình, hoặc ID nằm trong portfolio đã gán ở
      Danh mục, hoặc (tên không có mã ASIN nào) và đang chứa campaign được giữ.
   3. Search Term Report (có cột Customer Search Term): giữ nếu Campaign ID thuộc campaign
      được giữ; campaign không có trong file thì dò mã B0… trong tên campaign/portfolio.
   Sheet khác (Config, Brand Assets, SP_COLUMN_IDS, sheet rỗng…) giữ nguyên. */
import * as XLSX from "xlsx";

const ASIN_RE = /\bB0[A-Z0-9]{8}\b/g;
const asinsIn = (s) => (String(s ?? "").toUpperCase().match(ASIN_RE) || []);
// Tên campaign/portfolio: CHỈ lấy mã ĐẦU TIÊN — vị trí ASIN chủ theo quy ước "FBA - B0XXXX - SP - …".
// Campaign PT có thêm ASIN đối thủ ở cuối tên ("… - ASIN - 20261028 - Chung - B0GVDJBCXB - …"),
// lấy hết thì campaign người khác target ASIN của mình cũng bị giữ nhầm.
const ownerIn = (s) => asinsIn(s).slice(0, 1);

function fixDenseRef(sheet) {
  if (!Array.isArray(sheet)) return;
  let maxC = 0;
  for (const row of sheet) if (row && row.length > maxC) maxC = row.length;
  if (sheet.length && maxC) sheet["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: sheet.length - 1, c: maxC - 1 } });
}
const cellStr = (row, i) => (i < 0 || !row || !row[i] ? "" : String(row[i].w ?? row[i].v ?? "").trim());
const headerOf = (sheet) => (sheet[0] || []).map((c) => String(c?.v ?? "").trim());
const colIx = (H, ...names) => { for (const n of names) { const i = H.indexOf(n); if (i !== -1) return i; } return -1; };

/** Dựng sheet mới từ header + các dòng giữ lại (giữ nguyên object ô + độ rộng cột). */
function rebuild(sheet, keep) {
  const out = [sheet[0], ...keep];
  for (const k of ["!cols", "!autofilter", "!views"]) if (sheet[k]) out[k] = sheet[k];
  fixDenseRef(out);
  if (!out["!ref"]) out["!ref"] = sheet["!ref"];
  return out;
}

/**
 * @param buffer   file .xlsx
 * @param opts.asins        ASIN mình quản lý (mảng chuỗi)
 * @param opts.skuToAsin    { SKU: ASIN } từ Danh mục — dòng Product Ad thiếu ASIN thì tra SKU
 * @param opts.portfolioIds Portfolio ID đã gán cho các ASIN đó trong Danh mục
 * @returns { buffer, report }
 */
export function filterBulk(buffer, { asins = [], skuToAsin = {}, portfolioIds = [] } = {}) {
  const mine = new Set(asins.map((a) => String(a).trim().toUpperCase()).filter((a) => /^[A-Z0-9]{10}$/.test(a)));
  if (!mine.size) throw new Error("Chưa có ASIN nào để giữ lại");
  const skuMap = new Map(Object.entries(skuToAsin).map(([k, v]) => [String(k).trim().toUpperCase(), String(v).toUpperCase()]));
  const myPf = new Set(portfolioIds.map((x) => String(x).trim()).filter(Boolean));

  const wb = XLSX.read(buffer, { type: "buffer", dense: true, cellStyles: true });
  const sheets = wb.SheetNames.map((name) => {
    const sh = wb.Sheets[name];
    if (Array.isArray(sh)) fixDenseRef(sh); // file 10/2026 khai dimension sai (A1:BB1) → tính lại
    return { name, sh, H: Array.isArray(sh) ? headerOf(sh) : [] };
  });
  const isCampaign = (s) => s.H.includes("Entity") && s.H.includes("Campaign ID");
  const isSearchTerm = (s) => s.H.includes("Customer Search Term") && s.H.includes("Campaign ID");
  const isPortfolio = (s) => s.H.includes("Portfolio ID") && s.H.includes("Portfolio Name") && !s.H.includes("Campaign ID");

  // ---- Bước 1: ASIN của từng campaign (qua mọi sheet campaign) ----
  const camp = new Map(); // cid → { ad:Set, name:Set, pf:Set, pfid }
  const seenAsins = new Map(); // ASIN thấy trong file → số campaign (để báo ASIN lạ)
  const C = (cid) => { let c = camp.get(cid); if (!c) camp.set(cid, (c = { ad: new Set(), name: new Set(), pf: new Set(), pfid: "" })); return c; };
  for (const s of sheets.filter(isCampaign)) {
    const H = s.H;
    const ix = {
      ent: colIx(H, "Entity"), cid: colIx(H, "Campaign ID"), pfid: colIx(H, "Portfolio ID"),
      asin: colIx(H, "ASIN (Informational only)"), sku: colIx(H, "SKU"),
      cas: colIx(H, "Creative ASINs"), lpa: colIx(H, "Landing Page ASINs"),
      name: colIx(H, "Campaign Name (Informational only)", "Campaign Name"), name2: colIx(H, "Campaign Name"),
      pf: colIx(H, "Portfolio Name (Informational only)")
    };
    for (let r = 1; r < s.sh.length; r++) {
      const row = s.sh[r]; const cid = cellStr(row, ix.cid);
      if (!cid) continue;
      const c = C(cid);
      const ent = cellStr(row, ix.ent);
      if (ent === "Campaign") {
        for (const a of ownerIn(cellStr(row, ix.name) || cellStr(row, ix.name2))) c.name.add(a);
        for (const a of ownerIn(cellStr(row, ix.pf))) c.pf.add(a);
        c.pfid = cellStr(row, ix.pfid) || c.pfid;
      }
      // Product Ad (SP/SD) + mọi dòng có Creative/Landing ASINs (SB)
      for (const a of asinsIn(cellStr(row, ix.asin) + " " + cellStr(row, ix.cas) + " " + cellStr(row, ix.lpa))) c.ad.add(a);
      if (/Product Ad/i.test(ent)) {
        const viaSku = skuMap.get(cellStr(row, ix.sku).toUpperCase());
        if (viaSku) c.ad.add(viaSku);
      }
      if (!c.name.size && ix.name !== -1) for (const a of ownerIn(cellStr(row, ix.name))) c.name.add(a);
      if (!c.pf.size && ix.pf !== -1) for (const a of ownerIn(cellStr(row, ix.pf))) c.pf.add(a);
      if (!c.pfid) c.pfid = cellStr(row, ix.pfid);
    }
  }
  const keepCamp = new Set();
  const campReason = { ad: 0, name: 0, pf: 0 };
  for (const [cid, c] of camp) {
    const own = c.ad.size ? c.ad : c.name.size ? c.name : c.pf;
    for (const a of own) seenAsins.set(a, (seenAsins.get(a) || 0) + 1);
    let why = "";
    if (c.ad.size) { if ([...c.ad].some((a) => mine.has(a))) why = "ad"; }
    else if (c.name.size) { if ([...c.name].some((a) => mine.has(a))) why = "name"; }
    else if ([...c.pf].some((a) => mine.has(a)) || (c.pfid && myPf.has(c.pfid))) why = "pf";
    if (why) { keepCamp.add(cid); campReason[why]++; }
  }
  const keptPf = new Set([...keepCamp].map((cid) => camp.get(cid).pfid).filter(Boolean));

  // ---- Bước 2: lọc từng sheet ----
  const report = { sheets: [], campaigns: { total: camp.size, kept: keepCamp.size, by: campReason } };
  for (const s of sheets) {
    if (!Array.isArray(s.sh) || s.sh.length <= 1) continue;
    const H = s.H, before = s.sh.length - 1;
    let keep = null, kind = "";
    if (isCampaign(s)) {
      kind = "campaign";
      const ci = colIx(H, "Campaign ID");
      keep = s.sh.slice(1).filter((row) => keepCamp.has(cellStr(row, ci)));
    } else if (isSearchTerm(s)) {
      kind = "searchterm";
      const ci = colIx(H, "Campaign ID");
      const ni = colIx(H, "Campaign Name (Informational only)", "Campaign Name");
      const pi = colIx(H, "Portfolio Name (Informational only)");
      keep = s.sh.slice(1).filter((row) => {
        const cid = cellStr(row, ci);
        if (camp.has(cid)) return keepCamp.has(cid);
        const own = ownerIn(cellStr(row, ni)); // campaign không có trong file → dò theo tên
        return (own.length ? own : ownerIn(cellStr(row, pi))).some((a) => mine.has(a));
      });
    } else if (isPortfolio(s)) {
      kind = "portfolio";
      const ii = colIx(H, "Portfolio ID"), ni = colIx(H, "Portfolio Name");
      keep = s.sh.slice(1).filter((row) => {
        const id = cellStr(row, ii), inName = ownerIn(cellStr(row, ni));
        if (inName.some((a) => mine.has(a)) || myPf.has(id)) return true;
        return !inName.length && keptPf.has(id);
      });
    } else continue;
    wb.Sheets[s.name] = rebuild(s.sh, keep);
    report.sheets.push({ name: s.name, kind, before, after: keep.length });
  }

  report.mine = mine.size;
  report.mineFound = [...mine].filter((a) => seenAsins.has(a)).length;
  report.mineMissing = [...mine].filter((a) => !seenAsins.has(a)).sort();
  report.othersRemoved = [...seenAsins.entries()].filter(([a]) => !mine.has(a)).length;

  const out = XLSX.write(wb, { type: "buffer", bookType: "xlsx", compression: true, cellStyles: true });
  return { buffer: out, report };
}
