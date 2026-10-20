// browser.js — Khởi tạo Puppeteer với PHIÊN SẠCH (chống personalization) + STEALTH
//
// Khác v7 có chủ đích:
// - KHÔNG dùng userDataDir cố định mặc định (lịch sử tích lũy → badge "Previously viewed"
//   làm méo rank); bật profile bền vững RIÊNG cho worker qua WORKER_PROFILE
// - Chỉ nạp cookies từ cookies.json (giữ zip code/location), KHÔNG đăng nhập tài khoản
//
// LỚP STEALTH (nâng cấp 16/07/2026 — Amazon không block phiên nghi bot mà chỉ NGỪNG
// SERVE SP tile → ToS "?" nhiều):
// 1. puppeteer-extra-plugin-stealth: 16 evasion chuyên dụng (webdriver, chrome.runtime,
//    permissions, plugins, WebGL vendor, codec, iframe, UA headless...) — thay toàn bộ
//    shim thủ công trước đây
// 2. KHÔNG giả UA nữa: trước đây fix cứng "Chrome/124 Mac" trong khi Chrome thật là bản
//    mới hơn → UA string LỆCH Sec-CH-UA headers = tự tố mình là bot. Chrome thật + headful
//    có UA chuẩn sẵn; trường hợp headless plugin tự xóa token "HeadlessChrome"
// 3. Mặc định KHÔNG chặn image/media/font nữa: phiên tải HTML mà không bao giờ tải ảnh
//    là tín hiệu bot rất mạnh phía server Amazon. Muốn chạy nhanh/tiết kiệm băng thông:
//    BLOCK_ASSETS=1 (chấp nhận rủi ro detect cao hơn)
// 4. defaultViewport: null — dùng kích thước cửa sổ thật (viewport 800x600 mặc định
//    của Puppeteer là dấu hiệu bot kinh điển)

import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

puppeteerExtra.use(StealthPlugin());

const COOKIES_PATH = process.env.COOKIES_PATH || "./cookies.json";

/**
 * 3 mức "giống người thật" (cấu hình qua .env):
 * 1. CHROME_CHANNEL (mặc định "chrome"): binary Google Chrome THẬT — fallback Chromium bundled
 * 2. HEADFUL=1: chạy CÓ GIAO DIỆN (headless là dấu hiệu bot lớn nhất), cửa sổ ngoài màn hình
 * 3. WORKER_PROFILE=1 (hoặc =đường dẫn): profile riêng bền vững — phiên có tuổi thọ
 */
export async function launchBrowser() {
  const headful = process.env.HEADFUL === "1";
  const channel = process.env.CHROME_CHANNEL || "chrome";
  const profileDir =
    process.env.WORKER_PROFILE === "1" ? "./data/chrome-profile"
    : process.env.WORKER_PROFILE || null;

  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--disable-dev-shm-usage", // container (Railway/Docker): /dev/shm nhỏ → Chrome crash nếu không có flag này
    "--disable-gpu",
    "--window-size=1366,900",
    "--lang=en-US,en"
  ];
  if (headful) args.push("--window-position=-2400,-2400"); // ngoài màn hình — chạy ngầm
  // HEADLESS: screen.width/height mặc định là 800x600 — NHỎ HƠN cửa sổ 1366 → "màn hình bé hơn
  // cửa sổ" là điều bất khả thi với máy thật, detector bắt được (đo 06/08/2026: headful báo
  // 1470x956, headless báo 800x600 — khác biệt DUY NHẤT giữa 2 chế độ). --screen-info là flag
  // NATIVE của Chrome headless mới (không phải vá JS nên không lộ descriptor lạ).
  else args.push(`--screen-info={${process.env.SCREEN_INFO || "1470x956"}}`);

  const opts = {
    // HEADFUL=0/không đặt → HEADLESS THẾ HỆ MỚI (puppeteer 22+): cùng engine Chrome thật,
    // fingerprint gần headful — chạy NGẦM HOÀN TOÀN (không cửa sổ, không icon Dock).
    // HEADFUL=1: an toàn chống bot nhất (cửa sổ thật ngoài màn hình) — nếu "?" nhiều hãy bật lại.
    headless: !headful,
    args,
    defaultViewport: null // dùng kích thước cửa sổ thật thay vì 800x600 mặc định (dấu hiệu bot)
  };
  if (profileDir) opts.userDataDir = profileDir; // không set → phiên sạch mỗi lần chạy

  const launch = async () => {
    try {
      const b = await puppeteerExtra.launch({ ...opts, channel });
      console.log(`🌐 Browser: Google Chrome thật (channel=${channel}) + stealth plugin` +
        (headful ? " · headful ngoài màn hình" : " · headless MỚI (vô hình hoàn toàn)") +
        (profileDir ? ` · profile bền vững ${profileDir}` : " · phiên sạch"));
      return b;
    } catch (e) {
      // Khóa profile thì Chromium bundled cũng chịu chung số phận — đừng thử vô ích rồi
      // báo nhầm thành "không tìm thấy Google Chrome"
      if (LOCKED_RE.test(e.message)) throw e;
      const b = await puppeteerExtra.launch(opts);
      console.log("🌐 Browser: Chromium bundled + stealth plugin (không tìm thấy Google Chrome)" +
        (headful ? " · headful" : " · headless"));
      return b;
    }
  };

  try {
    return await launch();
  } catch (e) {
    // Khóa profile bỏ quên → dọn rồi thử LẠI ĐÚNG MỘT LẦN
    if (!profileDir || !LOCKED_RE.test(e.message) || !clearStaleProfileLock(path.resolve(profileDir))) throw e;
    return await launch();
  }
}

const LOCKED_RE = /already running|SingletonLock|ProcessSingleton/i;

/** Gỡ khóa profile Chrome bị bỏ quên.
 *  Chrome chết bất thường (close() treo quá hạn, agent bị kill, máy ngủ) để lại tiến trình
 *  mồ côi vẫn GIỮ khóa profile. Không ai dọn ⇒ mọi lần mở sau đều lỗi "The browser is already
 *  running for <profileDir>" và agent hỏng VĨNH VIỄN cho tới khi có người tự tay kill.
 *  SingletonLock là symlink trỏ tới "<hostname>-<pid>" nên biết chính xác phải giết ai; vẫn
 *  đối chiếu dòng lệnh của pid đó trước khi kill để không lỡ tay giết Chrome cá nhân của
 *  người dùng (pid có thể đã được hệ điều hành cấp lại cho tiến trình khác).
 *  Trả về true nếu có dọn được gì — tức là đáng thử mở lại. */
export function clearStaleProfileLock(profileDir) {
  const lock = path.join(profileDir, "SingletonLock");
  let target;
  try { target = fs.readlinkSync(lock); } catch { return false; } // không có khóa → nguyên nhân khác
  const pid = Number(String(target).split("-").pop());
  let killed = 0;
  if (Number.isInteger(pid) && pid > 1) {
    let cmd = "";
    try { cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }); } catch {}
    if (cmd.includes(profileDir)) {
      try { process.kill(pid, "SIGKILL"); killed = pid; } catch {}
    }
  }
  for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try { fs.unlinkSync(path.join(profileDir, f)); } catch {}
  }
  console.log(`🧹 Gỡ khóa profile Chrome bỏ quên${killed ? ` (đã kill pid ${killed})` : ""}: ${profileDir}`);
  return true;
}

/** Nối vào một Chrome NGƯỜI DÙNG đang mở sẵn (có cổng gỡ lỗi), thay vì tự mở trình duyệt mới.
 *  Dùng cho Helium 10: phiên H10 nằm ở bearer token trong localStorage, nên trình duyệt trắng
 *  dù nạp đủ cookie vẫn bị đá ra đăng nhập. Mượn luôn cửa sổ người dùng đang đăng nhập thì
 *  không phải xuất token, không lo hết hạn, và họ nhìn thấy tool đang làm gì.
 *  Trả null nếu không nối được — bên gọi tự quyết định có fallback hay không.
 *  ⚠️ Người gọi PHẢI dùng disconnect() chứ KHÔNG close(): close() tắt luôn Chrome của họ. */
export async function connectBrowser(browserURL, log = () => {}) {
  const url = String(browserURL || "").trim();
  if (!url) return null;
  try {
    const b = await puppeteerExtra.connect({ browserURL: url, defaultViewport: null });
    const v = await b.version().catch(() => "?");
    log(`🔗 Nối vào Chrome có sẵn tại ${url} (${v})`);
    return b;
  } catch (e) {
    log(`⚠️ Không nối được Chrome tại ${url}: ${e.message.slice(0, 80)}`);
    return null;
  }
}

export function loadCookies() {
  const p = path.resolve(COOKIES_PATH);
  if (!fs.existsSync(p)) return null;
  try {
    const cookies = JSON.parse(fs.readFileSync(p, "utf8"));
    // Lọc bỏ cookie đăng nhập (session/account) nếu có — chỉ giữ cookie location/phiên duyệt
    // Các cookie định danh đăng nhập của Amazon: 'x-main', 'at-main', 'sess-at-main'
    return cookies.filter((c) => !["x-main", "at-main", "sess-at-main"].includes(c.name));
  } catch {
    return null;
  }
}

export async function newCleanPage(browser, cookies) {
  const page = await browser.newPage();

  // Chặn tài nguyên nặng CHỈ khi BLOCK_ASSETS=1 — mặc định TẮT vì "tải HTML nhưng
  // không bao giờ tải ảnh" là tín hiệu bot mạnh phía server Amazon
  if (process.env.BLOCK_ASSETS === "1") {
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const t = req.resourceType();
      if (t === "image" || t === "media" || t === "font") req.abort();
      else req.continue();
    });
  }

  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
  // KHÔNG setUserAgent thủ công — UA giả lệch version với Sec-CH-UA headers là tự tố bot;
  // stealth plugin đã xử lý token "HeadlessChrome" khi chạy headless
  try { await page.emulateTimezone("America/New_York"); } catch {}

  if (cookies && cookies.length) await page.setCookie(...cookies);
  return page;
}

/** Kiểm tra session hợp lệ (kế thừa v7): search thử + phát hiện captcha/block. */
export async function verifySession(page) {
  try {
    await page.goto("https://www.amazon.com/s?k=gift", { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForSelector('div[data-component-type="s-search-result"]', { timeout: 8000 });
    const body = await page.evaluate(() => document.body.innerText.toLowerCase());
    const blocked =
      body.includes("enter the characters you see below") ||
      body.includes("robot") ||
      body.includes("503 service unavailable");
    return !blocked;
  } catch {
    return false;
  }
}
