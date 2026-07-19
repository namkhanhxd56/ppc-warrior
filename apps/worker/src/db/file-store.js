// file-store.js — Lưu trữ local bằng file JSON (giai đoạn chưa nối Postgres)
// Sau này thay bằng pg-store.js cùng interface → các module khác không đổi.

import fs from "fs";
import path from "path";

const DATA_DIR = "./data";
const VARIANTS_FILE = path.join(DATA_DIR, "variants-cache.json");
const RESULTS_DIR = path.join(DATA_DIR, "results");

function ensureDirs() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

/* ===== Cache biến thể (parent/child) ===== */
export function getProductVariants(asin) {
  const cache = readJson(VARIANTS_FILE, {});
  return cache[asin] || null; // {parentAsin, childAsins, checkedAt}
}

export function saveProductVariants(asin, parentAsin, childAsins) {
  ensureDirs();
  const cache = readJson(VARIANTS_FILE, {});
  cache[asin] = { parentAsin, childAsins, checkedAt: new Date().toISOString() };
  // các child cùng nhóm dùng chung cache
  for (const c of childAsins || []) {
    cache[c] = cache[asin];
  }
  fs.writeFileSync(VARIANTS_FILE, JSON.stringify(cache, null, 2));
}

/* ===== Lịch check daily ===== */
const SCHEDULE_FILE = path.join(DATA_DIR, "schedule.json");

export function getSchedule() {
  return readJson(SCHEDULE_FILE, { enabled: false, time: "07:00", jobs: [], lastRunDate: null });
}

export function saveSchedule(s) {
  ensureDirs();
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(s, null, 2));
}

/* ===== Cấu hình worker (zip code...) — sau này chuyển thành cấu hình theo project ===== */
const CONFIG_FILE = path.join(DATA_DIR, "worker-config.json");

export function getWorkerConfig() {
  return readJson(CONFIG_FILE, { zip: "10011" }); // spec gốc: zip theo project, hiện 10011
}

export function saveWorkerConfig(cfg) {
  ensureDirs();
  const cur = getWorkerConfig();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...cur, ...cfg, updatedAt: new Date().toISOString() }, null, 2));
  return getWorkerConfig();
}

/* ===== Cài đặt theo ASIN (toggle track parent...) ===== */
const SETTINGS_FILE = path.join(DATA_DIR, "asin-settings.json");

export function getAsinSettings(asin) {
  return readJson(SETTINGS_FILE, {})[asin] || null; // {trackParent: bool}
}

export function saveAsinSettings(asin, settings) {
  ensureDirs();
  const all = readJson(SETTINGS_FILE, {});
  all[asin] = { ...(all[asin] || {}), ...settings, updatedAt: new Date().toISOString() };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(all, null, 2));
}

/* ===== Chỉ số ads theo ASIN × ngày (từ file bulk daily / business report) ===== */
const METRICS_FILE = path.join(DATA_DIR, "asin-metrics.json");

export function saveAsinMetrics(asin, date, metrics) {
  ensureDirs();
  const all = readJson(METRICS_FILE, {});
  all[asin] = all[asin] || {};
  all[asin][date] = { ...(all[asin][date] || {}), ...metrics, updatedAt: new Date().toISOString() };
  fs.writeFileSync(METRICS_FILE, JSON.stringify(all, null, 2));
}

export function getAsinMetrics(asin) {
  return readJson(METRICS_FILE, {})[asin] || {}; // { "2026-07-13": {spent, salesAds, ordersAds, salesTotal} }
}

/* ===== CHUỖI THỜI GIAN DAILY (nguồn cho báo cáo tổng hợp / biểu đồ / dự phóng) =====
   Cấu trúc: { asin: { keyword: { "YYYY-MM-DD": {r, p, n, tos, ros, vid, sb, car, pv, va, t} } } }
   - r: organic rank toàn cục | p: page | n: no trong trang | tos: "x/y"
   - ros/vid/sb/car: 0|1 | pv: ownPreviouslyViewed | va: variant asin rank thay (nếu chính vắng)
   - t: checkedAt — nhiều lần check trong ngày → lần CUỐI thắng
   Map thẳng sang bảng rank_checks khi lên Postgres. */
const DAILY_FILE = path.join(DATA_DIR, "daily-rank.json");

export function saveDailyRanks(asin, checkedAt, results, dateKey) {
  ensureDirs();
  const all = readJson(DAILY_FILE, {});
  const date = dateKey || String(checkedAt).slice(0, 10); // dateKey = nhãn PHIÊN QUÉT (Run tạo mới, Continue nối vào)
  all[asin] = all[asin] || {};
  for (const x of results || []) {
    if (x.error) continue;
    const p = x.primary || {};
    const bestVar = (x.variants || []).find((v) => v.organicRank !== null);
    all[asin][x.keyword] = all[asin][x.keyword] || {};
    all[asin][x.keyword][date] = {
      r: p.organicRank, page: p.organicPage, n: p.organicPosInPage,
      // adsTilesServed === false → phiên không được serve SP tile: "?" (không kết
      // luận được), KHÔNG ghi 0/0 giả vào chuỗi lịch sử
      tos: x.adsTilesServed === false ? "?" : `${p.tosPosition || 0}/${p.tosTotal || 0}`,
      ros: p.rosPresent ? 1 : 0, vid: p.videoPresent ? 1 : 0,
      sb: p.sbPresent ? 1 : 0, car: p.spCarouselPresent ? 1 : 0,
      pv: p.ownPreviouslyViewed ? 1 : 0,
      bdg: (p.ownBadges || []).length ? p.ownBadges : undefined, // Overall Pick, Amazon's Choice...
      va: p.organicRank === null && bestVar ? { asin: bestVar.asin, r: bestVar.organicRank } : null,
      rc: x.resultCount || null,
      t: checkedAt
    };
  }
  fs.writeFileSync(DAILY_FILE, JSON.stringify(all));
  // Tự đăng ký ASIN + keyword vào bảng theo dõi + ghi nhãn phiên
  trackingRegisterRun(asin, (results || []).filter((x) => !x.error).map((x) => x.keyword), date);
  // Gộp competitor snapshot của phiên (nếu có)
  saveCompetitorAgg(asin, date, results);
}

export function getDailySeries(asin) {
  return readJson(DAILY_FILE, {})[asin] || {}; // { keyword: { date: {...} } }
}

/* ===== BẢNG THEO DÕI RANKING (tracking) =====
   tracking.json: cấu hình hiển thị/bật-tắt của bảng luôn-hiện:
   { asins: { ASIN: { enabled, loai, image, trackParent, saveCompetitor,
                      keywords: { kw: { enabled, volume, loai } } } },
     sessions: ["2026-07-14", "2026-07-19 09:45", ...],
     config: { metrics: ["Sale","Sale ads","Spent"], kwFields: ["tos","ros"] } } */
const TRACKING_FILE = path.join(DATA_DIR, "tracking.json");

export function getTracking() {
  const t = readJson(TRACKING_FILE, {});
  t.asins = t.asins || {};
  t.sessions = t.sessions || [];
  t.config = t.config || {};
  t.config.metrics = t.config.metrics || ["Sale", "Sale ads", "Spent"];
  t.config.kwFields = t.config.kwFields || ["tos", "ros"];
  return t;
}
function writeTracking(t) {
  ensureDirs();
  fs.writeFileSync(TRACKING_FILE, JSON.stringify(t, null, 1));
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
    const daily = readJson(DAILY_FILE, {}); delete daily[key];
    fs.writeFileSync(DAILY_FILE, JSON.stringify(daily));
    const met = readJson(METRICS_FILE, {}); delete met[key];
    fs.writeFileSync(METRICS_FILE, JSON.stringify(met, null, 1));
    const comp = readJson(COMPRANK_FILE, {}); delete comp[key];
    fs.writeFileSync(COMPRANK_FILE, JSON.stringify(comp));
    writeTracking(t);
    return t;
  }
  t.asins[key] = t.asins[key] || { enabled: true, loai: "", image: null, trackParent: false, saveCompetitor: false, keywords: {}, addedAt: new Date().toISOString() };
  for (const f of ["enabled", "loai", "trackParent", "saveCompetitor", "image", "adsScan"]) {
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
    const daily = readJson(DAILY_FILE, {});
    if (daily[key]) { delete daily[key][k]; fs.writeFileSync(DAILY_FILE, JSON.stringify(daily)); }
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
  writeTracking(t);
  return t.config;
}

/** Xoá 1 ngày/phiên khỏi toàn bộ data (daily-rank, metrics, competitor, sessions). */
export function trackingDeleteDate(dateKey) {
  const daily = readJson(DAILY_FILE, {});
  for (const asin of Object.keys(daily)) {
    for (const kw of Object.keys(daily[asin])) delete daily[asin][kw][dateKey];
  }
  fs.writeFileSync(DAILY_FILE, JSON.stringify(daily));
  const met = readJson(METRICS_FILE, {});
  for (const asin of Object.keys(met)) delete met[asin][dateKey];
  fs.writeFileSync(METRICS_FILE, JSON.stringify(met, null, 1));
  const comp = readJson(COMPRANK_FILE, {});
  for (const asin of Object.keys(comp)) { if (comp[asin]) delete comp[asin][dateKey]; }
  fs.writeFileSync(COMPRANK_FILE, JSON.stringify(comp));
  const t = getTracking();
  t.sessions = t.sessions.filter((s) => s !== dateKey);
  writeTracking(t);
}

/** Bảng đầy đủ cho UI: cấu hình + series + metrics + phân loại PPC từ kho keyword. */
export function getTrackingTable() {
  const t = getTracking();
  const daily = readJson(DAILY_FILE, {});
  const met = readJson(METRICS_FILE, {});
  const bank = readJson(BANK_FILE, {});
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

/* ===== Xếp hạng COMPETITOR theo phiên quét =====
   competitor-rank.json: { asin: { dateKey: { compAsin: {n, bestRank, kws: [...]} } } }
   n = số keyword (trong nhóm keyword của mình) mà competitor xuất hiện (ads hoặc organic top 10). */
const COMPRANK_FILE = path.join(DATA_DIR, "competitor-rank.json");

export function saveCompetitorAgg(asin, dateKey, results) {
  const key = String(asin).toUpperCase();
  const agg = {};
  let has = false;
  for (const x of results || []) {
    if (x.error || !Array.isArray(x.snapshot)) continue;
    const seen = new Set();
    for (const s of x.snapshot) {
      const a = String(s.asin || "").toUpperCase();
      if (!/^[A-Z0-9]{10}$/.test(a) || a === key) continue;
      const sponsored = s.type && s.type !== "ORGANIC";
      const orgTop10 = s.organicRank != null && s.organicRank <= 10;
      if (!sponsored && !orgTop10) continue; // competitor chỉ tính: ads + organic top 10
      has = true;
      if (seen.has(a)) { // đã đếm keyword này — chỉ cập nhật bestRank
        if (s.organicRank != null) agg[a].bestRank = Math.min(agg[a].bestRank ?? 999, s.organicRank);
        continue;
      }
      seen.add(a);
      agg[a] = agg[a] || { n: 0, bestRank: null, kws: [] };
      agg[a].n++;
      agg[a].kws.push(x.keyword);
      if (s.organicRank != null) agg[a].bestRank = Math.min(agg[a].bestRank ?? 999, s.organicRank);
    }
  }
  if (!has) return;
  const all = readJson(COMPRANK_FILE, {});
  all[key] = all[key] || {};
  const cur = all[key][dateKey] || {};
  for (const [a, v] of Object.entries(agg)) {
    const c = cur[a] || { n: 0, bestRank: null, kws: [] };
    const kws = [...new Set([...c.kws, ...v.kws])];
    cur[a] = { n: kws.length, bestRank: Math.min(c.bestRank ?? 999, v.bestRank ?? 999) === 999 ? null : Math.min(c.bestRank ?? 999, v.bestRank ?? 999), kws };
  }
  all[key][dateKey] = cur;
  fs.writeFileSync(COMPRANK_FILE, JSON.stringify(all));
}

export function getCompetitorRank(asin, dateKey) {
  const all = readJson(COMPRANK_FILE, {})[String(asin).toUpperCase()] || {};
  const dates = Object.keys(all).sort();
  const d = dateKey || dates[dates.length - 1];
  const list = Object.entries(all[d] || {})
    .map(([a, v]) => ({ asin: a, n: v.n, bestRank: v.bestRank, kws: v.kws }))
    .sort((x, y) => y.n - x.n || (x.bestRank ?? 999) - (y.bestRank ?? 999));
  return { date: d || null, dates, list };
}

/* ===== Module LAUNCHING: cài đặt + kho keyword + snapshot export ===== */
const LAUNCH_FILE = path.join(DATA_DIR, "launch-settings.json");

/** Thông tin lưu lại theo yêu cầu: SKU, ASIN, Portfolio ID, Mã cá nhân (KHÔNG lưu ngày tạo)
    + naming templates + cấu hình bid/campaign. */
export function getLaunchSettings() {
  return readJson(LAUNCH_FILE, {});
}
export function saveLaunchSettings(s) {
  ensureDirs();
  const cur = getLaunchSettings();
  delete s.startDate; // ngày tạo không lưu — mặc định today mỗi lần mở
  const merged = { ...cur, ...s, updatedAt: new Date().toISOString() };
  // HỒ SƠ SẢN PHẨM: lưu theo ASIN — sau này gõ ASIN hoặc SKU là các trường còn lại
  // (SKU/ASIN, Tên phân loại, mã cá nhân) tự điền lại
  if (s.asin && /^[A-Z0-9]{10}$/i.test(s.asin)) {
    merged.products = { ...(cur.products || {}) };
    merged.products[String(s.asin).toUpperCase()] = {
      sku: s.sku || "", category: s.category || "", manager: s.manager || "",
      updatedAt: new Date().toISOString()
    };
  }
  fs.writeFileSync(LAUNCH_FILE, JSON.stringify(merged, null, 2));
  return getLaunchSettings();
}

/* Kho keyword theo tag (mục 3.1-3.2 file kiến thức): PPC | manual | removal
   Dedup theo keyword+ASIN; ưu tiên tag: removal > PPC > manual (removal không bị ghi đè). */
const BANK_FILE = path.join(DATA_DIR, "keyword-bank.json");
const TAG_PRIORITY = { removal: 3, PPC: 2, manual: 1 };

export function getKeywordBank(asin) {
  const all = readJson(BANK_FILE, {});
  return asin ? all[String(asin).toUpperCase()] || {} : all;
}

export function upsertKeywords(asin, keywords, tag = "PPC", source = "launching") {
  ensureDirs();
  const all = readJson(BANK_FILE, {});
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
  fs.writeFileSync(BANK_FILE, JSON.stringify(all, null, 1));
  return { added, kept };
}

export function setKeywordTag(asin, keyword, tag) {
  ensureDirs();
  const all = readJson(BANK_FILE, {});
  const key = String(asin).toUpperCase();
  const k = String(keyword).trim().toLowerCase();
  if (all[key]?.[k]) {
    all[key][k].tag = tag;
    all[key][k].updatedAt = new Date().toISOString();
    fs.writeFileSync(BANK_FILE, JSON.stringify(all, null, 1));
    return true;
  }
  return false;
}

/* Snapshot export (mục 2 — Output: "lưu trữ lại toàn bộ nội dung đã export để đối chiếu") */
const EXPORTS_DIR = path.join(DATA_DIR, "exports");

export function saveExportSnapshot(meta, xlsxBuffer) {
  fs.mkdirSync(EXPORTS_DIR, { recursive: true });
  const id = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(EXPORTS_DIR, `${id}.xlsx`), xlsxBuffer);
  const idx = readJson(path.join(EXPORTS_DIR, "index.json"), []);
  idx.push({ id, ...meta, createdAt: new Date().toISOString() });
  fs.writeFileSync(path.join(EXPORTS_DIR, "index.json"), JSON.stringify(idx, null, 1));
  return id;
}
export function listExports() {
  return readJson(path.join(EXPORTS_DIR, "index.json"), []).slice(-30).reverse();
}

/* ===== Job queue (RUN_MODE=queue) =====
   Server trung tâm XẾP job — agent trên máy cá nhân KÉO về chạy (Phương án A, mục 8.6
   file kiến thức). Job "running" quá 30 phút coi như agent chết → trả lại hàng đợi.
   Map thẳng sang bảng jobs khi lên Postgres. */
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");

function readJobs() { return readJson(JOBS_FILE, []); }
function writeJobs(jobs) {
  ensureDirs();
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs.slice(-200), null, 1)); // giữ 200 job gần nhất
}

export function enqueueJob(payload) {
  const jobs = readJobs();
  const job = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    status: "pending", // pending → running → done | error
    payload, agent: null, logs: [],
    createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
    resultRunId: null, error: null
  };
  jobs.push(job);
  writeJobs(jobs);
  return job;
}

export function claimNextJob(agentName) {
  const jobs = readJobs();
  const now = Date.now();
  for (const j of jobs) {
    if (j.status === "running" && j.startedAt && now - new Date(j.startedAt).getTime() > 30 * 60000) {
      j.status = "pending"; j.agent = null;
      j.logs.push("⚠️ Job treo quá 30 phút — trả lại hàng đợi");
    }
  }
  const job = jobs.find((j) => j.status === "pending");
  if (job) {
    job.status = "running";
    job.agent = agentName || "?";
    job.startedAt = new Date().toISOString();
  }
  writeJobs(jobs);
  return job || null;
}

export function appendJobLog(id, line) {
  const jobs = readJobs();
  const j = jobs.find((x) => x.id === id);
  if (!j) return;
  j.logs.push(line);
  if (j.logs.length > 500) j.logs = j.logs.slice(-400);
  writeJobs(jobs);
}

export function completeJob(id, runId) {
  const jobs = readJobs();
  const j = jobs.find((x) => x.id === id);
  if (!j) return;
  j.status = "done"; j.resultRunId = runId; j.finishedAt = new Date().toISOString();
  writeJobs(jobs);
}

export function failJob(id, error) {
  const jobs = readJobs();
  const j = jobs.find((x) => x.id === id);
  if (!j) return;
  j.status = "error"; j.error = String(error); j.finishedAt = new Date().toISOString();
  writeJobs(jobs);
}

export function getJob(id) { return readJobs().find((x) => x.id === id) || null; }
export function listJobs() { return readJobs().slice(-50).reverse(); }

/** Lưu run do AGENT đẩy lên (giữ nguyên id của agent để không trùng). */
export function importRunResult(run) {
  ensureDirs();
  const id = run.id || new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(RESULTS_DIR, `${id}.json`), JSON.stringify({ ...run, id }, null, 2));
  return id;
}

/* ===== Kết quả check ===== */
export function saveRunResult(run) {
  ensureDirs();
  const id = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(RESULTS_DIR, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ id, ...run }, null, 2));
  return id;
}

export function listRunResults() {
  ensureDirs();
  return fs.readdirSync(RESULTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()
    .map((f) => {
      const r = readJson(path.join(RESULTS_DIR, f), {});
      return { id: r.id, asin: r.asin, checkedAt: r.checkedAt, keywordCount: (r.results || []).length };
    });
}

export function getRunResult(id) {
  if (!/^[\w-]+$/.test(id)) return null;
  return readJson(path.join(RESULTS_DIR, `${id}.json`), null);
}
