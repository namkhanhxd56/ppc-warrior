// dump-serp.js — Thu thập HTML + screenshot trang search Amazon để xây parser ranking
//
// CÁCH DÙNG:
//   1. Copy file này vào thư mục check-ranking-amazon-v7 (dùng chung puppeteer + cookies.json sẵn có)
//   2. Chạy:  node dump-serp.js "keyword 1, keyword 2, keyword 3"
//      (tùy chọn: MAX_PAGES=3 node dump-serp.js "...")
//   3. Kết quả trong thư mục ./serp_samples/ → nén cả thư mục gửi lại để phân tích
//
// Nên chọn keyword đa dạng: 1 keyword cạnh tranh cao (nhiều ads, có video/brand),
// 1 keyword ngách ít ads, 1 keyword có ASIN của bạn đang chạy PPC.

import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";

const KEYWORDS = (process.argv[2] || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
const MAX_PAGES = Number(process.env.MAX_PAGES || 3);
const OUT_DIR = "./serp_samples";

if (!KEYWORDS.length) {
  console.error('Cách dùng: node dump-serp.js "keyword 1, keyword 2"');
  process.exit(1);
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function setupPage(page) {
  // KHÔNG chặn image để screenshot đầy đủ (khác index.js)
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );
  try { await page.emulateTimezone("America/New_York"); } catch {}
  await page.setViewport({ width: 1366, height: 900, deviceScaleFactor: 1 });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    headless: true,
    userDataDir: "./puppeteer_profile",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const page = await browser.newPage();
  await setupPage(page);

  // Nạp cookies (giữ location/zip)
  const cookiePath = path.resolve("./cookies.json");
  if (fs.existsSync(cookiePath)) {
    const cookies = JSON.parse(fs.readFileSync(cookiePath, "utf-8"));
    await page.setCookie(...cookies);
    console.log("🍪 Cookies loaded.");
  } else {
    console.warn("⚠️ Không thấy cookies.json — chạy không cookie (location có thể sai).");
  }

  const meta = [];

  for (const kw of KEYWORDS) {
    for (let p = 1; p <= MAX_PAGES; p++) {
      const url = `https://www.amazon.com/s?k=${encodeURIComponent(kw)}&page=${p}`;
      console.log(`🔍 "${kw}" — page ${p}`);
      try {
        await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
        await page.waitForSelector('div[data-component-type="s-search-result"]', { timeout: 10000 });

        // Scroll từ từ xuống đáy để lazy-load render đủ widget (video/SB)
        await page.evaluate(async () => {
          await new Promise(resolve => {
            let y = 0;
            const t = setInterval(() => {
              window.scrollBy(0, 600);
              y += 600;
              if (y >= document.body.scrollHeight) { clearInterval(t); resolve(); }
            }, 150);
          });
        });
        await new Promise(r => setTimeout(r, 1500));

        const base = `${slug(kw)}_p${p}`;
        const html = await page.content();
        fs.writeFileSync(path.join(OUT_DIR, `${base}.html`), html);
        await page.screenshot({ path: path.join(OUT_DIR, `${base}.png`), fullPage: true });

        // Thống kê nhanh để đối chiếu
        const stats = await page.evaluate(() => {
          const tiles = [...document.querySelectorAll('div[data-component-type="s-search-result"]')];
          const widgets = [...document.querySelectorAll("[data-cel-widget]")]
            .map(w => w.getAttribute("data-cel-widget"))
            .filter(w => /video|brand|creative|collection|sponsor|sb/i.test(w || ""));
          return {
            tileCount: tiles.length,
            tilesWithSponsoredText: tiles.filter(t => /sponsored/i.test(t.innerText)).length,
            tilesNoPrice: tiles.filter(t => !t.querySelector(".a-price")).length,
            interestingWidgets: widgets
          };
        });
        meta.push({ keyword: kw, page: p, url, savedAt: new Date().toISOString(), ...stats });
        console.log(`   ✅ ${base}.html + .png | tiles: ${stats.tileCount}, sponsored-text: ${stats.tilesWithSponsoredText}, no-price: ${stats.tilesNoPrice}`);
      } catch (e) {
        console.warn(`   ⚠️ Lỗi: ${e.message}`);
        meta.push({ keyword: kw, page: p, url, error: e.message });
      }
      await new Promise(r => setTimeout(r, 800 + Math.random() * 700));
    }
  }

  fs.writeFileSync(path.join(OUT_DIR, "_meta.json"), JSON.stringify(meta, null, 2));
  await browser.close();
  console.log(`\n✅ Xong. Nén thư mục ${OUT_DIR}/ và gửi lại để phân tích parser.`);
}

main().catch(console.error);
