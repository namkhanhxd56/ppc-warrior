// server.js — PPC Warrior Worker: UI check ranking chạy local (http://localhost:3100)
import express from "express";
import fs from "fs";
import { spawn } from "child_process";
import dotenv from "dotenv";
import multer from "multer";
import * as XLSX from "xlsx";
import { launchBrowser, loadCookies, newCleanPage, verifySession } from "./src/scraper/browser.js";
import { setZipLocation, ensureZipLocation } from "./src/scraper/set-location.js";
import { runBatch } from "./src/jobs/run-batch.js";
import { planCampaigns, buildRowsFromPlans, buildSdRows, buildSbRows, BULK_HEADER, SD_HEADER, SB_HEADER, DEFAULTS as LAUNCH_DEFAULTS } from "./src/launching/bulk-builder.js";
import { parseH10 } from "./src/launching/h10-parser.js";
import { etlBulk, queryRows, buildUpdateRows, rowKey, groupTerms, listPortfolios, stampAsins } from "./src/adjust/bulk-etl.js";
import { evaluate as evaluateRules } from "./src/adjust/rule-engine.js";
import { DEFAULT_RULES } from "./src/adjust/default-rules.js";
import { buildMetrics, summarize, cellOf, buildAsinDaily } from "./src/data/consolidate.js";
import { importAdsBulk, importBusiness, importInventory, preview as previewImport, FIELD_SPECS } from "./src/data/imports.js";
import { evaluateAsin } from "./src/data/evaluate.js";
import * as store from "./src/db/file-store.js";
import * as auth from "./src/auth.js";
import { als, runAsUser, userDataDir } from "./src/db/user-context.js";

dotenv.config();
export const APP_VERSION = "0.40.0"; // tăng mỗi lần sửa API — UI đối chiếu để cảnh báo quên restart

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
/* ===== HỆ THỐNG USER (05/08/2026) =====
   - Chưa có user nào đăng ký → chạy như cũ (không hỏi đăng nhập; nếu đặt WORKER_PASSWORD thì Basic auth cũ)
   - Có user: trang → redirect /login.html; API → 401; phiên qua cookie ppcw_sid
   - Agent: Basic <username>:<password> (tài khoản thật) → job/data vào ĐÚNG PHÂN VÙNG user đó
   - Mỗi request chạy trong AsyncLocalStorage context → file-store tự resolve ./data hay ./data/users/<name> */
const PUBLIC_PATHS = ["/user", "/user.html", "/login.html", "/api/auth/login", "/api/auth/register", "/api/auth/me", "/api/version", "/favicon.ico", "/setup-agent.sh", "/agent-bundle.tgz"];
app.use((req, res, next) => {
  const p = req.path;
  if (PUBLIC_PATHS.includes(p)) return next();

  // Agent: TOKEN (máy không lưu user/pass — khuyên dùng) → Basic user:pass → fallback WORKER_PASSWORD
  if (p.startsWith("/api/agent/")) {
    const tokenUser = auth.resolveAgentToken(req.headers["x-agent-token"]);
    if (tokenUser) return runAsUser(tokenUser, next);
    const u = auth.verifyBasic(req);
    if (u) return runAsUser(u, next);
    if (!auth.hasUsers() && PASSWORD) {
      const pass = String(req.headers.authorization || "").startsWith("Basic ")
        ? Buffer.from(req.headers.authorization.slice(6), "base64").toString().split(":").slice(1).join(":") : "";
      if (pass === PASSWORD) return next(); // legacy: context gốc
    }
    if (!auth.hasUsers() && !PASSWORD) return next(); // local dev chưa cấu hình gì
    return res.status(401).json({ error: "Agent cần đăng nhập bằng tài khoản user (AGENT_USER/AGENT_PASSWORD)" });
  }

  // Chưa có user nào đăng ký → chế độ local 1 người như trước (kèm Basic WORKER_PASSWORD nếu đặt)
  if (!auth.hasUsers()) {
    if (PASSWORD) {
      const pass = String(req.headers.authorization || "").startsWith("Basic ")
        ? Buffer.from(req.headers.authorization.slice(6), "base64").toString().split(":").slice(1).join(":") : "";
      if (pass !== PASSWORD) {
        res.set("WWW-Authenticate", 'Basic realm="PPC Warrior Worker"');
        return res.status(401).send("Cần mật khẩu (WORKER_PASSWORD)");
      }
    }
    return next();
  }

  // Đã có user → bắt buộc phiên
  const tok = auth.parseCookie(req);
  const user = auth.getSession(tok);
  if (!user) {
    if (p.startsWith("/api/")) return res.status(401).json({ error: "Chưa đăng nhập" });
    return res.redirect("/user");
  }
  // ADMIN = tập hợp dự án: nếu đã chọn "dự án" (user khác) → mọi đọc/ghi vào phân vùng user đó
  const ctx = user.role === "admin" ? (auth.getActAs(tok) || user) : user;
  return runAsUser(ctx, next);
});

/* ===== API AUTH ===== */
app.use("/api/auth", express.json());

/* CHỐNG DÒ MẬT KHẨU: server công khai trên internet, mật khẩu tối thiểu chỉ 6 ký tự nên
   không có gì chặn thì dò được. Đếm trong RAM theo (IP + tên đăng nhập): sai 10 lần trong
   15 phút → khoá 15 phút. Đăng nhập đúng thì xoá bộ đếm. Mất khi restart — chấp nhận được,
   mục tiêu là chặn dò tự động chứ không phải chống tấn công có chủ đích kéo dài. */
const LOGIN_MAX = 10, LOGIN_WINDOW_MS = 15 * 60000;
const loginFails = new Map(); // key → {n, until}
const clientIp = (req) => String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
const failKey = (req, name) => `${clientIp(req)}|${String(name || "").toLowerCase()}`;
function loginBlockedFor(key) {
  const f = loginFails.get(key);
  if (!f) return 0;
  if (Date.now() > f.until) { loginFails.delete(key); return 0; }
  return f.n >= LOGIN_MAX ? Math.ceil((f.until - Date.now()) / 1000) : 0;
}
function noteLoginFail(key) {
  const f = loginFails.get(key) || { n: 0, until: 0 };
  f.n++; f.until = Date.now() + LOGIN_WINDOW_MS;
  loginFails.set(f.n === 1 ? key : key, f);
  if (loginFails.size > 5000) loginFails.clear(); // chặn phình RAM khi bị rải IP
}
// Cookie phiên: thêm Secure khi đứng sau HTTPS (Railway) — không đặt cứng vì local là http
function sessionCookie(req, token) {
  const https = String(req.headers["x-forwarded-proto"] || (req.secure ? "https" : "http")).split(",")[0].trim() === "https";
  return `ppcw_sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}${https ? "; Secure" : ""}`;
}
app.post("/api/auth/register", (req, res) => {
  try {
    const u = auth.register(req.body?.username, req.body?.password, req.body?.invite);
    const token = auth.createSession(u);
    res.setHeader("Set-Cookie", sessionCookie(req, token));
    res.json({ ok: true, user: u, first: u.role === "admin" });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post("/api/auth/login", (req, res) => {
  const key = failKey(req, req.body?.username);
  const wait = loginBlockedFor(key);
  if (wait) return res.status(429).json({ error: `Sai quá nhiều lần — thử lại sau ${Math.ceil(wait / 60)} phút` });
  const u = auth.verify(req.body?.username, req.body?.password);
  if (!u) { noteLoginFail(key); return res.status(401).json({ error: "Sai tên đăng nhập hoặc mật khẩu" }); }
  loginFails.delete(key);
  const token = auth.createSession(u);
  res.setHeader("Set-Cookie", sessionCookie(req, token));
  res.json({ ok: true, user: u });
});
app.post("/api/auth/logout", (req, res) => {
  auth.destroySession(auth.parseCookie(req));
  res.setHeader("Set-Cookie", "ppcw_sid=; Path=/; Max-Age=0");
  res.json({ ok: true });
});
app.get("/api/auth/me", (req, res) => {
  const tok = auth.parseCookie(req);
  const u = auth.getSession(tok);
  const out = { user: u, hasUsers: auth.hasUsers() };
  if (u?.role === "admin") {
    out.users = auth.listUsers().map((x) => x.name); // ADMIN = tập hợp dự án — chọn phân vùng để xem
    out.actAs = auth.getActAs(tok)?.name || u.name;
  }
  res.json(out);
});
// Admin chuyển dự án (phân vùng dữ liệu) đang thao tác
app.post("/api/auth/switch", (req, res) => {
  const tok = auth.parseCookie(req);
  const u = auth.getSession(tok);
  if (!u || u.role !== "admin") return res.status(403).json({ error: "Cần quyền admin" });
  try { auth.setActAs(tok, req.body?.name); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
const requireAdmin = (req, res, next) => {
  const u = auth.getSession(auth.parseCookie(req));
  if (!u || u.role !== "admin") return res.status(403).json({ error: "Cần quyền admin" });
  next();
};
app.get("/api/auth/users", requireAdmin, (req, res) => res.json({ users: auth.listUsers(), invite: auth.getInviteCode() }));

/* ===== AGENT TOKEN (🖥 mỗi user tự cấp cho máy của mình — credentials KHÔNG rời server) ===== */
app.post("/api/agent-tokens", (req, res) => {
  const u = auth.getSession(auth.parseCookie(req));
  if (!u) return res.status(401).json({ error: "Chưa đăng nhập" });
  const token = auth.createAgentToken(u.name, req.body?.label);
  // PHẢI đọc x-forwarded-proto: sau proxy Railway, req.protocol = "http" → lệnh cài sinh ra
  // SERVER_URL=http://... → Railway trả 301 sang https → fetch đổi POST thành GET → agent
  // nhận HTTP 404 ở /api/agent/poll (đã gặp thật 06/08/2026).
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol).split(",")[0].trim();
  const base = `${proto}://${req.get("host")}`;
  res.json({ ok: true, token,
    command: `curl -fsSL "${base}/setup-agent.sh" | bash -s -- "${base}" "${token}"` });
});
app.get("/api/agent-tokens", (req, res) => {
  const u = auth.getSession(auth.parseCookie(req));
  if (!u) return res.status(401).json({ error: "Chưa đăng nhập" });
  res.json({ tokens: auth.listAgentTokens(u.name, u.role === "admin") });
});
app.post("/api/agent-tokens/revoke", (req, res) => {
  const u = auth.getSession(auth.parseCookie(req));
  if (!u) return res.status(401).json({ error: "Chưa đăng nhập" });
  try { auth.revokeAgentToken(String(req.body?.id || ""), u.name, u.role === "admin"); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* ===== CÀI AGENT 1 LỆNH — tải code từ CHÍNH SERVER, không cần git/GitHub ===== */
app.get("/setup-agent.sh", (req, res) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(`#!/bin/bash
# PPC Warrior — cài agent 1 lệnh (không cần git). Dùng: curl -fsSL <url>/setup-agent.sh | bash -s -- <SERVER_URL> <TOKEN>
set -e
SERVER="\${1:?Thiếu SERVER_URL}"; TOKEN="\${2:?Thiếu TOKEN}"
command -v node >/dev/null || { echo "❌ Cần Node.js 20+ (https://nodejs.org)"; exit 1; }
DIR="$HOME/ppc-warrior-agent"
echo "📦 Tải agent từ $SERVER vào $DIR ..."
mkdir -p "$DIR" && cd "$DIR"
curl -fsSL "$SERVER/agent-bundle.tgz?token=$TOKEN" | tar xz
echo "📚 Cài thư viện (1-2 phút)..."
npm install --omit=dev --silent
cat > .env <<EOF
SERVER_URL=$SERVER
AGENT_TOKEN=$TOKEN
AGENT_NAME=$(hostname)
HEADFUL=0
CHROME_CHANNEL=chrome
WORKER_PROFILE=1
EOF
echo ""
echo "✅ Xong! Chạy agent:  cd $DIR && npm run agent"
echo "   (Token gắn với tài khoản của bạn trên server — máy này KHÔNG lưu mật khẩu)"
`);
});
app.get("/agent-bundle.tgz", (req, res) => {
  if (!auth.resolveAgentToken(String(req.query.token || ""))) return res.status(401).send("Token không hợp lệ/đã thu hồi");
  res.setHeader("Content-Type", "application/gzip");
  const tar = spawn("tar", ["czf", "-", "agent.js", "package.json", "src/scraper", "src/parser", "src/jobs", "src/db", "src/adjust", "src/launching", "src/data", "src/auth.js"]);
  tar.stdout.pipe(res);
  tar.on("error", () => res.end());
});
app.post("/api/auth/invite-regen", requireAdmin, (req, res) => res.json({ invite: auth.regenInviteCode() }));
app.post("/api/auth/role", requireAdmin, (req, res) => {
  try { auth.setRole(req.body?.name, req.body?.role); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post("/api/auth/delete-user", requireAdmin, (req, res) => {
  try { auth.deleteUser(req.body?.name); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.use(express.json({ limit: "25mb" })); // agent đẩy run kèm snapshot có thể lớn
app.use(express.static("public"));

app.get("/api/version", (req, res) => res.json({ version: APP_VERSION, runMode: RUN_MODE }));
// Trang tài khoản: domain/user (đăng nhập, tạo tài khoản, quản lý agent) — login.html cũ chuyển hướng về đây
app.get("/user", (req, res) => res.sendFile("user.html", { root: "public" }));
app.get("/login.html", (req, res) => res.redirect("/user"));

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
    running = false; // nhả cờ trước — browser.close() treo không khoá phiên sau
    if (browser) { try { await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 5000))]); } catch {} }
  }
}

/** id → tên portfolio, bơm vào planCampaigns để dựng nhãn "ASINs - <tên portfolio>".
 *  bulk-builder là hàm thuần (không đọc store) nên map này phải đi từ ngoài vào. */
function withPortfolioNames(body) {
  const names = {};
  for (const p of store.listPortfolioDir()) names[p.id] = p.name;
  return { ...(body || {}), portfolioNames: names };
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
    runId: body.runId || null,              // ID của LƯỢT bấm Run — khóa hàng đợi (xem activeSession)
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
      const payload = buildJobPayload(req.body || {});
      // KHÓA HÀNG ĐỢI: chỉ lượt chạy đang giữ chỗ mới được xếp thêm job. Trước đây nút Run
      // không có khóa nào — bấm 2 lần là 2 vòng lặp thay phiên chiếm agent, mọi keyword bị
      // quét 2 lượt và (nếu sang phút khác) đẻ thêm một cột mới. Khóa đặt ở SERVER nên ăn cả
      // trường hợp mở 2 tab hoặc 2 máy, thứ mà khóa ở nút bấm không với tới.
      const act = store.activeSession();
      if (act && act.runId !== payload.runId) {
        log(`⚠️ Đang có lượt chạy khác chiếm hàng đợi — phiên "${act.dateKey || "daily ⏰"}", còn ${act.count} job.`);
        log(`   Bấm ⏹ Dừng để hủy hàng đợi đó rồi chạy lại, hoặc chờ nó xong.`);
        log(`BUSY:${act.dateKey || ""}`);
        return res.end();
      }
      const job = store.enqueueJob(payload);
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

/* ===== ▶ RUN CẢ LƯỢT: server xếp TOÀN BỘ ASIN vào hàng đợi một lần =====
   Trước đây trình duyệt mới là "bộ điều phối": nó gọi /api/check cho ASIN 1, đợi xong, rồi
   mới gọi cho ASIN 2... Nghĩa là chuyển sang tab Adjust/Launching, đóng tab hay máy ngủ là
   KHÔNG AI xếp ASIN tiếp theo — lượt quét chết giữa chừng dù agent vẫn khỏe (gặp thật).
   Giờ một request xếp hết; hàng đợi single-flight tự chạy tuần tự đúng thứ tự trên xuống.
   Trình duyệt tụt xuống vai trò xem tiến độ, muốn tắt lúc nào cũng được. */
app.post("/api/run", (req, res) => {
  if (RUN_MODE !== "queue") {
    return res.status(409).json({ ok: false, mode: "local", message: "RUN_MODE=local — chạy trực tiếp trên server, UI dùng đường /api/check" });
  }
  try {
    const { targets, dateKey, maxPages } = req.body || {};
    if (!Array.isArray(targets) || !targets.length) throw new Error("Không có ASIN nào đang bật theo dõi");
    const act = store.activeSession();
    if (act) {
      return res.status(409).json({ ok: false, busy: true, dateKey: act.dateKey, count: act.count,
        message: `Đang có lượt chạy chiếm hàng đợi (phiên "${act.dateKey || "daily ⏰"}", còn ${act.count} job) — bấm ⏹ Dừng để hủy` });
    }
    const runId = "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const payloads = targets.map((t) => buildJobPayload({
      asin: t.asin, keywords: (t.kws || []).join("\n"), maxPages,
      checkVariants: t.trackParent, saveSnapshot: t.saveCompetitor,
      adsScan: t.adsScan, dateKey, runId
    }));
    const jobs = store.enqueueJobs(payloads);
    res.json({ ok: true, runId, dateKey, jobs: jobs.length,
      keywords: payloads.reduce((n, p) => n + p.keywords.length, 0) });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

// Tiến độ lượt chạy hiện tại — MỌI trang đều poll được để hiện thanh trạng thái chung
app.get("/api/run/active", (req, res) => res.json({ run: store.activeRun() }));

/* ===== Job queue: UI theo dõi + agent kéo job ===== */
/* ⏩ CONTINUE: server tự tính phần còn thiếu của CỘT DỞ DANG GẦN NHẤT.
   Trước đây chỉ trình duyệt biết ô nào trống (UI tự lọc), nên nếu không ai mở web thì
   phiên đứt dở nằm đó mãi. Giờ server là nguồn sự thật duy nhất — dùng chung logic với
   cơ chế thu hồi job treo. Chỉ xét cột dở dang gần nhất (không truy các cột cũ hơn). */
app.get("/api/continue-targets", (req, res) => {
  const dateKey = String(req.query.dateKey || "") || store.latestIncompleteSession();
  if (!dateKey) return res.json({ ok: true, dateKey: null, targets: [], message: "Không có cột nào còn ô trống" });
  const targets = store.missingTargets(dateKey);
  const kws = targets.reduce((n, t) => n + t.kws.length, 0);
  res.json({ ok: true, dateKey, targets, asinCount: targets.length, kwCount: kws });
});

app.get("/api/jobs", (req, res) => res.json(store.listJobs()));
app.get("/api/jobs/:id", (req, res) => {
  const j = store.getJob(req.params.id);
  j ? res.json(j) : res.status(404).json({ error: "not found" });
});

// Agent poll job (xác thực bằng chung WORKER_PASSWORD qua Basic-auth middleware phía trên)
app.post("/api/agent/poll", (req, res) => {
  // caps: agent tự khai làm được gì (vd {h10:true} khi máy đó có Chrome đã đăng nhập H10)
  const caps = (req.body && typeof req.body.caps === "object") ? req.body.caps : {};
  const job = store.claimNextJob(String(req.body?.agent || "?").slice(0, 40), caps);
  res.json({ job });
});
app.post("/api/agent/log", (req, res) => {
  const { jobId, line } = req.body || {};
  if (jobId && line) store.appendJobLog(jobId, String(line).slice(0, 500));
  res.json({ ok: true });
});
// LÔ LOG: agent gom nhiều dòng gửi 1 lần (1 request + 1 lần ghi jobs.json thay vì mỗi dòng
// một request). Mỗi lần gọi cũng là heartbeat của job.
app.post("/api/agent/logs", (req, res) => {
  const { jobId, lines } = req.body || {};
  if (jobId && Array.isArray(lines)) store.appendJobLogs(jobId, lines.slice(0, 200));
  res.json({ ok: true, stop: store.isStopRequested(jobId) });
});
/* LÔ KẾT QUẢ GIỮA CHỪNG: agent đẩy mỗi 5 keyword thay vì đợi hết ASIN.
   - Bảng trên web nhích theo từng lô (1 ASIN 200 keyword chạy ~20 phút, không phải đợi tới cuối)
   - Agent chết giữa ASIN chỉ mất tối đa 1 lô, phần đã đẩy nằm an toàn trên server
   - Mỗi lô cũng là heartbeat để job không bị coi là treo
   KHÔNG completeJob ở đây — job chỉ xong khi /api/agent/result gửi run đầy đủ. */
app.post("/api/agent/partial", (req, res) => {
  const { jobId, asin, dateKey, results, competitorMode } = req.body || {};
  const a = String(asin || "").toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(a) || !Array.isArray(results) || !results.length) {
    return res.status(400).json({ ok: false, message: "Lô không hợp lệ" });
  }
  const now = new Date().toISOString();
  if (competitorMode) store.saveCompetitorAgg(a, dateKey || now.slice(0, 10), results);
  else store.saveDailyRanks(a, now, results, dateKey || null);
  if (jobId) store.appendJobLogs(jobId, [`💾 Server nhận lô ${results.length} keyword của ${a}`]);
  // Cờ dừng đi NHỜ response của lô — agent không phải poll thêm request nào
  res.json({ ok: true, saved: results.length, stop: store.isStopRequested(jobId) });
});

app.post("/api/agent/result", (req, res) => {
  const { jobId, run } = req.body || {};
  if (!run || !run.asin || !Array.isArray(run.results)) {
    return res.status(400).json({ ok: false, message: "run không hợp lệ" });
  }
  const runId = store.importRunResult(run);
  if (req.body.competitorMode) {
    store.saveCompetitorAgg(run.asin, req.body.dateKey || String(run.checkedAt || "").slice(0, 10), run.results);
  } else {
    store.saveDailyRanks(run.asin, run.checkedAt || new Date().toISOString(), run.results, req.body.dateKey || null);
  }
  // Ảnh ASIN agent chụp từ SERP — trước đây chỉ ghi ở store MÁY AGENT nên bảng trên server
  // (Railway/queue) không có ảnh; giờ ghi vào tracking của server (chỉ điền khi chưa có)
  if (run.image) store.trackingSetImage(run.asin, run.image);
  if (jobId) store.completeJob(jobId, runId);
  res.json({ ok: true, runId });
});
// Agent đẩy kết quả quét Competitor Library (ảnh/title lần đầu, Sale + giá theo ngày)
app.post("/api/agent/lib-result", (req, res) => {
  const { jobId, items } = req.body || {};
  for (const it of items || []) {
    if (!/^[A-Z0-9]{10}$/.test(String(it.asin || ""))) continue;
    store.compLibSaveScan(it.asin, { title: it.title, image: it.image, sales: it.sales, price: it.price, date: it.date || new Date().toISOString().slice(0, 10) });
  }
  if (jobId) store.completeJob(jobId, null);
  res.json({ ok: true, saved: (items || []).length });
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
    running = false; // nhả cờ trước — browser.close() treo không khoá phiên sau
    if (browser) { try { await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 5000))]); } catch {} }
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
  // Đa user: duyệt từng user (admin gốc + members), mỗi user lịch/data riêng
  const userList = auth.hasUsers()
    ? auth.listUsers().map((u) => ({ name: u.name, role: u.role, legacyRoot: u.legacyRoot }))
    : [null]; // chưa có user → context gốc
  for (const u of userList) {
    await new Promise((done) => (u ? runAsUser(u, () => schedTick().finally(done)) : schedTick().finally(done)));
  }
}, 30000);

async function schedTick() {
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
  // Lịch đến đúng lúc đang có người bấm Run: MƯỢN runId của lượt đang giữ hàng đợi thay vì
  // mang runId riêng. Nếu mang runId riêng thì khi job thủ công cuối cùng xong, chủ hàng đợi
  // đổi sang job của lịch và vòng lặp thủ công bị chính khóa của mình chặn giữa chừng.
  const act = store.activeSession();
  const schedRunId = act ? act.runId : `sched-${today}`;
  for (const job of list) {
    try {
      if (RUN_MODE === "queue") {
        // Xếp job cho agent — agent offline thì job chờ sẵn, mở máy là chạy bù
        const q = store.enqueueJob(buildJobPayload({ ...job, runId: schedRunId }));
        console.log(`⏰ [Scheduler] đã xếp job ${q.id} (${job.asin})`);
      } else {
        const runId = await executeCheck({ ...job, dateKey: today }, (m) => console.log(`⏰ ${m}`));
        console.log(`⏰ [Scheduler] xong ${job.asin} → ${runId}`);
      }
    } catch (e) {
      console.error(`⏰ [Scheduler] lỗi ${job.asin}: ${e.message}`);
    }
  }
}

/* Cài đặt theo ASIN — UI tự nạp khi nhập ASIN */
app.get("/api/asin-settings/:asin", (req, res) => {
  res.json(store.getAsinSettings(String(req.params.asin).toUpperCase()) || { trackParent: true });
});

app.post("/api/stop", (req, res) => {
  stopFlag = true;                          // chế độ local: cắt vòng lặp ngay trong tiến trình này
  const r = store.requestStopJobs();        // chế độ queue: gắn cờ job đang chạy + HỦY job còn chờ
  res.json({ ok: true, jobsStopping: r.stopping, jobsCancelled: r.cancelled });
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
// ADJUST → TẠO FILE BULK TRỰC TIẾP (search term thăng cấp thành campaign Exact, bid = CPC, kèm portfolio)
function buildHarvestCreateRows(items, opts = {}) {
  const { portfolioId, campaignMode, note } = opts;
  if (!Array.isArray(items) || !items.length) throw new Error("Không có keyword nào");
  const saved = store.getLaunchSettings();
  // Mỗi item mang note/portfolio/chế độ RIÊNG (module "Thay đổi" gom nhiều lượt chọn term);
  // thiếu thì lấy giá trị chung của request → tương thích cách gọi cũ.
  const dfPf = String(portfolioId || "").trim();
  const dfNote = note === undefined ? "HARVEST" : String(note || "");
  const dfMode = campaignMode === "multi" ? "multi" : "single";
  const groups = new Map(); // asin|note|pf|mode → items[]
  for (const it of items) {
    const asin = String(it.asin || "").toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(asin)) continue;
    const pf = it.portfolioId === undefined ? dfPf : String(it.portfolioId || "").trim();
    const nt = it.note === undefined ? dfNote : String(it.note || "");
    const md = it.campaignMode ? (it.campaignMode === "multi" ? "multi" : "single") : dfMode;
    const key = [asin, nt, pf, md].join("");
    if (!groups.has(key)) groups.set(key, { asin, note: nt, pf, mode: md, list: [] });
    groups.get(key).list.push(it);
  }
  if (!groups.size) throw new Error("Không nhận diện được ASIN nào");
  const allRows = [];
  let total = 0;
  for (const g of groups.values()) {
    const asin = g.asin;
    const prof = saved.products?.[asin] || {};
    const input = {
      info: { sku: prof.sku || asin, asin, startDate: new Date().toISOString().slice(0, 10), manager: prof.manager || saved.manager || "", category: prof.category || "" },
      keywords: g.list.map((x) => ({ text: x.keyword, bid: x.bid || null })),
      naming: { kw: saved.nameKw ? String(saved.nameKw).replace(/\{Name\}/g, "{NameID}") : undefined }, // template cũ còn {Name} → quy về {NameID}
      portfolios: { exact: g.pf },
      bidRule: { mode: "fixed", fixedBid: Number(saved.fixedBid) || 0.6, minBid: Number(saved.minBid) || 0.15 },
      matches: { exact: { on: true, levels: 1, step: 0.02, note: g.note }, phrase: { on: false }, broad: { on: false } },
      campaignMode: g.mode
    };
    const { plans, trackingKeywords } = planCampaigns(withPortfolioNames(input));
    allRows.push(...buildRowsFromPlans(plans, input));
    store.upsertKeywords(asin, trackingKeywords.map((k) => k.keyword || k), "PPC", "adjust-harvest");
    total += plans.length;
  }
  return { rows: allRows, campaigns: total };
}

/** Đổi tên cột dòng Create (BULK_HEADER: "Campaign Id") sang header THẬT của dataset
 *  (file bulk Amazon tải về dùng "Campaign ID") để Update + Create nằm CHUNG 1 sheet.
 *  Trả {rows, missing} — missing = cột có giá trị nhưng header dataset không có. */
function remapToDatasetHeader(rows, header) {
  const norm = (s) => String(s).toLowerCase().replace(/\s*\(read only\)\s*/g, "").replace(/\s+/g, " ").trim();
  const byNorm = new Map(header.map((h) => [norm(h), h]));
  const missing = new Set();
  const out = rows.map((r) => {
    const o = Object.fromEntries(header.map((h) => [h, ""]));
    for (const [k, v] of Object.entries(r)) {
      if (v === "" || v === null || v === undefined) continue;
      const col = byNorm.get(norm(k));
      if (col) o[col] = v; else missing.add(k);
    }
    return o;
  });
  return { rows: out, missing: [...missing] };
}

// Chỉ dòng Create campaign mới (không kèm sửa/negative) — header 27 cột chuẩn template
app.post("/api/adjust/create-campaigns", (req, res) => {
  try {
    const { items, portfolioId, campaignMode, note } = req.body || {};
    const { rows, campaigns } = buildHarvestCreateRows(items, { portfolioId, campaignMode, note });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows, { header: BULK_HEADER }), "Sponsored Products Campaigns");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    store.saveExportSnapshot({ source: "adjust-harvest", campaigns, rows: rows.length }, buf);
    res.setHeader("Content-Disposition", `attachment; filename="bulk-create-harvest-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.send(buf);
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

app.post("/api/launch/preview", (req, res) => {
  try {
    const { plans, stats, trackingKeywords, asin, dropped, badPlaceholders } = planCampaigns(withPortfolioNames(req.body));
    res.json({ ok: true, stats, totalCampaigns: plans.length,
      plans: plans.slice(0, 1000), trackingCount: trackingKeywords.length, asin, dropped, badPlaceholders });
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
    const withPf = withPortfolioNames(body);
    const plans = Array.isArray(body.plans) && body.plans.length
      ? body.plans
      : planCampaigns(withPf).plans;
    const rows = buildRowsFromPlans(plans, withPf);       // SP → sheet "Sponsored Products Campaigns" (kèm Negative Keyword đính kèm)
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

/* ===================== DANH MỤC (ASIN|SKU|Type + Portfolio) ===================== */
app.get("/api/catalog", (req, res) => {
  const s = store.getLaunchSettings();
  res.json({ products: store.listCatalog(), portfolios: store.listPortfolioDir(), manager: s.manager || "" });
});

app.post("/api/catalog/products", (req, res) => {
  try {
    const rows = req.body?.rows;
    if (!Array.isArray(rows)) throw new Error("Thiếu danh sách dòng");
    const bad = rows.filter((r) => String(r.asin || "").trim() && !/^[A-Z0-9]{10}$/i.test(String(r.asin).trim()));
    // Gửi bảng rỗng = XOÁ SẠCH danh mục. Bắt xác nhận rõ ràng để một lỗi UI không thổi bay
    // toàn bộ SKU đã nạp (products cũng là nơi form Tạo Campaign lưu hồ sơ sản phẩm).
    if (!rows.length && Object.keys(store.getLaunchSettings().products || {}).length && !req.body?.confirmEmpty) {
      throw new Error("Bảng rỗng — gửi kèm confirmEmpty nếu thật sự muốn xoá toàn bộ danh mục");
    }
    const saved = store.saveCatalog(rows);
    res.json({ ok: true, products: saved, skipped: bad.map((r) => r.asin) });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

app.post("/api/catalog/portfolios", (req, res) => {
  try {
    const rows = req.body?.rows;
    if (!Array.isArray(rows)) throw new Error("Thiếu danh sách dòng");
    res.json({ ok: true, portfolios: store.savePortfolioDir(rows) });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

// Mã cá nhân: mặc định theo TÀI KHOẢN (trước đây gõ lại ở mỗi lần tạo campaign)
app.post("/api/catalog/manager", (req, res) => {
  const manager = String(req.body?.manager || "").trim().slice(0, 5);
  store.saveLaunchSettings({ manager });
  res.json({ ok: true, manager });
});

/* ===================== PHÂN TÍCH KEYWORD (Helium 10 Cerebro) ===================== */

// Cookie H10: chỉ GHI vào, đọc ra chỉ trả tóm tắt — không bao giờ trả giá trị cookie về UI
app.get("/api/h10/cookie", (req, res) => res.json(store.h10CookieStatus()));
app.post("/api/h10/cookie", (req, res) => {
  try {
    let { cookies, raw, note, storageRaw } = req.body || {};
    if (!Array.isArray(cookies)) cookies = parseCookieInput(raw);
    let storage = null;
    if (String(storageRaw || "").trim()) {
      const j = JSON.parse(String(storageRaw).trim());
      if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("localStorage phải là object {khoá: giá trị}");
      storage = Object.fromEntries(Object.entries(j).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
    }
    if (!cookies.length && !storage) throw new Error("Không đọc được gì — dán cookie (JSON từ EditThisCookie) hoặc localStorage");
    store.saveH10Cookie(cookies, note, storage);
    const st = store.h10CookieStatus();
    if (!st.hasToken) st.warn = "Chưa có CORE_BEARER_TOKEN trong localStorage — H10 xác thực bằng token này, chỉ cookie là chưa đủ";
    res.json({ ok: true, ...st });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

/** Nhận 2 dạng dán: JSON mảng cookie (EditThisCookie/Cookie-Editor) hoặc chuỗi "a=1; b=2".
 *  Chuỗi thô không mang domain nên mặc định .helium10.com. */
function parseCookieInput(raw) {
  let s = String(raw || "").trim();
  if (!s) return [];
  /* Dán thẳng từ Google Doc: trình soạn thảo escape dấu gạch dưới và ngoặc vuông
     (\_BEAMER\_USER\_ID, \[ ) và hay chèn dấu nháy cong — JSON.parse sẽ hỏng.
     Gỡ escape và nắn nháy về nháy thẳng trước khi phân tích. */
  s = s.replace(/\\([_[\]{}*`~])/g, "$1")
       .replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'")
       .replace(/\u00A0/g, " ")
       .trim();
  const i0 = s.indexOf("["), i1 = s.lastIndexOf("]");
  if (i0 !== -1 && i1 > i0) s = s.slice(i0, i1 + 1); // bỏ chữ thừa quanh khối JSON trong Doc
  if (s.startsWith("[") || s.startsWith("{")) {
    const j = JSON.parse(s);
    const arr = Array.isArray(j) ? j : [j];
    /* GIỮ NGUYÊN thuộc tính gốc. Bản trước ép secure=true cho mọi cookie và VỨT BỎ sameSite
       — EditThisCookie ghi "no_restriction" (nghĩa là None), bỏ đi thì Chrome mặc định Lax và
       cookie có thể không được gửi trong request phụ của SPA. */
    const SAME = { no_restriction: "None", unspecified: "Lax", lax: "Lax", strict: "Strict", none: "None" };
    return arr.filter((c) => c && c.name).map((c) => {
      const o = {
        name: String(c.name), value: String(c.value ?? ""),
        domain: c.domain || ".helium10.com", path: c.path || "/",
        secure: c.secure === undefined ? true : !!c.secure,
        httpOnly: !!c.httpOnly
      };
      const ss = SAME[String(c.sameSite || "").toLowerCase()];
      if (ss) o.sameSite = ss;
      if (o.sameSite === "None") o.secure = true;      // Chrome bắt buộc: SameSite=None phải Secure
      if (c.expirationDate) o.expires = Math.floor(c.expirationDate);
      return o;
    });
  }
  return s.split(";").map((part) => {
    const i = part.indexOf("=");
    if (i < 1) return null;
    return { name: part.slice(0, i).trim(), value: part.slice(i + 1).trim(),
      domain: ".helium10.com", path: "/", secure: true, httpOnly: false };
  }).filter(Boolean);
}

/* Agent lấy cookie H10 qua ĐÂY, không nhét vào payload của job: jobs.json giữ 200 job và
   trả nguyên về trình duyệt qua /api/jobs — nhét cookie vào đó là rải bản sao khắp nơi. */
app.post("/api/agent/h10-cookie", (req, res) => {
  const c = store.getH10Cookie();
  if (!c.cookies?.length && !Object.keys(c.storage || {}).length) {
    return res.status(404).json({ error: "Chưa nạp cookie/localStorage H10 ở trang Phân tích Keyword" });
  }
  res.json({ cookies: c.cookies || [], storage: c.storage || {}, updatedAt: c.updatedAt });
});

/* Báo cáo chẩn đoán: agent mở Cerebro rồi kể lại nó thấy gì. Có nó mới viết được selector
   đúng — đoán mò DOM của H10 là gần như chắc sai. */
const H10_REPORT = () => `${userDataDir()}/h10-report.json`;
app.post("/api/agent/h10-report", (req, res) => {
  try {
    fs.mkdirSync(userDataDir(), { recursive: true });
    fs.writeFileSync(H10_REPORT(), JSON.stringify({ ...(req.body || {}), at: new Date().toISOString() }, null, 1));
    if (req.body?.jobId) store.completeJob(req.body.jobId, null);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
app.get("/api/h10/report", (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(H10_REPORT(), "utf8"))); }
  catch { res.json({ at: null }); }
});

// Xếp job cho agent mở Cerebro và kể lại hiện trạng (đăng nhập được không, có bị chặn không)
app.post("/api/h10/check", (req, res) => {
  if (RUN_MODE !== "queue") return res.status(409).json({ ok: false, message: "Chỉ chạy ở chế độ queue (agent)" });
  const c = store.getH10Cookie();
  if (!c.cookies?.length) return res.status(400).json({ ok: false, message: "Chưa nạp cookie H10" });
  const asin = String(req.body?.asin || "").trim().toUpperCase();
  const job = store.enqueueJob({ kind: "h10check", asin: /^[A-Z0-9]{10}$/.test(asin) ? asin : null,
    runId: "h10-" + Date.now().toString(36) });
  res.json({ ok: true, jobId: job.id });
});

// Bộ quy tắc = đúng các ô lọc của Cerebro + cách quét
app.get("/api/h10/rules", (req, res) => res.json({ rules: store.listH10Rules() }));
app.post("/api/h10/rules", (req, res) => {
  try { res.json({ ok: true, rules: store.saveH10Rules(req.body?.rules) }); }
  catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

// Bộ keyword đã phân tích
app.get("/api/h10/sets", (req, res) => res.json({ sets: store.listH10Sets() }));
app.get("/api/h10/sets/:id", (req, res) => {
  const s = store.getH10Set(req.params.id);
  s ? res.json(s) : res.status(404).json({ error: "not found" });
});
app.post("/api/h10/sets", (req, res) => {
  try {
    const b = req.body || {};
    if (!Array.isArray(b.keywords) || !b.keywords.length) throw new Error("Bộ keyword rỗng");
    res.json({ ok: true, ...store.saveH10Set(b) });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});
app.delete("/api/h10/sets/:id", (req, res) => res.json({ ok: store.deleteH10Set(req.params.id) }));

/* ===================== MODULE ADJUST (chỉnh sửa ads từ file bulk) ===================== */
const ADJUST_DIR_FN = () => `${userDataDir()}/adjust`;
// Cache dataset: key PHẢI gồm phân vùng — key chỉ theo id thì user A biết id của user B là
// đọc trọn bulk data của B từ RAM (bỏ qua cả bước resolve đường dẫn). Giới hạn số dataset
// giữ trong RAM: mỗi file bulk ~170MB JSON, parse ra còn lớn hơn → không chặn là OOM.
const adjustCache = new Map(); // "<phân vùng>|<id>" → dataset (Map giữ thứ tự chèn = LRU thô)
// ĐO THẬT 06/08/2026: file bulk 81MB → RSS server tăng 44MB ⇒ 991MB (gấp ~12 lần file, do
// 300k object record). File 165MB ≈ 2GB. Nên chỉ giữ 1 dataset: giữ 3 là 4-6GB → OOM Railway.
// Đổi dataset phải nạp lại nhưng chỉ mất ~0.6s; cùng dataset (tab Targets↔Terms) vẫn cache hit.
const ADJUST_CACHE_MAX = 1;
const cacheKey = (id) => `${userDataDir()}|${id}`;
function cachePut(id, ds) {
  const k = cacheKey(id);
  adjustCache.delete(k);
  adjustCache.set(k, ds);
  while (adjustCache.size > ADJUST_CACHE_MAX) adjustCache.delete(adjustCache.keys().next().value);
}
function cacheGet(id) {
  const k = cacheKey(id);
  if (!adjustCache.has(k)) return null;
  const ds = adjustCache.get(k);
  adjustCache.delete(k); adjustCache.set(k, ds); // vừa dùng → đẩy xuống cuối
  return ds;
}
const uploadBig = multer({ dest: "./data/uploads", limits: { fileSize: 300 * 1024 * 1024 } });

function adjustIndex() {
  try { return JSON.parse(fs.readFileSync(`${ADJUST_DIR_FN()}/index.json`, "utf8")); } catch { return []; }
}
function loadDataset(id) {
  if (!/^[\w-]+$/.test(String(id || ""))) return null; // chặn traversal TRƯỚC khi tra cache
  const hit = cacheGet(id);
  if (hit) return hit;
  try {
    const ds = JSON.parse(fs.readFileSync(`${ADJUST_DIR_FN()}/${id}.json`, "utf8"));
    stampAsins(ds); // chạy lúc ĐỌC để dataset nạp từ trước cũng được nối ASIN, khỏi import lại
    ds.byKey = new Map(ds.records.map((r) => [rowKey(r), r]));
    cachePut(id, ds);
    return ds;
  } catch { return null; }
}

// Upload + ETL (file 30-40MB/300k dòng → chạy server-side, mất ~10-30s)
app.post("/api/adjust/import", (req, res, next) => uploadBig.single("file")(req, res, next), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, message: "Chưa chọn file" });
    const ds = etlBulk(fs.readFileSync(req.file.path), req.file.originalname);
    fs.unlinkSync(req.file.path);

    fs.mkdirSync(ADJUST_DIR_FN(), { recursive: true });
    const id = `${ds.meta.windowStart || "x"}-${ds.meta.windowEnd || "x"}-${Date.now().toString(36)}`;
    fs.writeFileSync(`${ADJUST_DIR_FN()}/${id}.json`, JSON.stringify(ds));
    const idx = adjustIndex().filter((d) => d.id !== id);
    idx.unshift({ id, ...ds.meta });
    fs.writeFileSync(`${ADJUST_DIR_FN()}/index.json`, JSON.stringify(idx.slice(0, 20), null, 1));
    stampAsins(ds);
    ds.byKey = new Map(ds.records.map((r) => [rowKey(r), r]));
    cachePut(id, ds);

    res.json({ ok: true, id, meta: ds.meta });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message });
  }
});

app.get("/api/adjust/datasets", (req, res) => res.json(adjustIndex()));

// Danh sách portfolio (tên + ID) trong dataset — cho dropdown filter
app.post("/api/adjust/portfolios", (req, res) => {
  const ds = loadDataset(req.body?.id);
  if (!ds) return res.status(404).json({ ok: false, message: "Chưa có dataset" });
  res.json({ ok: true, ...listPortfolios(ds.records) });
});

// Đặt tên (label) cho dataset đã lưu — lưu trữ file kết quả theo dải ngày + tên tự đặt
app.post("/api/adjust/datasets/:id/rename", (req, res) => {
  const idx = adjustIndex();
  const d = idx.find((x) => x.id === req.params.id);
  if (!d) return res.status(404).json({ ok: false, message: "Không tìm thấy dataset" });
  d.label = String(req.body?.name || "").slice(0, 80);
  fs.mkdirSync(ADJUST_DIR_FN(), { recursive: true });
  fs.writeFileSync(`${ADJUST_DIR_FN()}/index.json`, JSON.stringify(idx, null, 1));
  const ds = cacheGet(req.params.id); if (ds && ds.meta) ds.meta.label = d.label;
  res.json({ ok: true, label: d.label });
});

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

/** Dựng workbook Update (dòng thay đổi + Negative) + ghi audit. Trả {buf, rowCount}. */
function writeUpdateWorkbook(ds, edits, negatives, id, source) {
  const rows = buildUpdateRows(ds.header, ds.byKey, edits, negatives);
  if (!rows.length) throw new Error("Không có thay đổi nào để xuất");
  const ws = XLSX.utils.json_to_sheet(rows, { header: ds.header });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sponsored Products Campaigns");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  fs.mkdirSync(ADJUST_DIR_FN(), { recursive: true });
  const audit = { at: new Date().toISOString(), dataset: id, source: source || "manual",
    edits: (edits || []).length, negatives: (negatives || []).length, detail: { edits, negatives } };
  fs.appendFileSync(`${ADJUST_DIR_FN()}/audit.jsonl`, JSON.stringify(audit) + "\n");
  return { buf, rowCount: rows.length };
}

function sendWorkbook(res, buf, rowCount, id) {
  res.setHeader("Content-Disposition",
    `attachment; filename="bulk-update-${id}-${new Date().toISOString().slice(0, 10)}.xlsx"`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("X-Adjust-Info", JSON.stringify({ rows: rowCount }));
  res.send(buf);
}

// Search Term gom nhóm (ASIN → term → occurrences) — có tổng chỉ số theo term
app.post("/api/adjust/terms-grouped", (req, res) => {
  const ds = loadDataset(req.body?.id);
  if (!ds) return res.status(404).json({ ok: false, message: "Chưa có dataset — upload file bulk (tick Search Term Report)" });
  res.json({ ok: true, ...groupTerms(ds.terms || [], req.body), meta: ds.meta });
});

// Xuất file UPDATE (chỉ dòng thay đổi + Negative mới) + audit log
app.post("/api/adjust/export", (req, res) => {
  try {
    const { id, edits, negatives } = req.body || {};
    const ds = loadDataset(id);
    if (!ds) throw new Error("Dataset không tồn tại");
    const { buf, rowCount } = writeUpdateWorkbook(ds, edits, negatives, id, "manual");
    sendWorkbook(res, buf, rowCount, id);
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message });
  }
});

// XUẤT GỘP — 1 file duy nhất cho toàn bộ module "Thay đổi":
// dòng Update (sửa bid/budget/state/tên) + dòng Create (negative + campaign mới từ search term).
// Amazon đọc theo cột Operation nên Update và Create nằm chung 1 sheet được.
app.post("/api/adjust/export-all", (req, res) => {
  try {
    const { id, edits, negatives, creates } = req.body || {};
    const ds = loadDataset(id);
    if (!ds) throw new Error("Dataset không tồn tại");
    const updateRows = buildUpdateRows(ds.header, ds.byKey, edits, negatives);
    let createRows = [], campaigns = 0, missing = [];
    if (Array.isArray(creates) && creates.length) {
      const built = buildHarvestCreateRows(creates.map((c) => ({
        asin: c.asin, keyword: c.keyword, bid: c.bid || null,
        note: c.note, portfolioId: c.pf, campaignMode: c.mode
      })));
      campaigns = built.campaigns;
      const m = remapToDatasetHeader(built.rows, ds.header);
      createRows = m.rows; missing = m.missing;
    }
    const rows = [...updateRows, ...createRows];
    if (!rows.length) throw new Error("Không có thay đổi nào để xuất");
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows, { header: ds.header }), "Sponsored Products Campaigns");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    fs.mkdirSync(ADJUST_DIR_FN(), { recursive: true });
    const audit = { at: new Date().toISOString(), dataset: id, source: "manual",
      edits: (edits || []).length, negatives: (negatives || []).length, creates: (creates || []).length,
      detail: { edits, negatives, creates } };
    fs.appendFileSync(`${ADJUST_DIR_FN()}/audit.jsonl`, JSON.stringify(audit) + "\n");
    if (campaigns) store.saveExportSnapshot({ source: "adjust-all", campaigns, rows: createRows.length }, buf);
    res.setHeader("Content-Disposition",
      `attachment; filename="bulk-adjust-${id}-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("X-Adjust-Info", JSON.stringify({ rows: rows.length,
      updateRows: updateRows.length, createRows: createRows.length, campaigns, missing }));
    res.send(buf);
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message });
  }
});

// Nhật ký chỉnh sửa (mọi lần xuất file Update — thủ công hoặc từ rule)
app.get("/api/adjust/audit", (req, res) => {
  let lines = [];
  try { lines = fs.readFileSync(`${ADJUST_DIR_FN()}/audit.jsonl`, "utf8").split("\n").filter(Boolean); } catch { lines = []; }
  let entries = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (req.query.dataset) entries = entries.filter((e) => e.dataset === req.query.dataset);
  entries.reverse(); // mới nhất trước
  const limit = Math.min(500, Number(req.query.limit) || 100);
  res.json({ ok: true, entries: entries.slice(0, limit) });
});

/* ===================== MODULE ADJUST A3: rule engine (dry-run → proposals → export) ===================== */

// Rank ToS theo (ASIN|keyword) từ lịch sử daily (lấy dateKey mới nhất) — cho rule RANK R1
function buildRankMap(asins) {
  const map = {};
  for (const a of asins) {
    const series = store.getDailySeries(a); // { kw: { date: {tos:"x/y"...} } }
    for (const [kw, byDate] of Object.entries(series)) {
      const dates = Object.keys(byDate).sort();
      const last = byDate[dates[dates.length - 1]];
      if (!last) continue;
      let tosPos = null;
      if (typeof last.tos === "string" && last.tos.includes("/")) {
        const x = parseInt(last.tos.split("/")[0], 10);
        tosPos = isNaN(x) ? null : x;
      }
      map[`${a}|${kw.toLowerCase()}`] = { tosPos };
    }
  }
  return map;
}

// Rules CRUD (seed Rule Set v1 nếu rỗng)
app.get("/api/adjust/rules", (req, res) => {
  store.seedDefaultRulesIfEmpty(DEFAULT_RULES);
  res.json({ ok: true, rules: store.listRules() });
});
app.post("/api/adjust/rules", (req, res) => res.json({ ok: true, rule: store.createRule(req.body || {}) }));
app.put("/api/adjust/rules/:id", (req, res) => {
  const r = store.updateRule(req.params.id, req.body || {});
  if (!r) return res.status(404).json({ ok: false, message: "Không tìm thấy rule" });
  res.json({ ok: true, rule: r });
});
app.delete("/api/adjust/rules/:id", (req, res) => { store.deleteRule(req.params.id); res.json({ ok: true }); });
app.post("/api/adjust/rules/reset", (req, res) => { store.resetRules(DEFAULT_RULES); res.json({ ok: true, rules: store.listRules() }); });

// Products: target ACoS theo ASIN (rule P3/P4)
app.get("/api/adjust/products", (req, res) => res.json({ ok: true, products: store.listProducts() }));
app.post("/api/adjust/products", (req, res) => {
  const asin = String(req.body?.asin || "").toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(asin)) return res.status(400).json({ ok: false, message: "ASIN không hợp lệ" });
  const patch = {};
  if (req.body.target_acos !== undefined && req.body.target_acos !== "") patch.target_acos = Number(req.body.target_acos);
  res.json({ ok: true, product: store.upsertProduct(asin, patch) });
});

// Chạy rule (DRY-RUN) → sinh proposals pending (thay thế pending cũ của dataset)
app.post("/api/adjust/run-rules", (req, res) => {
  try {
    const { id, ruleIds } = req.body || {};
    const ds = loadDataset(id);
    if (!ds) throw new Error("Dataset không tồn tại — upload/chọn dataset trước");
    store.seedDefaultRulesIfEmpty(DEFAULT_RULES);
    let rules = store.listRules();
    if (Array.isArray(ruleIds) && ruleIds.length) rules = rules.filter((r) => ruleIds.includes(r.id));

    const asinOf = (r) => { const a = String(r.asin || "").toUpperCase(); if (/^B0[A-Z0-9]{8}$/.test(a)) return a; const m = String(r.name || "").toUpperCase().match(/B0[A-Z0-9]{8}/); return m ? m[0] : null; };
    const asins = [...new Set(ds.records.map(asinOf).filter(Boolean))];
    const products = store.getProductsMap(asins);
    const targetAcosByAsin = {};
    for (const [a, p] of Object.entries(products)) if (p.target_acos != null) targetAcosByAsin[a] = p.target_acos;
    const rankByAsinKw = buildRankMap(asins);

    const proposals = evaluateRules(rules, ds.records, { targetAcosByAsin, rankByAsinKw });
    const runId = Date.now().toString(36);
    store.setProposalStatusByDataset(id, "pending", "superseded"); // dọn dry-run cũ chưa duyệt
    const inserted = store.insertProposals(proposals.map((p) => ({ ...p, datasetId: id, runId })));
    const missingTargetAcos = asins.filter((a) => targetAcosByAsin[a] == null);
    res.json({ ok: true, runId, count: inserted.length, missingTargetAcos, proposals: inserted });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

app.get("/api/adjust/proposals", (req, res) => {
  res.json({ ok: true, proposals: store.listProposals({ datasetId: req.query.datasetId, status: req.query.status || null }) });
});
app.post("/api/adjust/proposals/approve", (req, res) => {
  const { ids, all, datasetId } = req.body || {};
  const n = all ? store.setProposalStatusByDataset(datasetId, "pending", "approved") : store.setProposalStatus(ids, "approved");
  res.json({ ok: true, updated: n });
});
app.post("/api/adjust/proposals/reject", (req, res) => {
  const { ids, all, datasetId } = req.body || {};
  const n = all ? store.setProposalStatusByDataset(datasetId, "pending", "rejected") : store.setProposalStatus(ids, "rejected");
  res.json({ ok: true, updated: n });
});

// Xuất file Update từ proposals ĐÃ DUYỆT (approved) — tái dùng buildUpdateRows
app.post("/api/adjust/proposals/export", (req, res) => {
  try {
    const { id } = req.body || {};
    const ds = loadDataset(id);
    if (!ds) throw new Error("Dataset không tồn tại");
    const approved = store.listProposals({ datasetId: id, status: "approved" });
    if (!approved.length) throw new Error("Chưa có đề xuất nào được duyệt");
    const edits = approved.map((p) => ({ k: p.k, field: p.field, value: p.new_value }));
    const { buf, rowCount } = writeUpdateWorkbook(ds, edits, [], id, "rules");
    store.setProposalStatusByDataset(id, "approved", "exported");
    sendWorkbook(res, buf, rowCount, id);
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

/* ===== Import file bulk daily → chỉ số ads theo ASIN (Spent, Sales ads, ACoS...) ===== */
const uploadMw = multer({ dest: "./data/uploads" });
const upload = uploadMw;

app.post("/api/import-bulk", upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, message: "Chưa chọn file" });
    const out = importAdsBulk(fs.readFileSync(req.file.path), req.file.originalname, req.body.date);
    fs.unlinkSync(req.file.path);
    res.json({ ok: true, ...out });
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

/* ===================== MODULE DATA (import + hợp nhất + đánh giá chỉ số theo ngày) ===================== */
function parseMapping(v) { try { return v ? JSON.parse(v) : {}; } catch { return {}; } }

// Import 3 nguồn (ads / business / inventory). mapping (JSON) tùy chọn cho business/inventory.
app.post("/api/data/import/ads", upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, message: "Chưa chọn file" });
    const out = importAdsBulk(fs.readFileSync(req.file.path), req.file.originalname, req.body.date);
    fs.unlinkSync(req.file.path);
    res.json({ ok: true, ...out });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

app.post("/api/data/import/business", upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, message: "Chưa chọn file" });
    const out = importBusiness(fs.readFileSync(req.file.path), req.file.originalname, req.body.date, parseMapping(req.body.mapping));
    fs.unlinkSync(req.file.path);
    res.json({ ok: true, ...out });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

app.post("/api/data/import/inventory", upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, message: "Chưa chọn file" });
    const out = importInventory(fs.readFileSync(req.file.path), req.file.originalname, req.body.date, parseMapping(req.body.mapping));
    fs.unlinkSync(req.file.path);
    res.json({ ok: true, ...out });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

// Preview ánh xạ cột (business/inventory) trước khi commit
app.post("/api/data/preview-columns", upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, message: "Chưa chọn file" });
    const kind = String(req.body.kind || "");
    const out = previewImport(kind, fs.readFileSync(req.file.path));
    fs.unlinkSync(req.file.path);
    res.json({ ok: true, kind, fields: FIELD_SPECS[kind].map((s) => ({ key: s.key, label: s.label })), ...out });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

app.get("/api/data/asins", (req, res) => res.json({ asins: store.listDataAsins() }));
app.get("/api/data/imports", (req, res) => res.json({ imports: store.listImports(req.query.kind || null) }));

// Bảng hợp nhất theo ngày cho 1 ASIN
app.get("/api/data/consolidated/:asin", (req, res) => {
  const out = buildAsinDaily(req.params.asin, { from: req.query.from || null, to: req.query.to || null });
  res.json(out);
});

// Tín hiệu đánh giá cho 1 ASIN (target ACoS lấy từ products, hoặc query override)
app.get("/api/data/evaluate/:asin", (req, res) => {
  const asin = String(req.params.asin).toUpperCase();
  const { days } = buildAsinDaily(asin, { from: req.query.from || null, to: req.query.to || null });
  let targetAcos = req.query.targetAcos != null && req.query.targetAcos !== "" ? Number(req.query.targetAcos) : null;
  if (targetAcos == null && store.getProduct) {
    const p = store.getProduct(asin);
    if (p && p.target_acos != null) targetAcos = Number(p.target_acos);
  }
  res.json({ asin, ...evaluateAsin(days, { targetAcos }) });
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

// Export bảng competitor ra Excel
app.get("/api/competitor-rank/:asin/export", (req, res) => {
  const r = store.getCompetitorRank(String(req.params.asin).toUpperCase(), req.query.date || null);
  const rows = r.list.map((x, i) => ({
    "#": i + 1, ASIN: x.asin, "Số keyword": x.n, "Best organic": x.bestRank ?? "",
    Keywords: (x.kws || []).join(", ")
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Competitor");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Disposition", `attachment; filename="competitor-${req.params.asin}-${(r.date || "all").replace(/[: ]/g, "_")}.xlsx"`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(buf);
});

// Get Competitor cho Tạo Campaign: nhiều phiên + khoảng số keyword + loại ASIN tắt theo dõi
app.post("/api/competitor-pick", (req, res) => {
  const { asin, dates, minKw, maxKw, excludeUntracked } = req.body || {};
  if (!/^[A-Z0-9]{10}$/i.test(String(asin || ""))) return res.status(400).json({ error: "ASIN không hợp lệ" });
  res.json({ list: store.getCompetitorPick(String(asin).toUpperCase(), dates || [], minKw, maxKw, !!excludeUntracked) });
});

/* ===== COMPETITOR LIBRARY ===== */
app.get("/api/competitor-library", (req, res) => res.json(store.getCompetitorLibrary()));

app.post("/api/competitor-library/add", (req, res) => {
  const main = String(req.body?.main || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(main)) return res.status(400).json({ error: "Chọn ASIN chính trước" });
  const asins = String(req.body?.asins || "").split(/[\s,;]+/).filter(Boolean);
  res.json({ ok: true, added: store.compLibAdd(main, asins) });
});

app.post("/api/competitor-library/patch", (req, res) => {
  const { main, comp, ...patch } = req.body || {};
  store.compLibPatch(main, comp, patch);
  res.json({ ok: true });
});

// Get Competitor (Tạo Campaign): CHỈ từ Library — khoảng keyword optional
app.post("/api/competitor-pick-lib", (req, res) => {
  const { asin, minKw, maxKw, includeUntracked } = req.body || {};
  if (!/^[A-Z0-9]{10}$/i.test(String(asin || ""))) return res.status(400).json({ error: "ASIN không hợp lệ" });
  res.json({ list: store.getCompetitorPickLib(String(asin).toUpperCase(), minKw, maxKw, !!includeUntracked) });
});

// Quét Library: ảnh + title (chỉ lần đầu) + Sale "bought in past month" (mỗi lần) — stream log
app.post("/api/competitor-library/scan", async (req, res) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  const log = (m) => { try { res.write(m + "\n"); } catch {} };
  const asins = (req.body?.asins || []).map((a) => String(a).trim().toUpperCase()).filter((a) => /^[A-Z0-9]{10}$/.test(a));
  if (!asins.length) { log("🚨 Chưa chọn competitor nào"); return res.end(); }
  // Chế độ queue (Railway): KHÔNG scrape trên server (IP datacenter bị Amazon nghi bot) —
  // xếp job cho agent trên máy cá nhân, kết quả đẩy về /api/agent/lib-result
  if (RUN_MODE === "queue") {
    const job = store.enqueueJob({ kind: "libscan", asins, zip: store.getWorkerConfig().zip });
    log(`📨 Đã xếp job quét ${asins.length} competitor — agent trên máy cá nhân sẽ chạy.`);
    log(`JOB_ID:${job.id}`);
    return res.end();
  }
  if (running) { log("Đang có phiên chạy — bấm Dừng trước."); return res.end(); }
  running = true; stopFlag = false;
  let browser = null;
  const today = new Date().toISOString().slice(0, 10);
  try {
    browser = await launchBrowser();
    const page = await newCleanPage(browser, loadCookies());
    await ensureZipLocation(page, store.getWorkerConfig().zip, log);
    for (let i = 0; i < asins.length; i++) {
      if (stopFlag) { log("⏹ Đã dừng."); break; }
      const a = asins[i];
      try {
        await page.goto(`https://www.amazon.com/dp/${a}`, { waitUntil: "domcontentloaded", timeout: 30000 });
        await new Promise((r) => setTimeout(r, 1200 + Math.random() * 800));
        const info = await page.evaluate(() => {
          const title = document.querySelector("#productTitle")?.textContent.trim() || null;
          const image = document.querySelector("#landingImage")?.getAttribute("src") || document.querySelector("#imgTagWrapperId img")?.getAttribute("src") || null;
          // "50+ bought in past month" / "1K+ bought in past month"
          const m = document.body.innerText.match(/([0-9.,]+[KkMm]?\+?)\s+bought in past month/);
          // Giá: khối buybox/core price đầu tiên
          const price = document.querySelector("#corePriceDisplay_desktop_feature_div .a-price .a-offscreen")?.textContent.trim()
            || document.querySelector("#apex_desktop .a-price .a-offscreen")?.textContent.trim()
            || document.querySelector(".a-price .a-offscreen")?.textContent.trim() || null;
          return { title, image, sales: m ? m[1] : null, price };
        });
        store.compLibSaveScan(a, { ...info, date: today });
        log(`🔍 [${i + 1}/${asins.length}] ${a} → ${info.title ? info.title.slice(0, 50) + "…" : "(không đọc được title)"} · Sale: ${info.sales || "_"} · Giá: ${info.price || "_"}`);
      } catch (e) {
        log(`⚠️ [${i + 1}/${asins.length}] ${a} lỗi: ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 800 + Math.random() * 700));
    }
    log("✅ Xong — ảnh/title lưu lần đầu, Sale lưu theo ngày " + today);
  } catch (e) {
    log(`🚨 ${e.message}`);
  } finally {
    // Nhả cờ TRƯỚC khi đóng browser: nếu close() treo (Chrome kẹt sau khi Dừng giữa chừng)
    // thì lần quét sau vẫn chạy được — không còn kẹt "Đang có phiên chạy"
    running = false;
    if (browser) { try { await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 5000))]); } catch {} }
    res.end();
  }
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

// UI_VERSION trong mỗi trang phải khớp APP_VERSION, nếu không banner "⚠️ Server đang chạy
// phiên bản cũ" hiện SAI ở mọi tab. Quên đồng bộ khi bump là lỗi rất dễ mắc và chỉ người
// dùng mới thấy — nên bắt ngay lúc boot thay vì để họ báo lại.
// Bọc try: đây chỉ là cảnh báo cho lập trình viên, KHÔNG được phép làm sập server nếu
// thư mục public không đọc được ở môi trường triển khai.
try {
  for (const f of fs.readdirSync("./public").filter((x) => x.endsWith(".html"))) {
    const m = fs.readFileSync(`./public/${f}`, "utf8").match(/UI_VERSION\s*=\s*['"]([^'"]+)/);
    if (m && m[1] !== APP_VERSION) console.error(`🚨 public/${f}: UI_VERSION=${m[1]} ≠ APP_VERSION=${APP_VERSION} — banner "phiên bản cũ" sẽ hiện sai`);
  }
} catch (e) { console.warn(`(bỏ qua kiểm tra UI_VERSION: ${e.message})`); }

// QUÊN MẬT KHẨU: đặt ADMIN_RESET="tên_đăng_nhập:mật_khẩu_mới" trong Railway Variables →
// server khởi động lại là mật khẩu được đặt lại → đăng nhập xong thì XOÁ biến đó đi.
// Chi tiết và lý do không làm thành endpoint HTTP: xem src/auth.js.
auth.applyAdminResetFromEnv(process.env.ADMIN_RESET);

console.log(`▶ boot: PORT=${process.env.PORT || "(trống)"} WORKER_PORT=${process.env.WORKER_PORT || "(trống)"} RUN_MODE=${RUN_MODE} node=${process.version}`);
const srv = app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 PPC Warrior Worker v${APP_VERSION}: http://localhost:${PORT}\n` +
    `   Chrome khi bấm Run: ${RUN_MODE === "queue" ? "KHÔNG mở trên server này (RUN_MODE=queue — agent chạy)"
      : process.env.HEADFUL === "1" ? "HEADFUL (cửa sổ ngoài màn hình, có icon Dock)"
      : "HEADLESS mới (vô hình hoàn toàn: không cửa sổ, không icon Dock)"}`)
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
