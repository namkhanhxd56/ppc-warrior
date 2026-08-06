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
  if (job.payload?.kind === "libscan") return runLibScanJob(job, send);
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
    const r = await api("/api/agent/result", { jobId: job.id, run, dateKey: p.dateKey || null, competitorMode: !!p.competitorMode });
    send(`📤 Đã đẩy kết quả lên server (run ${r.runId})`);
  } catch (e) {
    console.error("  🚨 " + e.message);
    await api("/api/agent/fail", { jobId: job.id, error: e.message }).catch(() => {});
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
  }
}

/* Job quét Competitor Library: mở trang /dp/ từng ASIN — ảnh/title (server chỉ lưu lần đầu),
   Sale "bought in past month" + GIÁ (lưu theo ngày) → đẩy về /api/agent/lib-result */
async function runLibScanJob(job, send) {
  let browser = null;
  try {
    const { asins, zip } = job.payload;
    send(`🖥 Agent "${NAME}" nhận job LIBRARY: quét ${asins.length} competitor`);
    browser = await launchBrowser();
    const page = await newCleanPage(browser, loadCookies());
    await ensureZipLocation(page, zip, send);
    const today = new Date().toISOString().slice(0, 10);
    const items = [];
    for (let i = 0; i < asins.length; i++) {
      const a = asins[i];
      try {
        await page.goto(`https://www.amazon.com/dp/${a}`, { waitUntil: "domcontentloaded", timeout: 30000 });
        await new Promise((r) => setTimeout(r, 1200 + Math.random() * 800));
        const info = await page.evaluate(() => {
          const title = document.querySelector("#productTitle")?.textContent.trim() || null;
          const image = document.querySelector("#landingImage")?.getAttribute("src") || document.querySelector("#imgTagWrapperId img")?.getAttribute("src") || null;
          const m = document.body.innerText.match(/([0-9.,]+[KkMm]?\+?)\s+bought in past month/);
          const price = document.querySelector("#corePriceDisplay_desktop_feature_div .a-price .a-offscreen")?.textContent.trim()
            || document.querySelector("#apex_desktop .a-price .a-offscreen")?.textContent.trim()
            || document.querySelector(".a-price .a-offscreen")?.textContent.trim() || null;
          return { title, image, sales: m ? m[1] : null, price };
        });
        items.push({ asin: a, ...info, date: today });
        send(`🔍 [${i + 1}/${asins.length}] ${a} → Sale: ${info.sales || "_"} · Giá: ${info.price || "_"}`);
      } catch (e) {
        send(`⚠️ [${i + 1}/${asins.length}] ${a} lỗi: ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 800 + Math.random() * 700));
    }
    const r = await api("/api/agent/lib-result", { jobId: job.id, items });
    send(`📤 Đã đẩy ${r.saved} kết quả Library lên server`);
  } catch (e) {
    console.error("  🚨 " + e.message);
    await api("/api/agent/fail", { jobId: job.id, error: e.message }).catch(() => {});
  } finally {
    if (browser) { try { await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 5000))]); } catch {} }
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
