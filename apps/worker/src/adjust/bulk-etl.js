// bulk-etl.js — Module ADJUST: ETL file bulk Amazon → bảng làm việc gọn + xuất file Update
//
// Thiết kế theo PPC-WARRIOR-ADJUST-KNOWLEDGE.md (đã chốt):
// - Kiến trúc 2 lớp: file gốc chỉ đọc 1 lần, lưu bảng GỌN (~20 trường) — 315k dòng × 54 cột
//   KHÔNG đưa thuần lên browser, mọi filter/phân trang chạy server-side
// - Chỉ giữ 4 entity điều chỉnh được: Campaign / Keyword / Product Targeting / Bidding Adjustment
// - Metrics tính lại từ số gốc (tránh lệch làm tròn), chuẩn hóa phẩy thập phân
// - Update: chỉ xuất dòng thay đổi, Operation=Update + ID thật + trường thay đổi
// - Negative Keyword: Entity "Negative Keyword" Operation=Create với ID thật (mẫu Negative Keyword.xlsx)

import * as XLSX from "xlsx";

export const num = (v) => {
  if (v === "" || v === null || v === undefined) return 0;
  const n = parseFloat(String(v).replace(",", "."));
  return isNaN(n) ? 0 : n;
};
export const r2 = (n) => Math.round(n * 100) / 100;
export const r4 = (n) => Math.round(n * 10000) / 10000;

// 6 entity chỉnh sửa được (user dùng bật/tắt cả Ad Group + Product Ad — không chỉ 4 như trước).
const KEEP_ENTITIES = new Set(["Campaign", "Ad Group", "Product Ad", "Keyword", "Product Targeting", "Bidding Adjustment"]);

/* ===== 3 loại ads: SP / SB / SD — mỗi loại 1 sheet riêng, header riêng =====
   SB: Amazon xuất 2 sheet — "Sponsored Brands Campaigns" (định dạng cũ) và "SB Multi Ad Group
   Campaigns" (định dạng mới). Sheet mới chứa TRỌN sheet cũ (đo file 14/07/2026: 388/388 campaign
   trùng, thêm Ad Group + Ad + Placement) → chỉ đọc 1 sheet, ưu tiên sheet mới, để khỏi đếm đôi. */
export const AD_TYPES = ["SP", "SB", "SD"];
export const AD_PRODUCT = { SP: "Sponsored Products", SB: "Sponsored Brands", SD: "Sponsored Display" };
const isSearchTerm = (n) => /search term/i.test(n);
const SHEET_PICK = {
  SP: (names) => names.find((n) => n === "Sponsored Products Campaigns")
    || names.find((n) => /^Sponsored Products/i.test(n) && !isSearchTerm(n)),
  SB: (names) => names.find((n) => /^SB Multi Ad Group/i.test(n))
    || names.find((n) => /^Sponsored Brands/i.test(n) && !isSearchTerm(n)),
  SD: (names) => names.find((n) => /^Sponsored Display/i.test(n) && !isSearchTerm(n))
};

/** Entity gốc của Amazon → entity chuẩn hoá mà UI/rule/export dùng chung.
    SP giữ nguyên. SB/SD: các loại Ad (Video Ad, Product Collection Ad, Brand Video Ad...) quy về
    "Product Ad" (chỉ bật/tắt), "Bidding Adjustment by Placement" → "Bidding Adjustment",
    SD "Audience/Contextual Targeting" → "Product Targeting" (bid + state). Tên gốc giữ ở `eo`
    để hiển thị và ghi đúng cột Entity khi xuất. Negative không giữ (chưa sửa trong Adjust). */
function normEntity(ad, ent) {
  if (ad === "SP") return KEEP_ENTITIES.has(ent) ? ent : null;
  if (/^Negative|Negative/.test(ent)) return null;
  if (["Campaign", "Ad Group", "Keyword", "Product Targeting"].includes(ent)) return ent;
  if (ad === "SB" && /^Bidding Adjustment/.test(ent)) return "Bidding Adjustment";
  if (ad === "SD" && /Targeting$/.test(ent)) return "Product Targeting";
  if (/Ad$/.test(ent)) return "Product Ad";
  return null;
}

/** Khóa duy nhất của 1 dòng entity (ID số là string — 15 chữ số, không để mất chính xác).
    Có adid để phân biệt nhiều Product Ad trong cùng Ad Group (camp multi-SKU).
    SB/SD có tiền tố "SB:"/"SD:"; SP KHÔNG có — giữ nguyên khoá cũ cho ledger/proposal đã lưu. */
export function rowKey(e) {
  const pre = e.ad && e.ad !== "SP" ? e.ad + ":" : "";
  return pre + [e.e, e.cid, e.agid, e.kid, e.tid, e.adid, e.pl].join("|");
}

/** Tính lại !ref theo ô thật của sheet dense. File bulk Amazon (từ ~10/2026) ghi
    <dimension ref="A1:BB1"/> dù có hàng chục nghìn dòng; SheetJS tin thẻ đó (chỉ bỏ qua
    khi ref thiếu dấu ":" như "A1" ở file cũ) → sheet_to_json chỉ trả mỗi dòng header. */
function fixDenseRef(sheet) {
  if (!sheet || !Array.isArray(sheet)) return;
  let maxC = 0;
  for (const row of sheet) if (row && row.length > maxC) maxC = row.length;
  if (sheet.length && maxC) sheet["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: sheet.length - 1, c: maxC - 1 } });
}

/** Đọc 1 sheet campaign (SP/SB/SD) → { header, total, records[] }. Tên cột khác nhau giữa
    các loại (Daily Budget ↔ Budget, Product Targeting ID ↔ Targeting ID...) → tra theo danh
    sách tên thay thế. */
function parseCampaignSheet(sheet, ad) {
  fixDenseRef(sheet);
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  if (!rows.length) return { header: [], total: 0, records: [] };
  const H = rows[0].map(String);
  const c = (...names) => { for (const n of names) { const i = H.indexOf(n); if (i !== -1) return i; } return -1; };
  const ix = {
    entity: c("Entity"), cid: c("Campaign ID"), agid: c("Ad Group ID"),
    kid: c("Keyword ID"), tid: c("Product Targeting ID", "Targeting ID"), adid: c("Ad ID"), sku: c("SKU"),
    name: c("Campaign Name (Informational only)", "Campaign Name"),
    agname: c("Ad Group Name (Informational only)", "Ad Group Name"), adname: c("Ad Name"),
    pfname: c("Portfolio Name (Informational only)"), pfid: c("Portfolio ID"), asin: c("ASIN (Informational only)"),
    casins: c("Creative ASINs"),
    state: c("State"), cstate: c("Campaign State (Informational only)"),
    bud: c("Daily Budget", "Budget"), agbid: c("Ad Group Default Bid"), bid: c("Bid"),
    sd: c("Start Date"), ed: c("End Date"),
    kw: c("Keyword Text"), mt: c("Match Type"),
    tt: c("Targeting Type"), tactic: c("Tactic"), cost: c("Cost Type"), fmt: c("Ad Format", "Creative Type"),
    bs: c("Bidding Strategy"), pl: c("Placement"), pct: c("Percentage"),
    ex: c("Product Targeting Expression", "Targeting Expression"),
    imp: c("Impressions"), clk: c("Clicks"), sp: c("Spend"), sa: c("Sales"),
    or: c("Orders"), un: c("Units")
  };
  if (ix.entity === -1 || ix.cid === -1) throw new Error(`Header sheet ${AD_PRODUCT[ad]} không khớp cấu trúc bulk chuẩn`);

  const records = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const g = (k) => (ix[k] === -1 ? "" : r[ix[k]]);
    const gs = (k) => String(g(k) ?? "");
    const eo = gs("entity");
    const entity = normEntity(ad, eo);
    if (!entity) continue;

    const imp = num(g("imp")), clk = num(g("clk")), sp = num(g("sp")),
      sa = num(g("sa")), or = num(g("or"));
    // SB ad: không có cột ASIN, chỉ có "Creative ASINs" — 1 ASIN thì nhận, nhiều thì để trống
    let asin = gs("asin");
    if (!asin && entity === "Product Ad") {
      const ca = gs("casins").split(/[,\s]+/).filter(Boolean);
      if (ca.length === 1) asin = ca[0];
    }
    const tt = ad === "SP" ? gs("tt")
      : ad === "SD" ? [gs("tactic"), gs("cost")].filter(Boolean).join(" · ")
      : gs("fmt");
    const rec = {
      e: entity,
      cid: gs("cid"), agid: gs("agid"),
      kid: gs("kid"), tid: gs("tid"),
      adid: gs("adid"), sku: entity === "Product Ad" ? (gs("sku") || gs("adname")) : "",
      name: gs("name"), agname: gs("agname"),
      pfname: gs("pfname"), pfid: gs("pfid"), asin,
      st: gs("state"), cst: gs("cstate"),
      bud: entity === "Campaign" ? num(g("bud")) : null,
      sd: entity === "Campaign" ? gs("sd") : "",
      ed: entity === "Campaign" ? gs("ed") : "",
      agbid: num(g("agbid")) || null,
      bid: (entity === "Keyword" || entity === "Product Targeting") ? num(g("bid")) : null,
      kw: gs("kw"), mt: gs("mt"),
      tt, bs: gs("bs"),
      pl: gs("pl"), pct: entity === "Bidding Adjustment" ? num(g("pct")) : null,
      ex: gs("ex"),
      imp, clk, sp: r2(sp), sa: r2(sa), or, un: num(g("un")),
      ctr: imp > 0 ? r4(clk / imp) : 0,
      cr: clk > 0 ? r4(or / clk) : 0,
      acos: sa > 0 ? r4(sp / sa) : null, // null = có spend không sales (∞) hoặc chưa có gì
      cpc: clk > 0 ? r2(sp / clk) : 0,
      roas: sp > 0 ? r2(sa / sp) : 0
    };
    if (ad !== "SP") { rec.ad = ad; if (eo !== entity) rec.eo = eo; }
    records.push(rec);
  }
  return { header: H, total: rows.length - 1, records };
}

/**
 * ETL file bulk (buffer) → dataset gọn. Đọc cả 3 sheet campaign SP / SB / SD (có sheet nào
 * đọc sheet đó — khi tải bulk, Amazon chỉ xuất loại được tick).
 * @returns {{ meta, header, headers, sheetNames, records[], terms[] }}
 *   header = header SP (giữ tên cũ cho code xuất Create/harvest); headers/sheetNames theo loại.
 */
export function etlBulk(buffer, filename) {
  const wb = XLSX.read(buffer, { type: "buffer", dense: true });
  const headers = {}, sheetNames = {}, byAd = {};
  const records = [];
  let totalRows = 0;
  for (const ad of AD_TYPES) {
    const name = SHEET_PICK[ad](wb.SheetNames);
    if (!name) continue;
    const out = parseCampaignSheet(wb.Sheets[name], ad);
    headers[ad] = out.header; sheetNames[ad] = name;
    byAd[ad] = { sheet: name, rows: out.total, kept: out.records.length };
    totalRows += out.total;
    for (const rec of out.records) records.push(rec);
  }
  if (!Object.keys(sheetNames).length)
    throw new Error('Không tìm thấy sheet "Sponsored Products / Sponsored Brands / Sponsored Display Campaigns" — có đúng file bulk Amazon?');
  if (!totalRows) throw new Error(`Các sheet ${Object.values(sheetNames).join(", ")} không có dòng dữ liệu nào`);

  /* ===== SP Search Term Report (nếu có khi tải bulk) ===== */
  const terms = [];
  const stSheet = wb.Sheets["SP Search Term Report"];
  if (stSheet) {
    fixDenseRef(stSheet);
    const st = XLSX.utils.sheet_to_json(stSheet, { header: 1, defval: "" });
    const h2 = st[0].map(String);
    const c2 = (n) => h2.findIndex((h) => h === n);
    const j = {
      cid: c2("Campaign ID"), agid: c2("Ad Group ID"),
      name: c2("Campaign Name (Informational only)"), agname: c2("Ad Group Name (Informational only)"),
      kw: c2("Keyword Text"), mt: c2("Match Type"),
      rex: c2("Resolved Product Targeting Expression (Informational only)"),
      term: c2("Customer Search Term"),
      imp: c2("Impressions"), clk: c2("Clicks"), sp: c2("Spend"), sa: c2("Sales"), or: c2("Orders")
    };
    for (let i = 1; i < st.length; i++) {
      const r = st[i];
      const term = String(r[j.term] || "");
      if (!term) continue;
      const imp = num(r[j.imp]), clk = num(r[j.clk]), sp = num(r[j.sp]),
        sa = num(r[j.sa]), or = num(r[j.or]);
      terms.push({
        cid: String(r[j.cid] || ""), agid: String(r[j.agid] || ""),
        name: String(r[j.name] || ""),
        targeting: String(r[j.kw] || "") || String(r[j.rex] || ""), // keyword camp: kw; auto camp: close-match...
        mt: String(r[j.mt] || ""),
        term,
        imp, clk, sp: r2(sp), sa: r2(sa), or,
        ctr: imp > 0 ? r4(clk / imp) : 0,
        cr: clk > 0 ? r4(or / clk) : 0,
        acos: sa > 0 ? r4(sp / sa) : null,
        cpc: clk > 0 ? r2(sp / clk) : 0
      });
    }
  }

  // Window từ tên file: bulk-{account}-{start}-{end}-{ts}.xlsx (quy tắc ETL đã chốt: date = [start, end))
  const m = String(filename).match(/(\d{8})-(\d{8})/);
  const stats = {};
  for (const r of records) stats[r.e] = (stats[r.e] || 0) + 1;

  return {
    meta: {
      filename,
      windowStart: m ? m[1] : null, windowEnd: m ? m[2] : null,
      importedAt: new Date().toISOString(),
      totalRows, kept: records.length, termCount: terms.length, stats, byAd,
      spend: r2(records.filter((r) => r.e === "Campaign").reduce((n, r) => n + r.sp, 0)),
      sales: r2(records.filter((r) => r.e === "Campaign").reduce((n, r) => n + r.sa, 0)),
      orders: records.filter((r) => r.e === "Campaign").reduce((n, r) => n + r.or, 0)
    },
    header: headers.SP || [], headers, sheetNames,
    records, terms
  };
}

/* ============================================================
   GẮN ASIN CHO MỌI DÒNG — qua Product Ad cùng ad group, không moi từ TÊN campaign
   ============================================================
   Chỉ dòng Product Ad mới mang sẵn SKU và ASIN; dòng Keyword/Product Targeting thì không.
   Trước đây Adjust moi ASIN từ TÊN campaign bằng mẫu B0xxxxxxxx. Cách đó hỏng ngay khi
   campaign gom nhiều sản phẩm (tên thành "ASINs - <portfolio>") hoặc khi ai đó đổi tên
   campaign — mà tên thì người ta đổi suốt, SKU thì không.
   Ba tầng, chính xác giảm dần: ad group → campaign → tên campaign (dự phòng cuối, giữ lại
   cho ad group rỗng không có Product Ad nào).
   Ad group nhiều sản phẩm → KHÔNG quy về một ASIN (ghi vào .asins), vì một campaign quảng
   cáo 5 ASIN thì không thuộc về ASIN nào cả; rule cần target ACoS theo ASIN sẽ bỏ qua. */
const asinFromCampName = (n) => (String(n || "").toUpperCase().match(/B0[A-Z0-9]{8}/) || [""])[0];

export function stampAsins(ds) {
  if (!ds || !Array.isArray(ds.records)) return ds;
  const byAg = new Map(), byCid = new Map();
  const add = (m, k, v) => { if (!k || !v) return; if (!m.has(k)) m.set(k, new Set()); m.get(k).add(v); };
  for (const r of ds.records) {
    if (r.e !== "Product Ad") continue;
    add(byAg, r.agid, r.asin); add(byCid, r.cid, r.asin);
  }
  const apply = (row) => {
    if (row.asin) return;
    const s = byAg.get(row.agid) || byCid.get(row.cid) || null;
    if (!s) { row.asin = asinFromCampName(row.name); return; }
    if (s.size === 1) row.asin = [...s][0];
    else row.asins = [...s]; // nhiều sản phẩm — để asin rỗng là CỐ Ý
  };
  for (const r of ds.records) apply(r);
  for (const t of ds.terms || []) apply(t);
  return ds;
}

/* ============================================================
   Query server-side: filter + sort + phân trang (dữ liệu lớn không đưa hết lên browser)
   ============================================================ */
export function queryRows(list, q = {}) {
  let out = list;
  const f = q.filters || {};

  if (f.q) {
    const s = String(f.q).toLowerCase();
    out = out.filter((r) =>
      (r.name && r.name.toLowerCase().includes(s)) ||
      (r.kw && r.kw.toLowerCase().includes(s)) ||
      (r.ex && r.ex.toLowerCase().includes(s)) ||
      (r.term && r.term.toLowerCase().includes(s)) ||
      (r.asin && r.asin.toLowerCase().includes(s)) ||
      (r.agname && r.agname.toLowerCase().includes(s)) ||
      (r.sku && r.sku.toLowerCase().includes(s)) ||
      (r.tt && r.tt.toLowerCase().includes(s)) ||
      (r.targeting && r.targeting.toLowerCase().includes(s)));
  }
  if (f.ad) out = out.filter((r) => (r.ad || "SP") === f.ad);
  if (f.entity) { const ents = Array.isArray(f.entity) ? f.entity : [f.entity]; if (ents.length) out = out.filter((r) => ents.includes(r.e)); }
  // Portfolio: gộp tên + ID. Portfolio chỉ có ở dòng Campaign → lọc cả cây campaign qua cid.
  if (f.portfolio) {
    const s = String(f.portfolio).toLowerCase();
    const okCids = new Set();
    const noPf = s === "__none__";
    for (const r of list) {
      if (r.e !== "Campaign") continue;
      const hit = noPf ? (!r.pfid && !r.pfname)
        : ((r.pfname && r.pfname.toLowerCase().includes(s)) || (r.pfid && String(r.pfid).toLowerCase().includes(s)));
      if (hit) okCids.add(r.cid);
    }
    out = out.filter((r) => okCids.has(r.cid));
  }
  if (f.matchType) out = out.filter((r) => (r.mt || "").toLowerCase() === f.matchType.toLowerCase());
  if (f.state) out = out.filter((r) => r.st === f.state);
  // Dòng "đã sửa" (đang chờ trong ledger + đã xuất gần đây — server ghép bộ khoá vào q.editedKeys)
  if (f.edited && q.editedKeys instanceof Set) {
    const ek = q.editedKeys;
    if (f.edited === "hide") out = out.filter((r) => !ek.has(rowKey(r)));
    else if (f.edited === "only") out = out.filter((r) => ek.has(rowKey(r)));
  }
  // Khoảng chỉ số: {metric: [min, max]} — '' = không giới hạn
  for (const [metric, range] of Object.entries(f.ranges || {})) {
    const [min, max] = range;
    out = out.filter((r) => {
      const v = r[metric];
      const val = v === null ? (metric === "acos" ? Infinity : 0) : v; // ACoS null (spend>0, sales=0) coi là ∞
      if (min !== "" && min !== null && val < Number(min)) return false;
      if (max !== "" && max !== null && val > Number(max)) return false;
      return true;
    });
  }

  const total = out.length;
  // Tổng hợp KHÔNG cộng dồn trùng cấp: chỉ cộng dòng Campaign (đã là tổng campaign).
  // Nếu tập lọc không có dòng Campaign (vd lọc riêng Keyword) → cộng chính tập đó (cùng cấp).
  const campRows = out.filter((r) => r.e === "Campaign");
  const aggBase = campRows.length ? campRows : out;
  const agg = aggBase.reduce((a, r) => {
    a.sp += r.sp; a.sa += r.sa; a.or += r.or; a.clk += r.clk; a.imp += r.imp;
    return a;
  }, { sp: 0, sa: 0, or: 0, clk: 0, imp: 0 });
  agg.sp = r2(agg.sp); agg.sa = r2(agg.sa);
  agg.acos = agg.sa > 0 ? r4(agg.sp / agg.sa) : null;
  agg.level = campRows.length ? "campaign" : "filtered"; // nhãn: tổng theo campaign hay theo tập lọc

  const sortF = q.sort || "grp";
  const dir = q.dir === "asc" ? 1 : -1;
  if (sortF === "grp") {
    // Nhóm theo campaign, thứ tự entity như file: Campaign → Bidding Adjustment → Ad Group → Product Ad → Keyword → Product Targeting
    const ER = { "Campaign": 0, "Bidding Adjustment": 1, "Ad Group": 2, "Product Ad": 3, "Keyword": 4, "Product Targeting": 5 };
    const campSpend = {};
    for (const r of out) if (r.e === "Campaign") campSpend[r.cid] = r.sp;
    out = out.slice().sort((a, b) => {
      if (a.cid !== b.cid) {
        const ga = campSpend[a.cid] ?? -1, gb = campSpend[b.cid] ?? -1; // campaign spend cao lên trước
        if (ga !== gb) return gb - ga;
        return a.cid < b.cid ? -1 : 1;
      }
      const ea = ER[a.e] ?? 9, eb = ER[b.e] ?? 9;
      if (ea !== eb) return ea - eb;
      return (b.sp || 0) - (a.sp || 0);
    });
  } else if (SORTABLE.has(sortF)) {
    // Ô trống (Bid của dòng Campaign, Budget của Keyword...) luôn nằm CUỐI dù tăng hay giảm.
    // ACoS null mà có spend = tiêu tiền không ra đơn → coi là ∞ (xếp như ACoS cao nhất).
    const val = (r) => {
      const v = r[sortF];
      if (v === null || v === undefined || v === "") return sortF === "acos" && r.sp > 0 ? Infinity : null;
      return typeof v === "string" ? v.toLowerCase() : v;
    };
    out = out.slice().sort((a, b) => {
      const av = val(a), bv = val(b);
      if (av === null || bv === null) return av === bv ? 0 : av === null ? 1 : -1;
      return av < bv ? -dir : av > bv ? dir : 0;
    });
  }

  const pageSize = Math.min(500, q.pageSize || 100);
  const page = Math.max(1, q.page || 1);
  return { total, agg, page, pageSize, rows: out.slice((page - 1) * pageSize, page * pageSize) };
}

/** Cột được phép sắp xếp (bấm tiêu đề cột) — chặn sort theo khoá lạ. */
const SORTABLE = new Set(["name", "e", "st", "bud", "bid", "agbid", "pct",
  "imp", "clk", "sp", "sa", "or", "acos", "roas", "ctr", "cr", "cpc"]);

/** Danh sách portfolio (tên + ID) từ dòng Campaign — cho dropdown filter. */
export function listPortfolios(records) {
  const map = new Map();
  let none = 0;
  for (const r of records || []) {
    if (r.e !== "Campaign") continue;
    if (!r.pfid && !r.pfname) { none++; continue; }
    const key = r.pfid || r.pfname;
    if (!map.has(key)) map.set(key, { pfid: r.pfid, pfname: r.pfname, count: 0 });
    map.get(key).count++;
  }
  return { portfolios: [...map.values()].sort((a, b) => b.count - a.count), none };
}

/* ============================================================
   Search Term GOM NHÓM: theo (ASIN) → search term → occurrences (ad group).
   Mỗi group: tổng chỉ số của term; children = từng dòng ad group/campaign của term đó.
   ============================================================ */
// ASIN của 1 dòng search term: ưu tiên cái stampAsins() đã nối qua ad group; tên campaign
// chỉ là dự phòng (campaign nhiều ASIN không có mã nào trong tên).
const asinFromName = (name) => { const m = String(name || "").toUpperCase().match(/B0[A-Z0-9]{8}/); return m ? m[0] : ""; };
const asinOfTerm = (r) => r.asin || asinFromName(r.name);

export function groupTerms(terms, q = {}) {
  const f = q.filters || {};
  let list = terms || [];
  if (f.q) {
    const s = String(f.q).toLowerCase();
    list = list.filter((r) =>
      (r.term && r.term.toLowerCase().includes(s)) ||
      (r.name && r.name.toLowerCase().includes(s)) ||
      (r.targeting && r.targeting.toLowerCase().includes(s)));
  }
  if (f.asin) { const a = String(f.asin).toUpperCase(); list = list.filter((r) => asinOfTerm(r) === a); }

  // Gom theo (asin | term) — "tổng của keyword đó đối với 1 ASIN"
  const map = new Map();
  for (const r of list) {
    const asin = asinOfTerm(r);
    const key = asin + "|" + r.term;
    if (!map.has(key)) map.set(key, { term: r.term, asin, children: [], sp: 0, sa: 0, or: 0, clk: 0, imp: 0 });
    const g = map.get(key);
    g.children.push({ ...r, asin, roas: r.sp > 0 ? r2(r.sa / r.sp) : 0 });
    g.sp += r.sp; g.sa += r.sa; g.or += r.or; g.clk += r.clk; g.imp += r.imp;
  }
  let groups = [...map.values()].map((g) => ({
    term: g.term, asin: g.asin, count: g.children.length,
    imp: g.imp, clk: g.clk, sp: r2(g.sp), sa: r2(g.sa), or: g.or,
    ctr: g.imp > 0 ? r4(g.clk / g.imp) : 0, cr: g.clk > 0 ? r4(g.or / g.clk) : 0,
    acos: g.sa > 0 ? r4(g.sp / g.sa) : null, roas: g.sp > 0 ? r2(g.sa / g.sp) : 0,
    cpc: g.clk > 0 ? r2(g.sp / g.clk) : 0,
    children: g.children.sort((a, b) => b.sp - a.sp)
  }));

  // Tổng theo ASIN (dòng header ASIN đứng đầu mỗi cụm)
  const at = {};
  for (const g of groups) { const a = g.asin || ""; at[a] = at[a] || { sp: 0, sa: 0, or: 0, clk: 0, imp: 0, terms: 0 }; const t = at[a]; t.sp += g.sp; t.sa += g.sa; t.or += g.or; t.clk += g.clk; t.imp += g.imp; t.terms++; }
  const asinTotals = {};
  for (const [a, t] of Object.entries(at)) asinTotals[a] = { sp: r2(t.sp), sa: r2(t.sa), or: t.or, clk: t.clk, imp: t.imp, terms: t.terms, ctr: t.imp > 0 ? r4(t.clk / t.imp) : 0, cr: t.clk > 0 ? r4(t.or / t.clk) : 0, acos: t.sa > 0 ? r4(t.sp / t.sa) : null, roas: t.sp > 0 ? r2(t.sa / t.sp) : 0, cpc: t.clk > 0 ? r2(t.sp / t.clk) : 0 };

  const agg = groups.reduce((a, g) => { a.sp += g.sp; a.sa += g.sa; a.or += g.or; a.clk += g.clk; a.imp += g.imp; return a; }, { sp: 0, sa: 0, or: 0, clk: 0, imp: 0 });
  agg.sp = r2(agg.sp); agg.sa = r2(agg.sa); agg.acos = agg.sa > 0 ? r4(agg.sp / agg.sa) : null; agg.level = "filtered";

  const total = groups.length;
  const VALID = ["sp", "sa", "or", "clk", "imp", "acos", "ctr", "cr", "roas", "cpc"];
  const sortF = VALID.includes(q.sort) ? q.sort : "sp";
  const dir = q.dir === "asc" ? 1 : -1;
  // Cụm theo ASIN (ASIN spend cao lên đầu), trong mỗi ASIN sort theo metric chọn
  groups.sort((a, b) => {
    const aa = a.asin || "", ba = b.asin || "";
    if (aa !== ba) { const sa = asinTotals[aa]?.sp ?? -1, sb = asinTotals[ba]?.sp ?? -1; if (sa !== sb) return sb - sa; return aa < ba ? -1 : 1; }
    const av = a[sortF] === null ? -Infinity : (a[sortF] || 0);
    const bv = b[sortF] === null ? -Infinity : (b[sortF] || 0);
    return av < bv ? -dir : av > bv ? dir : 0;
  });
  const pageSize = Math.min(200, q.pageSize || 60);
  const page = Math.max(1, q.page || 1);
  return { total, agg, asinTotals, page, pageSize, groups: groups.slice((page - 1) * pageSize, page * pageSize) };
}

/* ============================================================
   Xuất file UPDATE: chỉ dòng thay đổi + dòng Negative Keyword mới
   ============================================================ */
const FIELD_TO_COL = {
  bud: "Daily Budget", bid: "Bid", st: "State", bs: "Bidding Strategy",
  pct: "Percentage", agbid: "Ad Group Default Bid",
  name: "Campaign Name",   // đổi tên campaign
  agname: "Ad Group Name"  // đổi tên ad group
};
// SB/SD: budget nằm ở cột "Budget"; SB không có Ad Group Default Bid / Bidding Strategy
const FIELD_TO_COL_AD = {
  SP: FIELD_TO_COL,
  SB: { ...FIELD_TO_COL, bud: "Budget", bs: null, agbid: null },
  SD: { ...FIELD_TO_COL, bud: "Budget", bs: null, pct: null }
};

/**
 * Dòng Update cho 1 loại ads (mặc định SP — giữ tương thích lời gọi cũ).
 * Chỉ lấy edit của record cùng loại; negative chỉ áp cho SP (search term chỉ có ở SP).
 */
export function buildUpdateRows(header, recordsByKey, edits, negatives, ad = "SP") {
  const emptyRow = () => Object.fromEntries(header.map((h) => [h, ""]));
  const has = new Set(header);
  const rows = [];

  // Gom edits theo dòng (1 dòng nhiều trường đổi → 1 dòng Update duy nhất)
  const byRow = new Map();
  for (const ed of edits || []) {
    if (!byRow.has(ed.k)) byRow.set(ed.k, {});
    byRow.get(ed.k)[ed.field] = ed.value;
  }

  for (const [k, fields] of byRow) {
    const rec = recordsByKey.get(k);
    if (!rec || (rec.ad || "SP") !== ad) continue;
    const row = emptyRow();
    const set = (col, v) => { if (col && has.has(col)) row[col] = v; };
    row["Product"] = AD_PRODUCT[ad];
    row["Entity"] = rec.eo || rec.e; // SB/SD: ghi lại đúng tên entity gốc (Video Ad, Audience Targeting...)
    row["Operation"] = "Update";
    row["Campaign ID"] = rec.cid;
    if (rec.agid) set("Ad Group ID", rec.agid);
    if (rec.kid) set("Keyword ID", rec.kid);
    if (rec.tid) set(has.has("Product Targeting ID") ? "Product Targeting ID" : "Targeting ID", rec.tid);
    if (rec.adid) set("Ad ID", rec.adid);
    // Placement giữ NGUYÊN chuỗi đầy đủ từ file ("Placement Top"/"Placement Rest Of Search"/
    // "Placement Product Page"/"Placement Amazon Business") — KHÔNG map camelCase (xác minh Book2.xlsx).
    // SB: "Top of Search"/"Detail Page"/"Home"/"Other" — cũng giữ nguyên.
    if (rec.e === "Bidding Adjustment") set("Placement", rec.pl);

    if (ad === "SP") {
      // ⚠️ REQUIRED HEADERS khi Update (sheet Config trong chính file bulk Amazon, xác minh 18/07/2026):
      // - Campaign: Campaign Id, Campaign Name, Daily Budget, State, Start Date, Bidding Strategy
      //   (PHẢI có đủ dù không đổi — thiếu là Amazon từ chối dòng)
      // - Ad Group: Ad Group Id, Ad Group Name, Ad Group Default Bid, State
      // - Product Ad: Campaign Id, Ad Group Id, Ad ID, State (+ SKU)
      // - Keyword / Product Targeting: Id + State (Bid optional)
      // - Bidding Adjustment: Campaign Id + Placement (Percentage optional)
      // → điền giá trị HIỆN TẠI cho trường required, rồi đè bằng giá trị user sửa
      if (rec.e === "Campaign") {
        row["Campaign Name"] = rec.name || "";
        row["Daily Budget"] = rec.bud ?? "";
        row["State"] = rec.st || "enabled";
        row["Start Date"] = rec.sd || "";
        row["Bidding Strategy"] = rec.bs || "";
      } else if (rec.e === "Ad Group") {
        row["Ad Group Name"] = rec.agname || "";
        row["Ad Group Default Bid"] = rec.agbid ?? "";
        row["State"] = rec.st || "enabled";
      } else if (rec.e === "Product Ad") {
        row["State"] = rec.st || "enabled";
        if (rec.sku) row["SKU"] = rec.sku;
      } else if (rec.e === "Keyword" || rec.e === "Product Targeting") {
        row["State"] = rec.st || "enabled";
      }
    } else if (rec.e !== "Bidding Adjustment") {
      // SB/SD: file Config KHÔNG có bảng required headers cho 2 loại này → ghi tối thiểu:
      // ID + State hiện tại (+ Budget hiện tại với Campaign) rồi đè trường user sửa.
      set("State", rec.st || "enabled");
      if (rec.e === "Campaign") set("Budget", rec.bud ?? "");
    }

    const map = FIELD_TO_COL_AD[ad] || FIELD_TO_COL;
    for (const [f, v] of Object.entries(fields)) set(map[f], v);
    rows.push(row);
  }
  if (ad !== "SP") return rows;

  // Negative Keyword mới (Create, ID thật — pattern Negative Keyword.xlsx)
  for (const ng of negatives || []) {
    const row = emptyRow();
    row["Product"] = "Sponsored Products";
    row["Entity"] = "Negative Keyword";
    row["Operation"] = "Create";
    row["Campaign ID"] = ng.cid;
    row["Ad Group ID"] = ng.agid;
    row["State"] = "enabled";
    row["Keyword Text"] = ng.term;
    row["Match Type"] = ng.mt === "negativePhrase" ? "negativePhrase" : "negativeExact";
    rows.push(row);
  }

  return rows;
}
