// server.js — PPC Warrior Worker: UI check ranking chạy local (http://localhost:3100)
import express from "express";
import fs from "fs";
import dotenv from "dotenv";
import multer from "multer";
import * as XLSX from "xlsx";
import { launchBrowser, loadCookies, newCleanPage, verifySession } from "./src/scraper/browser.js";
import { setZipLocation, ensureZipLocation } from "./src/scraper/set-location.js";
import { runBatch } from "./src/jobs/run-batch.js";
import { planCampaigns, buildRowsFromPlans, buildSdRows, buildSbRows, BULK_HEADER, SD_HEADER, SB_HEADER, DEFAULTS as LAUNCH_DEFAULTS } from "./src/launching/bulk-builder.js";
import { parseH10 } from "./src/launching/h10-parser.js";
import { etlBulk, queryRows, buildUpdateRows, rowKey } from "./src/adjust/bulk-etl.js";
import * as store from "./src/db/file-store.js";

dotenv.config();
export const APP_VERSION = "0.21.0"; // tăng mỗi lần sửa API — UI đối chiếu để cảnh báo quên restart

// RUN_MODE:
// - "local" (mặc định): bấm Kiểm tra là scrape NGAY trên máy này (dùng 1 người, chạy local)
// - "queue" (server Railway cho team): bấm Kiểm tra chỉ XẾP JOB vào hàng đợi —
//   agent trên máy cá nhân từng người kéo về chạy ngầm rồi đẩy kết quả lên (Phương án A)
const RUN_MODE = process.env.RUN_MODE === "queue" ? "queue" : "local";
const app = express();
// Railway/PaaS cấp cổng qua biến PORT — ưu tiên nó; local vẫn là 3100
const PORT = Number(process.env.PORT || process.env.WORKER_PORT || 3100);
const COOKIES_PATH = process.env.COOKIES_PATH || "./cookies.json";

let running = false;
let stopFlag = false;

// Bảo vệ bằng mật khẩu khi chạy trên VPS mở port ra internet (đặt WORKER_PASSWORD trong .env).
// Không đặt → không hỏi (chạy local như cũ). Trình duyệt sẽ tự hiện hộp đăng nhập,
// user = bất kỳ (VD "admin"), password = WORKER_PASSWORD.
const PASSWORD = process.env.WORKER_PASSWORD || "";
if (PASSWORD) {
  app.use((req, res, next) => {
    const auth = req.headers.authorization || "";
    const pass = auth.startsWith("Basic ")
      ? Buffer.from(auth.slice(6), "base64").toString().split(":").slice(1).join(":")
      : "";
    if (pass === PASSWORD) return next();
    res.set("WWW-Authenticate", 'Basic realm="PPC Warrior Worker"');
    res.status(401).send("Cần mật khẩu (WORKER_PASSWORD)");
  });
}

app.use(express.json({ limit: "25mb" })); // agent đẩy run kèm snapshot có thể lớn
app.use(express.static("public"));

app.get("/api/version", (req, res) => res.json({ version: APP_VERSION, runMode: RUN_MODE }));

/* ===== Cookies (giữ zip code) ===== */
app.get("/api/cookies", (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(COOKIES_PATH, "utf8"))); }
  catch { res.json([]); }
});

app.post("/api/cookies", (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ ok: false, message: "Phải là JSON array" });
  fs.writeFileSync(COOKIES_PATH, JSON.stringify(req.body, null, 2));
  res.json({ ok: true });
});

/* ===== Lõi thực thi check — dùng chung cho manual & scheduler ===== */
async function executeCheck({ asin, keywords, maxPages, checkVariants, saveSnapshot, debug, dateKey, competitorMode, adsScan }, log) {
  const kwList = String(keywords || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const asinClean = String(asin || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(asinClean)) throw new Error("ASIN không hợp lệ");
  if (!kwList.length) throw new Error("Chưa nhập keyword");

  store.saveAsinSettings(asinClean, { trackParent: !!checkVariants });
  running = true;
  stopFlag = false;
  let browser = null;
  try {
    log(`▶️ Check ${asinClean} × ${kwList.length} keyword (tối đa ${maxPages || 3} trang/keyword)`);
    browser = await launchBrowser();
    const cookies = loadCookies();
    log(cookies ? `🍪 Cookies: ${cookies.length} (đã lọc cookie đăng nhập — phiên sạch)` : "⚠️ Không có cookies.json — location có thể sai");

    const page = await newCleanPage(browser, cookies);

    // Đảm bảo đúng zip TRƯỚC khi check (máy VN mở phiên mới → "Deliver to Vietnam"
    // → SERP/ads khác hẳn shopper Mỹ). Sai zip thì tự đặt lại theo cấu hình.
    const cfg = store.getWorkerConfig();
    await ensureZipLocation(page, cfg.zip, log);

    log("🔐 Kiểm tra session...");
    if (!(await verifySession(page))) throw new Error("Session lỗi/captcha — cập nhật cookies.json mới rồi chạy lại");
    log("✅ Session hợp lệ");

    return await runBatch({
      page, asin: asinClean, keywords: kwList,
      opts: { maxPages, checkVariants, saveSnapshot, debug, dateKey, competitorMode, adsScan },
      log, shouldStop: () => stopFlag
    });
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
    running = false;
  }
}

/* Chuẩn hóa payload check thành job cho agent (kèm zip cấu hình của server) */
function buildJobPayload(body) {
  const kwList = String(body.keywords || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const asin = String(body.asin || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(asin)) throw new Error("ASIN không hợp lệ");
  if (!kwList.length) throw new Error("Chưa nhập keyword");
  return {
    asin, keywords: kwList,
    maxPages: Number(body.maxPages) || 3,
    checkVariants: !!body.checkVariants,
    saveSnapshot: !!body.saveSnapshot,
    dateKey: body.dateKey || null,          // nhãn phiên quét (Run tạo mới / Continue dùng lại)
    competitorMode: !!body.competitorMode,  // chỉ ads + top 10 organic
    adsScan: body.adsScan !== false,        // false = bỏ reload kiểm chứng + quét bù (nhanh hơn, ToS có thể "?")
    debug: false, // debug chỉ có ý nghĩa trên máy chạy scrape
    zip: store.getWorkerConfig().zip
  };
}

/* ===== Chạy check manual =====
   - local: scrape ngay, stream log, dòng cuối RESULT_ID:xxx
   - queue: xếp job cho agent, trả JOB_ID:xxx — UI tự poll /api/jobs/:id */
app.post("/api/check", async (req, res) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  const log = (m) => { try { res.write(m + "\n"); } catch {} };

  if (RUN_MODE === "queue") {
    try {
      const job = store.enqueueJob(buildJobPayload(req.body || {}));
      log(`📨 Đã xếp job vào hàng đợi — agent trên máy cá nhân sẽ tự kéo về chạy.`);
      log(`JOB_ID:${job.id}`);
    } catch (e) { log(`🚨 ${e.message}`); }
    return res.end();
  }

  if (running) { log("Đang có phiên chạy — bấm Dừng trước."); return res.end(); }
  try {
    const runId = await executeCheck(req.body || {}, log);
    log(`RESULT_ID:${runId}`);
  } catch (e) {
    log(`🚨 ${e.message}`);
  }
  res.end();
});

/* ===== Job queue: UI theo dõi + agent kéo job ===== */
app.get("/api/jobs", (req, res) => res.json(store.listJobs()));
app.get("/api/jobs/:id", (req, res) => {
  const j = store.getJob(req.params.id);
  j ? res.json(j) : res.status(404).json({ error: "not found" });
});

// Agent poll job (xác thực bằng chung WORKER_PASSWORD qua Basic-auth middleware phía trên)
app.post("/api/agent/poll", (req, res) => {
  const job = store.claimNextJob(String(req.body?.agent || "?").slice(0, 40));
  res.json({ job });
});
app.post("/api/agent/log", (req, res) => {
  const { jobId, line } = req.body || {};
  if (jobId && line) store.appendJobLog(jobId, String(line).slice(0, 500));
  res.json({ ok: true });
});
app.post("/api/agent/result", (req, res) => {
  const { jobId, run } = req.body || {};
  if (!run || !run.asin || !Array.isArray(run.results)) {
    return res.status(400).json({ ok: false, message: "run không hợp lệ" });
  }
  const runId = store.importRunResult(run);
  store.saveDailyRanks(run.asin, run.checkedAt || new Date().toISOString(), run.results);
  if (jobId) store.completeJob(jobId, runId);
  res.json({ ok: true, runId });
});
app.post("/api/agent/fail", (req, res) => {
  const { jobId, error } = req.body || {};
  if (jobId) store.failJob(jobId, error || "unknown");
  res.json({ ok: true });
});

/* ===== Zip code / location ===== */
app.get("/api/location", (req, res) => res.json(store.getWorkerConfig()));

// Đặt zip ngay lập tức: mở browser → set qua widget địa chỉ → export cookies mới
app.post("/api/location", async (req, res) => {
  const zip = String(req.body?.zip || "").trim();
  if (!/^\d{5}$/.test(zip)) return res.status(400).json({ ok: false, message: "Zip phải là 5 chữ số US (VD 10011)" });
  if (running) return res.status(409).json({ ok: false, message: "Đang có phiên chạy — bấm Dừng trước." });

  store.saveWorkerConfig({ zip });

  // saveOnly: CHỈ LƯU — zip sẽ tự được kiểm tra & đặt NGẦM ở đầu mỗi lần chạy (ensureZipLocation)
  if (req.body?.saveOnly) return res.json({ ok: true, saved: true, zip });

  // Chế độ queue: server không mở browser — zip đã lưu, AGENT tự đặt trên máy cá nhân
  // trước mỗi job (ensureZipLocation trong agent.js)
  if (RUN_MODE === "queue") {
    return res.json({ ok: true, zip, location: `(đã lưu — agent sẽ tự đặt zip ${zip} khi chạy job)`, cookieCount: 0 });
  }
  running = true;
  let browser = null;
  try {
    browser = await launchBrowser();
    const page = await newCleanPage(browser, loadCookies());
    const location = await setZipLocation(page, zip, (m) => console.log(m));
    // Export cookies mới (chứa zip) → các lần chạy sau nạp lại được kể cả phiên sạch
    const cookies = await page.cookies();
    fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
    res.json({ ok: true, zip, location, cookieCount: cookies.length });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
    running = false;
  }
});

/* ===== Lịch check daily (spec gốc: manual HOẶC theo giờ cụ thể) ===== */
app.get("/api/schedule", (req, res) => res.json(store.getSchedule()));

app.post("/api/schedule", (req, res) => {
  const { enabled, time, jobs } = req.body || {};
  const cur = store.getSchedule();
  store.saveSchedule({
    ...cur,
    enabled: !!enabled,
    time: /^\d{2}:\d{2}$/.test(time || "") ? time : cur.time,
    jobs: Array.isArray(jobs) ? jobs : cur.jobs // [{asin, keywords, maxPages, checkVariants}]
  });
  res.json({ ok: true, ...store.getSchedule() });
});

/* Vòng lặp scheduler: mỗi 30s so giờ máy; mỗi ngày chạy 1 lần đúng giờ đã đặt */
setInterval(async () => {
  const s = store.getSchedule();
  if (!s.enabled || running) return;
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const today = now.toISOString().slice(0, 10);
  if (hhmm !== s.time || s.lastRunDate === today) return;

  // Job daily lấy từ BẢNG THEO DÕI: ASIN bật ⏰ — duyệt TUẦN TỰ TỪ TRÊN XUỐNG.
  // ASIN không set ⏰ thì bỏ qua. (jobs cũ trong schedule.json chỉ là fallback.)
  const jobs = store.trackingDailyJobs();
  const list = jobs.length ? jobs : (s.jobs || []);
  if (!list.length) return;

  store.saveSchedule({ ...s, lastRunDate: today });
  console.log(`⏰ [Scheduler] ${s.time} — ${RUN_MODE === "queue" ? "xếp" : "chạy"} ${list.length} ASIN daily (⏰)`);
  for (const job of list) {
    try {
      if (RUN_MODE === "queue") {
        // Xếp job cho agent — agent offline thì job chờ sẵn, mở máy là chạy bù
        const q = store.enqueueJob(buildJobPayload(job));
        console.log(`⏰ [Scheduler] đã xếp job ${q.id} (${job.asin})`);
      } else {
        const runId = await executeCheck({ ...job, dateKey: today }, (m) => console.log(`⏰ ${m}`));
        console.log(`⏰ [Scheduler] xong ${job.asin} → ${runId}`);
      }
    } catch (e) {
      console.error(`⏰ [Scheduler] lỗi ${job.asin}: ${e.message}`);
    }
  }
}, 30000);

/* Cài đặt theo ASIN — UI tự nạp khi nhập ASIN */
app.get("/api/asin-settings/:asin", (req, res) => {
  res.json(store.getAsinSettings(String(req.params.asin).toUpperCase()) || { trackParent: true });
});

app.post("/api/stop", (req, res) => {
  stopFlag = true;
  res.json({ ok: true });
});

/* ===================== MODULE LAUNCHING (Tạo campaign) ===================== */

// Cài đặt đã lưu (SKU/ASIN/Portfolio/Mã cá nhân + naming + bid config) + defaults
app.get("/api/launch/settings", (req, res) => {
  res.json({ saved: store.getLaunchSettings(), defaults: LAUNCH_DEFAULTS });
});
app.post("/api/launch/settings", (req, res) => {
  res.json({ ok: true, saved: store.saveLaunchSettings(req.body || {}) });
});

// Upload file Helium10 (Cerebro/Magnet csv|xlsx) → danh sách keyword + bid đề xuất
app.post("/api/launch/h10", (req, res, next) => uploadMw.single("file")(req, res, next), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, message: "Chưa chọn file" });
    const out = parseH10(fs.readFileSync(req.file.path));
    fs.unlinkSync(req.file.path);
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message });
  }
});

// Preview: lập danh sách campaign PLAN — UI hiển thị bảng CHỈNH SỬA ĐƯỢC (bid, budget,
// portfolio, note) trước khi export
app.post("/api/launch/preview", (req, res) => {
  try {
    const { plans, stats, trackingKeywords, asin } = planCampaigns(req.body || {});
    res.json({ ok: true, stats, totalCampaigns: plans.length,
      plans: plans.slice(0, 1000), trackingCount: trackingKeywords.length, asin });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message });
  }
});

// Export: nhận plans ĐÃ CHỈNH từ preview (có thể gom NHIỀU ASIN) → xlsx bulk + snapshot
// + kho keyword tag PPC (tùy chọn saveToBank, mặc định bật)
app.post("/api/launch/export", (req, res) => {
  try {
    const body = req.body || {};
    // Có plans từ danh sách tích lũy → dùng thẳng (không phụ thuộc form hiện tại);
    // không có → dựng từ form
    const plans = Array.isArray(body.plans) && body.plans.length
      ? body.plans
      : planCampaigns(body).plans;
    const rows = buildRowsFromPlans(plans, body);       // SP → sheet "Sponsored Products Campaigns" (kèm Negative Keyword đính kèm)
    const sdRows = buildSdRows(plans, body);             // SD → sheet "Sponsored Display Campaigns" (22 cột)
    const sbRows = buildSbRows(plans, body);             // SB Video → sheet "Sponsored Brands Campaigns" (32 cột)
    const campaigns = plans.filter((p) => p?.name);
    const stats = {};
    for (const p of campaigns) stats[p.type] = (stats[p.type] || 0) + 1;
    if (!rows.length && !sdRows.length && !sbRows.length) throw new Error("Không có campaign nào — kiểm tra keyword/lựa chọn loại campaign");

    const wb = XLSX.utils.book_new();
    if (rows.length) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows, { header: BULK_HEADER }), "Sponsored Products Campaigns");
    }
    if (sdRows.length) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sdRows, { header: SD_HEADER }), "Sponsored Display Campaigns");
    }
    if (sbRows.length) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sbRows, { header: SB_HEADER }), "Sponsored Brands Campaigns");
    }
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    // Kho keyword tag PPC: gom keyword theo TỪNG ASIN trên plan (multi-ASIN OK)
    const saveToBank = body.saveToBank !== false;
    const bank = { added: 0, kept: 0 };
    if (saveToBank) {
      const byAsin = {};
      for (const p of campaigns) {
        if (p.keyword && p.asin) (byAsin[p.asin] = byAsin[p.asin] || new Set()).add(p.keyword);
      }
      for (const [a, set] of Object.entries(byAsin)) {
        const r = store.upsertKeywords(a, [...set], "PPC", "launching");
        bank.added += r.added; bank.kept += r.kept;
      }
    }

    const asins = [...new Set(campaigns.map((p) => p.asin).filter(Boolean))];
    const label = asins.length === 1 ? asins[0] : `${asins.length}asin`;
    const snapId = store.saveExportSnapshot(
      { asin: label, asins, campaigns: campaigns.length, rows: rows.length + sdRows.length + sbRows.length, stats }, buf);

    res.setHeader("Content-Disposition",
      `attachment; filename="bulk-create-${label}-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("X-Launch-Info", JSON.stringify({ snapId, campaigns: campaigns.length, bank, saveToBank, asins: asins.length }));
    res.send(buf);
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message });
  }
});

// Kho keyword (tracking dùng chung): lấy keyword theo ASIN + tag
app.get("/api/keyword-bank/:asin", (req, res) => {
  const bank = store.getKeywordBank(req.params.asin);
  const tag = req.query.tag;
  const list = Object.entries(bank)
    .filter(([, v]) => !tag || v.tag === tag)
    .map(([k, v]) => ({ keyword: k, ...v }));
  res.json({ asin: String(req.params.asin).toUpperCase(), count: list.length, keywords: list });
});

app.get("/api/launch/exports", (req, res) => res.json(store.listExports()));

// Competitor snapshot theo khoảng thời gian: gom ASIN đối thủ từ các lần check ranking
// đã lưu snapshot (bật "Lưu competitor snapshot" bên Check Ranking) → đổ vào ô Target ASINs
app.get("/api/competitor-snapshot/:asin", (req, res) => {
  const asin = String(req.params.asin).toUpperCase();
  const from = req.query.from ? new Date(req.query.from + "T00:00:00") : null;
  const to = req.query.to ? new Date(req.query.to + "T23:59:59") : null;

  const runs = store.listRunResults().filter((r) => r.asin === asin);
  const agg = new Map(); // competitorAsin → {count, types:Set, keywords:Set}
  let runsScanned = 0, runsWithSnapshot = 0;

  for (const meta of runs) {
    const t = new Date(meta.checkedAt);
    if ((from && t < from) || (to && t > to)) continue;
    runsScanned++;
    const run = store.getRunResult(meta.id);
    let has = false;
    for (const kw of run?.results || []) {
      for (const s of kw.snapshot || []) {
        has = true;
        const list = s.asin ? [s.asin] : (s.asins || []);
        for (const a of list) {
          if (!a || a === asin) continue;
          if (!agg.has(a)) agg.set(a, { count: 0, types: new Set(), keywords: new Set() });
          const e = agg.get(a);
          e.count++;
          e.types.add(s.positionType);
          e.keywords.add(kw.keyword);
        }
      }
    }
    if (has) runsWithSnapshot++;
  }

  const competitors = [...agg.entries()]
    .map(([a, e]) => ({ asin: a, count: e.count, types: [...e.types], keywords: e.keywords.size }))
    .sort((x, y) => y.count - x.count);

  res.json({ asin, runsScanned, runsWithSnapshot, competitors });
});

/* ===================== MODULE ADJUST (chỉnh sửa ads từ file bulk) ===================== */
const ADJUST_DIR = "./data/adjust";
const adjustCache = new Map(); // id → dataset (lazy load)
const uploadBig = multer({ dest: "./data/uploads", limits: { fileSize: 300 * 1024 * 1024 } });

function adjustIndex() {
  try { return JSON.parse(fs.readFileSync(`${ADJUST_DIR}/index.json`, "utf8")); } catch { return []; }
}
function loadDataset(id) {
  if (adjustCache.has(id)) return adjustCache.get(id);
  if (!/^[\w-]+$/.test(id)) return null;
  try {
    const ds = JSON.parse(fs.readFileSync(`${ADJUST_DIR}/${id}.json`, "utf8"));
    ds.byKey = new Map(ds.records.map((r) => [rowKey(r), r]));
    adjustCache.set(id, ds);
    return ds;
  } catch { return null; }
}

// Upload + ETL (file 30-40MB/300k dòng → chạy server-side, mất ~10-30s)
app.post("/api/adjust/import", (req, res, next) => uploadBig.single("file")(req, res, next), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, message: "Chưa chọn file" });
    const ds = etlBulk(fs.readFileSync(req.file.path), req.file.originalname);
    fs.unlinkSync(req.file.path);

    fs.mkdirSync(ADJUST_DIR, { recursive: true });
    const id = `${ds.meta.windowStart || "x"}-${ds.meta.windowEnd || "x"}-${Date.now().toString(36)}`;
    fs.writeFileSync(`${ADJUST_DIR}/${id}.json`, JSON.stringify(ds));
    const idx = adjustIndex().filter((d) => d.id !== id);
    idx.unshift({ id, ...ds.meta });
    fs.writeFileSync(`${ADJUST_DIR}/index.json`, JSON.stringify(idx.slice(0, 20), null, 1));
    ds.byKey = new Map(ds.records.map((r) => [rowKey(r), r]));
    adjustCache.set(id, ds);

    res.json({ ok: true, id, meta: ds.meta });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message });
  }
});

app.get("/api/adjust/datasets", (req, res) => res.json(adjustIndex()));

// Query bảng làm việc (filter/sort/phân trang server-side)
app.post("/api/adjust/query", (req, res) => {
  const { id, tab } = req.body || {};
  const ds = loadDataset(id);
  if (!ds) return res.status(404).json({ ok: false, message: "Chưa có dataset — upload file bulk trước" });
  const list = tab === "terms" ? ds.terms : ds.records;
  const out = queryRows(list, req.body);
  // gắn rowKey cho tab targets (để ledger sửa đổi)
  if (tab !== "terms") out.rows = out.rows.map((r) => ({ k: rowKey(r), ...r }));
  res.json({ ok: true, ...out, meta: ds.meta });
});

// Xuất file UPDATE (chỉ dòng thay đổi + Negative mới) + audit log
app.post("/api/adjust/export", (req, res) => {
  try {
    const { id, edits, negatives } = req.body || {};
    const ds = loadDataset(id);
    if (!ds) throw new Error("Dataset không tồn tại");
    const rows = buildUpdateRows(ds.header, ds.byKey, edits, negatives);
    if (!rows.length) throw new Error("Không có thay đổi nào để xuất");

    const ws = XLSX.utils.json_to_sheet(rows, { header: ds.header });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sponsored Products Campaigns");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    // Audit log: ai/khi nào/old→new (spec: mọi thay đổi ghi log)
    fs.mkdirSync(ADJUST_DIR, { recursive: true });
    const audit = { at: new Date().toISOString(), dataset: id,
      edits: (edits || []).length, negatives: (negatives || []).length,
      detail: { edits, negatives } };
    fs.appendFileSync(`${ADJUST_DIR}/audit.jsonl`, JSON.stringify(audit) + "\n");

    res.setHeader("Content-Disposition",
      `attachment; filename="bulk-update-${id}-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("X-Adjust-Info", JSON.stringify({ rows: rows.length }));
    res.send(buf);
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message });
  }
});

/* ===== Import file bulk daily → chỉ số ads theo ASIN (Spent, Sales ads, ACoS...) ===== */
const uploadMw = multer({ dest: "./data/uploads" });
const upload = uploadMw;

app.post("/api/import-bulk", upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, message: "Chưa chọn file" });

    // Ngày của metrics = start_date trong tên file bulk-{acc}-{start}-{end}-{ts}, hoặc user nhập
    let date = String(req.body.date || "").trim();
    const fm = (req.file.originalname || "").match(/-(\d{8})-(\d{8})-/);
    if (!date && fm) date = `${fm[1].slice(0, 4)}-${fm[1].slice(4, 6)}-${fm[1].slice(6, 8)}`;
    if (!date) return res.status(400).json({ ok: false, message: "Không xác định được ngày — nhập tay" });

    const wb = XLSX.readFile(req.file.path);
    const ws = wb.Sheets["Sponsored Products Campaigns"];
    if (!ws) return res.status(400).json({ ok: false, message: "Thiếu sheet Sponsored Products Campaigns" });
    const rows = XLSX.utils.sheet_to_json(ws);

    // ETL: dòng Entity=Campaign, trích ASIN từ tên campaign (naming template) → cộng Spend/Sales/Orders
    const agg = {};
    for (const r of rows) {
      if (r["Entity"] !== "Campaign") continue;
      const name = r["Campaign Name (Informational only)"] || r["Campaign Name"] || "";
      const am = String(name).match(/B0[A-Z0-9]{8}/i);
      if (!am) continue;
      const a = am[0].toUpperCase();
      agg[a] = agg[a] || { spent: 0, salesAds: 0, ordersAds: 0, impressions: 0, clicks: 0 };
      agg[a].spent += Number(r["Spend"]) || 0;
      agg[a].salesAds += Number(r["Sales"]) || 0;
      agg[a].ordersAds += Number(r["Orders"]) || 0;
      agg[a].impressions += Number(r["Impressions"]) || 0;
      agg[a].clicks += Number(r["Clicks"]) || 0;
    }
    for (const [a, m] of Object.entries(agg)) {
      store.saveAsinMetrics(a, date, {
        spent: round2(m.spent), salesAds: round2(m.salesAds), ordersAds: m.ordersAds,
        impressions: m.impressions, clicks: m.clicks
      });
    }
    fs.unlinkSync(req.file.path);
    res.json({ ok: true, date, asinCount: Object.keys(agg).length });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

/* Nhập tay Sale total (từ Business Report — chưa có file import riêng) */
app.post("/api/metrics", (req, res) => {
  const { asin, date, salesTotal } = req.body || {};
  if (!asin || !date) return res.status(400).json({ ok: false });
  store.saveAsinMetrics(String(asin).toUpperCase(), date, { salesTotal: Number(salesTotal) || 0 });
  res.json({ ok: true });
});

function round2(n) { return Math.round(n * 100) / 100; }

/* ===== ASIN DAILY — bảng chỉ số quyết định cho 1 ASIN theo ngày ===== */
app.get("/api/asin-daily/:asin", (req, res) => {
  const asin = String(req.params.asin).toUpperCase();
  const metricsByDate = store.getAsinMetrics(asin);

  // Rank summary theo ngày (từ các lần check ranking — lấy lần cuối trong ngày)
  const runs = store.listRunResults().filter((r) => r.asin === asin)
    .sort((a, b) => (a.checkedAt < b.checkedAt ? -1 : 1));
  const rankByDate = {};
  for (const meta of runs) {
    const run = store.getRunResult(meta.id);
    rankByDate[String(run.checkedAt || "").slice(0, 10)] = summarize(run);
  }

  const dates = [...new Set([...Object.keys(metricsByDate), ...Object.keys(rankByDate)])].sort();
  const days = dates.map((d) => {
    const m = metricsByDate[d] || null;
    const spent = m?.spent ?? null, salesAds = m?.salesAds ?? null;
    const imp = m?.impressions ?? null, clicks = m?.clicks ?? null, orders = m?.ordersAds ?? null;
    const salesTotal = m?.salesTotal ?? null;
    return {
      date: d,
      hasFile: !!m, // false → cả cột #N/A
      impressions: imp, clicks,
      ctr: imp > 0 ? round2((clicks / imp) * 100) : (m ? 0 : null),          // %
      cpc: clicks > 0 ? round2(spent / clicks) : null,
      spent, ordersAds: orders, salesAds,
      cr: clicks > 0 ? round2((orders / clicks) * 100) : (m ? 0 : null),     // %
      acos: salesAds > 0 ? round2((spent / salesAds) * 100) : null,          // %
      salesTotal,
      tacos: salesTotal > 0 ? round2((spent / salesTotal) * 100) : null,     // %
      rank: rankByDate[d] || null
    };
  });
  res.json({ asin, days });
});

/* ===== Chuỗi thời gian daily — nguồn cho báo cáo/biểu đồ/dự phóng ===== */
app.get("/api/series/:asin", (req, res) => {
  res.json({
    asin: String(req.params.asin).toUpperCase(),
    rank: store.getDailySeries(String(req.params.asin).toUpperCase()),   // {keyword: {date: {...}}}
    metrics: store.getAsinMetrics(String(req.params.asin).toUpperCase()) // {date: {spent, salesAds...}}
  });
});

/* ===== BẢNG THEO DÕI RANKING (luôn hiện) ===== */
app.get("/api/tracking", (req, res) => res.json(store.getTrackingTable()));

// Thêm ASIN + keywords vào bảng theo dõi (chưa cần chạy)
app.post("/api/tracking/add", (req, res) => {
  const asin = String(req.body?.asin || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(asin)) return res.status(400).json({ error: "ASIN không hợp lệ" });
  const kws = String(req.body?.keywords || "").split("\n").map((x) => x.trim().toLowerCase()).filter(Boolean);
  store.trackingRegisterRun(asin, kws, null);
  res.json({ ok: true, added: kws.length });
});

app.post("/api/tracking/asin", (req, res) => {
  const { asin, ...patch } = req.body || {};
  if (!/^[A-Z0-9]{10}$/i.test(String(asin || ""))) return res.status(400).json({ error: "ASIN không hợp lệ" });
  store.trackingPatchAsin(asin, patch);
  res.json({ ok: true });
});

app.post("/api/tracking/keyword", (req, res) => {
  const { asin, keyword, ...patch } = req.body || {};
  if (!asin || !keyword) return res.status(400).json({ error: "Thiếu asin/keyword" });
  store.trackingPatchKeyword(asin, keyword, patch);
  res.json({ ok: true });
});

app.post("/api/tracking/config", (req, res) => {
  res.json(store.trackingSetConfig(req.body || {}));
});

app.post("/api/tracking/delete-date", (req, res) => {
  const d = String(req.body?.date || "").trim();
  if (!d) return res.status(400).json({ error: "Thiếu date" });
  store.trackingDeleteDate(d);
  res.json({ ok: true });
});

// Chỉnh tay 3 chỉ số chính của ô ASIN × ngày
app.post("/api/tracking/metrics", (req, res) => {
  const { asin, date, values } = req.body || {};
  if (!asin || !date) return res.status(400).json({ error: "Thiếu asin/date" });
  store.saveAsinMetrics(String(asin).toUpperCase(), date, { custom: values || {} });
  res.json({ ok: true });
});

// Upload volume: txt/csv/xlsx 2 cột keyword|volume (header có/không đều được)
app.post("/api/tracking/volumes", (req, res, next) => uploadMw.single("file")(req, res, next), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Chưa chọn file" });
    const name = (req.file.originalname || "").toLowerCase();
    const buf = fs.readFileSync(req.file.path);
    fs.unlinkSync(req.file.path);
    let pairs = [];
    if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
      const wb = XLSX.read(buf, { type: "buffer" });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
      pairs = rows.map((r) => [r[0], r[1]]);
    } else {
      const text = buf.toString("utf8");
      pairs = text.split(/\r?\n/).map((line) => {
        const cells = line.split(/[\t,;]/);
        return [cells[0], cells[1]];
      });
    }
    // bỏ header nếu cột 2 không phải số
    pairs = pairs.filter((r) => r && r[0] != null && String(r[0]).trim());
    if (pairs.length && !isFinite(Number(String(pairs[0][1]).replace(/[^0-9.]/g, "")))) pairs.shift();
    const applied = store.trackingApplyVolumes(pairs);
    res.json({ ok: true, rows: pairs.length, applied });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Xếp hạng competitor xuất hiện nhiều nhất trong nhóm keyword
app.get("/api/competitor-rank/:asin", (req, res) => {
  res.json(store.getCompetitorRank(String(req.params.asin).toUpperCase(), req.query.date || null));
});

/* ===== Kết quả ===== */
app.get("/api/results", (req, res) => res.json(store.listRunResults()));
app.get("/api/results/:id", (req, res) => {
  const r = store.getRunResult(req.params.id);
  if (!r) return res.status(404).json({ error: "not found" });
  res.json(r);
});

/* ===== Ma trận lịch sử theo ASIN: mỗi keyword 3 dòng (Organic / ToS / RoS) ===== */
app.get("/api/history/:asin", (req, res) => {
  const asin = String(req.params.asin).toUpperCase();
  const runs = store.listRunResults()
    .filter((r) => r.asin === asin)
    .sort((a, b) => (a.checkedAt < b.checkedAt ? -1 : 1))
    .map((r) => store.getRunResult(r.id));

  const keywords = [...new Set(runs.flatMap((r) => (r.results || []).map((x) => x.keyword)))];
  const image = runs.map((r) => r.image).filter(Boolean).pop() || null;
  const metricsByDate = store.getAsinMetrics(asin); // {"2026-07-13": {spent, salesAds, salesTotal...}}

  const columns = runs.map((r) => ({
    id: r.id,
    date: r.checkedAt,
    metrics: buildMetrics(metricsByDate[String(r.checkedAt || "").slice(0, 10)]),
    rankSummary: summarize(r),
    cells: Object.fromEntries((r.results || []).map((x) => [x.keyword, cellOf(x)]))
  }));
  res.json({ asin, image, keywords, columns });
});

/* Chỉ số chính của ASIN theo ngày: Spent, Sales ads, Sale total, ACoS, TACoS
   Quy ước: không có file import ngày đó → null (#N/A); có file, thiếu salesTotal → '-' */
function buildMetrics(m) {
  if (!m) return null; // #N/A — chưa upload file của ngày này
  const spent = m.spent ?? 0;
  const salesAds = m.salesAds ?? 0;
  const salesTotal = m.salesTotal; // có thể chưa nhập (Business Report)
  return {
    spent,
    salesAds,
    ordersAds: m.ordersAds ?? 0,
    salesTotal: salesTotal ?? null, // null → hiển thị '-'
    acos: salesAds > 0 ? Math.round((spent / salesAds) * 1000) / 10 : null,       // %
    tacos: salesTotal > 0 ? Math.round((spent / salesTotal) * 1000) / 10 : null   // %
  };
}

/* Thống kê rank phụ (dòng nhỏ dưới chỉ số chính) */
function summarize(run) {
  const rs = run.results || [];
  let p1 = 0, tos = 0, nf = 0;
  for (const x of rs) {
    if (x.error) continue;
    const p = x.primary || {};
    const vOrg = (x.variants || []).find((v) => v.organicRank !== null);
    const page = p.organicPage ?? vOrg?.organicPage ?? null;
    if (page === 1) p1++;
    if ((p.tosPosition || 0) > 0 || (x.variants || []).some((v) => v.tosPosition > 0)) tos++;
    if (x.notFound) nf++;
  }
  return { total: rs.length, p1, tos, nf };
}

/* 1 keyword × 1 lần chạy → 3 tầng: organic / tos / ros */
function cellOf(x) {
  if (x.error) return { error: true };
  const p = x.primary || {};
  const cell = { organic: null, rank: null, pv: false, variant: null, tos: null, tosPos: 0, ros: null, notFound: !!x.notFound,
    // true = 0 SP tile cả N trang sau retry → ToS/RoS của lần check này không kết luận được
    tosUnknown: x.adsTilesServed === false };

  if (p.organicRank !== null) {
    cell.organic = `Page ${p.organicPage} No ${p.organicPosInPage}`;
    cell.rank = p.organicRank;
    cell.pv = !!p.ownPreviouslyViewed;
  }
  // Badge Amazon trên tile của chính mình (Overall Pick, Amazon's Choice, Best Seller...)
  cell.badges = (p.ownBadges || []).length ? p.ownBadges : null;

  // ToS: CHỈ của ASIN chính (biến thể nằm trong float, không trộn vào ô)
  if ((p.tosTotal || 0) > 0 || (p.tosPosition || 0) > 0) {
    cell.tos = `${p.tosPosition}/${p.tosTotal}`;
    cell.tosPos = p.tosPosition || 0;
  }

  // Chi tiết biến thể — ASIN ĐẦY ĐỦ, hiển thị dạng float khi hover (không chiếm chỗ ô chính)
  cell.variants = (x.variants || [])
    .filter((v) => v.organicRank !== null || (v.tosPosition || 0) > 0 || v.rosPresent)
    .map((v) => ({
      asin: v.asin,
      organic: v.organicRank !== null ? `Page ${v.organicPage} No ${v.organicPosInPage}` : null,
      tos: (v.tosPosition || 0) > 0 ? `${v.tosPosition}/${v.tosTotal}` : null,
      ros: !!v.rosPresent,
      badges: (v.ownBadges || []).length ? v.ownBadges : null
    }));
  cell.hasVariantRank = cell.variants.some((v) => v.organic);

  // RoS (mọi sponsored ngoài ToS page 1, gồm cả ads đầu trang 2/3)
  const rosParts = [];
  if (p.rosPresent) rosParts.push(`✓ p${Object.keys(p.rosDetail || {}).join(",p") || "?"}`);
  if ((x.variants || []).some((v) => v.rosPresent)) rosParts.push("var ✓");
  cell.ros = rosParts.join(" · ") || null;

  return cell;
}

const srv = app.listen(PORT, () =>
  console.log(`🚀 PPC Warrior Worker v${APP_VERSION}: http://localhost:${PORT}`)
);
srv.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error("");
    console.error("🚨🚨🚨 PORT " + PORT + " ĐANG BỊ CHIẾM — server CŨ vẫn đang chạy nền! 🚨🚨🚨");
    console.error("Trình duyệt của bạn đang nói chuyện với CODE CŨ → hiển thị sai dữ liệu.");
    console.error("Chạy lệnh sau để diệt rồi start lại:");
    console.error(`   lsof -ti :${PORT} | xargs kill -9 && npm start`);
    console.error("");
    process.exit(1);
  }
  throw e;
});
