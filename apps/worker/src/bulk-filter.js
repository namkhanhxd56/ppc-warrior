/* bulk-filter.js — LỌC FILE BULK THEO ASIN MÌNH QUẢN LÝ (22/11/2026, viết lại 23/11/2026)
   File bulk Amazon tải về chứa campaign của MỌI người trong acc. Trước khi chỉnh hàng loạt,
   người dùng muốn file chỉ còn ASIN của mình. Tool chỉ BỎ DÒNG, mọi thứ khác giữ nguyên:

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
   Sheet khác (Config, Brand Assets, SP_COLUMN_IDS, sheet rỗng…) giữ nguyên từng byte.

   VÌ SAO KHÔNG DÙNG SheetJS: file bulk 21MB = 285MB XML; SheetJS nạp cả workbook thành object
   ô → cần >1,5GB heap, server Railway hết RAM, tự khởi động lại giữa chừng (người dùng thấy
   "file đã hết hạn", lọc lại cũng hỏng). SheetJS còn làm rơi dropdown (dataValidations) và
   định dạng có điều kiện của Amazon. Giờ đọc thẳng XML trong zip theo từng <row>:
   - lượt 1 đọc vài cột cần thiết của mỗi dòng → quyết định giữ/bỏ;
   - lượt 2 chép nguyên văn XML các dòng giữ lại (đánh số dòng lại cho liền) vào zip mới.
   Bộ nhớ ≈ dung lượng XML của sheet lớn nhất (Buffer ngoài heap), không phụ thuộc số ô. */
import zlib from "zlib";
import { StringDecoder } from "string_decoder";
import { readZip, writeZip, crc32 } from "./xlsx-zip.js";

const ASIN_RE = /\bB0[A-Z0-9]{8}\b/g;
const asinsIn = (s) => (String(s ?? "").toUpperCase().match(ASIN_RE) || []);
// Tên campaign/portfolio: CHỈ lấy mã ĐẦU TIÊN — vị trí ASIN chủ theo quy ước "FBA - B0XXXX - SP - …".
// Campaign PT có thêm ASIN đối thủ ở cuối tên ("… - ASIN - 20261028 - Chung - B0GVDJBCXB - …"),
// lấy hết thì campaign người khác target ASIN của mình cũng bị giữ nhầm.
const ownerIn = (s) => asinsIn(s).slice(0, 1);
const colIx = (H, ...names) => { for (const n of names) { const i = H.indexOf(n); if (i !== -1) return i; } return -1; };

/* ===== XML ===== */
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unesc = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) =>
  e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()]);
const textOf = (xml) => { let out = ""; for (const m of xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) out += m[1]; return unesc(out); };
const colNum = (ref) => { let n = 0; for (const ch of ref) { const c = ch.charCodeAt(0); if (c < 65 || c > 90) break; n = n * 26 + c - 64; } return n - 1; };
const colName = (n) => { let s = ""; for (n++; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

/** Giá trị các cột cần đọc của 1 <row> (wanted: Set chỉ số cột, null = mọi cột). */
function rowValues(rowXml, sst, wanted) {
  const vals = [];
  let col = -1;
  for (const m of rowXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = m[1];
    const r = attrs.match(/\br="([A-Z]+)\d*"/);
    col = r ? colNum(r[1]) : col + 1;
    if (wanted && !wanted.has(col)) continue;
    const body = m[2] || "";
    const t = (attrs.match(/\bt="([^"]*)"/) || [])[1] || "";
    let v;
    if (t === "inlineStr") v = textOf(body);
    else {
      const raw = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      v = raw == null ? "" : t === "s" ? sst[parseInt(raw, 10)] ?? "" : unesc(raw);
    }
    vals[col] = String(v).trim();
  }
  return vals;
}

/** Duyệt từng <row> của XML sheet (Buffer đã giải nén) theo khúc 8MB — không dựng chuỗi 285MB.
    onRow(rowXml, index) với index 0 = dòng đầu (header). Trả về { head, tail } phần ngoài sheetData. */
function eachRow(xmlBuf, onRow) {
  const dec = new StringDecoder("utf8");
  const STEP = 8 * 1024 * 1024;
  let pend = "", head = null, idx = 0, tail = "";
  const ROW = /<row\b[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g;
  for (let off = 0; off <= xmlBuf.length; off += STEP) {
    const last = off + STEP >= xmlBuf.length;
    pend += last ? dec.write(xmlBuf.subarray(off)) + dec.end() : dec.write(xmlBuf.subarray(off, off + STEP));
    if (head === null) {
      const k = pend.indexOf("<sheetData");
      if (k === -1) { if (last) return { head: pend, tail: "", noData: true }; continue; }
      const gt = pend.indexOf(">", k);
      if (gt === -1) continue;
      if (pend[gt - 1] === "/") { // <sheetData/> — sheet rỗng
        return { head: pend.slice(0, gt + 1), tail: pend.slice(gt + 1) + (last ? "" : dec.write(xmlBuf.subarray(off + STEP)) + dec.end()), empty: true };
      }
      head = pend.slice(0, gt + 1); pend = pend.slice(gt + 1);
    }
    const endData = pend.indexOf("</sheetData>");
    const limit = endData !== -1 ? endData : last ? pend.length : pend.lastIndexOf("</row>") + 6;
    if (limit <= 5 && endData === -1 && !last) continue;
    const chunk = pend.slice(0, limit);
    ROW.lastIndex = 0;
    let m, consumed = 0;
    while ((m = ROW.exec(chunk))) { onRow(m[0], idx++); consumed = ROW.lastIndex; }
    if (endData !== -1) {
      tail = pend.slice(endData);
      if (!last) tail += dec.write(xmlBuf.subarray(off + STEP)) + dec.end();
      return { head, tail };
    }
    pend = pend.slice(consumed);
  }
  return { head: head ?? "", tail: pend };
}

/** Đổi số dòng của 1 <row> thành n (cả r của từng ô) — dòng giữ lại phải đánh số liền. */
const renumber = (rowXml, n) => rowXml
  .replace(/^<row\b([^>]*?)\br="\d+"/, `<row$1r="${n}"`)
  .replace(/(<c\b[^>]*?\br=")([A-Z]+)\d+"/g, `$1$2${n}"`);

/* ===== ĐỌC CẤU TRÚC WORKBOOK ===== */
function workbookSheets(zip) {
  const get = (p) => zip.text(p);
  const wbXml = get("xl/workbook.xml");
  const rels = Object.fromEntries([...get("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b[^>]*>/g)].map((m) => [
    (m[0].match(/\bId="([^"]+)"/) || [])[1], (m[0].match(/\bTarget="([^"]+)"/) || [])[1]
  ]));
  return [...wbXml.matchAll(/<sheet\b[^>]*>/g)].map((m) => {
    const name = unesc((m[0].match(/\bname="([^"]*)"/) || [])[1] || "");
    const rid = (m[0].match(/\br:id="([^"]+)"/) || m[0].match(/\bid="([^"]+)"/) || [])[1];
    let target = rels[rid] || "";
    target = target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, "");
    return { name, path: target.replace(/\/[^/]+\/\.\.\//g, "/") };
  }).filter((s) => zip.has(s.path));
}
function sharedStrings(zip) {
  if (!zip.has("xl/sharedStrings.xml")) return [];
  const out = [];
  eachSi(zip.buffer("xl/sharedStrings.xml"), (x) => out.push(textOf(x)));
  return out;
}
function eachSi(buf, fn) {
  const s = buf.toString("utf8"); // sharedStrings của bulk Amazon chỉ vài KB (ô dùng inlineStr)
  for (const m of s.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) fn(m[1] || "");
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

  let zip;
  try { zip = readZip(buffer); } catch { throw new Error("File không phải .xlsx hợp lệ — tải lại file bulk từ Amazon"); }
  if (!zip.has("xl/workbook.xml")) throw new Error("File không phải .xlsx hợp lệ — tải lại file bulk từ Amazon");
  const sst = sharedStrings(zip);

  // ---- Lượt 1: header + các cột cần của từng sheet → dữ kiện để quyết định ----
  const camp = new Map(); // cid → { ad:Set, name:Set, pf:Set, pfid }
  const C = (cid) => { let c = camp.get(cid); if (!c) camp.set(cid, (c = { ad: new Set(), name: new Set(), pf: new Set(), pfid: "" })); return c; };
  const sheets = [];
  for (const sh of workbookSheets(zip)) {
    const xml = zip.buffer(sh.path);
    let H = null, kind = "", ix = null, wanted = null;
    const facts = []; // theo thứ tự dòng dữ liệu
    eachRow(xml, (rowXml, i) => {
      if (i === 0) {
        H = []; const v = rowValues(rowXml, sst, null);
        for (let k = 0; k < v.length; k++) H[k] = v[k] ?? "";
        if (H.includes("Entity") && H.includes("Campaign ID")) kind = "campaign";
        else if (H.includes("Customer Search Term") && H.includes("Campaign ID")) kind = "searchterm";
        else if (H.includes("Portfolio ID") && H.includes("Portfolio Name") && !H.includes("Campaign ID")) kind = "portfolio";
        ix = {
          ent: colIx(H, "Entity"), cid: colIx(H, "Campaign ID"), pfid: colIx(H, "Portfolio ID"),
          asin: colIx(H, "ASIN (Informational only)"), sku: colIx(H, "SKU"),
          cas: colIx(H, "Creative ASINs"), lpa: colIx(H, "Landing Page ASINs"),
          name: colIx(H, "Campaign Name (Informational only)", "Campaign Name"), name2: colIx(H, "Campaign Name"),
          pf: colIx(H, "Portfolio Name (Informational only)"), pfname: colIx(H, "Portfolio Name")
        };
        wanted = new Set(Object.values(ix).filter((x) => x >= 0));
        return;
      }
      if (!kind) return;
      const v = rowValues(rowXml, sst, wanted);
      const g = (k) => (ix[k] >= 0 ? v[ix[k]] || "" : "");
      if (kind === "campaign") {
        const cid = g("cid");
        facts.push(cid);
        if (!cid) return;
        const c = C(cid), ent = g("ent");
        if (ent === "Campaign") {
          for (const a of ownerIn(g("name") || g("name2"))) c.name.add(a);
          for (const a of ownerIn(g("pf"))) c.pf.add(a);
          c.pfid = g("pfid") || c.pfid;
        }
        // Product Ad (SP/SD) + mọi dòng có Creative/Landing ASINs (SB)
        for (const a of asinsIn(g("asin") + " " + g("cas") + " " + g("lpa"))) c.ad.add(a);
        if (/Product Ad/i.test(ent)) { const viaSku = skuMap.get(g("sku").toUpperCase()); if (viaSku) c.ad.add(viaSku); }
        if (!c.name.size) for (const a of ownerIn(g("name"))) c.name.add(a);
        if (!c.pf.size) for (const a of ownerIn(g("pf"))) c.pf.add(a);
        if (!c.pfid) c.pfid = g("pfid");
      } else if (kind === "searchterm") {
        const own = ownerIn(g("name"));
        facts.push({ cid: g("cid"), own: own.length ? own : ownerIn(g("pf")) });
      } else {
        facts.push({ id: g("pfid"), own: ownerIn(g("pfname")) });
      }
    });
    sheets.push({ ...sh, kind, facts });
  }

  const keepCamp = new Set(), seenAsins = new Set();
  const campReason = { ad: 0, name: 0, pf: 0 };
  for (const [cid, c] of camp) {
    const own = c.ad.size ? c.ad : c.name.size ? c.name : c.pf;
    for (const a of own) seenAsins.add(a);
    let why = "";
    if (c.ad.size) { if ([...c.ad].some((a) => mine.has(a))) why = "ad"; }
    else if (c.name.size) { if ([...c.name].some((a) => mine.has(a))) why = "name"; }
    else if ([...c.pf].some((a) => mine.has(a)) || (c.pfid && myPf.has(c.pfid))) why = "pf";
    if (why) { keepCamp.add(cid); campReason[why]++; }
  }
  const keptPf = new Set([...keepCamp].map((cid) => camp.get(cid).pfid).filter(Boolean));
  const decide = {
    campaign: (cid) => keepCamp.has(cid),
    searchterm: (f) => (camp.has(f.cid) ? keepCamp.has(f.cid) : f.own.some((a) => mine.has(a))),
    portfolio: (f) => f.own.some((a) => mine.has(a)) || myPf.has(f.id) || (!f.own.length && keptPf.has(f.id))
  };

  // ---- Lượt 2: chép lại các dòng giữ ----
  const report = { sheets: [], campaigns: { total: camp.size, kept: keepCamp.size, by: campReason } };
  const replaced = new Map(); // path → Buffer XML mới
  for (const s of sheets) {
    if (!s.kind || !s.facts.length) continue;
    const keep = s.facts.map(decide[s.kind]);
    const parts = [];
    let n = 0;
    const { head, tail } = eachRow(zip.buffer(s.path), (rowXml, i) => {
      if (i === 0 || keep[i - 1]) parts.push(Buffer.from(renumber(rowXml, ++n), "utf8"));
    });
    // <dimension> (nếu có) phải khớp số dòng mới — Amazon không ghi thẻ này, file khác có thể có
    const head2 = head.replace(/<dimension\b[^>]*\bref="([A-Z]+)\d+(?::([A-Z]+)\d+)?"[^>]*\/>/,
      (m, a, b) => `<dimension ref="${a}1${b ? `:${b}${Math.max(n, 1)}` : ""}"/>`);
    replaced.set(s.path, Buffer.concat([Buffer.from(head2, "utf8"), ...parts, Buffer.from(tail, "utf8")]));
    report.sheets.push({ name: s.name, kind: s.kind, before: s.facts.length, after: n - 1 });
  }

  report.mine = mine.size;
  report.mineFound = [...mine].filter((a) => seenAsins.has(a)).length;
  report.mineMissing = [...mine].filter((a) => !seenAsins.has(a)).sort();
  report.othersRemoved = [...seenAsins].filter((a) => !mine.has(a)).length;

  // Đóng zip: phần không đổi chép nguyên dữ liệu nén, sheet đã lọc nén lại bằng zlib
  const entries = zip.entries.map((e) => {
    const data = replaced.get(e.name);
    if (!data) return e;
    return { name: e.name, method: 8, crc: crc32(data), size: data.length, comp: zlib.deflateRawSync(data, { level: 6 }) };
  });
  return { buffer: writeZip(entries), report };
}

export const _test = { rowValues, eachRow, renumber, colName };
