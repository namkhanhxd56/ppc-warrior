// file-store.js — Lưu trữ local bằng file JSON (giai đoạn chưa nối Postgres)
// Sau này thay bằng pg-store.js cùng interface → các module khác không đổi.

import fs from "fs";
import path from "path";
import { userDataDir } from "./user-context.js";

// PHÂN VÙNG THEO USER (05/08/2026): mọi đường dẫn resolve TẠI THỜI ĐIỂM GỌI qua userDataDir()
// — chưa đăng nhập/admin gốc → ./data (dữ liệu cũ nguyên vẹn); member → ./data/users/<name>/
const DATA_DIR = "./data"; // chỉ còn dùng cho file DÙNG CHUNG (users.json, sessions.json)
const VARIANTS_FILE = () => path.join(userDataDir(), "variants-cache.json");
const RESULTS_DIR = () => path.join(userDataDir(), "results");

function ensureDirs() {
  fs.mkdirSync(RESULTS_DIR(), { recursive: true }); // tự tạo cả ./data/users/<name>/results
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

/** Ghi NGUYÊN TỬ: file tạm → rename đè (rename là thao tác nguyên tử của hệ thống file).
 *  Ghi thẳng mà tiến trình chết/hết đĩa giữa chừng là file JSON hỏng — với daily-rank.json
 *  hay tracking.json thì mất luôn lịch sử rank. Dùng cho mọi file dữ liệu quan trọng. */
function writeJsonAtomic(file, obj, space) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, space === undefined ? JSON.stringify(obj) : JSON.stringify(obj, null, space));
  fs.renameSync(tmp, file);
}

/* ===== Cache biến thể (parent/child) ===== */
export function getProductVariants(asin) {
  const cache = readJson(VARIANTS_FILE(), {});
  return cache[asin] || null; // {parentAsin, childAsins, checkedAt}
}

export function saveProductVariants(asin, parentAsin, childAsins) {
  ensureDirs();
  const cache = readJson(VARIANTS_FILE(), {});
  cache[asin] = { parentAsin, childAsins, checkedAt: new Date().toISOString() };
  // các child cùng nhóm dùng chung cache
  for (const c of childAsins || []) {
    cache[c] = cache[asin];
  }
  fs.writeFileSync(VARIANTS_FILE(), JSON.stringify(cache, null, 2));
}

/* ===== Lịch check daily ===== */
const SCHEDULE_FILE = () => path.join(userDataDir(), "schedule.json");

export function getSchedule() {
  return readJson(SCHEDULE_FILE(), { enabled: false, time: "07:00", jobs: [], lastRunDate: null });
}

export function saveSchedule(s) {
  ensureDirs();
  fs.writeFileSync(SCHEDULE_FILE(), JSON.stringify(s, null, 2));
}

/* ===== Cấu hình worker (zip code...) — sau này chuyển thành cấu hình theo project ===== */
const CONFIG_FILE = () => path.join(userDataDir(), "worker-config.json");

export function getWorkerConfig() {
  return readJson(CONFIG_FILE(), { zip: "10011" }); // spec gốc: zip theo project, hiện 10011
}

export function saveWorkerConfig(cfg) {
  ensureDirs();
  const cur = getWorkerConfig();
  fs.writeFileSync(CONFIG_FILE(), JSON.stringify({ ...cur, ...cfg, updatedAt: new Date().toISOString() }, null, 2));
  return getWorkerConfig();
}

/* ===== Cài đặt theo ASIN (toggle track parent...) ===== */
const SETTINGS_FILE = () => path.join(userDataDir(), "asin-settings.json");

export function getAsinSettings(asin) {
  return readJson(SETTINGS_FILE(), {})[asin] || null; // {trackParent: bool}
}

export function saveAsinSettings(asin, settings) {
  ensureDirs();
  const all = readJson(SETTINGS_FILE(), {});
  all[asin] = { ...(all[asin] || {}), ...settings, updatedAt: new Date().toISOString() };
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(all, null, 2));
}

/* ===== Chỉ số ads theo ASIN × ngày (từ file bulk daily / business report) ===== */
const METRICS_FILE = () => path.join(userDataDir(), "asin-metrics.json");

export function saveAsinMetrics(asin, date, metrics) {
  ensureDirs();
  const all = readJson(METRICS_FILE(), {});
  all[asin] = all[asin] || {};
  all[asin][date] = { ...(all[asin][date] || {}), ...metrics, updatedAt: new Date().toISOString() };
  fs.writeFileSync(METRICS_FILE(), JSON.stringify(all, null, 2));
}

export function getAsinMetrics(asin) {
  return readJson(METRICS_FILE(), {})[asin] || {}; // { "2026-07-13": {spent, salesAds, ordersAds, salesTotal} }
}

/* ===== MODULE DATA: import chỉ số theo ngày (ads / business / tồn kho) =====
   Shape "phẳng theo (asin,date)" để sau map thẳng sang Postgres.
   Dedup re-upload: ghi ĐÈ trọn NHÓM trường của nguồn đó (không sót giá trị cũ). */

/** Chỉ số ads: ghi trọn 5 trường (re-upload đè cả nhóm). Wrapper của saveAsinMetrics. */
export function saveAdsMetrics(asin, date, { impressions = 0, clicks = 0, spent = 0, salesAds = 0, ordersAds = 0 } = {}) {
  saveAsinMetrics(String(asin).toUpperCase(), date, { impressions, clicks, spent, salesAds, ordersAds });
}

/** Business Report: sessions / units / salesTotal — fold chung asin-metrics.json (giữ getAsinMetrics chạy). */
export function saveBusinessData(asin, date, { sessions = null, units = null, salesTotal = null } = {}) {
  const m = {};
  if (sessions !== null) m.sessions = sessions;
  if (units !== null) m.units = units;
  if (salesTotal !== null) m.salesTotal = salesTotal;
  saveAsinMetrics(String(asin).toUpperCase(), date, m);
}

const INVENTORY_FILE = () => path.join(userDataDir(), "inventory-daily.json");

export function saveInventory(asin, date, { unitsAvailable = null, inbound = null, reserved = null, daysOfSupply = null, source = "" } = {}) {
  ensureDirs();
  const all = readJson(INVENTORY_FILE(), {});
  const key = String(asin).toUpperCase();
  all[key] = all[key] || {};
  all[key][date] = { unitsAvailable, inbound, reserved, daysOfSupply, source, updatedAt: new Date().toISOString() };
  fs.writeFileSync(INVENTORY_FILE(), JSON.stringify(all, null, 1));
}

export function getInventory(asin) {
  return readJson(INVENTORY_FILE(), {})[String(asin).toUpperCase()] || {}; // { "YYYY-MM-DD": {unitsAvailable, inbound...} }
}

/** Union ASIN có mặt ở metrics + inventory + daily-rank (dùng cho ASIN picker). */
export function listDataAsins() {
  const set = new Set();
  for (const a of Object.keys(readJson(METRICS_FILE(), {}))) set.add(a);
  for (const a of Object.keys(readJson(INVENTORY_FILE(), {}))) set.add(a);
  for (const a of dailyAsins()) set.add(a);
  return [...set].sort();
}

/* Lịch sử import (giống index Adjust) — cho UI hiển thị danh sách file đã nạp. */
const IMPORTS_FILE = () => path.join(userDataDir(), "data-imports.json");

export function recordImport(entry) {
  ensureDirs();
  const idx = readJson(IMPORTS_FILE(), []);
  idx.unshift({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ...entry, importedAt: new Date().toISOString() });
  fs.writeFileSync(IMPORTS_FILE(), JSON.stringify(idx.slice(0, 100), null, 1));
}

export function listImports(kind) {
  const idx = readJson(IMPORTS_FILE(), []);
  return kind ? idx.filter((x) => x.kind === kind) : idx;
}

/* ===== CHUỖI THỜI GIAN DAILY (nguồn cho báo cáo tổng hợp / biểu đồ / dự phóng) =====
   Cấu trúc: { asin: { keyword: { "YYYY-MM-DD": {r, p, n, tos, ros, vid, sb, car, pv, va, t} } } }
   - r: organic rank toàn cục | p: page | n: no trong trang | tos: "x/y"
   - ros/vid/sb/car: 0|1 | pv: ownPreviouslyViewed | va: variant asin rank thay (nếu chính vắng)
   - t: checkedAt — nhiều lần check trong ngày → lần CUỐI thắng
   Map thẳng sang bảng rank_checks khi lên Postgres. */
/* TÁCH FILE THEO ASIN (07/08/2026). Trước đây tất cả nằm trong 1 file daily-rank.json, nên
   MỖI lần điền lô 5 keyword là đọc + ghi lại TOÀN BỘ lịch sử của mọi ASIN. Đo trên dữ liệu
   thật (165 byte/ô): 3 ASIN × 200 keyword × 365 ngày ≈ 35MB ⇒ mỗi lô ~69MB I/O, 40 lô/ASIN
   ≈ 2,7GB cho một lượt quét. Tách ra thì mỗi lô chỉ chạm file của đúng ASIN đang quét, và
   chi phí KHÔNG tăng khi thêm ASIN mới.
   Chuyển đổi tự động, chạy 1 lần: tách file cũ ra rồi đổi tên thành *.migrated (giữ lại làm
   bản dự phòng, không xoá). */
const DAILY_DIR = () => path.join(userDataDir(), "daily");
const DAILY_ASIN_FILE = (asin) => path.join(DAILY_DIR(), `${String(asin).toUpperCase()}.json`);
const DAILY_LEGACY_FILE = () => path.join(userDataDir(), "daily-rank.json");

function migrateDailyIfNeeded() {
  const legacy = DAILY_LEGACY_FILE();
  if (!fs.existsSync(legacy)) return;
  const all = readJson(legacy, {});
  fs.mkdirSync(DAILY_DIR(), { recursive: true });
  for (const [asin, kws] of Object.entries(all)) {
    const f = DAILY_ASIN_FILE(asin);
    const cur = readJson(f, {}); // đã có file mới thì gộp, dữ liệu mới thắng
    writeJsonAtomic(f, { ...kws, ...cur });
  }
  fs.renameSync(legacy, legacy + ".migrated");
  console.log(`🔀 daily-rank.json → tách ${Object.keys(all).length} file theo ASIN (bản cũ giữ ở daily-rank.json.migrated)`);
}

/** Danh sách ASIN có dữ liệu daily. */
function dailyAsins() {
  migrateDailyIfNeeded();
  try { return fs.readdirSync(DAILY_DIR()).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)); }
  catch { return []; }
}
/** { keyword: { dateKey: cell } } của 1 ASIN. */
function readDailyAsin(asin) {
  migrateDailyIfNeeded();
  return readJson(DAILY_ASIN_FILE(asin), {});
}
function writeDailyAsin(asin, kws) {
  fs.mkdirSync(DAILY_DIR(), { recursive: true });
  writeJsonAtomic(DAILY_ASIN_FILE(asin), kws);
}
/** Gộp mọi ASIN — CHỈ dùng cho bảng theo dõi (cần toàn cảnh); đường ghi không được dùng. */
function readDailyAll() {
  const out = {};
  for (const a of dailyAsins()) out[a] = readJson(DAILY_ASIN_FILE(a), {});
  return out;
}

export function saveDailyRanks(asin, checkedAt, results, dateKey) {
  ensureDirs();
  const key = String(asin).toUpperCase();
  const kws = readDailyAsin(key); // CHỈ file của ASIN này — không đụng ASIN khác
  const date = dateKey || String(checkedAt).slice(0, 10); // dateKey = nhãn PHIÊN QUÉT (Run tạo mới, Continue nối vào)
  for (const x of results || []) {
    if (x.error) continue;
    const p = x.primary || {};
    const bestVar = (x.variants || []).find((v) => v.organicRank !== null);
    kws[x.keyword] = kws[x.keyword] || {};
    kws[x.keyword][date] = {
      r: p.organicRank, page: p.organicPage, n: p.organicPosInPage,
      // 3 trạng thái ads, KHÔNG bao giờ ghi 0/0 giả vào chuỗi lịch sử:
      //   "_"  = KHÔNG QUÉT ads (user tắt 📢 cho ASIN này) — không có gì để nói
      //   "?"  = có quét nhưng phiên không được serve SP tile → không kết luận được
      //   x/y  = số liệu thật
      tos: x.adsScanned === false ? "_" : (x.adsTilesServed === false ? "?" : `${p.tosPosition || 0}/${p.tosTotal || 0}`),
      ros: x.adsScanned === false ? "_" : (p.rosPresent ? 1 : 0),
      vid: x.adsScanned === false ? "_" : (p.videoPresent ? 1 : 0),
      sb: x.adsScanned === false ? "_" : (p.sbPresent ? 1 : 0),
      car: x.adsScanned === false ? "_" : (p.spCarouselPresent ? 1 : 0),
      pv: p.ownPreviouslyViewed ? 1 : 0,
      bdg: (p.ownBadges || []).length ? p.ownBadges : undefined, // Overall Pick, Amazon's Choice...
      va: p.organicRank === null && bestVar ? { asin: bestVar.asin, r: bestVar.organicRank } : null,
      rc: x.resultCount || null,
      t: checkedAt
    };
  }
  writeDailyAsin(key, kws);
  // Tự đăng ký ASIN + keyword vào bảng theo dõi + ghi nhãn phiên
  trackingRegisterRun(asin, (results || []).filter((x) => !x.error).map((x) => x.keyword), date);
  // Gộp competitor snapshot của phiên (nếu có)
  saveCompetitorAgg(asin, date, results);
}

export function getDailySeries(asin) {
  return readDailyAsin(asin); // { keyword: { date: {...} } }
}

/* ===== BẢNG THEO DÕI RANKING (tracking) =====
   tracking.json: cấu hình hiển thị/bật-tắt của bảng luôn-hiện:
   { asins: { ASIN: { enabled, loai, image, trackParent, saveCompetitor,
                      keywords: { kw: { enabled, volume, loai } } } },
     sessions: ["2026-07-14", "2026-07-19 09:45", ...],
     config: { metrics: ["Sale","Sale ads","Spent"], kwFields: ["tos","ros"] } } */
const TRACKING_FILE = () => path.join(userDataDir(), "tracking.json");

export function getTracking() {
  const t = readJson(TRACKING_FILE(), {});
  t.asins = t.asins || {};
  t.sessions = t.sessions || [];
  t.config = t.config || {};
  t.config.metrics = t.config.metrics || ["Sale", "Sale ads", "Spent"];
  t.config.kwFields = t.config.kwFields || ["tos", "ros"];
  return t;
}
function writeTracking(t) {
  ensureDirs();
  writeJsonAtomic(TRACKING_FILE(), t, 1);
}

/** Run xong tự đăng ký ASIN/keyword vào bảng + ghi nhãn phiên quét. */
export function trackingRegisterRun(asin, keywords, dateKey) {
  const t = getTracking();
  const key = String(asin).toUpperCase();
  t.asins[key] = t.asins[key] || { enabled: true, loai: "", image: null, trackParent: false, saveCompetitor: false, keywords: {}, addedAt: new Date().toISOString() };
  for (const kw of keywords || []) {
    const k = String(kw).trim().toLowerCase();
    if (!k) continue;
    t.asins[key].keywords[k] = t.asins[key].keywords[k] || { enabled: true, volume: null, loai: "", addedAt: new Date().toISOString() };
  }
  if (dateKey && !t.sessions.includes(dateKey)) t.sessions.push(dateKey);
  t.sessions.sort();
  writeTracking(t);
}

export function trackingSetImage(asin, image) {
  if (!image) return;
  const t = getTracking();
  const key = String(asin).toUpperCase();
  if (t.asins[key] && !t.asins[key].image) { t.asins[key].image = image; writeTracking(t); }
}

export function trackingPatchAsin(asin, patch) {
  const t = getTracking();
  const key = String(asin).toUpperCase();
  if (patch.delete) { // xoá hẳn: cấu hình + toàn bộ lịch sử rank + metrics + competitor
    delete t.asins[key];
    try { fs.unlinkSync(DAILY_ASIN_FILE(key)); } catch {} // xoá ASIN = xoá đúng file của nó
    const met = readJson(METRICS_FILE(), {}); delete met[key];
    fs.writeFileSync(METRICS_FILE(), JSON.stringify(met, null, 1));
    const comp = readJson(COMPRANK_FILE(), {}); delete comp[key];
    fs.writeFileSync(COMPRANK_FILE(), JSON.stringify(comp));
    writeTracking(t);
    return t;
  }
  t.asins[key] = t.asins[key] || { enabled: true, loai: "", image: null, trackParent: false, saveCompetitor: false, keywords: {}, addedAt: new Date().toISOString() };
  for (const f of ["enabled", "loai", "trackParent", "saveCompetitor", "image", "adsScan", "daily"]) {
    if (patch[f] !== undefined) t.asins[key][f] = patch[f];
  }
  writeTracking(t);
  return t;
}

export function trackingPatchKeyword(asin, keyword, patch) {
  const t = getTracking();
  const key = String(asin).toUpperCase();
  const k = String(keyword).trim().toLowerCase();
  if (!t.asins[key]) return t;
  if (patch.delete) { // xoá keyword khỏi bảng + lịch sử của keyword đó
    delete t.asins[key].keywords[k];
    const kwsOf = readDailyAsin(key);
    if (kwsOf[k]) { delete kwsOf[k]; writeDailyAsin(key, kwsOf); }
    writeTracking(t);
    return t;
  }
  t.asins[key].keywords[k] = t.asins[key].keywords[k] || { enabled: true, volume: null, loai: "", addedAt: new Date().toISOString() };
  for (const f of ["enabled", "volume", "loai", "tag"]) {
    if (patch[f] !== undefined) t.asins[key].keywords[k][f] = patch[f];
  }
  writeTracking(t);
  return t;
}

/** Nạp volume từ file keyword|volume — áp cho MỌI ASIN có keyword khớp. */
export function trackingApplyVolumes(pairs) {
  const t = getTracking();
  let applied = 0;
  for (const [kw, vol] of pairs) {
    const k = String(kw).trim().toLowerCase();
    const v = Number(String(vol).replace(/[^0-9.]/g, ""));
    if (!k || !isFinite(v)) continue;
    for (const a of Object.values(t.asins)) {
      if (a.keywords[k]) { a.keywords[k].volume = v; applied++; }
    }
  }
  writeTracking(t);
  return applied;
}

export function trackingSetConfig(cfg) {
  const t = getTracking();
  if (Array.isArray(cfg.metrics)) t.config.metrics = cfg.metrics.slice(0, 3);
  if (Array.isArray(cfg.kwFields)) t.config.kwFields = cfg.kwFields.slice(0, 2);
  if (Array.isArray(cfg.tags)) t.config.tags = [...new Set(cfg.tags.map((x) => String(x).trim()).filter(Boolean))];
  if (Array.isArray(cfg.accTags)) t.config.accTags = [...new Set(cfg.accTags.map((x) => String(x).trim()).filter(Boolean))];
  writeTracking(t);
  return t.config;
}

/** Xoá 1 ngày/phiên khỏi toàn bộ data (daily-rank, metrics, competitor, sessions). */
export function trackingDeleteDate(dateKey) {
  // Xoá 1 cột thì phải duyệt mọi ASIN, nhưng chỉ ghi lại file nào thực sự có thay đổi
  for (const asin of dailyAsins()) {
    const kws = readDailyAsin(asin);
    let touched = false;
    for (const kw of Object.keys(kws)) if (kws[kw][dateKey]) { delete kws[kw][dateKey]; touched = true; }
    if (touched) writeDailyAsin(asin, kws);
  }
  const met = readJson(METRICS_FILE(), {});
  for (const asin of Object.keys(met)) delete met[asin][dateKey];
  fs.writeFileSync(METRICS_FILE(), JSON.stringify(met, null, 1));
  const comp = readJson(COMPRANK_FILE(), {});
  for (const asin of Object.keys(comp)) { if (comp[asin]) delete comp[asin][dateKey]; }
  fs.writeFileSync(COMPRANK_FILE(), JSON.stringify(comp));
  const t = getTracking();
  t.sessions = t.sessions.filter((s) => s !== dateKey);
  writeTracking(t);
}

/** Bảng đầy đủ cho UI: cấu hình + series + metrics + phân loại PPC từ kho keyword. */
export function getTrackingTable() {
  const t = getTracking();
  const daily = readDailyAll(); // bảng theo dõi cần toàn cảnh — chỗ DUY NHẤT đọc hết mọi ASIN
  const met = readJson(METRICS_FILE(), {});
  const bank = readJson(BANK_FILE(), {});
  // ASIN có trong daily nhưng chưa có tracking (data cũ) → tự thêm
  for (const asin of Object.keys(daily)) {
    if (!t.asins[asin]) {
      t.asins[asin] = { enabled: true, loai: "", image: null, trackParent: false, saveCompetitor: false, keywords: {}, addedAt: new Date().toISOString() };
    }
    for (const kw of Object.keys(daily[asin])) {
      t.asins[asin].keywords[kw] = t.asins[asin].keywords[kw] || { enabled: true, volume: null, loai: "" };
    }
  }
  // sessions = union nhãn phiên đã đăng ký + mọi date key có trong daily/metrics (data cũ trước tracking)
  const sess = new Set(t.sessions);
  for (const asin of Object.keys(daily)) for (const kw of Object.keys(daily[asin])) for (const d of Object.keys(daily[asin][kw])) sess.add(d);
  for (const asin of Object.keys(met)) for (const d of Object.keys(met[asin])) sess.add(d);
  t.sessions = [...sess].sort();
  const rows = Object.entries(t.asins).map(([asin, a]) => ({
    asin,
    enabled: a.enabled !== false,
    loai: a.loai || "",
    image: a.image || null,
    trackParent: !!a.trackParent,
    saveCompetitor: !!a.saveCompetitor,
    adsScan: a.adsScan !== false,
    daily: !!a.daily,
    metrics: met[asin] || {},           // { dateKey: {custom: {...}, spent...} }
    keywords: Object.entries(a.keywords).map(([kw, kcfg]) => ({
      kw,
      enabled: kcfg.enabled !== false,
      volume: kcfg.volume ?? null,
      loai: kcfg.loai || "",
      tag: kcfg.tag || bank[asin]?.[kw]?.tag || "",  // Phân loại: tag tay đè tag kho (PPC...)
      series: daily[asin]?.[kw] || {}    // { dateKey: {r,page,n,tos,ros,vid,sb,car,bdg,va,rc,t} }
    }))
  }));
  return { asins: rows, sessions: t.sessions, config: t.config };
}

/* ===== CÒN THIẾU GÌ Ở MỘT CỘT (phiên) — nguồn sự thật phía SERVER =====
   Trước đây chỉ trình duyệt biết ô nào trống (UI tự lọc rồi gọi Run), nên server/agent
   không thể tự chạy tiếp khi job đứt. Đưa phép tính này về server để dùng ở 2 chỗ:
   ⏩ Continue và thu hồi job treo (dựng lại payload = đúng phần còn thiếu).
   Ô "trống" = chưa có bản ghi trong daily[asin][kw][dateKey]. Keyword LỖI không được
   saveDailyRanks ghi → tính là trống (sẽ chạy lại). "Ngoài 150" hay ToS "?" là kết quả
   THẬT (có bản ghi) → tính là đã xong. */

/** Keyword của 1 ASIN còn trống ở cột dateKey (giữ nguyên thứ tự đầu vào). */
export function missingKeywords(asin, keywords, dateKey) {
  const daily = readDailyAsin(asin);
  return (keywords || []).filter((kw) => !daily[kw]?.[dateKey]);
}

/** Danh sách ASIN/keyword còn trống ở cột dateKey — cùng thứ tự + cùng bộ lọc như bảng UI. */
export function missingTargets(dateKey) {
  if (!dateKey) return [];
  const { asins } = getTrackingTable();
  return asins
    .filter((a) => a.enabled)
    .map((a) => ({
      asin: a.asin,
      trackParent: a.trackParent,
      saveCompetitor: a.saveCompetitor,
      adsScan: a.adsScan,
      kws: a.keywords.filter((k) => k.enabled && !k.series[dateKey]).map((k) => k.kw)
    }))
    .filter((t) => t.kws.length);
}

/** Cột DỞ DANG gần nhất = nhãn phiên mới nhất mà vẫn còn ô trống.
    Khác "phiên mới nhất" nói chung: bấm ▶ của 1 ASIN lẻ tạo cột mới, không được để
    cột đó chiếm chỗ cột đang làm dở. Không tìm thấy → null (không có gì để tiếp). */
export function latestIncompleteSession() {
  const { sessions } = getTrackingTable();
  for (let i = sessions.length - 1; i >= 0; i--) {
    if (missingTargets(sessions[i]).length) return sessions[i];
  }
  return null;
}

/** Job daily từ bảng theo dõi: ASIN có ⏰ daily=true (và đang bật theo dõi), tuần tự từ trên xuống. */
export function trackingDailyJobs() {
  const t = getTracking();
  const out = [];
  for (const [asin, a] of Object.entries(t.asins)) {
    if (!a.daily || a.enabled === false) continue;
    const kws = Object.entries(a.keywords).filter(([, k]) => k.enabled !== false).map(([kw]) => kw);
    if (!kws.length) continue;
    out.push({ asin, keywords: kws.join("\n"), maxPages: 3,
      checkVariants: !!a.trackParent, saveSnapshot: !!a.saveCompetitor,
      adsScan: a.adsScan !== false });
  }
  return out;
}

/* ===== Xếp hạng COMPETITOR theo phiên quét =====
   competitor-rank.json: { asin: { dateKey: { compAsin: {n, bestRank, kws: [...]} } } }
   n = số keyword (trong nhóm keyword của mình) mà competitor xuất hiện (ads hoặc organic top 10). */
const COMPRANK_FILE = () => path.join(userDataDir(), "competitor-rank.json");

export function saveCompetitorAgg(asin, dateKey, results) {
  const key = String(asin).toUpperCase();
  // Loại CHÍNH MÌNH + parent + mọi biến thể cùng nhóm khỏi danh sách competitor (chống "trùng" với sản phẩm của mình)
  const own = new Set([key]);
  const vc = readJson(VARIANTS_FILE(), {})[key];
  if (vc) { if (vc.parentAsin) own.add(String(vc.parentAsin).toUpperCase()); for (const c of vc.childAsins || []) own.add(String(c).toUpperCase()); }
  const agg = {};
  let has = false;
  for (const x of results || []) {
    if (x.error || !Array.isArray(x.snapshot)) continue;
    const seen = new Set();
    const hit = (a, orgRank) => {
      if (!/^[A-Z0-9]{10}$/.test(a) || own.has(a)) return;
      has = true;
      if (!seen.has(a)) {
        seen.add(a);
        agg[a] = agg[a] || { n: 0, bestRank: null, kws: [] };
        agg[a].n++;
        agg[a].kws.push(x.keyword);
      }
      if (orgRank != null) agg[a].bestRank = Math.min(agg[a].bestRank ?? 999, orgRank);
    };
    for (const sl of x.snapshot) {
      // Shape thật từ serp-parser: {page, positionType: "ToS"|"RoS"|"ORGANIC"|..., positionIndex, asin, asins?}
      const pt = String(sl.positionType || "");
      const sponsored = pt && pt !== "ORGANIC";
      const orgTop10 = pt === "ORGANIC" && sl.positionIndex != null && sl.positionIndex <= 10;
      if (!sponsored && !orgTop10) continue; // competitor chỉ tính: ads + organic top 10
      const orgRank = pt === "ORGANIC" ? sl.positionIndex : null;
      if (sl.asin) hit(String(sl.asin).toUpperCase(), orgRank);
      for (const a2 of sl.asins || []) hit(String(a2).toUpperCase(), null); // tile nhiều ASIN (SB/video)
    }
  }
  if (!has) return;
  const all = readJson(COMPRANK_FILE(), {});
  all[key] = all[key] || {};
  const cur = all[key][dateKey] || {};
  for (const [a, v] of Object.entries(agg)) {
    const c = cur[a] || { n: 0, bestRank: null, kws: [] };
    const kws = [...new Set([...c.kws, ...v.kws])];
    const best = Math.min(c.bestRank ?? 999, v.bestRank ?? 999);
    cur[a] = { n: kws.length, bestRank: best === 999 ? null : best, kws };
  }
  all[key][dateKey] = cur;
  fs.writeFileSync(COMPRANK_FILE(), JSON.stringify(all));
  compLibUpdateStats(key, dateKey); // Số keyword + Best Organic trong Library update theo phiên này
}

export function getCompetitorRank(asin, dateKey) {
  const all = readJson(COMPRANK_FILE(), {})[String(asin).toUpperCase()] || {};
  const dates = Object.keys(all).sort();
  const d = dateKey || dates[dates.length - 1];
  const list = Object.entries(all[d] || {})
    .map(([a, v]) => ({ asin: a, n: v.n, bestRank: v.bestRank, kws: v.kws }))
    .sort((x, y) => y.n - x.n || (x.bestRank ?? 999) - (y.bestRank ?? 999));
  return { date: d || null, dates, list };
}

/* ===== COMPETITOR LIBRARY (v2 — PHÂN NHÓM THEO ASIN CHÍNH) =====
   competitor-library.json: { _v: 2, groups: { MAIN_ASIN: { COMP_ASIN: {
       enabled, image, title, sales: {"YYYY-MM-DD": "50+"|null},
       n, bestRank, statDate,          // Số keyword + Best Organic — update theo PHIÊN CHẠY MỚI NHẤT (không duyệt lịch sử)
       addedAt, scannedAt } } } }
   - ảnh + title: quét 1 LẦN; Sale: mỗi lần quét
   - legacy v1 (phẳng, chưa phân nhóm): backup .v1.bak rồi làm mới — user tự add lại */
const COMPLIB_FILE = () => path.join(userDataDir(), "competitor-library.json");

export function getCompetitorLibrary() {
  const raw = readJson(COMPLIB_FILE(), { _v: 2, groups: {} });
  if (raw._v !== 2) { // legacy phẳng → backup + reset
    try { fs.writeFileSync(COMPLIB_FILE() + ".v1.bak", JSON.stringify(raw)); } catch {}
    const fresh = { _v: 2, groups: {} };
    writeCompLib(fresh);
    return fresh;
  }
  raw.groups = raw.groups || {};
  return raw;
}
function writeCompLib(lib) {
  ensureDirs();
  fs.writeFileSync(COMPLIB_FILE(), JSON.stringify(lib, null, 1));
}
export function compLibAdd(mainAsin, asins) {
  const lib = getCompetitorLibrary();
  const main = String(mainAsin).trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(main)) return 0;
  lib.groups[main] = lib.groups[main] || {};
  let added = 0;
  for (const a of asins || []) {
    const key = String(a).trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(key) || key === main || lib.groups[main][key]) continue;
    lib.groups[main][key] = { enabled: true, image: null, title: null, sales: {}, n: null, bestRank: null, statDate: null, addedAt: new Date().toISOString() };
    added++;
  }
  writeCompLib(lib);
  return added;
}
export function compLibPatch(mainAsin, compAsin, patch) {
  const lib = getCompetitorLibrary();
  const main = String(mainAsin).toUpperCase();
  const comp = String(compAsin).toUpperCase();
  if (!lib.groups[main]) return;
  if (patch.delete) {
    delete lib.groups[main][comp];
    if (!Object.keys(lib.groups[main]).length) delete lib.groups[main]; // nhóm rỗng thì xoá header
    writeCompLib(lib);
    return;
  }
  if (!lib.groups[main][comp]) return;
  for (const f of ["enabled", "favorite"]) if (patch[f] !== undefined) lib.groups[main][comp][f] = patch[f];
  writeCompLib(lib);
}
/** Quét trang sản phẩm: cập nhật comp ở MỌI nhóm chứa nó (ảnh/title chỉ điền lần đầu, Sale theo ngày). */
export function compLibSaveScan(compAsin, { title, image, sales, price, date }) {
  const lib = getCompetitorLibrary();
  const comp = String(compAsin).toUpperCase();
  let touched = false;
  for (const g of Object.values(lib.groups)) {
    if (!g[comp]) continue;
    if (title && !g[comp].title) g[comp].title = title;
    if (image && !g[comp].image) g[comp].image = image;
    g[comp].sales[date] = sales ?? null;
    g[comp].prices = g[comp].prices || {};
    g[comp].prices[date] = price ?? null; // giá theo ngày — mỗi lần quét (Sale/Favorite) đều cập nhật
    g[comp].scannedAt = new Date().toISOString();
    touched = true;
  }
  if (touched) writeCompLib(lib);
}
/** Sau MỖI PHIÊN chạy: cập nhật Số keyword + Best Organic cho competitor trong nhóm của ASIN chính. */
export function compLibUpdateStats(mainAsin, dateKey) {
  const lib = getCompetitorLibrary();
  const main = String(mainAsin).toUpperCase();
  const g = lib.groups[main];
  if (!g) return;
  const agg = readJson(COMPRANK_FILE(), {})[main]?.[dateKey] || {};
  let touched = false;
  for (const [comp, v] of Object.entries(agg)) {
    if (!g[comp]) continue;
    g[comp].n = v.n;
    g[comp].bestRank = v.bestRank ?? null;
    g[comp].statDate = dateKey;
    touched = true;
  }
  if (touched) writeCompLib(lib);
}
/** Get Competitor (Tạo Campaign): CHỈ từ Library — nhóm của ASIN chính, đang theo dõi, khoảng keyword OPTIONAL. */
export function getCompetitorPickLib(mainAsin, minKw, maxKw, includeUntracked) {
  const g = getCompetitorLibrary().groups[String(mainAsin).toUpperCase()] || {};
  const lo = minKw ? Number(minKw) : null;
  const hi = maxKw ? Number(maxKw) : null;
  return Object.entries(g)
    .filter(([, v]) => includeUntracked || v.enabled !== false)
    .filter(([, v]) => (lo == null || (v.n ?? 0) >= lo) && (hi == null || (v.n ?? 0) <= hi))
    .map(([a, v]) => ({ asin: a, n: v.n, bestRank: v.bestRank }))
    .sort((x, y) => (y.n ?? 0) - (x.n ?? 0) || (x.bestRank ?? 999) - (y.bestRank ?? 999));
}

/** Get Competitor cho Tạo Campaign: gộp NHIỀU PHIÊN + lọc khoảng số keyword + loại ASIN đã tắt theo dõi. */
export function getCompetitorPick(asin, dates, minKw, maxKw, excludeUntracked) {
  const all = readJson(COMPRANK_FILE(), {})[String(asin).toUpperCase()] || {};
  const lib = excludeUntracked ? getCompetitorLibrary() : null;
  const merged = {}; // comp → Set(kws), bestRank
  for (const d of dates || []) {
    for (const [comp, v] of Object.entries(all[d] || {})) {
      merged[comp] = merged[comp] || { kws: new Set(), bestRank: null };
      (v.kws || []).forEach((k) => merged[comp].kws.add(k));
      if (v.bestRank != null) merged[comp].bestRank = Math.min(merged[comp].bestRank ?? 999, v.bestRank);
    }
  }
  const lo = Number(minKw) || 1;
  const hi = Number(maxKw) || 9999;
  return Object.entries(merged)
    .map(([a, v]) => ({ asin: a, n: v.kws.size, bestRank: v.bestRank, kws: [...v.kws] }))
    .filter((x) => x.n >= lo && x.n <= hi)
    .filter((x) => !lib || lib[x.asin]?.enabled !== false) // loại competitor đã tắt theo dõi trong Library
    .sort((x, y) => y.n - x.n || (x.bestRank ?? 999) - (y.bestRank ?? 999));
}

/* ===== Module LAUNCHING: cài đặt + kho keyword + snapshot export ===== */
const LAUNCH_FILE = () => path.join(userDataDir(), "launch-settings.json");

/** Thông tin lưu lại theo yêu cầu: SKU, ASIN, Portfolio ID, Mã cá nhân (KHÔNG lưu ngày tạo)
    + naming templates + cấu hình bid/campaign. */
export function getLaunchSettings() {
  return readJson(LAUNCH_FILE(), {});
}
export function saveLaunchSettings(s) {
  ensureDirs();
  const cur = getLaunchSettings();
  delete s.startDate; // ngày tạo không lưu — mặc định today mỗi lần mở
  const merged = { ...cur, ...s, updatedAt: new Date().toISOString() };
  // HỒ SƠ SẢN PHẨM: lưu theo ASIN — sau này gõ ASIN hoặc SKU là các trường còn lại
  // (SKU/ASIN, Tên phân loại, mã cá nhân) tự điền lại
  if (s.asin && /^[A-Z0-9]{10}$/i.test(s.asin)) {
    const key = String(s.asin).toUpperCase();
    merged.products = { ...(cur.products || {}) };
    // GỘP, không ghi đè: products[] giờ còn mang list/type/portfolioId của Danh mục. Ghi đè
    // trọn object là bấm "Lưu" ở form Tạo Campaign xoá sạch mấy trường đó của ASIN đang chọn.
    merged.products[key] = {
      ...(cur.products?.[key] || {}),
      sku: s.sku || "", category: s.category || "", manager: s.manager || "",
      updatedAt: new Date().toISOString()
    };
  }
  fs.writeFileSync(LAUNCH_FILE(), JSON.stringify(merged, null, 2));
  return getLaunchSettings();
}

/* ===== DANH MỤC (catalog) =====
   Hai bảng người dùng tự nạp, dùng làm nguồn cho trang Tạo Campaign:
     1. Sản phẩm:  tên list | ASIN | SKU | Type (FBA/FBM)
     2. Portfolio: Portfolio ID | Tên
   CỐ Ý không tạo kho sản phẩm thứ hai: bảng sản phẩm ghi thẳng vào launch-settings.products
   — chỗ form Tạo Campaign vốn đã lưu SKU/category/manager theo ASIN. Thêm kho mới là có hai
   nơi chứa cùng một SKU, sửa một bên lệch bên kia.
   Type (FBA/FBM) là thứ quyết định tiền tố tên campaign qua placeholder {Type}. */

export function listCatalog() {
  const s = getLaunchSettings();
  const pfDir = readJson(PORTFOLIOS_FILE(), {});
  return Object.entries(s.products || {})
    .map(([asin, p]) => ({
      asin,
      // tài khoản seller — xuất bulk không được trộn ASIN của nhiều acc. Acc LOOKUP từ Danh mục
      // portfolio theo Portfolio mặc định (portfolio thuộc đúng 1 tài khoản); không còn gõ tay.
      acc: pfDir[String(p.portfolioId || "").trim()]?.acc || "",
      list: p.list || "", sku: p.sku || "", type: p.type === "FBM" ? "FBM" : "FBA",
      portfolioId: p.portfolioId || "",  // portfolio mặc định — gán theo TÊN LIST, tự điền khi chọn ASIN
      kwList: p.kwList || "",            // id list trong Danh mục Target — Tạo Campaign kéo keyword + Target ASIN từ đây
      category: p.category || ""
    }))
    .sort((a, b) => (a.acc || "~").localeCompare(b.acc || "~") || (a.list || "~").localeCompare(b.list || "~") || a.asin.localeCompare(b.asin));
}

/** Ghi đè danh sách sản phẩm (bảng nhập liệu gửi nguyên bảng lên).
 *  Giữ lại các trường form cũ (manager…) của ASIN đã có — chỉ đụng 4 cột của danh mục. */
export function saveCatalog(rows) {
  ensureDirs();
  const s = getLaunchSettings();
  const old = s.products || {};
  const next = {};
  for (const r of rows || []) {
    const asin = String(r.asin || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(asin)) continue;
    next[asin] = {
      ...(old[asin] || {}),
      acc: String(r.acc ?? old[asin]?.acc ?? "").trim().slice(0, 40),
      // Cột "Tên list" đã bỏ khỏi bảng (30/10/2026) — UI không gửi list nữa thì giữ giá trị cũ, không xoá
      list: String(r.list ?? old[asin]?.list ?? "").trim().slice(0, 60),
      sku: String(r.sku || "").trim().slice(0, 60),
      type: String(r.type || "").toUpperCase() === "FBM" ? "FBM" : "FBA",
      portfolioId: String(r.portfolioId || "").trim(),
      kwList: String(r.kwList ?? old[asin]?.kwList ?? "").trim().slice(0, 40),
      category: String(r.category ?? old[asin]?.category ?? "").trim().slice(0, 60),
      updatedAt: new Date().toISOString()
    };
  }
  fs.writeFileSync(LAUNCH_FILE(), JSON.stringify({ ...s, products: next, updatedAt: new Date().toISOString() }, null, 2));
  return listCatalog();
}

/** ASIN → {sku, type, list} — dùng khi dựng tên campaign và điền Product Ad. */
export function catalogMap() {
  const out = {};
  for (const r of listCatalog()) out[r.asin] = r;
  return out;
}

/* Danh bạ portfolio: { "<id>": {name, updatedAt} }. Trước đây 13 ô portfolio trong form
   Tạo Campaign đều phải GÕ TAY Portfolio ID — sai một chữ số là campaign rơi nhầm chỗ và
   chỉ phát hiện sau khi đã upload lên Amazon. */
const PORTFOLIOS_FILE = () => path.join(userDataDir(), "portfolios.json");

export function listPortfolioDir() {
  const all = readJson(PORTFOLIOS_FILE(), {});
  return Object.entries(all)
    .map(([id, v]) => ({ id, name: v.name || "", acc: v.acc || "" }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
export function savePortfolioDir(rows) {
  ensureDirs();
  const next = {};
  for (const r of rows || []) {
    const id = String(r.id || "").trim();
    if (!id) continue;
    next[id] = { name: String(r.name || "").trim().slice(0, 80), acc: String(r.acc || "").trim().slice(0, 40), updatedAt: new Date().toISOString() };
  }
  writeJsonAtomic(PORTFOLIOS_FILE(), next, 1);
  return listPortfolioDir();
}
/* ===== DANH MỤC TARGET (tên cũ: Danh mục Keyword — độc lập với "Phân tích Keyword") =====
   List (VD "Pickle ornament") → nhiều group (keyword product / gift / decor...), mỗi group có
   bid riêng và offset +n ngày so với ngày launch chính (ô "Ngày tạo" ở Tạo Campaign).
   Keyword: {kw, sv, group, bid} — bid null = theo bid của group, có số = chỉnh tay.
   Cùng 1 keyword được nằm ở nhiều list (mỗi list giữ group/bid riêng).
   Sản phẩm trong Danh mục gán kwList = id list → Tạo Campaign kéo nhanh "kw | bid | +n". */
const KWLISTS_FILE = () => path.join(userDataDir(), "kw-lists.json");
const kwListsAll = () => { const d = readJson(KWLISTS_FILE(), {}); return Array.isArray(d.lists) ? d.lists : []; };
const kwListsWrite = (lists) => { ensureDirs(); writeJsonAtomic(KWLISTS_FILE(), { lists }, 1); };
const numOrNull = (v) => { if (v === "" || v === null || v === undefined) return null; const n = parseFloat(String(v).replace(",", ".")); return isNaN(n) ? null : n; };
function cleanKwList(l) {
  const groups = [];
  const gSeen = new Set();
  for (const g of Array.isArray(l.groups) ? l.groups : []) {
    const name = String(g.name || "").trim().slice(0, 60);
    if (!name || gSeen.has(name.toLowerCase())) continue;
    gSeen.add(name.toLowerCase());
    groups.push({ name, bid: numOrNull(g.bid), offset: Math.max(0, Math.min(365, Math.round(Number(g.offset) || 0))) });
  }
  const gNames = new Set(groups.map((g) => g.name));
  const keywords = [];
  const kSeen = new Set();
  for (const k of Array.isArray(l.keywords) ? l.keywords : []) {
    const kw = String(k.kw || "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 200);
    if (!kw || kSeen.has(kw)) continue;
    kSeen.add(kw);
    keywords.push({ kw, sv: numOrNull(k.sv), group: gNames.has(k.group) ? k.group : "", bid: numOrNull(k.bid) });
  }
  // Target ASIN của list (đối thủ / ASIN muốn chạy Product Targeting) — Tạo Campaign kéo vào ô Target ASINs
  const asins = [...new Set((Array.isArray(l.asins) ? l.asins : [])
    .map((a) => String(a || "").trim().toUpperCase()).filter((a) => /^[A-Z0-9]{10}$/.test(a)))].slice(0, 5000);
  return { id: l.id, name: String(l.name || "").trim().slice(0, 80) || "List không tên", groups, keywords, asins,
    rev: Number(l.rev) || 0, updatedAt: new Date().toISOString() };
}

/* ===== LỊCH SỬ PHIÊN BẢN (30/10/2026 — sau vụ mất cập nhật list "beer ornament") =====
   Trước đây mỗi lần lưu GHI ĐÈ bản trước, không giữ gì → mất là mất hẳn. Giờ:
   - Mỗi list có `rev` tăng sau mỗi lần ghi. PUT phải gửi `baseRev` = rev mà trang đang cầm;
     lệch (tab/máy khác đã lưu sau đó) → TỪ CHỐI (409) thay vì âm thầm ghi đè. Đây là nguyên
     nhân mất cập nhật: tab mở từ trước tự lưu bản cũ đè lên bản mới.
   - Trước khi ghi, chụp bản ĐANG CÓ vào kw-lists-history/<id>.json: tự lưu thì tối đa 1 bản
     mỗi 10 phút (một đợt sửa liên tục = 1 bản); nạp file / khôi phục / ghi đè / xoá thì luôn chụp.
     Giữ 50 bản gần nhất mỗi list. Xoá list vẫn giữ file lịch sử (cứu được bằng tay). */
const KWHIST_DIR = () => path.join(userDataDir(), "kw-lists-history");
const KWHIST_FILE = (id) => path.join(KWHIST_DIR(), String(id).replace(/[^\w-]/g, "") + ".json");
const KWHIST_KEEP = 50, KWHIST_GAP_MS = 10 * 60 * 1000;
const kwHistRead = (id) => { const h = readJson(KWHIST_FILE(id), []); return Array.isArray(h) ? h : []; };
function kwSnapshot(l, kind, force) {
  if (!l) return;
  const h = kwHistRead(l.id);
  const last = h[h.length - 1];
  if (!force && last && Date.now() - Date.parse(last.at) < KWHIST_GAP_MS) return;
  h.push({ at: new Date().toISOString(), kind, rev: Number(l.rev) || 0, name: l.name,
    kwCount: (l.keywords || []).length, groupCount: (l.groups || []).length, asinCount: (l.asins || []).length,
    grouped: (l.keywords || []).filter((k) => k.group).length, data: l });
  fs.mkdirSync(KWHIST_DIR(), { recursive: true });
  writeJsonAtomic(KWHIST_FILE(l.id), h.slice(-KWHIST_KEEP));
}
export function listKwHistory(id) {
  return kwHistRead(id).map(({ data, ...meta }) => meta).reverse(); // mới nhất trước
}
export function getKwVersion(id, at) { return kwHistRead(id).find((v) => v.at === at)?.data || null; }

export function listKwLists() {
  return kwListsAll().map((l) => ({ id: l.id, name: l.name, groups: l.groups || [], kwCount: (l.keywords || []).length,
    asinCount: (l.asins || []).length, updatedAt: l.updatedAt, rev: Number(l.rev) || 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
export function getKwList(id) { return kwListsAll().find((l) => l.id === id) || null; }
export function createKwList(name, data) {
  const lists = kwListsAll();
  const l = cleanKwList({ groups: [], keywords: [], asins: [], ...(data || {}), id: "kl" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name, rev: 1 });
  lists.push(l); kwListsWrite(lists);
  return l;
}
/**
 * Ghi list. opts.baseRev: rev trang đang cầm — lệch với server thì trả {conflict} (không ghi).
 * opts.force: ghi đè dù lệch (người dùng chủ động chọn) — luôn chụp bản hiện có trước.
 * opts.kind: nhãn cho bản chụp lịch sử ("tự lưu" | "nạp file" | "khôi phục" | "ghi đè").
 */
export function saveKwList(id, data, opts = {}) {
  const lists = kwListsAll();
  const i = lists.findIndex((l) => l.id === id);
  if (i === -1) return null;
  const cur = lists[i], curRev = Number(cur.rev) || 0;
  if (!opts.force && opts.baseRev !== undefined && Number(opts.baseRev) !== curRev) {
    return { conflict: true, rev: curRev, updatedAt: cur.updatedAt };
  }
  const kind = opts.kind || (opts.force ? "ghi đè" : "tự lưu");
  kwSnapshot(cur, kind, kind !== "tự lưu");
  lists[i] = cleanKwList({ ...data, id, rev: curRev + 1 });
  kwListsWrite(lists);
  return lists[i];
}
export function restoreKwVersion(id, at) {
  const v = getKwVersion(id, at);
  if (!v || !getKwList(id)) return null;
  return saveKwList(id, { ...v, id }, { force: true, kind: "trước khi khôi phục" });
}
export function deleteKwList(id) {
  const lists = kwListsAll();
  const gone = lists.find((l) => l.id === id);
  const next = lists.filter((l) => l.id !== id);
  if (!gone) return false;
  kwSnapshot(gone, "trước khi xoá", true);
  kwListsWrite(next);
  return true;
}
/** Gộp keyword mới vào list (import Cerebro / dán tay): keyword đã có thì chỉ cập nhật SV,
 *  giữ nguyên group/bid đã phân — import lại file mới không làm mất công phân group. */
export function mergeKwIntoList(id, rows, group) {
  const l = getKwList(id);
  if (!l) return null;
  const byKw = new Map(l.keywords.map((k) => [k.kw, k]));
  let added = 0, updated = 0;
  for (const r of rows || []) {
    const kw = String(r.kw || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!kw) continue;
    const ex = byKw.get(kw);
    if (ex) { if (r.sv != null) { ex.sv = r.sv; updated++; } continue; }
    const k = { kw, sv: r.sv ?? null, group: group || "", bid: null };
    l.keywords.push(k); byKw.set(kw, k); added++;
  }
  // gộp vào bản MỚI NHẤT trên server (không cần baseRev) — chụp bản trước khi nạp
  const saved = saveKwList(id, l, { force: true, kind: "trước khi nạp file" });
  return { list: saved, added, updated };
}

/** ID → tên (tên portfolio đi vào tên campaign khi campaign gom nhiều ASIN/keyword). */
export function portfolioName(id) {
  if (!id) return "";
  return readJson(PORTFOLIOS_FILE(), {})[String(id).trim()]?.name || "";
}

/* Kho keyword theo tag (mục 3.1-3.2 file kiến thức): PPC | manual | removal
   Dedup theo keyword+ASIN; ưu tiên tag: removal > PPC > manual (removal không bị ghi đè). */
const BANK_FILE = () => path.join(userDataDir(), "keyword-bank.json");
const TAG_PRIORITY = { removal: 3, PPC: 2, manual: 1 };

export function getKeywordBank(asin) {
  const all = readJson(BANK_FILE(), {});
  return asin ? all[String(asin).toUpperCase()] || {} : all;
}

export function upsertKeywords(asin, keywords, tag = "PPC", source = "launching") {
  ensureDirs();
  const all = readJson(BANK_FILE(), {});
  const key = String(asin).toUpperCase();
  all[key] = all[key] || {};
  let added = 0, kept = 0;
  for (const kw of keywords) {
    const k = String(kw).trim().toLowerCase();
    if (!k) continue;
    const cur = all[key][k];
    if (cur && (TAG_PRIORITY[cur.tag] || 0) > (TAG_PRIORITY[tag] || 0)) { kept++; continue; } // removal thắng
    all[key][k] = {
      tag, source,
      addedAt: cur?.addedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    added++;
  }
  fs.writeFileSync(BANK_FILE(), JSON.stringify(all, null, 1));
  return { added, kept };
}

export function setKeywordTag(asin, keyword, tag) {
  ensureDirs();
  const all = readJson(BANK_FILE(), {});
  const key = String(asin).toUpperCase();
  const k = String(keyword).trim().toLowerCase();
  if (all[key]?.[k]) {
    all[key][k].tag = tag;
    all[key][k].updatedAt = new Date().toISOString();
    fs.writeFileSync(BANK_FILE(), JSON.stringify(all, null, 1));
    return true;
  }
  return false;
}

/* Snapshot export (mục 2 — Output: "lưu trữ lại toàn bộ nội dung đã export để đối chiếu") */
const EXPORTS_DIR = () => path.join(userDataDir(), "exports");

export function saveExportSnapshot(meta, xlsxBuffer) {
  fs.mkdirSync(EXPORTS_DIR(), { recursive: true });
  const id = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(EXPORTS_DIR(), `${id}.xlsx`), xlsxBuffer);
  const idx = readJson(path.join(EXPORTS_DIR(), "index.json"), []);
  idx.push({ id, ...meta, createdAt: new Date().toISOString() });
  fs.writeFileSync(path.join(EXPORTS_DIR(), "index.json"), JSON.stringify(idx, null, 1));
  return id;
}
export function listExports() {
  return readJson(path.join(EXPORTS_DIR(), "index.json"), []).slice(-30).reverse();
}

/* ===== MODULE ADJUST A3: rules + proposed_changes + products (target ACoS) =====
   Map thẳng sang bảng rules / proposed_changes / products khi lên Postgres. */
const ADJUST_DIR = () => path.join(userDataDir(), "adjust");
// PHẢI là HÀM: hằng số sẽ tính lúc import (chưa có user context) → mọi user
// dùng chung file của admin gốc — rò rules/proposals giữa các phân vùng.
const RULES_FILE = () => path.join(ADJUST_DIR(), "rules.json");
const PROPOSALS_FILE = () => path.join(ADJUST_DIR(), "proposals.json");
const PRODUCTS_FILE = () => path.join(userDataDir(), "products.json");
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function ensureAdjustDir() { fs.mkdirSync(ADJUST_DIR(), { recursive: true }); }

export function listRules() { return readJson(RULES_FILE(), []); }
export function createRule(r) {
  ensureAdjustDir();
  const all = listRules();
  const rule = { id: uid(), enabled: true, priority: 100, ...r, createdAt: new Date().toISOString() };
  all.push(rule);
  fs.writeFileSync(RULES_FILE(), JSON.stringify(all, null, 1));
  return rule;
}
export function updateRule(id, patch) {
  const all = listRules();
  const r = all.find((x) => x.id === id);
  if (!r) return null;
  Object.assign(r, patch, { updatedAt: new Date().toISOString() });
  fs.writeFileSync(RULES_FILE(), JSON.stringify(all, null, 1));
  return r;
}
export function deleteRule(id) {
  ensureAdjustDir();
  fs.writeFileSync(RULES_FILE(), JSON.stringify(listRules().filter((x) => x.id !== id), null, 1));
}
/** Seed Rule Set v1 nếu bảng rule rỗng (defaults = mảng object rule). */
export function seedDefaultRulesIfEmpty(defaults) {
  if (listRules().length) return false;
  ensureAdjustDir();
  const all = (defaults || []).map((r) => ({ id: uid(), createdAt: new Date().toISOString(), ...r }));
  fs.writeFileSync(RULES_FILE(), JSON.stringify(all, null, 1));
  return true;
}
/** Reset về mặc định (xóa hết rồi seed lại). */
export function resetRules(defaults) {
  ensureAdjustDir();
  fs.writeFileSync(RULES_FILE(), JSON.stringify([], null, 1));
  return seedDefaultRulesIfEmpty(defaults);
}

export function insertProposals(rows) {
  ensureAdjustDir();
  const all = readJson(PROPOSALS_FILE(), []);
  const now = new Date().toISOString();
  const added = (rows || []).map((r) => ({ id: uid(), status: "pending", createdAt: now, ...r }));
  const merged = [...all, ...added].slice(-5000); // chống phình
  fs.writeFileSync(PROPOSALS_FILE(), JSON.stringify(merged, null, 1));
  return added;
}
export function listProposals({ datasetId, status, runId } = {}) {
  let out = readJson(PROPOSALS_FILE(), []);
  if (datasetId) out = out.filter((p) => p.datasetId === datasetId);
  if (runId) out = out.filter((p) => p.runId === runId);
  if (status) out = out.filter((p) => p.status === status);
  return out;
}
export function setProposalStatus(ids, status) {
  const set = new Set(ids || []);
  const all = readJson(PROPOSALS_FILE(), []);
  let n = 0;
  for (const p of all) if (set.has(p.id)) { p.status = status; p.reviewedAt = new Date().toISOString(); n++; }
  ensureAdjustDir();
  fs.writeFileSync(PROPOSALS_FILE(), JSON.stringify(all, null, 1));
  return n;
}
/** Đặt status cho TẤT CẢ proposals pending của 1 dataset (approve/reject all). */
export function setProposalStatusByDataset(datasetId, fromStatus, toStatus) {
  const all = readJson(PROPOSALS_FILE(), []);
  let n = 0;
  for (const p of all) if (p.datasetId === datasetId && p.status === fromStatus) { p.status = toStatus; p.reviewedAt = new Date().toISOString(); n++; }
  ensureAdjustDir();
  fs.writeFileSync(PROPOSALS_FILE(), JSON.stringify(all, null, 1));
  return n;
}

/* Products: target ACoS theo ASIN (user nhập từ margin) — rule P3/P4 cần. */
export function getProduct(asin) { return readJson(PRODUCTS_FILE(), {})[String(asin).toUpperCase()] || null; }
export function upsertProduct(asin, patch) {
  ensureDirs();
  const all = readJson(PRODUCTS_FILE(), {});
  const key = String(asin).toUpperCase();
  all[key] = { ...(all[key] || {}), ...patch, updatedAt: new Date().toISOString() };
  fs.writeFileSync(PRODUCTS_FILE(), JSON.stringify(all, null, 1));
  return all[key];
}
export function getProductsMap(asins) {
  const all = readJson(PRODUCTS_FILE(), {});
  if (!asins) return all;
  const out = {};
  for (const a of asins) { const k = String(a).toUpperCase(); if (all[k]) out[k] = all[k]; }
  return out;
}
export function listProducts() { return readJson(PRODUCTS_FILE(), {}); }

/* ===== PHÂN TÍCH KEYWORD (Helium 10 Cerebro) =====
   Ba thứ tách bạch:
     1. cookie H10   — phiên đăng nhập, agent dùng để mở Cerebro (h10-cookie.json)
     2. bộ quy tắc   — đúng các ô lọc của Cerebro + cách quét (h10-rules.json)
     3. bộ keyword   — kết quả đã lọc, lưu theo TỪNG FILE (h10/<id>.json) + index
   Lưu mỗi bộ một file vì một bộ có thể vài nghìn keyword; gộp chung một file là mỗi lần
   lưu lại phải đọc-ghi toàn bộ lịch sử — đúng vết xe của daily-rank.json trước đây. */
const H10_COOKIE_FILE = () => path.join(userDataDir(), "h10-cookie.json");
const H10_RULES_FILE = () => path.join(userDataDir(), "h10-rules.json");
const H10_DIR = () => path.join(userDataDir(), "h10");
const H10_INDEX = () => path.join(H10_DIR(), "index.json");

/** Cookie H10. Trả {cookies, note, updatedAt} — KHÔNG log ra ngoài. */
export function getH10Cookie() {
  return readJson(H10_COOKIE_FILE(), { cookies: [], storage: {}, note: "", updatedAt: null });
}
/** Lưu cookie VÀ localStorage. H10 xác thực bằng bearer token trong localStorage
 *  (CORE_BEARER_TOKEN), cookie chỉ là phần phụ — đo thật 20/10/2026: nạp đủ 30 cookie vào
 *  trình duyệt trắng vẫn bị đá ra /user/signin. Trình duyệt của người dùng vào được vì nó
 *  đã sẵn localStorage từ lần đăng nhập trước. */
export function saveH10Cookie(cookies, note, storage) {
  ensureDirs();
  const list = Array.isArray(cookies) ? cookies : [];
  const cur = getH10Cookie();
  const st = (storage && typeof storage === "object") ? storage : cur.storage || {};
  writeJsonAtomic(H10_COOKIE_FILE(), {
    cookies: list.length ? list : cur.cookies || [],
    storage: st,
    note: String(note || "").slice(0, 200), updatedAt: new Date().toISOString()
  }, 1);
  return h10CookieStatus();
}
/** Tóm tắt an toàn để hiện lên UI — KHÔNG trả giá trị cookie hay token. */
export function h10CookieStatus() {
  const c = getH10Cookie();
  const st = c.storage || {};
  const token = st.CORE_BEARER_TOKEN;
  return {
    count: (c.cookies || []).length,
    domains: [...new Set((c.cookies || []).map((x) => x.domain).filter(Boolean))],
    storageKeys: Object.keys(st).length,
    hasToken: !!(token && String(token).length > 20), // chỉ báo CÓ hay KHÔNG, không lộ giá trị
    note: c.note || "", updatedAt: c.updatedAt
  };
}

export function listH10Rules() { return readJson(H10_RULES_FILE(), []); }
export function saveH10Rules(rules) {
  ensureDirs();
  const clean = (Array.isArray(rules) ? rules : []).slice(0, 50).map((r) => ({
    ...r,
    id: r.id || uid(),
    name: String(r.name || "Bộ quy tắc").slice(0, 60),
    updatedAt: new Date().toISOString()
  }));
  writeJsonAtomic(H10_RULES_FILE(), clean, 1);
  return clean;
}

export function listH10Sets() { return readJson(H10_INDEX(), []); }
export function getH10Set(id) {
  if (!/^[\w-]+$/.test(String(id || ""))) return null;
  return readJson(path.join(H10_DIR(), `${id}.json`), null);
}
export function saveH10Set(set) {
  fs.mkdirSync(H10_DIR(), { recursive: true });
  const id = set.id && /^[\w-]+$/.test(set.id) ? set.id : uid();
  const kws = Array.isArray(set.keywords) ? set.keywords : [];
  const full = { ...set, id, keywords: kws, savedAt: new Date().toISOString() };
  writeJsonAtomic(path.join(H10_DIR(), `${id}.json`), full);
  const idx = listH10Sets().filter((x) => x.id !== id);
  idx.unshift({ id, name: full.name || "(chưa đặt tên)", asins: full.asins || [],
    ruleName: full.ruleName || "", count: kws.length, savedAt: full.savedAt });
  writeJsonAtomic(H10_INDEX(), idx.slice(0, 200), 1);
  return { id, count: kws.length };
}
export function deleteH10Set(id) {
  if (!/^[\w-]+$/.test(String(id || ""))) return false;
  try { fs.unlinkSync(path.join(H10_DIR(), `${id}.json`)); } catch {}
  // Xoá cả file LẪN index — chỉ cắt index là file nằm lại trên đĩa mãi (đã dính ở adjust)
  writeJsonAtomic(H10_INDEX(), listH10Sets().filter((x) => x.id !== id), 1);
  return true;
}

/* ===== Job queue (RUN_MODE=queue) =====
   Server trung tâm XẾP job — agent trên máy cá nhân KÉO về chạy (Phương án A, mục 8.6
   file kiến thức). Job "running" quá 30 phút coi như agent chết → trả lại hàng đợi.
   Map thẳng sang bảng jobs khi lên Postgres. */
const JOBS_FILE = () => path.join(userDataDir(), "jobs.json");

function readJobs() { return readJson(JOBS_FILE(), []); }

const JOBS_KEEP_DONE = 200; // số job ĐÃ XONG giữ lại làm lịch sử
/** Cắt bớt lịch sử nhưng KHÔNG BAO GIỜ cắt job chưa chạy xong.
 *  Trước đây là slice(-200) cứng: xếp cả lượt Run một lúc (có thể >200 ASIN) thì job cuối
 *  hàng đợi bị đẩy ra ngoài và biến mất IM LẶNG — quét thiếu mà không ai biết.
 *  Giữ nguyên thứ tự mảng vì claimNextJob lấy job pending ĐẦU TIÊN và activeSession lấy job
 *  hoạt động CŨ NHẤT làm chủ hàng đợi. */
function writeJobs(jobs) {
  ensureDirs();
  const finished = [];
  jobs.forEach((j, i) => { if (j.status !== "pending" && j.status !== "running") finished.push(i); });
  const drop = new Set(finished.slice(0, Math.max(0, finished.length - JOBS_KEEP_DONE)));
  writeJsonAtomic(JOBS_FILE(), drop.size ? jobs.filter((_, i) => !drop.has(i)) : jobs, 1);
}

const newJob = (payload, seq = 0) => ({
  id: Date.now().toString(36) + seq.toString(36) + Math.random().toString(36).slice(2, 5),
  status: "pending", // pending → running → done | error | cancelled
  payload, agent: null, logs: [],
  createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
  resultRunId: null, error: null
});

/** Xếp NHIỀU job trong MỘT lần đọc-ghi — cả lượt Run vào hàng đợi cùng lúc.
 *  Đây là thứ cho phép người dùng chuyển tab / đóng trình duyệt mà lượt quét vẫn chạy tiếp:
 *  trước đây trình duyệt mới là nơi giữ vòng lặp "ASIN kế tiếp". */
export function enqueueJobs(payloads) {
  const jobs = readJobs();
  const added = (payloads || []).map((p, i) => newJob(p, i));
  jobs.push(...added);
  writeJobs(jobs);
  return added;
}

export function enqueueJob(payload) {
  const jobs = readJobs();
  const job = newJob(payload);
  jobs.push(job);
  writeJobs(jobs);
  return job;
}

/** Tiến độ lượt chạy đang chiếm hàng đợi (null = rảnh) — nguồn cho thanh trạng thái ở MỌI trang.
 *  Nhờ nó mà mở tab Adjust/Launching vẫn thấy lượt quét đang chạy tới đâu. */
/* CHỈ xét job quét ranking (payload không có kind). Job H10/libscan là việc độc lập — để
   chúng chiếm khóa hàng đợi thì một lượt phân tích keyword đang chờ sẽ chặn đứng cả việc
   bấm Run quét ranking, trong khi hai thứ chẳng liên quan gì nhau. */
const isRankJob = (j) => !j.payload?.kind;

export function activeRun() {
  const jobs = readJobs().filter(isRankJob);
  const live = jobs.filter((j) => j.status === "pending" || j.status === "running");
  if (!live.length) return null;
  const runId = live[0].payload?.runId || null;
  const mine = jobs.filter((j) => (j.payload?.runId || null) === runId);
  const cur = live.find((j) => j.status === "running");
  const count = (s) => mine.filter((j) => j.status === s).length;
  return {
    runId, dateKey: live[0].payload?.dateKey || null,
    total: mine.length,
    done: count("done"), error: count("error"), cancelled: count("cancelled"), pending: count("pending"),
    current: cur ? {
      id: cur.id, asin: cur.payload?.asin || null, agent: cur.agent,
      keywords: (cur.payload?.keywords || []).length,
      logs: (cur.logs || []).slice(-40)
    } : null
  };
}

// Mất heartbeat bao lâu thì coi là agent chết. Trước đây là "running > 30 phút" — sai với
// ASIN nhiều keyword: 200 keyword × ~6s ≈ 20 phút, cộng reload/quét bù là vượt 30 phút rất
// dễ → job đang chạy bình thường bị phát lại và quét TRÙNG. Giờ đo bằng heartbeat thật
// (agent gửi log/kết quả → cập nhật lastSeen), nên job chạy bao lâu cũng được.
const JOB_STALE_MS = 5 * 60000;

/** Agent xin job kế tiếp.
 *  KHÔNG cần lock: hàm này đồng bộ hoàn toàn (readFileSync/writeFileSync, không await) nên
 *  trong 1 tiến trình Node nó không thể bị chen ngang → 2 agent không thể cùng giành 1 job.
 *  ⚠️ Nếu sau này Railway scale ≥2 replica (2 tiến trình chung volume) thì điều này KHÔNG
 *  còn đúng — lúc đó phải thêm lock file (O_EXCL) hoặc chuyển hàng đợi sang Postgres. */
/* Job nào cần máy có khả năng gì. Job H10 phải chạy trên máy có cửa sổ Chrome đã đăng nhập
   Helium 10 — giao cho máy chỉ quét ranking là chắc chắn hỏng. Agent khai khả năng của mình
   khi poll; agent bản cũ không khai gì thì coi như KHÔNG làm được việc cần khả năng đặc biệt
   (thà job nằm chờ đúng máy còn hơn hỏng ở máy sai). */
const JOB_NEEDS = { h10check: "h10", h10scan: "h10" };
const agentCan = (job, caps) => {
  const need = JOB_NEEDS[job.payload?.kind];
  return !need || !!(caps && caps[need]);
};

export function claimNextJob(agentName, caps) {
  const jobs = readJobs();
  const now = Date.now();
  let dirty = false;

  // 1. Thu hồi job mất heartbeat — dựng lại payload = ĐÚNG PHẦN CÒN THIẾU (không quét trùng)
  for (const j of jobs) {
    if (j.status !== "running") continue;
    const beat = new Date(j.lastSeen || j.startedAt || 0).getTime();
    if (now - beat <= JOB_STALE_MS) continue;
    dirty = true;
    const p = j.payload || {};
    const resumable = p.dateKey && p.asin && Array.isArray(p.keywords);
    const left = resumable ? missingKeywords(p.asin, p.keywords, p.dateKey) : (p.keywords || []);
    if (resumable && !left.length) {
      j.status = "done"; j.finishedAt = new Date().toISOString();
      j.logs.push("✅ Mất heartbeat nhưng cột đã đủ dữ liệu — coi như xong, không quét lại");
      continue;
    }
    const skipped = (p.keywords || []).length - left.length;
    j.payload = { ...p, keywords: left };
    j.status = "pending"; j.agent = null; j.startedAt = null; j.lastSeen = null;
    j.logs.push(`⚠️ Mất heartbeat >${JOB_STALE_MS / 60000} phút — trả lại hàng đợi với ${left.length} keyword còn thiếu`
      + (skipped > 0 ? ` (bỏ ${skipped} keyword đã có dữ liệu)` : ""));
  }

  /* 2. SINGLE-FLIGHT THEO LÀN, không phải toàn cục.
     Mỗi loại việc là một làn riêng; trong một làn chỉ 1 job chạy tại một thời điểm.
     - làn "rank": lý do gốc của single-flight — tránh 2 agent cùng đọc-sửa-ghi chuỗi rank
     - làn "h10check"/"h10scan": chạy trên Chrome riêng, không đụng gì tới dữ liệu rank
     Khoá toàn cục như trước thì máy B không làm được việc H10 chỉ vì máy A đang quét
     ranking — hai việc chẳng liên quan, mà người dùng lại cắm 2 máy đúng để làm song song. */
  const laneOf = (j) => j.payload?.kind || "rank";
  const busyLanes = new Set(jobs.filter((j) => j.status === "running").map(laneOf));

  /* Bỏ qua job mà máy này không làm được hoặc làn đang bận, XÉT TIẾP job sau — không trả
     null, nếu không một job H10 nằm đầu hàng đợi sẽ chặn đứng mọi job ranking phía sau. */
  const job = jobs.find((j) => j.status === "pending" && agentCan(j, caps) && !busyLanes.has(laneOf(j)));
  // 3. Hàng đợi rỗng → KHÔNG ghi file. Trước đây mọi lần poll đều rewrite jobs.json:
  //    4 lần/phút/agent = ~5.760 lượt ghi volume Railway mỗi ngày dù không có việc gì.
  if (!job) {
    if (dirty) writeJobs(jobs);
    return null;
  }

  job.status = "running";
  job.agent = agentName || "?";
  job.startedAt = new Date().toISOString();
  job.lastSeen = job.startedAt;
  writeJobs(jobs);
  return job;
}

/** Ghi NHIỀU dòng log trong 1 lần đọc-ghi file + cập nhật heartbeat.
 *  Agent gom log rồi gửi theo lô: 200 keyword trước đây là ~250-300 request và ~250-300 lần
 *  rewrite jobs.json trên volume Railway; giờ còn ~40. Mỗi lần ghi cũng là 1 nhịp heartbeat
 *  nên job dài bao lâu cũng không bị coi là treo. */
export function appendJobLogs(id, lines) {
  const arr = (Array.isArray(lines) ? lines : [lines]).filter((l) => l != null);
  if (!arr.length) return;
  const jobs = readJobs();
  const j = jobs.find((x) => x.id === id);
  if (!j) return;
  for (const l of arr) j.logs.push(String(l).slice(0, 500));
  if (j.logs.length > 500) j.logs = j.logs.slice(-400);
  j.lastSeen = new Date().toISOString(); // heartbeat
  writeJobs(jobs);
}
export function appendJobLog(id, line) { appendJobLogs(id, [line]); } // giữ cho agent bản cũ

/** Lượt chạy đang CHIẾM hàng đợi, hay null nếu rảnh.
 *  Dùng để khóa nút Run: mỗi vòng lặp chạy ở trình duyệt mang một runId riêng, ai xếp job
 *  trước thì giữ hàng đợi cho tới khi xếp hết. Lần bấm Run thứ hai (runId khác) bị từ chối
 *  ngay ở server nên khóa ăn cả trường hợp mở 2 tab / 2 máy, không chỉ 1 tab.
 *  Lấy job hoạt động CŨ NHẤT làm chủ — người đến trước giữ chỗ. */
export function activeSession() {
  const act = readJobs().filter(isRankJob).filter((j) => j.status === "pending" || j.status === "running");
  if (!act.length) return null;
  const owner = act[0];
  return {
    runId: owner.payload?.runId || null,
    dateKey: owner.payload?.dateKey || null,
    count: act.length,
    running: act.some((j) => j.status === "running")
  };
}

/** Bấm ⏹ Dừng — ĐÓNG SỔ NGAY mọi job chưa xong, cả pending lẫn running.
 *
 *  Trước đây job đang chạy chỉ được GẮN CỜ và giữ nguyên status "running", chờ agent tự
 *  báo xong. Hậu quả: khóa hàng đợi không nhả, người dùng bấm Dừng rồi bấm Run vẫn bị báo
 *  "hàng đợi đang thuộc lượt chạy khác" — Dừng nhìn như không có tác dụng. Tệ hơn, nếu agent
 *  đã tắt/mất mạng thì không bao giờ có ai báo xong, và trong 5 phút chờ hết heartbeat thì
 *  Dừng cũng bó tay.
 *  Giờ Dừng là dứt khoát: status → "cancelled" (nhả khóa tức thì) VÀ stopRequested = true
 *  (agent đọc được ở lô kế tiếp rồi tự bỏ dở). Dữ liệu đã quét không mất — mỗi lô 5 keyword
 *  đã được ghi qua /api/agent/partial trước đó rồi.
 *  Trả về {stopping, cancelled} = số job đang chạy / đang chờ bị đóng sổ. */
/** Dừng ĐÚNG MỘT job. requestStopJobs() hủy sạch mọi job chưa xong — đúng cho nút Dừng của
 *  trang Check Ranking, nhưng sai cho trang Phân tích Keyword: ở đó bấm Dừng sẽ giết luôn
 *  lượt quét rank mà người khác trong team đang chạy. */
export function requestStopJob(id) {
  const jobs = readJobs();
  const j = jobs.find((x) => x.id === id);
  if (!j || (j.status !== "pending" && j.status !== "running")) return false;
  j.stopRequested = true;
  j.status = "cancelled";
  j.finishedAt = new Date().toISOString();
  j.logs.push("⏹ Đã dừng theo yêu cầu — phần đã quét xong vẫn được giữ");
  writeJobs(jobs);
  return true;
}

export function requestStopJobs() {
  const jobs = readJobs();
  const now = new Date().toISOString();
  let stopping = 0, cancelled = 0;
  for (const j of jobs) {
    if (j.status !== "pending" && j.status !== "running") continue;
    const wasRunning = j.status === "running";
    j.stopRequested = true;
    j.status = "cancelled";
    j.finishedAt = now;
    j.logs.push(wasRunning
      ? "⏹ Đã dừng theo yêu cầu — agent sẽ bỏ dở ở lô kế tiếp, kết quả đã quét vẫn giữ"
      : "⏹ Đã hủy khi còn chờ trong hàng đợi");
    wasRunning ? stopping++ : cancelled++;
  }
  if (stopping || cancelled) writeJobs(jobs);
  return { stopping, cancelled };
}

/** Job này có đang được yêu cầu dừng không (agent hỏi ở mỗi lô).
 *  "cancelled" cũng tính: job bị hủy vì mất heartbeat, agent ngủ dậy đẩy lô lên thì phải
 *  biết mình đã bị thu hồi và dừng ngay, thay vì quét tiếp cho một job không còn ai chờ. */
export function isStopRequested(id) {
  if (!id) return false;
  const j = readJobs().find((x) => x.id === id);
  return !!j && (j.stopRequested === true || j.status === "cancelled");
}

// Job đã bị ⏹ Dừng đóng sổ thì agent báo về muộn KHÔNG được hồi sinh nó: làm vậy sẽ dựng
// lại một job "running/done" sau khi người dùng đã dọn hàng đợi và bắt đầu lượt mới.
// Chỉ chặn việc đổi trạng thái — dữ liệu quét được vẫn lưu bình thường ở /api/agent/result.
const finalized = (j) => !j || j.status === "cancelled";

/** Job xong rồi thì log chi tiết không còn tác dụng: người dùng đã xem trực tiếp lúc chạy, và
 *  bản đầy đủ nằm ở results/<id>.json. Giữ nguyên 500 dòng × 200 job là jobs.json phình tới
 *  ~6 MB — mà file này bị ĐỌC LẠI mỗi 3 giây bởi thanh tiến độ. Giữ 40 dòng cuối là đủ để
 *  soi nguyên nhân lỗi. */
const trimLogs = (j) => { if ((j.logs || []).length > 40) j.logs = j.logs.slice(-40); };

export function completeJob(id, runId) {
  const jobs = readJobs();
  const j = jobs.find((x) => x.id === id);
  if (finalized(j)) return;
  j.status = "done"; j.resultRunId = runId; j.finishedAt = new Date().toISOString();
  trimLogs(j);
  writeJobs(jobs);
}

export function failJob(id, error) {
  const jobs = readJobs();
  const j = jobs.find((x) => x.id === id);
  if (finalized(j)) return;
  j.status = "error"; j.error = String(error); j.finishedAt = new Date().toISOString();
  trimLogs(j);
  writeJobs(jobs);
}

export function getJob(id) { return readJobs().find((x) => x.id === id) || null; }
export function listJobs() { return readJobs().slice(-50).reverse(); }

/** Lưu run do AGENT đẩy lên (giữ nguyên id của agent để không trùng). */
export function importRunResult(run) {
  ensureDirs();
  const id = run.id || new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(RESULTS_DIR(), `${id}.json`), JSON.stringify({ ...run, id }, null, 2));
  return id;
}

/* ===== Kết quả check ===== */
export function saveRunResult(run) {
  ensureDirs();
  const id = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(RESULTS_DIR(), `${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ id, ...run }, null, 2));
  return id;
}

export function listRunResults() {
  ensureDirs();
  return fs.readdirSync(RESULTS_DIR())
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()
    .map((f) => {
      const r = readJson(path.join(RESULTS_DIR(), f), {});
      return { id: r.id, asin: r.asin, checkedAt: r.checkedAt, keywordCount: (r.results || []).length };
    });
}

export function getRunResult(id) {
  if (!/^[\w-]+$/.test(id)) return null;
  return readJson(path.join(RESULTS_DIR(), `${id}.json`), null);
}
