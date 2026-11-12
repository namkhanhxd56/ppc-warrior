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
import { parseKeywordFile } from "./src/keywords/kw-import.js";
import { etlBulk, queryRows, buildUpdateRows, rowKey, groupTerms, listPortfolios, stampAsins, AD_TYPES, AD_PRODUCT, assertBidCap } from "./src/adjust/bulk-etl.js";
import { evaluate as evaluateRules } from "./src/adjust/rule-engine.js";
import { DEFAULT_RULES } from "./src/adjust/default-rules.js";
import { buildMetrics, summarize, cellOf, buildAsinDaily } from "./src/data/consolidate.js";
import { importAdsBulk, importBusiness, importInventory, preview as previewImport, FIELD_SPECS } from "./src/data/imports.js";
import { evaluateAsin } from "./src/data/evaluate.js";
import * as store from "./src/db/file-store.js";
import * as auth from "./src/auth.js";
import { als, runAsUser, userDataDir } from "./src/db/user-context.js";

dotenv.config();
export const APP_VERSION = "0.49.6"; // tăng mỗi lần sửa API — UI đối chiếu để cảnh báo quên restart

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
/* /nav.js và /agent-panel.js phải công khai: chúng nằm trên CHÍNH trang đăng nhập. Không
   mở thì thẻ <script src> bị redirect sang /user, trình duyệt nhận về HTML và ném
   "Unexpected token '<'" ngay giữa màn hình đăng nhập. Hai file này chỉ là mã giao diện —
   mọi API chúng gọi vẫn chặn theo phiên như cũ. */
const PUBLIC_PATHS = ["/user", "/user.html", "/login.html", "/api/auth/login", "/api/auth/register", "/api/auth/me", "/api/version", "/favicon.ico", "/setup-agent.sh", "/setup-agent.ps1", "/agent-bundle.tgz", "/nav.js", "/agent-panel.js"];
app.use((req, res, next) => {
  const p = req.path;
  // /kwlist/<slug> = trang CHIA SẺ Danh mục Target (xem server.js phần "CHIA SẺ LIST") — cố ý
  // công khai, không cần đăng nhập, để gửi được cho người ngoài tool (VA/freelancer...).
  if (PUBLIC_PATHS.includes(p) || p.startsWith("/kwlist/")) return next();

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
/* PHẢI tự khai express.json() ở đây: bộ đọc JSON dùng chung mãi dưới dòng ~334, mà nhóm
   route này nằm TRÊN nó nên req.body luôn undefined. Hậu quả im lặng, không hề báo lỗi:
   đặt tên máy → label undefined → mọi máy đều thành "máy chưa đặt tên"; đổi tên/xoá/thu hồi
   → id undefined → "Mã token không hợp lệ". Đúng 3 lỗi người dùng báo. */
app.use("/api/agent-tokens", express.json());
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
app.post("/api/agent-tokens/delete", (req, res) => {
  const u = auth.getSession(auth.parseCookie(req));
  if (!u) return res.status(401).json({ error: "Chưa đăng nhập" });
  try { auth.deleteAgentToken(String(req.body?.id || ""), u.name, u.role === "admin"); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});
app.post("/api/agent-tokens/rename", (req, res) => {
  const u = auth.getSession(auth.parseCookie(req));
  if (!u) return res.status(401).json({ error: "Chưa đăng nhập" });
  try { res.json({ ok: true, label: auth.renameAgentToken(String(req.body?.id || ""), req.body?.label, u.name, u.role === "admin") }); }
  catch (e) { res.status(400).json({ ok: false, message: e.message }); }
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
command -v node >/dev/null || { echo "❌ Cần Node.js 20+ (https://nodejs.org)"; return; }
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
/* ===== CÀI AGENT TRÊN WINDOWS =====
   setup-agent.sh là bash — Windows không chạy được. Bản PowerShell này chỉ dùng curl.exe và
   tar.exe CÓ SẴN trong Windows 10 (1803+) và 11, nên ngoài Node.js không phải cài thêm gì.
   Ghi .env bằng Out-File -Encoding ascii: PowerShell 5.1 mặc định thêm BOM, dotenv sẽ đọc
   dòng đầu thành "\uFEFFSERVER_URL" rồi agent báo thiếu SERVER_URL.
   Dùng "return" chứ KHÔNG dùng "exit": lệnh cài chạy script qua
   [scriptblock]::Create(...) ngay trong phiên hiện tại, mà "exit" trong scriptblock đóng
   LUÔN CỬA SỔ PowerShell — người dùng mất sạch thông báo lỗi vừa in ra.
   Gọi npm.cmd chứ không phải npm: PowerShell phân giải "npm" thành npm.ps1 và từ chối chạy
   khi ExecutionPolicy còn Restricted (mặc định trên Windows) — "running scripts is disabled
   on this system". npm.cmd là file batch nên không dính chính sách đó, khỏi phải bảo người
   dùng hạ cài đặt bảo mật của máy. */
const PS_SETUP = [
  "param(",
  "  [Parameter(Mandatory=$true)][string]$Server,",
  "  [Parameter(Mandatory=$true)][string]$Token",
  ")",
  "$ErrorActionPreference = \"Stop\"",
  "",
  "# Don dep tham so: copy tu web hay dinh dang \"url (url/)\" hoac khoang trang thua,",
  "# curl se bao \"Malformed input to a URL function\". Cat tu khoang trang dau tien.",
  "$Server = (($Server -replace '[()]',' ') -split '\\s+' | Where-Object { $_ -match '^https?://' } | Select-Object -First 1)",
  "if (-not $Server) { Write-Host \"[X] SERVER_URL khong hop le\" -ForegroundColor Red; return }",
  "$Server = $Server.TrimEnd('/')",
  "$Token  = ($Token -split '\\s+' | Where-Object { $_ -match '^pwa_' } | Select-Object -First 1)",
  "if (-not $Token) { Write-Host \"[X] TOKEN khong hop le - phai bat dau bang pwa_\" -ForegroundColor Red; return }",
  "Write-Host \"    Server: $Server\" -ForegroundColor DarkGray",
  "",
  "if (-not (Get-Command node -ErrorAction SilentlyContinue)) {",
  "  Write-Host \"[X] Can Node.js 20+ - tai tai https://nodejs.org roi chay lai\" -ForegroundColor Red",
  "  return",
  "}",
  "$dir = Join-Path $env:USERPROFILE \"ppc-warrior-agent\"",
  "Write-Host \"[1/3] Tai agent tu $Server vao $dir ...\"",
  "Write-Host \"      (neu lenh dung toi day roi dung, nghia la buoc tai that bai)\" -ForegroundColor DarkGray",
  "New-Item -ItemType Directory -Force -Path $dir | Out-Null",
  "Set-Location $dir",
  "$tgz = Join-Path $env:TEMP \"ppc-agent.tgz\"",
  "curl.exe -fsSL \"$Server/agent-bundle.tgz?token=$Token\" -o $tgz",
  "if ($LASTEXITCODE -ne 0) { Write-Host \"[X] Tai that bai - kiem tra SERVER_URL va TOKEN\" -ForegroundColor Red; return }",
  "tar.exe -xzf $tgz",
  "if ($LASTEXITCODE -ne 0) { Write-Host \"[X] Giai nen that bai - can Windows 10 1803+ (co san tar.exe)\" -ForegroundColor Red; return }",
  "Remove-Item $tgz -Force",
  "# Kiem tra that su co file, dung tin vao ma thoat cua tar",
  "if (-not (Test-Path (Join-Path $dir \"agent.js\"))) { Write-Host \"[X] Thieu agent.js sau khi giai nen - thu mục co the bi khoa boi phan mem diet virus\" -ForegroundColor Red; return }",
  "",
  "Write-Host \"[2/3] Cai thu vien (1-2 phut)...\"",
  "npm.cmd install --omit=dev --silent",
  "if (-not (Test-Path (Join-Path $dir \"node_modules\\puppeteer\"))) { Write-Host \"[X] npm install chua xong - thieu node_modules\\puppeteer. Chay lai: npm.cmd install --omit=dev\" -ForegroundColor Red; return }",
  "",
  "Write-Host \"[3/3] Ghi .env ...\"",
  "$envPath = Join-Path $dir \".env\"",
  "if (Test-Path $envPath) {",
  "  Write-Host \"    .env da co - giu nguyen cau hinh cu, chi cap nhat code\"",
  "} else {",
  "  $lines = @(",
  "    \"SERVER_URL=$Server\",",
  "    \"AGENT_TOKEN=$Token\",",
  "    \"AGENT_NAME=$env:COMPUTERNAME\",",
  "    \"HEADFUL=0\",",
  "    \"CHROME_CHANNEL=chrome\",",
  "    \"WORKER_PROFILE=1\",",
  "    \"H10_BROWSER_URL=http://127.0.0.1:9222\"",
  "  )",
  "  $lines | Out-File -FilePath $envPath -Encoding ascii",
  "}",
  "",
  "Write-Host \"\"",
  "Write-Host \"[OK] Xong. Chay agent:\" -ForegroundColor Green",
  "Write-Host \"     cd $dir\"",
  "Write-Host \"     npm.cmd run agent\"",
  "Write-Host \"\"",
  "Write-Host \"Luu y: dung npm.cmd (khong phai npm). PowerShell chan npm.ps1 neu may chua mo ExecutionPolicy.\" -ForegroundColor Yellow"
];
app.get("/setup-agent.ps1", (req, res) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(PS_SETUP.join("\r\n")); // Windows cần CRLF
});

app.get("/agent-bundle.tgz", (req, res) => {
  if (!auth.resolveAgentToken(String(req.query.token || ""))) return res.status(401).send("Token không hợp lệ/đã thu hồi");
  res.setHeader("Content-Type", "application/gzip");
  /* Danh sách này PHẢI phủ hết mọi thứ agent.js import. Thiếu một thư mục thì máy cài agent
     chạy được đúng tới lúc khởi động rồi chết với ERR_MODULE_NOT_FOUND — mà lỗi đó chỉ hiện
     trên máy đó, bên này không thấy gì. (Đã dính: thêm src/keywords mà quên khai ở đây.) */
  const tar = spawn("tar", ["czf", "-", "agent.js", "package.json", "src/scraper", "src/parser",
    "src/jobs", "src/db", "src/adjust", "src/launching", "src/data", "src/keywords", "src/auth.js"]);
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

// agent đẩy run kèm snapshot có thể lớn; Bulk Create gửi cả nghìn campaign lên /api/launch/export
app.use(express.json({ limit: "100mb" }));
app.use(express.static("public"));

app.get("/api/version", (req, res) => res.json({ version: APP_VERSION, runMode: RUN_MODE }));
// Trang tài khoản: domain/user (đăng nhập, tạo tài khoản, quản lý agent) — login.html cũ chuyển hướng về đây
app.get("/user", (req, res) => res.sendFile("user.html", { root: "public" }));
app.get("/login.html", (req, res) => res.redirect("/user"));
// Bulk Create = chính trang Tạo Campaign ở chế độ nhiều ASIN (launching.html tự đổi giao diện theo đường dẫn)
app.get("/bulk.html", (req, res) => res.sendFile("launching.html", { root: "public" }));

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
// Dừng riêng một job (trang Phân tích Keyword) — KHÁC /api/stop vốn hủy sạch hàng đợi
app.post("/api/jobs/:id/stop", (req, res) => res.json({ ok: store.requestStopJob(req.params.id) }));

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
  const normMode = (m) => (m === "onegroup" || m === "multi") ? "onegroup" : "single";
  const dfMode = normMode(campaignMode);
  const groups = new Map(); // asin|note|pf|mode → items[]
  for (const it of items) {
    const asin = String(it.asin || "").toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(asin)) continue;
    const pf = it.portfolioId === undefined ? dfPf : String(it.portfolioId || "").trim();
    const nt = it.note === undefined ? dfNote : String(it.note || "");
    const md = it.campaignMode ? normMode(it.campaignMode) : dfMode;
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
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx", compression: true });
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

/** 1 file bulk chỉ upload được vào 1 tài khoản seller. Gom ASIN của mọi plan (cả Product Ad
 *  trong campaign nhiều sản phẩm) → tra cột Acc ở Danh mục Tài sản; quá 1 acc thì CHẶN xuất —
 *  upload nhầm acc là campaign tạo ra trỏ vào ASIN không thuộc tài khoản đó. ASIN chưa gán acc
 *  không chặn (chưa biết) nhưng trả về để cảnh báo. */
function accCheck(plans, info) {
  const cat = store.catalogMap();
  const asins = new Set();
  for (const p of plans || []) {
    if (p?.asin) asins.add(String(p.asin).toUpperCase());
    for (const ag of p?.adGroups || []) for (const pa of ag.productAds || []) if (pa?.asin) asins.add(String(pa.asin).toUpperCase());
  }
  for (const x of info?.products || []) if (x?.asin) asins.add(String(x.asin).toUpperCase());
  const byAcc = {}, noAcc = [];
  for (const a of asins) {
    const acc = cat[a]?.acc || "";
    if (!acc) { noAcc.push(a); continue; }
    (byAcc[acc] = byAcc[acc] || []).push(a);
  }
  const accs = Object.keys(byAcc);
  if (accs.length > 1) {
    throw new Error(`File đang trộn ${accs.length} tài khoản: ` + accs.map((k) => `${k} (${byAcc[k].slice(0, 4).join(", ")}${byAcc[k].length > 4 ? "…" : ""})`).join(" · ")
      + " — mỗi file bulk chỉ được 1 acc. Bỏ campaign của acc kia (dấu −) rồi xuất từng acc.");
  }
  return { acc: accs[0] || "", noAcc };
}

/** Dựng 1 file bulk từ plans: SP → "Sponsored Products Campaigns" (kèm Negative Keyword đính kèm),
 *  SD → "Sponsored Display Campaigns" (22 cột), SB Video → "Sponsored Brands Campaigns" (32 cột).
 *  compression: xlsx KHÔNG nén nặng ~1KB/dòng → nén lại nhỏ cỡ 10 lần (Amazon nhận bình thường). */
function buildLaunchXlsx(plans, withPf, body) {
  const rows = buildRowsFromPlans(plans, withPf);
  const sdRows = buildSdRows(plans, body);
  const sbRows = buildSbRows(plans, body);
  const wb = XLSX.utils.book_new();
  if (rows.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows, { header: BULK_HEADER }), "Sponsored Products Campaigns");
  if (sdRows.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sdRows, { header: SD_HEADER }), "Sponsored Display Campaigns");
  if (sbRows.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sbRows, { header: SB_HEADER }), "Sponsored Brands Campaigns");
  const nRows = rows.length + sdRows.length + sbRows.length;
  return { buf: nRows ? XLSX.write(wb, { type: "buffer", bookType: "xlsx", compression: true }) : null, nRows };
}

/* Amazon/người dùng giới hạn file upload: mỗi file PHẢI < 30MB → chừa biên, cắt ở 28MB. */
const EXPORT_MAX_BYTES = Number(process.env.EXPORT_MAX_BYTES) || 28 * 1024 * 1024;
/** Chia plans thành các phần, mỗi phần dựng ra file < EXPORT_MAX_BYTES. Chia ĐÔI liên tục:
 *  ưu tiên cắt giữa các ASIN (campaign của 1 ASIN nằm chung 1 file), ASIN nào một mình vẫn quá
 *  lớn thì mới cắt giữa các campaign của nó — campaign luôn trọn trong 1 file. */
function splitLaunchExport(plans, withPf, body) {
  const built = buildLaunchXlsx(plans, withPf, body);
  if (!built.buf || built.buf.length <= EXPORT_MAX_BYTES || plans.length <= 1) return [{ plans, ...built }];
  const asinOrder = [...new Set(plans.map((p) => p.asin || ""))];
  let left, right;
  if (asinOrder.length > 1) {
    const byAsin = new Map(asinOrder.map((a) => [a, []]));
    for (const p of plans) byAsin.get(p.asin || "").push(p);
    const total = plans.length;
    let acc = 0, cut = 1;
    for (let i = 0; i < asinOrder.length - 1; i++) {
      acc += byAsin.get(asinOrder[i]).length;
      cut = i + 1;
      if (acc >= total / 2) break;
    }
    left = asinOrder.slice(0, cut).flatMap((a) => byAsin.get(a));
    right = asinOrder.slice(cut).flatMap((a) => byAsin.get(a));
  } else {
    const mid = Math.ceil(plans.length / 2);
    left = plans.slice(0, mid); right = plans.slice(mid);
  }
  return [...splitLaunchExport(left, withPf, body), ...splitLaunchExport(right, withPf, body)];
}

// Export: nhận plans ĐÃ CHỈNH từ preview (có thể gom NHIỀU ASIN) → xlsx bulk + snapshot
// + kho keyword tag PPC (tùy chọn saveToBank, mặc định bật). File ≥ 28MB → chia nhiều phần:
// trả JSON {parts:[...]} thay vì file, trang tải từng phần qua /api/launch/exports/:id.
app.post("/api/launch/export", (req, res) => {
  try {
    const body = req.body || {};
    // Có plans từ danh sách tích lũy → dùng thẳng (không phụ thuộc form hiện tại);
    // không có → dựng từ form
    const withPf = withPortfolioNames(body);
    const plans = Array.isArray(body.plans) && body.plans.length
      ? body.plans
      : planCampaigns(withPf).plans;
    const accInfo = accCheck(plans, body.info);           // chặn trộn tài khoản trước khi dựng file
    const campaigns = plans.filter((p) => p?.name);
    const stats = {};
    for (const p of campaigns) stats[p.type] = (stats[p.type] || 0) + 1;
    const parts = splitLaunchExport(plans, withPf, body);
    if (!parts.some((x) => x.buf)) throw new Error("Không có campaign nào — kiểm tra keyword/lựa chọn loại campaign");
    const tooBig = parts.find((x) => x.buf && x.buf.length > EXPORT_MAX_BYTES);
    if (tooBig) throw new Error(`Có 1 campaign tự nó đã ${(tooBig.buf.length / 1048576).toFixed(1)}MB — không chia nhỏ hơn được`);

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
    const fileTag = String(body.fileTag || "").replace(/[^\w.-]+/g, "_").slice(0, 30); // VD "lowest-cost"
    const label = (fileTag ? fileTag + "-" : "") + (accInfo.acc ? accInfo.acc.replace(/[^\w.-]+/g, "_") + "-" : "") + (asins.length === 1 ? asins[0] : `${asins.length}asin`);
    const day = new Date().toISOString().slice(0, 10);
    const info = { campaigns: campaigns.length, bank, saveToBank, asins: asins.length, acc: accInfo.acc, noAcc: accInfo.noAcc.length };
    const real = parts.filter((x) => x.buf);

    if (real.length === 1) {
      const { buf, nRows } = real[0];
      const snapId = store.saveExportSnapshot({ asin: label, asins, campaigns: campaigns.length, rows: nRows, stats }, buf);
      res.setHeader("Content-Disposition", `attachment; filename="bulk-create-${label}-${day}.xlsx"`);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("X-Launch-Info", JSON.stringify({ snapId, ...info }));
      return res.send(buf);
    }

    // Nhiều phần: lưu từng phần thành snapshot riêng (id khác nhau vì sinh theo thời gian ms)
    const out = real.map((x, i) => {
      const pAsins = [...new Set(x.plans.map((p) => p.asin).filter(Boolean))];
      const pCamps = x.plans.filter((p) => p?.name).length;
      const id = store.saveExportSnapshot({ asin: `${label} (phần ${i + 1}/${real.length})`, asins: pAsins, campaigns: pCamps, rows: x.nRows, part: i + 1, of: real.length }, x.buf);
      return { id, filename: `bulk-create-${label}-${day}-phan${i + 1}of${real.length}.xlsx`,
        size: x.buf.length, campaigns: pCamps, asins: pAsins.length, rows: x.nRows };
    });
    res.json({ ok: true, ...info, parts: out });
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
// Tải lại 1 file đã xuất (export chia nhiều phần tải từng phần qua đây). ?name= đặt tên file tải về
app.get("/api/launch/exports/:id", (req, res) => {
  const f = store.exportFilePath(req.params.id);
  if (!f) return res.status(404).json({ ok: false, message: "Không tìm thấy file" });
  const name = String(req.query.name || `bulk-create-${req.params.id}.xlsx`).replace(/[^\w.() -]+/g, "_");
  res.download(f, name);
});

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

// Gán nhiều bộ keyword cho 1 ASIN (Bulk Create chọn riêng từng dòng) — lưu vĩnh viễn, giữ ASIN khác.
app.post("/api/catalog/product-kwlists", (req, res) => {
  try {
    const { asin, kwLists } = req.body || {};
    const products = store.setProductKwLists(asin, kwLists);
    res.json({ ok: true, products });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

app.post("/api/catalog/portfolios", (req, res) => {
  try {
    const rows = req.body?.rows;
    if (!Array.isArray(rows)) throw new Error("Thiếu danh sách dòng");
    res.json({ ok: true, portfolios: store.savePortfolioDir(rows) });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

/* ===== BUDGET PORTFOLIO → file Bulk-port (mẫu Amazon: sheet "Portfolios", Operation Update) ===== */
app.get("/api/portfolio-budgets", (req, res) => res.json({ ok: true, ...store.getPortfolioBudgets() }));
app.put("/api/portfolio-budgets", (req, res) => {
  try { res.json({ ok: true, ...store.savePortfolioBudgets(req.body || {}) }); }
  catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});
const PORT_HEADER = ["Product", "Entity", "Operation", "Portfolio ID", "Portfolio Name", "Budget Amount", "Budget Currency Code",
  "Budget Policy", "Budget Start Date", "Budget End Date", "State (Informational only)", "In Budget (Informational only)"];
const ymd = (s) => { const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? m[1] + m[2] + m[3] : ""; };
// rows: [{id, name, budget}] — budget trống/0 → "No Cap" (không ghi số tiền, không ghi ngày)
app.post("/api/portfolio-budgets/export", (req, res) => {
  try {
    const { rows, startDate, endDate, setName, acc } = req.body || {};
    const start = ymd(startDate), end = endDate ? ymd(endDate) : "";
    if (!start) throw new Error("Thiếu Budget Start Date");
    if (endDate && !end) throw new Error("Budget End Date không hợp lệ");
    if (end && end < start) throw new Error("Budget End Date phải sau Start Date");
    const out = [];
    for (const r of Array.isArray(rows) ? rows : []) {
      const id = String(r.id || "").trim();
      if (!/^\d+$/.test(id)) continue;
      const n = parseFloat(String(r.budget ?? "").replace(",", "."));
      const cap = isFinite(n) && n > 0;
      out.push({
        Product: "Portfolios", Entity: "Portfolio", Operation: "Update",
        "Portfolio ID": id, "Portfolio Name": String(r.name || "").trim(),
        // undefined = ô TRỐNG thật (như file Amazon tải về), "" sẽ thành ô chuỗi rỗng
        "Budget Amount": cap ? Math.round(n * 100) / 100 : undefined, "Budget Currency Code": "USD",
        "Budget Policy": cap ? "Date Range" : "No Cap",
        "Budget Start Date": cap ? start : undefined, "Budget End Date": cap && end ? end : undefined
      });
    }
    if (!out.length) throw new Error("Không có portfolio nào (cần Portfolio ID dạng số)");
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(out, { header: PORT_HEADER }), "Portfolios");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx", compression: true });
    const tag = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D")
      .replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40); // "Đầu ngày $1" → "Dau_ngay_1"
    // Tên file: bulk-port-<ngày start>-<tên bộ>-<acc>.xlsx
    const fname = ["bulk-port", start, tag(setName), tag(acc)].filter(Boolean).join("-") + ".xlsx";
    res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("X-Port-Info", JSON.stringify({ rows: out.length, noCap: out.filter((x) => x["Budget Policy"] === "No Cap").length }));
    res.send(buf);
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

// Mã cá nhân: mặc định theo TÀI KHOẢN (trước đây gõ lại ở mỗi lần tạo campaign)
app.post("/api/catalog/manager", (req, res) => {
  const manager = String(req.body?.manager || "").trim().slice(0, 5);
  store.saveLaunchSettings({ manager });
  res.json({ ok: true, manager });
});

/* ===================== DANH MỤC TARGET (list → group → keyword, + Target ASIN) =====================
   Độc lập với "Phân tích Keyword". Nạp từ file H10 / Amazon SQP / csv-xlsx tự làm (tự nhận dạng). */
const uploadKw = multer({ dest: "./data/uploads", limits: { fileSize: 40 * 1024 * 1024 } });

/* ===== CHIA SẺ LIST qua URL /kwlist/<slug> (công khai — xem PUBLIC_PATHS phía trên) =====
   Dữ liệu chia theo phân vùng user (file-store.js), nhưng link chia sẻ KHÔNG đăng nhập nên
   không biết list thuộc user nào — phải dò qua MỌI phân vùng (tenant) để tìm đúng shareSlug.
   slug lưu CỐ ĐỊNH trên list (không tính lại từ tên) để đổi tên list sau đó không làm hỏng link
   đã gửi đi; tạo lần đầu mới sinh slug và đảm bảo không trùng slug của bất kỳ list nào (mọi user). */
function escHtml(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function slugifyName(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "list";
}
// Chạy fn trong TỪNG phân vùng (tenant) đang có — chưa có user nào đăng ký thì chỉ có 1 "phân vùng" (ROOT, chạy ngoài context).
function kwTenants() {
  const users = auth.listUsers();
  return users.length ? users.map((u) => ({ name: u.name, legacyRoot: u.legacyRoot })) : [null];
}
function runInTenant(tenant, fn) { return tenant ? runAsUser(tenant, fn) : fn(); }
function findKwListBySlug(slug) {
  for (const t of kwTenants()) {
    const hit = runInTenant(t, () => {
      const s = store.listKwLists().find((l) => l.shareSlug === slug);
      return s ? store.getKwList(s.id) : null;
    });
    if (hit) return hit;
  }
  return null;
}
function makeUniqueShareSlug(name, excludeSlug) {
  const used = new Set();
  for (const t of kwTenants()) runInTenant(t, () => { for (const l of store.listKwLists()) if (l.shareSlug) used.add(l.shareSlug); });
  if (excludeSlug) used.delete(excludeSlug);
  const base = slugifyName(name);
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i++) { const s = `${base}-${i}`; if (!used.has(s)) return s; }
  return `${base}-${Date.now().toString(36)}`;
}
// Bật/tắt chia sẻ cho list hiện tại (trong phân vùng của user đang đăng nhập — như mọi API /api/kwlists khác).
app.post("/api/kwlists/:id/share", (req, res) => {
  const l = store.getKwList(req.params.id);
  if (!l) return res.status(404).json({ ok: false, message: "Không tìm thấy list" });
  if (req.body?.on === false) { const u = store.setKwShareSlug(l.id, ""); return res.json({ ok: true, list: u }); }
  const slug = l.shareSlug || makeUniqueShareSlug(l.name);
  const u = store.setKwShareSlug(l.id, slug);
  res.json({ ok: true, list: u, url: `/kwlist/${slug}` });
});
// Trang xem CÔNG KHAI (không đăng nhập): chỉ hiện Keyword · Search Volume · Group · Target ASIN — không có Bid/chiến lược.
app.get("/kwlist/:slug", (req, res) => {
  const slug = String(req.params.slug || "").trim().toLowerCase();
  const l = findKwListBySlug(slug);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (!l) {
    return res.status(404).send(`<!DOCTYPE html><html lang="vi"><meta charset="UTF-8"><title>Không tìm thấy — PPC Warrior</title>
      <body style="font-family:-apple-system,Arial,sans-serif;background:#f4f6fa;color:#1b2330;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
      <div style="text-align:center"><h2>🔍 Không tìm thấy list chia sẻ này</h2><p style="color:#667">Link đã bị tắt chia sẻ, hoặc không đúng.</p></div></body></html>`);
  }
  const kwRows = (l.keywords || []).map((k) => `<tr><td>${escHtml(k.kw)}</td><td class="num">${k.sv ?? ""}</td><td>${escHtml(k.group || "")}</td></tr>`).join("");
  const asinRows = (l.asins || []).map((a) => `<tr><td class="mono">${escHtml(a)}</td></tr>`).join("");
  const kwTsv = (l.keywords || []).map((k) => [k.kw, k.sv ?? "", k.group || ""].join("\t")).join("\n");
  res.send(`<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escHtml(l.name)} — PPC Warrior (chia sẻ)</title>
  <style>
    * { box-sizing:border-box; } body { font-family:-apple-system,Segoe UI,Arial,sans-serif; margin:0; background:#f4f6fa; color:#1b2330; }
    header { background:#101828; color:#fff; padding:14px 24px; } header h1 { font-size:16px; margin:0 0 2px; } header p { margin:0; font-size:12px; color:#9fb0c8; }
    main { max-width:820px; margin:20px auto; padding:0 16px 40px; }
    .card { background:#fff; border:1px solid #e3e8f0; border-radius:12px; padding:16px 18px; margin-bottom:16px; }
    .card h2 { font-size:14px; margin:0 0 10px; display:flex; align-items:center; gap:8px; }
    .card h2 .n { font-size:12px; color:#667; font-weight:400; }
    table { border-collapse:collapse; width:100%; font-size:13px; } th,td { border:1px solid #e3e8f0; padding:6px 8px; text-align:left; }
    th { background:#f0f3f9; font-size:11.5px; color:#667; } td.num { text-align:right; } td.mono { font-family:ui-monospace,Menlo,monospace; }
    .scroll { max-height:520px; overflow:auto; border:1px solid #e3e8f0; border-radius:8px; } .scroll table { border:none; }
    button { padding:6px 14px; border:none; border-radius:7px; cursor:pointer; font-size:12.5px; font-weight:600; background:#eef1f7; }
    .hint { font-size:12px; color:#667; margin:0 0 10px; }
  </style></head><body>
  <header><h1>⚔️ PPC Warrior — 🗂 ${escHtml(l.name)}</h1><p>Link chia sẻ chỉ xem (keyword + Target ASIN) — không cần đăng nhập</p></header>
  <main>
    <div class="card">
      <h2>🔑 Keyword <span class="n">(${(l.keywords || []).length})</span>
        <button style="margin-left:auto" onclick="copyKw()">📋 Copy keyword</button></h2>
      <div class="scroll"><table><thead><tr><th>Keyword</th><th>Search Volume</th><th>Group</th></tr></thead><tbody>${kwRows || '<tr><td colspan="3" style="color:#99a">— trống —</td></tr>'}</tbody></table></div>
    </div>
    <div class="card">
      <h2>🎯 Target ASIN <span class="n">(${(l.asins || []).length})</span>
        <button style="margin-left:auto" onclick="copyAsin()">📋 Copy ASIN</button></h2>
      <div class="scroll"><table><thead><tr><th>Target ASIN</th></tr></thead><tbody>${asinRows || '<tr><td style="color:#99a">— trống —</td></tr>'}</tbody></table></div>
    </div>
  </main>
  <textarea id="kwRaw" style="position:absolute;left:-9999px">${escHtml(kwTsv)}</textarea>
  <textarea id="asinRaw" style="position:absolute;left:-9999px">${escHtml((l.asins || []).join("\n"))}</textarea>
  <script>
    function copyText(id, label) {
      const el = document.getElementById(id);
      navigator.clipboard.writeText(el.value).then(() => alert('✅ Đã copy ' + label)).catch(() => { el.style.left = '12px'; el.style.top = '12px'; el.select(); alert('Trình duyệt chặn copy — đã bôi đen, bấm Cmd/Ctrl+C'); });
    }
    function copyKw() { copyText('kwRaw', 'keyword'); }
    function copyAsin() { copyText('asinRaw', 'ASIN'); }
  </script>
  </body></html>`);
});
app.get("/api/kwlists", (req, res) => res.json({ ok: true, lists: store.listKwLists() }));
// Group DÙNG CHUNG cho mọi list: {op:"upsert", name, bid?, offset?} | {op:"rename", from, to} | {op:"delete", name}
app.get("/api/kw-groups", (req, res) => res.json({ ok: true, groups: store.getKwGroups() }));
app.post("/api/kw-groups", (req, res) => {
  try { res.json({ ok: true, ...store.kwGroupOp(req.body || {}) }); }
  catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});
// Xuất TOÀN BỘ list (mọi list đang có) ra 1 file: 1 dòng = 1 keyword, cột List phân biệt list nào.
// ?asin=1 → xuất kèm sheet Target ASIN (List · Target ASIN); không truyền hoặc =0 thì bỏ sheet này.
app.get("/api/kwlists/export-all", (req, res) => {
  const withAsin = ["1", "true", "yes"].includes(String(req.query.asin || "").toLowerCase());
  const lists = store.listKwLists().map((s) => store.getKwList(s.id)).filter(Boolean);
  const wb = XLSX.utils.book_new();
  const kwRows = [];
  for (const l of lists) for (const k of l.keywords || []) kwRows.push({ "List": l.name, "Keyword": k.kw, "Search Volume": k.sv ?? "", "Group": k.group || "" });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(kwRows, { header: ["List", "Keyword", "Search Volume", "Group"] }), "Keywords");
  if (withAsin) {
    const asinRows = [];
    for (const l of lists) for (const a of l.asins || []) asinRows.push({ "List": l.name, "Target ASIN": a });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(asinRows, { header: ["List", "Target ASIN"] }), "Target ASIN");
  }
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx", compression: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  res.setHeader("Content-Disposition", `attachment; filename="danh-muc-target-toan-bo-${stamp}.xlsx"`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(buf);
});
app.get("/api/kwlists/:id", (req, res) => {
  const l = store.getKwList(req.params.id);
  if (!l) return res.status(404).json({ ok: false, message: "Không tìm thấy list" });
  res.json({ ok: true, list: l });
});
app.post("/api/kwlists", (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ ok: false, message: "Nhập tên list" });
  res.json({ ok: true, list: store.createKwList(name) });
});
app.put("/api/kwlists/:id", (req, res) => {
  const { baseRev, force, ...data } = req.body || {};
  // Không gửi baseRev = trang bản cũ (trước khi có kiểm phiên bản) → coi như lệch, không cho ghi đè mù
  const l = store.saveKwList(req.params.id, data, { baseRev: baseRev ?? -1, force: force === true });
  if (!l) return res.status(404).json({ ok: false, message: "Không tìm thấy list" });
  if (l.conflict) return res.status(409).json({ ok: false, conflict: true, rev: l.rev, updatedAt: l.updatedAt,
    message: "List đã được sửa ở tab/máy khác — tải lại để lấy bản mới nhất" });
  res.json({ ok: true, list: { id: l.id, rev: l.rev, updatedAt: l.updatedAt } });
});
// Lịch sử phiên bản: danh sách (không kèm dữ liệu) · khôi phục 1 bản (chụp bản hiện tại trước)
app.get("/api/kwlists/:id/history", (req, res) => res.json({ ok: true, versions: store.listKwHistory(req.params.id) }));
app.post("/api/kwlists/:id/restore", (req, res) => {
  const l = store.restoreKwVersion(req.params.id, String(req.body?.at || ""));
  if (!l) return res.status(404).json({ ok: false, message: "Không tìm thấy bản này" });
  res.json({ ok: true, list: l });
});
// Xuất list (bản hiện tại, hoặc 1 bản trong lịch sử ?at=) ra Excel 3 sheet — tự cất giữ / nạp lại
app.get("/api/kwlists/:id/export", (req, res) => {
  const l = req.query.at ? store.getKwVersion(req.params.id, String(req.query.at)) : store.getKwList(req.params.id);
  if (!l) return res.status(404).json({ ok: false, message: "Không tìm thấy list/bản" });
  const gOf = (n) => (l.groups || []).find((g) => g.name === n);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet((l.keywords || []).map((k) => ({
    "Keyword": k.kw, "Search Volume": k.sv ?? "", "Group": k.group || "", "Bid": k.bid ?? "",
    "Bid group": gOf(k.group)?.bid ?? "", "+n ngày": gOf(k.group)?.offset || 0
  })), { header: ["Keyword", "Search Volume", "Group", "Bid", "Bid group", "+n ngày"] }), "Keywords");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet((l.groups || []).map((g) => ({
    "Group": g.name, "Bid mặc định": g.bid ?? "", "+n ngày": g.offset || 0
  })), { header: ["Group", "Bid mặc định", "+n ngày"] }), "Groups");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet((l.asins || []).map((a) => ({ "Target ASIN": a })), { header: ["Target ASIN"] }), "Target ASIN");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx", compression: true });
  const safe = String(l.name || "list").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").replace(/[^\w.-]+/g, "_").slice(0, 60);
  const stamp = (req.query.at ? String(req.query.at) : new Date().toISOString()).slice(0, 16).replace(/[:T]/g, "-");
  res.setHeader("Content-Disposition", `attachment; filename="danh-muc-target-${safe}-${stamp}.xlsx"`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(buf);
});
// Nạp lại file đã xuất ở trên → tạo LIST MỚI (không đụng list đang có)
app.post("/api/kwlists/import-file", (req, res, next) => uploadKw.single("file")(req, res, next), (req, res) => {
  try {
    if (!req.file) throw new Error("Chưa chọn file");
    let wb;
    try { wb = XLSX.read(fs.readFileSync(req.file.path), { type: "buffer" }); } finally { fs.unlink(req.file.path, () => {}); }
    const sheet = (n) => wb.Sheets[wb.SheetNames.find((x) => x.toLowerCase() === n.toLowerCase())];
    if (!sheet("Keywords") && !sheet("Groups") && !sheet("Target ASIN")) throw new Error('File không phải file xuất từ Danh mục Target (cần sheet "Keywords" / "Groups" / "Target ASIN")');
    const rows = (n) => (sheet(n) ? XLSX.utils.sheet_to_json(sheet(n), { defval: "" }) : []);
    const num = (v) => { const x = parseFloat(String(v).replace(",", ".")); return isNaN(x) ? null : x; };
    const groups = rows("Groups").map((r) => ({ name: r["Group"], bid: num(r["Bid mặc định"]), offset: num(r["+n ngày"]) || 0 }));
    const keywords = rows("Keywords").map((r) => ({ kw: r["Keyword"], sv: num(r["Search Volume"]), group: String(r["Group"] || ""), bid: num(r["Bid"]) }));
    // group có trong Keywords mà thiếu ở Groups (file sửa tay) → vẫn giữ, lấy bid/+n từ cột phụ
    for (const r of rows("Keywords")) {
      const gn = String(r["Group"] || "").trim();
      if (gn && !groups.some((g) => String(g.name).trim() === gn)) groups.push({ name: gn, bid: num(r["Bid group"]), offset: num(r["+n ngày"]) || 0 });
    }
    const asins = rows("Target ASIN").map((r) => r["Target ASIN"]);
    const base = String(req.body?.name || req.file.originalname.replace(/\.[^.]+$/, "")).trim().slice(0, 70) || "List từ file";
    const l = store.createKwList(base + " (từ file)", { groups, keywords, asins });
    res.json({ ok: true, list: l });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});
app.delete("/api/kwlists/:id", (req, res) => res.json({ ok: store.deleteKwList(req.params.id) }));
// Import file (H10 Cerebro/Magnet, Amazon SQP, csv/xlsx tự làm) → keyword + search volume, gộp vào list
app.post("/api/kwlists/:id/import", (req, res, next) => uploadKw.single("file")(req, res, next), (req, res) => {
  try {
    if (!req.file) throw new Error("Chưa chọn file");
    let parsed;
    try { parsed = parseKeywordFile(fs.readFileSync(req.file.path)); } finally { fs.unlink(req.file.path, () => {}); }
    const out = store.mergeKwIntoList(req.params.id, parsed.rows, String(req.body?.group || ""));
    if (!out) return res.status(404).json({ ok: false, message: "Không tìm thấy list" });
    res.json({ ok: true, ...out, total: parsed.total, source: parsed.source, hasVolume: parsed.hasVolume });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
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
/* Agent nộp bộ keyword đã quét + lọc xong. Lưu THÀNH BỘ ngay tại đây chứ không bắt trang
   web gọi thêm lượt nữa: máy đã quét xong rồi mà trình duyệt người dùng đóng tab thì công
   sức mất trắng. */
app.post("/api/agent/h10-scan-result", (req, res) => {
  const b = req.body || {};
  const keywords = Array.isArray(b.keywords) ? b.keywords : [];
  if (!keywords.length) return res.status(400).json({ error: "Bộ keyword rỗng" });
  const saved = store.saveH10Set({ name: b.name, asins: b.asins || [], ruleName: b.ruleName || "",
    rule: b.rule || {}, perAsin: b.perAsin || [], keywords, source: "cerebro", jobId: b.jobId });
  try { fs.writeFileSync(H10_REPORT(), JSON.stringify({ ...(b.diag || {}), savedSet: saved, at: new Date().toISOString() }, null, 1)); } catch {}
  res.json({ ok: true, name: b.name, ...saved });
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

/* Xếp job QUÉT THẬT: agent mở Cerebro, nhập ASIN, bấm Export, đọc file rồi áp bộ quy tắc.
   Cả danh sách ASIN đi trong MỘT job: agent giữ nguyên tab Cerebro giữa các lượt (mỗi lượt
   mở lại trang mới mất ~10s), và tiến độ nằm gọn trong một dòng log để trang web bám theo. */
app.post("/api/h10/scan", (req, res) => {
  if (RUN_MODE !== "queue") return res.status(409).json({ ok: false, message: "Chỉ chạy ở chế độ queue (agent)" });
  const b = req.body || {};
  const asins = [...new Set((b.asins || []).map((a) => String(a).trim().toUpperCase()).filter((a) => /^[A-Z0-9]{10}$/.test(a)))];
  if (!asins.length) return res.status(400).json({ ok: false, message: "Chưa có ASIN hợp lệ" });
  const name = String(b.setName || "").trim() || `Cerebro ${new Date().toLocaleDateString("vi-VN")}`;
  const job = store.enqueueJob({ kind: "h10scan", asins, rule: b.rule || {}, setName: name,
    runId: "h10scan-" + Date.now().toString(36) });
  res.json({ ok: true, jobId: job.id, asins: asins.length, setName: name });
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
  const q = { ...req.body };
  if (q.filters?.edited || (q.filters?.chips || []).some((c) => c && c.f === "edited")) {
    // "Đã sửa" = đang chờ trong tab Thay đổi (client gửi khoá) + đã xuất file trong 7 ngày qua
    q.editedKeys = new Set([...recentExportedKeys(), ...(Array.isArray(q.pendingKeys) ? q.pendingKeys : [])]);
  }
  const out = queryRows(list, q);
  // gắn rowKey cho tab targets (để ledger sửa đổi)
  if (tab !== "terms") out.rows = out.rows.map((r) => ({ k: rowKey(r), ...r }));
  res.json({ ok: true, ...out, meta: ds.meta });
});

/** Khoá dòng đã xuất file Update trong N ngày (đọc audit.jsonl — gồm cả xuất thủ công lẫn từ rule).
    Khoá theo ID Amazon nên vẫn khớp khi import file bulk mới hôm sau. Cache theo mtime file. */
const EDITED_LOOKBACK_DAYS = 7;
const exportedKeysCache = new Map(); // đường dẫn audit → { mtime, day, keys }
function recentExportedKeys() {
  const file = `${ADJUST_DIR_FN()}/audit.jsonl`;
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return []; }
  const day = new Date().toISOString().slice(0, 10);
  const hit = exportedKeysCache.get(file);
  if (hit && hit.mtime === mtime && hit.day === day) return hit.keys;
  const since = Date.now() - EDITED_LOOKBACK_DAYS * 864e5;
  const keys = new Set();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (!e.at || Date.parse(e.at) < since) continue;
    for (const ed of e.detail?.edits || []) if (ed && ed.k) keys.add(ed.k);
  }
  const arr = [...keys];
  exportedKeysCache.set(file, { mtime, day, keys: arr });
  return arr;
}

/** Dòng Update chia theo loại ads → [{ ad, sheet, header, rows }]. Mỗi loại ghi vào sheet
    cùng tên sheet gốc trong file bulk (Amazon nhận diện SP/SB/SD theo tên sheet + cột Product).
    Dataset cũ (trước khi có SB/SD) không có headers/sheetNames → chỉ SP với ds.header. */
function buildUpdateSheets(ds, edits, negatives) {
  const out = [];
  for (const ad of AD_TYPES) {
    const header = ad === "SP" ? ds.header : ds.headers?.[ad];
    if (!header || !header.length) continue;
    const rows = buildUpdateRows(header, ds.byKey, edits, ad === "SP" ? negatives : [], ad);
    const sheet = ds.sheetNames?.[ad] || `${AD_PRODUCT[ad]} Campaigns`;
    out.push({ ad, sheet, header, rows });
  }
  return out;
}

/** Dựng workbook Update (dòng thay đổi + Negative) + ghi audit. Trả {buf, rowCount}. */
function writeUpdateWorkbook(ds, edits, negatives, id, source) {
  assertBidCap(ds.byKey, edits);
  const sheets = buildUpdateSheets(ds, edits, negatives).filter((x) => x.rows.length);
  const rowCount = sheets.reduce((n, x) => n + x.rows.length, 0);
  if (!rowCount) throw new Error("Không có thay đổi nào để xuất");
  const wb = XLSX.utils.book_new();
  for (const x of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(x.rows, { header: x.header }), x.sheet);
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx", compression: true });
  fs.mkdirSync(ADJUST_DIR_FN(), { recursive: true });
  const audit = { at: new Date().toISOString(), dataset: id, source: source || "manual",
    edits: (edits || []).length, negatives: (negatives || []).length, detail: { edits, negatives } };
  fs.appendFileSync(`${ADJUST_DIR_FN()}/audit.jsonl`, JSON.stringify(audit) + "\n");
  return { buf, rowCount };
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
    assertBidCap(ds.byKey, edits);
    const sheets = buildUpdateSheets(ds, edits, negatives);
    const updateRows = sheets.flatMap((x) => x.rows);
    let createRows = [], campaigns = 0, missing = [];
    if (Array.isArray(creates) && creates.length) {
      const built = buildHarvestCreateRows(creates.map((c) => ({
        asin: c.asin, keyword: c.keyword, bid: c.bid || null,
        note: c.note, portfolioId: c.pf, campaignMode: c.mode
      })));
      campaigns = built.campaigns;
      if (!ds.header?.length) throw new Error("Dataset không có sheet Sponsored Products — không tạo được campaign SP mới");
      const m = remapToDatasetHeader(built.rows, ds.header);
      createRows = m.rows; missing = m.missing;
    }
    const rows = [...updateRows, ...createRows];
    if (!rows.length) throw new Error("Không có thay đổi nào để xuất");
    // SP: Update + Create chung 1 sheet; SB/SD: mỗi loại 1 sheet riêng (chỉ Update)
    const wb = XLSX.utils.book_new();
    const bySheet = {};
    for (const x of sheets) {
      const xr = x.ad === "SP" ? [...x.rows, ...createRows] : x.rows;
      if (!xr.length) continue;
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(xr, { header: x.header }), x.sheet);
      bySheet[x.ad] = xr.length;
    }
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx", compression: true });
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
      updateRows: updateRows.length, createRows: createRows.length, campaigns, missing, bySheet }));
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
    // Rule Set v1 viết cho SP (placement, match type, harvest...) — chưa áp lên SB/SD
    const spRecords = ds.records.filter((r) => !r.ad || r.ad === "SP");
    const asins = [...new Set(spRecords.map(asinOf).filter(Boolean))];
    const products = store.getProductsMap(asins);
    const targetAcosByAsin = {};
    for (const [a, p] of Object.entries(products)) if (p.target_acos != null) targetAcosByAsin[a] = p.target_acos;
    const rankByAsinKw = buildRankMap(asins);

    const proposals = evaluateRules(rules, spRecords, { targetAcosByAsin, rankByAsinKw });
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
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx", compression: true });
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
