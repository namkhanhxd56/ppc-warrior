// set-location.js — Đặt zip code giao hàng cho phiên Amazon (kế thừa setLocation.js của v7)
//
// Vì sao cần: Amazon xác định location theo phiên/IP — máy ở Việt Nam mở phiên mới sẽ
// thấy "Deliver to Vietnam" → SERP (đặc biệt là ads) KHÁC hẳn shopper Mỹ. Phải đặt
// zip US trước khi check ranking.
//
// Cơ chế: mở amazon.com → click widget địa chỉ (glow) → nhập zip → Apply → verify.
// Với WORKER_PROFILE bền vững: đặt 1 lần là profile nhớ. Với phiên sạch: cookies
// sau khi đặt được export ra cookies.json để các lần chạy sau nạp lại.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Đọc location hiện tại từ thanh nav ("Deliver to ... New York 10011"). */
export async function getCurrentLocation(page) {
  try {
    return await page.$eval("#glow-ingress-line2", (el) => el.textContent.trim());
  } catch {
    return null;
  }
}

/**
 * Đặt zip code. Trả về text location sau khi đặt (VD "New York 10011") hoặc throw.
 * @param {import('puppeteer').Page} page
 * @param {string} zip - 5 chữ số US
 */
export async function setZipLocation(page, zip, log = () => {}) {
  if (!/^\d{5}$/.test(String(zip))) throw new Error(`Zip không hợp lệ: "${zip}" (cần 5 chữ số US)`);

  await page.goto("https://www.amazon.com/", { waitUntil: "domcontentloaded", timeout: 40000 });
  await sleep(1500);

  // Trang chặn kiểu "Continue shopping" (interstitial) — bấm qua nếu có
  try {
    const btn = await page.$('button[alt="Continue shopping"], input[data-action-type="DISMISS"]');
    if (btn) { await btn.click(); await sleep(1500); }
  } catch {}

  const current = await getCurrentLocation(page);
  if (current && current.includes(zip)) {
    log(`📍 Location đã đúng: ${current}`);
    return current;
  }
  log(`📍 Location hiện tại: ${current || "?"} → đặt zip ${zip}...`);

  // Mở widget địa chỉ
  await page.waitForSelector("#nav-global-location-popover-link", { timeout: 15000 });
  await page.click("#nav-global-location-popover-link");

  // Nhập zip + Apply
  await page.waitForSelector("#GLUXZipUpdateInput", { timeout: 10000 });
  await page.click("#GLUXZipUpdateInput", { clickCount: 3 }); // select-all để ghi đè zip cũ
  await page.type("#GLUXZipUpdateInput", String(zip), { delay: 80 });
  await sleep(300);
  await page.click("#GLUXZipUpdate");
  await sleep(2500);

  // Đóng dialog xác nhận nếu Amazon hiện ("Done"/"Continue")
  for (const sel of ["#GLUXConfirmClose", 'button[name="glowDoneButton"]', ".a-popover-footer .a-button-primary input"]) {
    try {
      const b = await page.$(sel);
      if (b) { await b.click(); await sleep(1200); break; }
    } catch {}
  }

  // Verify: reload trang chủ, đọc lại nav
  await page.goto("https://www.amazon.com/", { waitUntil: "domcontentloaded", timeout: 40000 });
  await sleep(1500);
  const after = await getCurrentLocation(page);
  if (!after || !after.includes(zip)) {
    throw new Error(`Đặt zip thất bại — nav đang hiển thị: "${after || "?"}"`);
  }
  log(`✅ Đã đặt location: ${after}`);
  return after;
}

/**
 * Đảm bảo phiên đúng zip trước khi chạy batch: kiểm tra nhanh, sai thì tự đặt lại.
 * Trả về true nếu location đúng (sẵn sàng chạy).
 */
export async function ensureZipLocation(page, zip, log = () => {}) {
  if (!zip) return true; // chưa cấu hình zip → bỏ qua (giữ hành vi cũ)
  try {
    await page.goto("https://www.amazon.com/", { waitUntil: "domcontentloaded", timeout: 40000 });
    await sleep(1000);
    const cur = await getCurrentLocation(page);
    if (cur && cur.includes(zip)) {
      log(`📍 Location OK: ${cur}`);
      return true;
    }
    await setZipLocation(page, zip, log);
    return true;
  } catch (e) {
    log(`⚠️ Không đặt được zip ${zip}: ${e.message} — kết quả có thể sai location!`);
    return false;
  }
}
