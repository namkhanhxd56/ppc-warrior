// agent.js — PPC Warrior AGENT: chạy NGẦM trên máy cá nhân từng thành viên
//
// Kiến trúc Phương án A (file kiến thức mục 8.6):
//   Server (Railway, RUN_MODE=queue): UI cho team + hàng đợi job + lưu kết quả
//   Agent (máy cá nhân, file này):   poll server lấy job → scrape Amazon bằng Chrome
//                                     local (IP dân cư + cookies riêng) → đẩy kết quả lên
//
// Chạy: npm run agent   (cấu hình SERVER_URL / WORKER_PASSWORD / AGENT_NAME trong .env)
// Máy tắt → job chờ trên server, mở máy agent tự kéo về chạy bù.

import dotenv from "dotenv";
import os from "os";
import { launchBrowser, loadCookies, newCleanPage, verifySession } from "./src/scraper/browser.js";
import { ensureZipLocation } from "./src/scraper/set-location.js";
import { runBatch } from "./src/jobs/run-batch.js";
import * as store from "./src/db/file-store.js";

dotenv.config();

const SERVER = String(process.env.SERVER_URL || "").replace(/\/+$/, "");
const PASSWORD = process.env.WORKER_PASSWORD || "";
const NAME = process.env.AGENT_NAME || os.hostname();
const POLL_MS = Math.max(5000, Number(process.env.POLL_INTERVAL_MS || 15000));

const headers = {
  "Content-Type": "application/json",
  ...(PASSWORD ? { Authorization: "Basic " + Buffer.from("agent:" + PASSWORD).toString("base64") } : {})
};

async function api(path, body) {
  const r = await fetch(SERVER + path, { method: "POST", headers, body: JSON.stringify(body || {}) });
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.json();
}

async function runJob(job) {
  const send = (line) => {
    console.log("  " + line);
    api("/api/agent/log", { jobId: job.id, line }).catch(() => {});
  };
  let browser = null;
  try {
    const p = job.payload;
    send(`🖥 Agent "${NAME}" nhận job: ${p.asin} × ${p.keywords.length} keyword`);
    browser = await launchBrowser();
    const page = await newCleanPage(browser, loadCookies());

    await ensureZipLocation(page, p.zip, send); // zip lấy từ cấu hình server
    send("🔐 Kiểm tra session...");
    if (!(await verifySession(page))) throw new Error("Session lỗi/captcha trên máy agent — cập nhật cookies.json");
    send("✅ Session hợp lệ");

    store.saveAsinSettings(p.asin, { trackParent: !!p.checkVariants });
    const runId = await runBatch({
      page, asin: p.asin, keywords: p.keywords,
      opts: p, log: send, shouldStop: () => false
    });

    // Đẩy nguyên bản run (đã lưu local làm bản dự phòng) lên server cho team xem
    const run = store.getRunResult(runId);
    const r = await api("/api/agent/result", { jobId: job.id, run });
    send(`📤 Đã đẩy kết quả lên server (run ${r.runId})`);
  } catch (e) {
    console.error("  🚨 " + e.message);
    await api("/api/agent/fail", { jobId: job.id, error: e.message }).catch(() => {});
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
  }
}

(async () => {
  if (!SERVER) {
    console.error('Thiếu SERVER_URL trong .env — VD: SERVER_URL=https://xxx.up.railway.app');
    process.exit(1);
  }
  console.log(`🛰 PPC Warrior Agent "${NAME}" → ${SERVER} (poll ${POLL_MS / 1000}s, Ctrl+C để dừng)`);
  console.log("   Chrome chạy ngầm (cửa sổ ngoài màn hình) — đừng tắt tiến trình Chrome khi đang có job.");
  let lastErr = "";
  while (true) {
    try {
      const { job } = await api("/api/agent/poll", { agent: NAME });
      lastErr = "";
      if (job) await runJob(job);
    } catch (e) {
      if (e.message !== lastErr) { console.error("Poll lỗi:", e.message); lastErr = e.message; }
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
})();
