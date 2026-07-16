// check-rank-job.js — Flow đầy đủ check ranking 1 keyword × 1 ASIN (kèm nhóm biến thể)
//
// Quy tắc đã chốt:
// 1. Kiểm tra ASIN có parent/child không → có thì lấy TOÀN BỘ child của nhóm
// 2. Quét đủ MAX_PAGES (mặc định 3), lưu thứ hạng của TẤT CẢ child vào biến tạm
// 3. Quyết định bản ghi cuối (primary + variants) → ghi DB
// 4. GIẢI PHÓNG BỘ NHỚ ngay sau khi ghi xong (slots, snapshot, variantMap)
//    → xử lý keyword TUẦN TỰ, không giữ dữ liệu trang của keyword trước

import { serpParserSource, isBotCheckPage } from "../parser/serp-parser.js";
import { checkAcrossPages } from "../parser/rank-aggregator.js";
import { resolveVariants } from "../scraper/variant-resolver.js";

const MAX_PAGES = Number(process.env.MAX_PAGES || 3);

export async function runCheckRankJob(db, page, job) {
  const { projectId, keyword, asin, options = {} } = job;

  // ===== BƯỚC 1: Resolve nhóm biến thể (cache-first, tốn tối đa 1 request khi miss) =====
  const variantInfo = await resolveVariants(db, page, asin, projectId);
  const siblings = variantInfo.hasVariants
    ? variantInfo.childAsins.filter((a) => a !== asin)
    : [];

  // ===== BƯỚC 2: Quét N trang SERP — biến tạm pagesSlots giữ dữ liệu thô =====
  let pagesSlots = [];
  for (let p = 1; p <= MAX_PAGES; p++) {
    const url = `https://www.amazon.com/s?k=${encodeURIComponent(keyword)}&page=${p}`;

    // Tối đa 2 lượt load/trang: lượt 2 chỉ khi 0 SP tile (chống ToS 0/0 giả —
    // Amazon không serve SP tile cho phiên nghi bot; audit 16/07/2026)
    let best = null;
    for (let load = 1; load <= 2; load++) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

      const html = await page.content();
      if (isBotCheckPage(html)) {
        throw new RetryableError(`Bot-check tại "${keyword}" page ${p} — retry sau delay`);
      }

      // Chờ nhãn Sponsored render (ads inject async) — không có sau 3s thì đi tiếp
      try { await page.waitForSelector(".puis-sponsored-label-text", { timeout: 3000 }); } catch {}

      // Scroll để lazy-load widget (video/SB) render đủ rồi mới parse
      await autoScroll(page);
      const { slots } = await page.evaluate(serpParserSource());

      const spTiles = slots.filter((s) => s.type === "SP_TILE").length;
      if (!best || spTiles > best.spTiles) best = { slots, spTiles };
      if (spTiles > 0) break;
      if (load === 1) await sleep(1500 + Math.random() * 1500);
    }
    pagesSlots.push(best.slots);

    await sleep(400 + Math.random() * 400);
  }

  // 0 SP tile cả N trang sau retry → ToS/RoS không kết luận được (không phải 0/0 thật)
  const adsTilesServed = pagesSlots.some((slots) => slots.some((s) => s.type === "SP_TILE"));

  // ===== BƯỚC 3: Tính thứ hạng TOÀN BỘ nhóm — variantMap nằm trong record =====
  let record = checkAcrossPages(pagesSlots, asin, siblings, options);

  // ===== BƯỚC 4: Quyết định + ghi DB =====
  // Lưu bản ghi: primary + TẤT CẢ variants có rank (quy tắc: nhiều ASIN rank → lưu hết)
  const rankCheckId = await db.insertRankCheck(projectId, job.keywordAsinId, {
    ranked_asin: record.primary.foundInPages ? asin : (record.rankedAsins[0] || null),
    ads_tiles_served: adsTilesServed, // false → tos/ros của bản ghi này không kết luận được
    organic_rank: record.primary.organicRank,
    organic_rank_clean: record.primary.organicRankClean,
    organic_page: record.primary.organicPage,
    own_previously_viewed: record.primary.ownPreviouslyViewed,
    tos_position: record.primary.tosPosition,
    tos_total: record.primary.tosTotal,
    ros_present: record.primary.rosPresent,
    video_present: record.primary.videoPresent,
    sb_present: record.primary.sbPresent,
    sp_carousel_present: record.primary.spCarouselPresent,
    not_found: record.notFound,
    pages_scanned: record.pagesScanned,
    variants: record.variants          // toàn bộ child có rank — UI xử lý sau
  });

  if (options.saveSnapshot !== false) {
    await db.insertSerpSnapshots(rankCheckId, record.competitorSnapshot);
  }

  // ===== BƯỚC 5: GIẢI PHÓNG BỘ NHỚ =====
  // Cắt mọi tham chiếu tới dữ liệu lớn để GC thu hồi trước khi nhận job kế tiếp.
  // pagesSlots (~200 slot × 3 trang) + competitorSnapshot là phần nặng nhất.
  pagesSlots.length = 0;
  pagesSlots = null;
  record.competitorSnapshot = null;
  record.variants = null;
  record = null;

  return { ok: true, rankCheckId };
}

/* ================= helpers ================= */

export class RetryableError extends Error {}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let y = 0;
      const t = setInterval(() => {
        window.scrollBy(0, 700);
        y += 700;
        if (y >= document.body.scrollHeight) { clearInterval(t); resolve(); }
      }, 120);
    });
  });
  await new Promise((r) => setTimeout(r, 800));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
