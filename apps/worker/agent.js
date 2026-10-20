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
import { launchBrowser, loadCookies, newCleanPage, verifySession, connectBrowser } from "./src/scraper/browser.js";
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

/* ===== GIỮ BROWSER SỐNG GIỮA CÁC JOB =====
   Mỗi job là 1 ASIN, trước đây mỗi job mở Chrome mới → tốn ~6,6s/ASIN (đo thật: Chrome 1,4s
   + page 0,6s + kiểm zip 2,8s + verify session 1,8s). Giữ browser lại thì ASIN thứ 2 trở đi
   chỉ tốn ~0,6s mở page. Vì hàng đợi đã single-flight (1 job tại một thời điểm) nên các job
   chạy nối tiếp, dùng chung được ngay.
   KHÔNG gộp nhiều ASIN vào 1 job: làm vậy phải đổi giao thức và agent bản cũ trong team sẽ
   chỉ quét ASIN đầu rồi báo xong ⇒ mất dữ liệu. Cách này đạt cùng lợi ích mà không phá gì.
   Tự đóng khi rảnh IDLE_CLOSE_MS để không để Chrome nằm mở cả ngày. */
/* Chrome RIÊNG cho Helium 10 mà người dùng mở sẵn và đã đăng nhập. Mặc định cổng 9222.
   Đặt H10_BROWSER_URL= (rỗng) trong .env để tắt hẳn, quay về cách nạp cookie/localStorage. */
const H10_BROWSER_URL = process.env.H10_BROWSER_URL === undefined ? "http://127.0.0.1:9222" : process.env.H10_BROWSER_URL;

/* Máy này có làm được việc H10 không = có Chrome mở cổng điều khiển hay không.
   Hỏi bằng HTTP thường chứ không dựng Puppeteer: rẻ hơn nhiều vì mỗi nhịp poll đều hỏi.
   Nhớ kết quả 60 giây để người dùng vừa mở Chrome là agent nhận ra trong vòng 1 phút. */
let h10Cap = { ok: false, at: 0 };
async function h10Ready() {
  if (!H10_BROWSER_URL) return false;
  if (Date.now() - h10Cap.at < 60000) return h10Cap.ok;
  let ok = false;
  try {
    const r = await fetch(H10_BROWSER_URL.replace(/\/$/, "") + "/json/version", { signal: AbortSignal.timeout(2500) });
    ok = r.ok;
  } catch {}
  if (ok !== h10Cap.ok) console.log(ok ? "  🔗 Đã thấy Chrome H10 — máy này nhận được job phân tích keyword" : "  ⚠️ Mất Chrome H10 — máy này sẽ không nhận job phân tích keyword");
  h10Cap = { ok, at: Date.now() };
  return ok;
}

const RECYCLE_PAGES = Math.max(50, Number(process.env.RECYCLE_PAGES) || 400);
const IDLE_CLOSE_MS = 60000;
let hold = null; // { browser, verified, lastUsed }

async function getBrowser(zip, log) {
  if (hold?.browser?.connected === false) { hold = null; } // Chrome chết ngoài ý muốn
  if (hold) return hold.browser;
  const browser = await launchBrowser();
  hold = { browser, verified: false, lastUsed: Date.now(), pages: 0 };
  return browser;
}
/** Page mới + zip + (lần đầu của browser này) kiểm session. */
async function newReadyPage(zip, log) {
  const browser = await getBrowser(zip, log);
  const page = await newCleanPage(browser, loadCookies());
  await ensureZipLocation(page, zip, log);
  if (!hold.verified) {
    log("🔐 Kiểm tra session...");
    if (!(await verifySession(page))) throw new Error("Session lỗi/captcha trên máy agent — cập nhật cookies.json");
    log("✅ Session hợp lệ");
    hold.verified = true;
  }
  hold.lastUsed = Date.now();
  return page;
}
async function closeBrowser(why) {
  if (!hold) return;
  const b = hold.browser; hold = null;
  const proc = b.process?.();
  try { await Promise.race([b.close(), new Promise((r) => setTimeout(r, 5000))]); } catch {}
  // Hết 5s mà close() chưa xong = Chrome treo. Bỏ mặc thì tiến trình mồ côi đó VẪN GIỮ khóa
  // chrome-profile, và MỌI job sau đều chết ngay từ khi mở browser với "The browser is
  // already running for ..." — agent hỏng vĩnh viễn dù vẫn poll bình thường.
  if (proc?.pid && proc.exitCode === null && proc.signalCode === null) {
    try { process.kill(proc.pid, "SIGKILL"); console.log(`  🔪 Chrome không chịu đóng — đã kill pid ${proc.pid}`); } catch {}
  }
  if (why) console.log(`  🧹 Đã đóng trình duyệt (${why})`);
}

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
function makeLogger(jobId, onStop) {
  let buf = [];
  let timer = null;
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!buf.length) return Promise.resolve();
    const lines = buf; buf = [];
    // Response mang cờ dừng → biết được yêu cầu Dừng ngay giữa 2 lô (mỗi ≤5s)
    return api("/api/agent/logs", { jobId, lines }).then((r) => { if (r?.stop) onStop?.(); }).catch(() => {});
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
  // ⏹ Dừng: server đánh dấu job.stopRequested, agent nhận cờ qua response của LÔ và của LOG
  // (mỗi ≤5s) → dừng giữa chừng thay vì phải chạy hết ASIN như trước.
  let stopping = false;
  const markStop = () => { if (!stopping) { stopping = true; console.log("  ⏹ Nhận yêu cầu dừng từ server"); } };
  const logger = makeLogger(job.id, markStop);
  const send = logger.send;
  if (job.payload?.kind === "libscan") return runLibScanJob(job, logger);
  if (job.payload?.kind === "h10check") return runH10CheckJob(job, logger);

  /* Loại job lạ = agent đang chạy BẢN CŨ (đã cập nhật file nhưng chưa khởi động lại tiến
     trình — Node nạp code lúc khởi động). Bản cũ rơi thẳng xuống nhánh quét rank rồi đọc
     p.keywords.length của payload không có keywords, ném "Cannot read properties of
     undefined" — nhìn như lỗi cookie/mạng, mất công truy sai hướng. Nói thẳng ra. */
  if (job.payload?.kind) {
    send(`🚨 Agent không hiểu loại job "${job.payload.kind}" — gần như chắc đang chạy BẢN CŨ.`);
    send('   Dừng agent (Ctrl+C) rồi chạy lại "npm run agent". Cập nhật file thôi chưa đủ.');
    await logger.flush();
    await api("/api/agent/fail", { jobId: job.id, error: `Agent bản cũ: không hỗ trợ loại job "${job.payload.kind}"` }).catch(() => {});
    return;
  }
  if (!Array.isArray(job.payload?.keywords)) {
    send("🚨 Job thiếu danh sách keyword — payload không hợp lệ.");
    await logger.flush();
    await api("/api/agent/fail", { jobId: job.id, error: "Payload thiếu keywords" }).catch(() => {});
    return;
  }
  let page = null;
  try {
    const p = job.payload;
    send(`🖥 Agent "${NAME}" nhận job: ${p.asin} × ${p.keywords.length} keyword`);
    // Browser dùng chung giữa các job — chỉ ASIN đầu tiên trả giá mở Chrome + verify session
    page = await newReadyPage(p.zip, send);

    store.saveAsinSettings(p.asin, { trackParent: !!p.checkVariants });
    const runId = await runBatch({
      page, asin: p.asin, keywords: p.keywords,
      opts: { ...p, recycleAfterPages: RECYCLE_PAGES }, log: send, shouldStop: () => stopping,
      // Bộ đếm trang phải SỐNG QUA NHIỀU JOB: mỗi job là 1 ASIN, nếu để runBatch tự đếm thì
      // nó reset về 0 mỗi job ⇒ browser dùng chung chạy vài nghìn trang vẫn không được làm mới.
      onPages: (n) => { if (hold) hold.pages += n; },
      shouldRenew: () => !!hold && hold.pages >= RECYCLE_PAGES,
      // Quét nhiều trang thì Chrome phình bộ nhớ → runBatch gọi cái này để thay browser mới
      renewPage: async () => {
        try { await page.close(); } catch {}
        await closeBrowser();
        page = await newReadyPage(p.zip, send);
        return page;
      },
      // Đẩy TỪNG LÔ lên server ngay khi runBatch điền xong lô đó (mặc định 5 keyword, lô
      // cuối của ASIN là phần dư). Lỗi mạng ở đây không làm hỏng lượt quét: dữ liệu đã nằm
      // ở store cục bộ, và bản run đầy đủ vẫn được đẩy lại ở cuối job.
      onBatch: async (batch) => {
        await logger.flush(); // log của lô này lên trước cho khớp thứ tự
        const r = await api("/api/agent/partial", {
          jobId: job.id, asin: p.asin, dateKey: p.dateKey || null,
          competitorMode: !!p.competitorMode, results: batch
        });
        if (r?.stop) markStop(); // dừng ngay sau lô này
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
    // Chỉ đóng PAGE — browser giữ lại cho job kế tiếp (tự đóng khi rảnh, xem vòng poll)
    if (page) { try { await page.close(); } catch {} }
    if (hold) hold.lastUsed = Date.now();
  }
}

/* ===== CHẨN ĐOÁN HELIUM 10 =====
   Chạy MỘT LẦN trước khi viết phần quét Cerebro thật. Nạp cookie, mở Cerebro, rồi kể lại:
   vào được hay bị đá ra trang đăng nhập, có dính Cloudflare không, và các ô nhập/nút bấm
   trên trang tên là gì. Không có báo cáo này thì selector chỉ là đoán mò. */
/** Nạp cookie + localStorage vào trình duyệt đang có. Dùng cho cả trình duyệt riêng của
 *  agent LẪN Chrome người dùng (khi phiên H10 ở đó đã chết và cần hồi lại).
 *  Trả {cookieOk, cookieTotal, storageWritten}. */
async function injectH10Session(browser, page, cookies, storage, send) {
  const toSet = (cookies || []).map((c) => {
    const o = { name: c.name, value: String(c.value ?? ""), domain: c.domain || ".helium10.com",
      path: c.path || "/", secure: c.secure !== false, httpOnly: !!c.httpOnly };
    if (c.sameSite) o.sameSite = c.sameSite;
    if (c.expires) o.expires = Number(c.expires);
    return o;
  });
  let err = 0;
  for (const c of toSet) {
    try {
      if (typeof browser.setCookie === "function") await browser.setCookie(c);
      else await page.setCookie(c);
    } catch { err++; }
  }
  let wrote = 0;
  const st = storage || {};
  if (Object.keys(st).length) {
    // localStorage gắn với ORIGIN — phải đứng ở đúng origin mới ghi được
    if (!/members\.helium10\.com/.test(page.url())) {
      await page.goto("https://members.helium10.com/user/signin", { waitUntil: "domcontentloaded", timeout: 60000 });
    }
    wrote = await page.evaluate((s) => {
      let n = 0;
      for (const [k, v] of Object.entries(s)) { try { localStorage.setItem(k, v); n++; } catch {} }
      return n;
    }, st).catch(() => 0);
  }
  send(`   nạp ${toSet.length - err}/${toSet.length} cookie · ghi ${wrote}/${Object.keys(st).length} khoá localStorage`);
  return { cookieOk: toSet.length - err, cookieTotal: toSet.length, storageWritten: wrote };
}

/** Mở Cerebro rồi đọc hiện trạng. Tách riêng để gọi được LẦN HAI sau khi hồi phiên.
 *  @param {string} tryAsin nếu truyền: thử nhập ASIN và bấm tìm, rồi dò lại trang KẾT QUẢ —
 *         nút Export chỉ xuất hiện sau khi có kết quả, nên không làm vậy thì không bao giờ
 *         thấy nó. */
async function probeCerebro(page, tryAsin) {
  // /cerebro tự chuyển sang /cerebro-new — vào thẳng để bớt một nhịp chuyển hướng
  await page.goto("https://members.helium10.com/cerebro-new", { waitUntil: "domcontentloaded", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 6000)); // Cerebro là SPA — chờ dựng xong
  const live = await page.cookies().catch(() => []);
  const out = await page.evaluate(() => {
    const txt = document.body.innerText.slice(0, 1500);
    const keys = (s) => { try { return Object.keys(s).slice(0, 30); } catch { return []; } };
    const t = localStorage.getItem("CORE_BEARER_TOKEN");
    const sel = (q) => [...document.querySelectorAll(q)].slice(0, 25).map((e) => ({
      tag: e.tagName.toLowerCase(), id: e.id || undefined,
      name: e.getAttribute("name") || undefined, ph: e.getAttribute("placeholder") || undefined,
      aria: e.getAttribute("aria-label") || undefined,
      test: e.getAttribute("data-testid") || e.getAttribute("data-test") || undefined,
      cls: (typeof e.className === "string") ? e.className.slice(0, 60) : undefined,
      text: (e.innerText || "").trim().slice(0, 40) || undefined
    }));
    return {
      text: txt, inputs: sel("input, textarea"), buttons: sel("button, a[role=button]"),
      localStorageKeys: keys(localStorage), sessionStorageKeys: keys(sessionStorage),
      tokenLive: t ? `có (${String(t).length} ký tự)` : "không có", // không bao giờ trả giá trị token
      hasLogin: /sign in|log in|đăng nhập|password/i.test(txt),
      hasCloudflare: /cloudflare|checking your browser|just a moment/i.test(txt + document.title),
      exportish: [...document.querySelectorAll("button, a")]
        .filter((e) => /export/i.test(e.innerText || ""))
        .slice(0, 6).map((e) => ({ text: (e.innerText || "").trim().slice(0, 40), cls: String(e.className).slice(0, 80), id: e.id || undefined }))
    };
  });
  out.url = page.url();
  out.title = await page.title();
  out.cookiesInBrowser = live.length;
  out.cookieNames = live.map((c) => c.name).slice(0, 40);

  /* Thử chạy một lượt tìm thật: nhập ASIN → bấm nút tìm → chờ bảng kết quả → dò lại.
     Không làm vậy thì nút Export không bao giờ xuất hiện để mà dò. Dùng cách tìm theo DẤU
     HIỆU (placeholder/aria-label có chữ asin) chứ không theo class, vì class của H10 là mã
     sinh tự động, đổi mỗi lần họ build lại. */
  if (tryAsin && !out.hasLogin) {
    try {
      const typed = await page.evaluate((asin) => {
        const cands = [...document.querySelectorAll("input, textarea")].filter((e) => {
          const s = `${e.placeholder || ""} ${e.getAttribute("aria-label") || ""} ${e.name || ""} ${e.id || ""}`.toLowerCase();
          return /asin|product|keyword phrase/.test(s);
        });
        const el = cands[0];
        if (!el) return null;
        const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value")?.set;
        setter ? setter.call(el, asin) : (el.value = asin); // React bỏ qua gán .value thường
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { tag: el.tagName.toLowerCase(), id: el.id || null, name: el.name || null,
                 ph: el.placeholder || null, aria: el.getAttribute("aria-label") || null,
                 cls: String(el.className).slice(0, 80) };
      }, tryAsin);
      out.asinInput = typed || "KHÔNG tìm thấy ô nhập ASIN";
      if (typed) {
        await page.keyboard.press("Enter");
        await new Promise((r) => setTimeout(r, 12000)); // Cerebro tra cứu khá lâu
        out.afterSearch = await page.evaluate(() => {
          const btn = (q) => [...document.querySelectorAll(q)].map((e) => ({
            text: (e.innerText || "").trim().slice(0, 30), id: e.id || undefined,
            test: e.getAttribute("data-testid") || undefined,
            cls: String(e.className).slice(0, 70)
          })).slice(0, 30);
          return {
            url: location.href,
            exportish: btn("button, a").filter((b) => /export|download/i.test(b.text)),
            allButtons: btn("button"),
            rowCount: document.querySelectorAll("table tbody tr, [role=row]").length,
            text: document.body.innerText.slice(0, 600)
          };
        });
      }
    } catch (e) { out.searchError = e.message; }
  }
  return out;
}

async function runH10CheckJob(job, logger) {
  const send = logger.send;
  const report = { jobId: job.id, agent: NAME };
  let page = null, shared = null;
  try {
    /* CÁCH 1 (ưu tiên): mượn Chrome người dùng đang mở và đã đăng nhập H10.
       Không phải xuất cookie/token, không lo hết hạn, và họ nhìn thấy tool đang làm gì. */
    shared = await connectBrowser(H10_BROWSER_URL, send);
    report.mode = shared ? "chrome-co-san" : "trinh-duyet-rieng";
    const browser = shared || await getBrowser(null, send);
    page = shared ? await shared.newPage() : await newCleanPage(browser, null);

    // Trình duyệt riêng thì trắng tinh — phải nạp phiên TRƯỚC khi mở Cerebro
    if (!shared) {
      send("🔑 Không có Chrome sẵn — nạp cookie/localStorage từ server...");
      const s = await api("/api/agent/h10-cookie", {});
      const r = await injectH10Session(browser, page, s.cookies, s.storage, send);
      Object.assign(report, { cookiesSent: r.cookieTotal, cookieSetErrors: r.cookieTotal - r.cookieOk, storageWritten: r.storageWritten });
    }

    send("🌐 Mở Cerebro...");
    const tryAsin = job.payload?.asin || "B0991NYY1P"; // ASIN mẫu để kích hoạt bảng kết quả
    let probe = await probeCerebro(page, tryAsin);

    /* TỰ HỒI PHIÊN: Chrome người dùng bị H10 đá ra đăng nhập thì agent làm đúng thao tác tay
       của họ — nạp cookie đã lưu rồi tải lại. Chỉ chạy KHI ĐÃ HỎNG, không đụng vào phiên
       đang chạy tốt. Cookie đã lưu mà cũng hết hạn thì không ai cứu được, phải lấy cookie mới. */
    if (probe.hasLogin && shared) {
      send("⚠️ Chrome này đã mất đăng nhập H10 — thử hồi phiên bằng cookie đã lưu...");
      try {
        const s = await api("/api/agent/h10-cookie", {});
        const r = await injectH10Session(browser, page, s.cookies, s.storage, send);
        Object.assign(report, { recoveryTried: true, cookiesSent: r.cookieTotal, storageWritten: r.storageWritten });
        probe = await probeCerebro(page, tryAsin);
        report.recovered = !probe.hasLogin;
        send(probe.hasLogin
          ? "   🚨 Vẫn bị đá ra — cookie đã lưu cũng hết hạn. Đăng nhập lại H10 trong cửa sổ Chrome đó, hoặc nạp cookie mới."
          : "   ✅ Hồi phiên thành công");
      } catch (e) {
        report.recoveryError = e.message;
        send(`   ⚠️ Không hồi được: ${e.message}`);
      }
    }

    Object.assign(report, probe);
    send(`   URL: ${probe.url}`);
    send(`   Tiêu đề: ${probe.title}`);
    send(probe.hasCloudflare ? "   🚨 Dính Cloudflare" : "   ✓ Không thấy Cloudflare");
    send(probe.hasLogin ? "   🚨 Đang ở trang đăng nhập" : "   ✓ Đã đăng nhập");
    send(`   CORE_BEARER_TOKEN: ${probe.tokenLive} · ${probe.cookiesInBrowser} cookie · ${probe.localStorageKeys.length} khoá localStorage`);
    send(`   Thấy ${probe.inputs.length} ô nhập · ${probe.buttons.length} nút · ${probe.exportish.length} nút có chữ Export`);
    if (probe.asinInput) send(`   Ô nhập ASIN: ${typeof probe.asinInput === "string" ? probe.asinInput : JSON.stringify(probe.asinInput)}`);
    if (probe.afterSearch) send(`   Sau khi tìm: ${probe.afterSearch.rowCount} dòng · ${probe.afterSearch.exportish.length} nút Export`);
    if (probe.searchError) send(`   ⚠️ Thử tìm lỗi: ${probe.searchError}`);

    try {
      const shot = `${process.cwd()}/data/h10-check.png`;
      await page.screenshot({ path: shot });
      report.screenshot = shot;
      send(`   📸 Ảnh màn hình: ${shot}`);
    } catch {}
    report.ok = !probe.hasLogin && !probe.hasCloudflare;
  } catch (e) {
    report.error = e.message;
    send(`🚨 ${e.message}`);
  } finally {
    await logger.flush();
    try { await api("/api/agent/h10-report", report); } catch (e) { console.error("  gửi báo cáo lỗi:", e.message); }
    if (page) { try { await page.close(); } catch {} }
    /* NGẮT chứ không ĐÓNG: close() sẽ tắt luôn cửa sổ Chrome của người dùng, mất cả phiên
       H10 họ đang giữ — đúng thứ ta vừa cất công mượn. */
    if (shared) { try { shared.disconnect(); } catch {} }
    else if (hold) hold.lastUsed = Date.now();
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
      const { job } = await api("/api/agent/poll", { agent: NAME, caps: { h10: await h10Ready() } });
      lastErr = "";
      if (job) await runJob(job);
      // Rảnh lâu thì đóng Chrome — giữ sống chỉ để tiết kiệm giữa các job liền nhau,
      // không phải để nó nằm mở cả ngày ăn RAM.
      else if (hold && Date.now() - hold.lastUsed > IDLE_CLOSE_MS) await closeBrowser("rảnh 60s");
    } catch (e) {
      if (e.message !== lastErr) { console.error("Poll lỗi:", e.message); lastErr = e.message; }
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
})();
