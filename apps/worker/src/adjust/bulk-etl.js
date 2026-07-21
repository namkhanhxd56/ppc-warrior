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

/** Khóa duy nhất của 1 dòng entity (ID số là string — 15 chữ số, không để mất chính xác).
    Có adid để phân biệt nhiều Product Ad trong cùng Ad Group (camp multi-SKU). */
export function rowKey(e) {
  return [e.e, e.cid, e.agid, e.kid, e.tid, e.adid, e.pl].join("|");
}

/**
 * ETL file bulk (buffer) → dataset gọn.
 * @returns {{ meta, header, records[], terms[] }}
 */
export function etlBulk(buffer, filename) {
  const wb = XLSX.read(buffer, { type: "buffer", dense: true });
  const sheet = wb.Sheets["Sponsored Products Campaigns"];
  if (!sheet) throw new Error('Không tìm thấy sheet "Sponsored Products Campaigns" — có đúng file bulk Amazon?');

  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  const H = rows[0].map(String);
  const c = (name) => H.findIndex((h) => h === name);
  const ix = {
    entity: c("Entity"), cid: c("Campaign ID"), agid: c("Ad Group ID"),
    kid: c("Keyword ID"), tid: c("Product Targeting ID"), adid: c("Ad ID"), sku: c("SKU"),
    name: c("Campaign Name (Informational only)"), agname: c("Ad Group Name (Informational only)"),
    pfname: c("Portfolio Name (Informational only)"), asin: c("ASIN (Informational only)"),
    state: c("State"), cstate: c("Campaign State (Informational only)"),
    bud: c("Daily Budget"), agbid: c("Ad Group Default Bid"), bid: c("Bid"),
    sd: c("Start Date"),
    kw: c("Keyword Text"), mt: c("Match Type"), tt: c("Targeting Type"),
    bs: c("Bidding Strategy"), pl: c("Placement"), pct: c("Percentage"),
    ex: c("Product Targeting Expression"), ed: c("End Date"),
    imp: c("Impressions"), clk: c("Clicks"), sp: c("Spend"), sa: c("Sales"),
    or: c("Orders"), un: c("Units")
  };
  if (ix.entity === -1 || ix.cid === -1) throw new Error("Header không khớp cấu trúc bulk chuẩn");

  const records = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const entity = String(r[ix.entity] || "");
    if (!KEEP_ENTITIES.has(entity)) continue;

    const imp = num(r[ix.imp]), clk = num(r[ix.clk]), sp = num(r[ix.sp]),
      sa = num(r[ix.sa]), or = num(r[ix.or]);
    records.push({
      e: entity,
      cid: String(r[ix.cid] || ""), agid: String(r[ix.agid] || ""),
      kid: String(r[ix.kid] || ""), tid: String(r[ix.tid] || ""),
      adid: String(r[ix.adid] || ""), sku: entity === "Product Ad" ? String(r[ix.sku] || "") : "",
      name: String(r[ix.name] || ""), agname: String(r[ix.agname] || ""),
      pfname: String(r[ix.pfname] || ""), asin: String(r[ix.asin] || ""),
      st: String(r[ix.state] || ""), cst: String(r[ix.cstate] || ""),
      bud: entity === "Campaign" ? num(r[ix.bud]) : null,
      sd: entity === "Campaign" ? String(r[ix.sd] || "") : "",
      ed: entity === "Campaign" ? String(r[ix.ed] || "") : "",
      agbid: num(r[ix.agbid]) || null,
      bid: (entity === "Keyword" || entity === "Product Targeting") ? num(r[ix.bid]) : null,
      kw: String(r[ix.kw] || ""), mt: String(r[ix.mt] || ""),
      tt: String(r[ix.tt] || ""), bs: String(r[ix.bs] || ""),
      pl: String(r[ix.pl] || ""), pct: entity === "Bidding Adjustment" ? num(r[ix.pct]) : null,
      ex: String(r[ix.ex] || ""),
      imp, clk, sp: r2(sp), sa: r2(sa), or, un: num(r[ix.un]),
      ctr: imp > 0 ? r4(clk / imp) : 0,
      cr: clk > 0 ? r4(or / clk) : 0,
      acos: sa > 0 ? r4(sp / sa) : null, // null = có spend không sales (∞) hoặc chưa có gì
      cpc: clk > 0 ? r2(sp / clk) : 0,
      roas: sp > 0 ? r2(sa / sp) : 0
    });
  }

  /* ===== SP Search Term Report (nếu có khi tải bulk) ===== */
  const terms = [];
  const stSheet = wb.Sheets["SP Search Term Report"];
  if (stSheet) {
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
      totalRows: rows.length - 1, kept: records.length, termCount: terms.length, stats,
      spend: r2(records.filter((r) => r.e === "Campaign").reduce((n, r) => n + r.sp, 0)),
      sales: r2(records.filter((r) => r.e === "Campaign").reduce((n, r) => n + r.sa, 0)),
      orders: records.filter((r) => r.e === "Campaign").reduce((n, r) => n + r.or, 0)
    },
    header: H,
    records, terms
  };
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
  if (f.entity) out = out.filter((r) => r.e === f.entity);
  if (f.matchType) out = out.filter((r) => (r.mt || "").toLowerCase() === f.matchType.toLowerCase());
  if (f.state) out = out.filter((r) => r.st === f.state);
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
  } else {
    out = out.slice().sort((a, b) => {
      const av = a[sortF] === null ? -Infinity : a[sortF];
      const bv = b[sortF] === null ? -Infinity : b[sortF];
      return av < bv ? -dir : av > bv ? dir : 0;
    });
  }

  const pageSize = Math.min(500, q.pageSize || 100);
  const page = Math.max(1, q.page || 1);
  return { total, agg, page, pageSize, rows: out.slice((page - 1) * pageSize, page * pageSize) };
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

export function buildUpdateRows(header, recordsByKey, edits, negatives) {
  const emptyRow = () => Object.fromEntries(header.map((h) => [h, ""]));
  const rows = [];

  // Gom edits theo dòng (1 dòng nhiều trường đổi → 1 dòng Update duy nhất)
  const byRow = new Map();
  for (const ed of edits || []) {
    if (!byRow.has(ed.k)) byRow.set(ed.k, {});
    byRow.get(ed.k)[ed.field] = ed.value;
  }

  for (const [k, fields] of byRow) {
    const rec = recordsByKey.get(k);
    if (!rec) continue;
    const row = emptyRow();
    row["Product"] = "Sponsored Products";
    row["Entity"] = rec.e;
    row["Operation"] = "Update";
    row["Campaign ID"] = rec.cid;
    if (rec.agid) row["Ad Group ID"] = rec.agid;
    if (rec.kid) row["Keyword ID"] = rec.kid;
    if (rec.tid) row["Product Targeting ID"] = rec.tid;
    if (rec.adid) row["Ad ID"] = rec.adid;
    // Placement giữ NGUYÊN chuỗi đầy đủ từ file ("Placement Top"/"Placement Rest Of Search"/
    // "Placement Product Page"/"Placement Amazon Business") — KHÔNG map camelCase (xác minh Book2.xlsx).
    if (rec.e === "Bidding Adjustment") row["Placement"] = rec.pl;

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

    for (const [f, v] of Object.entries(fields)) {
      const colName = FIELD_TO_COL[f];
      if (colName) row[colName] = v;
    }
    rows.push(row);
  }

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
