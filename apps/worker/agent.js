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

// SERVER_URL http:// tới host thật → Railway trả 301 sang https, và fetch đổi POST thành GET
// khi đi theo redirect ⇒ mọi endpoint agent (chỉ có app.post) trả HTTP 404. Nâng lên https
// và NÓI RÕ, không sửa ngầm.
const SERVER = (() => {
  let s = String(process.env.SERVER_URL || "").replace(/\/+$/, "");
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(s);
  if (s.startsWith("http://") && !local) {
    s = s.replace(/^http:\/\//, "https://");
    console.log(`⚠️  SERVER_URL dùng http:// → tự chuyển sang ${s}`);
    console.log("    (http bị redirect 301 sang https, POST biến thành GET → agent nhận 404). Sửa .env cho gọn.");
  }
  return s;
})();
const PASSWORD = process.env.WORKER_PASSWORD || "";
// HỆ THỐNG USER: agent đăng nhập bằng TÀI KHOẢN THẬT (AGENT_USER/AGENT_PASSWORD)
// → job + dữ liệu vào ĐÚNG PHÂN VÙNG của user đó trên server. Chưa có user: fallback WORKER_PASSWORD cũ.
const AGENT_USER = process.env.AGENT_USER || "";
const AGENT_PASSWORD = process.env.AGENT_PASSWORD || "";
// KHUYÊN DÙNG: AGENT_TOKEN — máy không lưu user/pass (token cấp từ web 🖥, thu hồi được)
const AGENT_TOKEN = process.env.AGENT_TOKEN || "";
const NAME = process.env.AGENT_NAME || os.hostname();
const POLL_MS = Math.max(5000, Number(process.env.POLL_INTERVAL_MS || 15000));

const basicPair = AGENT_USER ? `${AGENT_USER}:${AGENT_PASSWORD}` : (PASSWORD ? `agent:${PASSWORD}` : "");
const headers = {
  "Content-Type": "application/json",
  ...(AGENT_TOKEN ? { "x-agent-token": AGENT_TOKEN } : {}),
  ...(!AGENT_TOKEN && basicPair ? { Authorization: "Basic " + Buffer.from(basicPair).toString("base64") } : {})
};

async function api(path, body) {
  const r = await fetch(SERVER + path, { method: "POST", headers, body: JSON.stringify(body || {}) });
  // Bị redirect = URL sai (http→https, thiếu/thừa đường dẫn): fetch đi theo 301 nhưng ĐỔI POST
  // thành GET nên server trả 404 — báo đúng nguyên nhân thay vì để user đoán mò.
  if (r.redirected) throw new Error(`${path} → bị redirect sang ${r.url} (HTTP ${r.status}) — sửa SERVER_URL trong .env thành đúng địa chỉ cuối`);
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.json();
}

/* GOM LOG: trước đây mỗi dòng log là 1 request tới server (200 keyword ⇒ ~250-300 request
   × ~0,42s RTT tới Railway ≈ 100 giây, và server rewrite cả jobs.json mỗi dòng).
   Giờ đệm lại, gửi khi đủ 10 dòng hoặc quá 5 giây, và flush khi job kết thúc.
   Mỗi lần gửi cũng là heartbeat để server biết job còn sống. */
function makeLogger(jobId) {
  let buf = [];
  let timer = null;
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!buf.length) return Promise.resolve();
    const lines = buf; buf = [];
    return api("/api/agent/logs", { jobId, lines }).catch(() => {});
  };
  const send = (line) => {
    console.log("  " + line);
    buf.push(line);
    if (buf.length >= 10) { flush(); return; }
    if (!timer) timer = setTimeout(flush, 5000);
  };
  return { send, flush };
}

async function runJob(job) {
  const logger = makeLogger(job.id);
  const send = logger.send;
  if (job.payload?.kind === "libscan") return runLibScanJob(job, logger);
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
      opts: p, log: send, shouldStop: () => false,
      // Đẩy TỪNG LÔ lên server ngay khi runBatch điền xong lô đó (mặc định 5 keyword, lô
      // cuối của ASIN là phần dư). Lỗi mạng ở đây không làm hỏng lượt quét: dữ liệu đã nằm
      // ở store cục bộ, và bản run đầy đủ vẫn được đẩy lại ở cuối job.
      onBatch: async (batch) => {
        await logger.flush(); // log của lô này lên trước cho khớp thứ tự
        await api("/api/agent/partial", {
          jobId: job.id, asin: p.asin, dateKey: p.dateKey || null,
          competitorMode: !!p.competitorMode, results: batch
        });
      }
    });

    // Đẩy nguyên bản run (đã lưu local làm bản dự phòng) lên server cho team xem
    const run = store.getRunResult(runId);
    const r = await api("/api/agent/result", { jobId: job.id, run, dateKey: p.dateKey || null, competitorMode: !!p.competitorMode });
    send(`📤 Đã đẩy kết quả lên server (run ${r.runId})`);
  } catch (e) {
    console.error("  🚨 " + e.message);
    send("🚨 " + e.message);
    await logger.flush(); // log lỗi phải lên server TRƯỚC khi báo fail
    await api("/api/agent/fail", { jobId: job.id, error: e.message }).catch(() => {});
  } finally {
    await logger.flush(); // đừng để mất mấy dòng còn trong đệm
    if (browser) { try { await browser.close(); } catch {} }
  }
}

/* Job quét Competitor Library: mở trang /dp/ từng ASIN — ảnh/title (server chỉ lưu lần đầu),
   Sale "bought in past month" + GIÁ (lưu theo ngày) → đẩy về /api/agent/lib-result */
async function runLibScanJob(job, logger) {
  const send = logger.send;
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
    send("🚨 " + e.message);
    await logger.flush();
    await api("/api/agent/fail", { jobId: job.id, error: e.message }).catch(() => {});
  } finally {
    await logger.flush();
    if (browser) { try { await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 5000))]); } catch {} }
  }
}

(async () => {
  if (!SERVER) {
    console.error('Thiếu SERVER_URL trong .env — VD: SERVER_URL=https://xxx.up.railway.app');
    process.exit(1);
  }
  console.log(`🛰 PPC Warrior Agent "${NAME}" → ${SERVER} (poll ${POLL_MS / 1000}s, Ctrl+C để dừng)`);
  console.log(process.env.HEADFUL === "1"
    ? "   Chrome chạy ngầm HEADFUL (cửa sổ đẩy ngoài màn hình, có icon Dock) — đừng tắt Chrome khi đang có job."
    : "   Chrome chạy HEADLESS mới (vô hình hoàn toàn: không cửa sổ, không icon Dock) — đổi HEADFUL=1 trong .env nếu ToS ra '?' nhiều.");
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
