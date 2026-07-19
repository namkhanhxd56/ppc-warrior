// run-batch.js — Chạy check ranking 1 ASIN × N keyword (tuần tự, giải phóng bộ nhớ từng keyword)

import fs from "fs";
import { serpParserSource, isBotCheckPage } from "../parser/serp-parser.js";
import { checkAcrossPages } from "../parser/rank-aggregator.js";
import { extractVariantsFromProductPage } from "../scraper/variant-resolver.js";
import * as store from "../db/file-store.js";

const VARIANT_TTL_DAYS = 7;

/**
 * @param {object} p
 * @param {import('puppeteer').Page} p.page
 * @param {string} p.asin
 * @param {string[]} p.keywords
 * @param {object} p.opts {maxPages, checkVariants, saveSnapshot}
 * @param {(msg:string)=>void} p.log
 * @param {()=>boolean} p.shouldStop
 */
export async function runBatch({ page, asin, keywords, opts, log, shouldStop }) {
  // Chế độ COMPETITOR: chỉ cần ads + top 10 organic → quét 1 trang, luôn lưu snapshot
  if (opts.competitorMode) { opts = { ...opts, maxPages: 1, saveSnapshot: true }; }
  const maxPages = Math.min(Number(opts.maxPages) || 3, 5);

  /* ===== 1. Resolve nhóm biến thể (cache file, TTL 7 ngày) ===== */
  let siblings = [];
  let variantInfo = null;
  if (opts.checkVariants) {
    variantInfo = store.getProductVariants(asin);
    const fresh = variantInfo &&
      (Date.now() - new Date(variantInfo.checkedAt).getTime()) / 86400000 < VARIANT_TTL_DAYS;
    if (!fresh) {
      log(`🧬 Kiểm tra biến thể của ${asin} (mở product page)...`);
      try {
        await page.goto(`https://www.amazon.com/dp/${asin}`, { waitUntil: "domcontentloaded", timeout: 30000 });
        const html = await page.content();
        const v = extractVariantsFromProductPage(html, asin);
        store.saveProductVariants(asin, v.parentAsin, v.childAsins);
        variantInfo = { parentAsin: v.parentAsin, childAsins: v.childAsins };
        log(v.hasVariants
          ? `   → parent ${v.parentAsin || "?"} với ${v.childAsins.length} biến thể`
          : "   → ASIN không có biến thể");
      } catch (e) {
        log(`   ⚠️ Không đọc được biến thể: ${e.message} — check riêng ASIN này`);
        variantInfo = { parentAsin: null, childAsins: [asin] };
      }
    } else {
      log(`🧬 Biến thể (cache): ${variantInfo.childAsins.length} ASIN cùng nhóm`);
    }
    siblings = (variantInfo.childAsins || []).filter((a) => a !== asin);
  }

  /* ===== 2. Check từng keyword tuần tự ===== */
  const results = [];
  // GHI NGAY từng keyword xong (không đợi hết ASIN): đứt giữa chừng không mất dữ liệu,
  // Continue chính xác đến từng keyword, bảng theo dõi cập nhật trực tiếp trong lúc chạy
  const persistOne = (res) => {
    if (!res || res.error) return;
    const now = new Date().toISOString();
    if (opts.competitorMode) {
      store.saveCompetitorAgg(asin, opts.dateKey || now.slice(0, 10), [res]);
    } else {
      store.saveDailyRanks(asin, now, [res], opts.dateKey); // tự đăng ký tracking + gộp competitor nếu có snapshot
    }
  };
  let asinImage = null; // hình sản phẩm — lấy từ tile SERP đầu tiên khớp nhóm ASIN
  const groupAsins = new Set([asin, ...siblings]);
  for (let i = 0; i < keywords.length; i++) {
    if (shouldStop()) { log("⏹ Đã dừng theo yêu cầu."); break; }
    const kw = keywords[i];

    try {
      let { pagesSlots, resultCount, adsTilesServed } = await scrapeKeyword(page, kw, maxPages, log, opts.debug, opts.adsScan !== false);
      let record = checkAcrossPages(pagesSlots, asin, siblings);

      // 🐞 Debug: lưu slots đã phân loại để đối chiếu với HTML (kiểm chứng ToS/sponsored)
      if (opts.debug) {
        const slug = kw.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);
        fs.mkdirSync("./data/debug", { recursive: true });
        fs.writeFileSync(`./data/debug/${slug}.slots.json`, JSON.stringify(pagesSlots, null, 1));
        log(`   🐞 Debug: đã lưu data/debug/${slug}_p*.html + .slots.json`);
      }

      if (!asinImage) {
        for (const slots of pagesSlots) {
          const own = slots.find((s) => s.img && groupAsins.has(s.asin));
          if (own) { asinImage = own.img; break; }
        }
      }

      const display = fmt(record, adsTilesServed);
      log(`🔍 [${i + 1}/${keywords.length}] "${kw}" → ${display}`);

      results.push({
        keyword: kw,
        resultCount, // "over 30,000" — số sản phẩm cạnh tranh
        adsTilesServed, // false = 0 SP tile cả N trang sau retry → ToS/RoS không tin được
        primary: record.primary,
        variants: record.variants,
        rankedAsins: record.rankedAsins,
        notFound: record.notFound,
        pagesScanned: record.pagesScanned,
        snapshot: opts.saveSnapshot ? record.competitorSnapshot : undefined
      });
      persistOne(results[results.length - 1]); // điền kết quả vào bảng NGAY

      /* ===== Giải phóng bộ nhớ trước keyword kế ===== */
      pagesSlots.length = 0;
      pagesSlots = null;
      record.competitorSnapshot = null;
      record = null;
    } catch (e) {
      log(`⚠️ [${i + 1}/${keywords.length}] "${kw}" lỗi: ${e.message}`);
      results.push({ keyword: kw, error: e.message });
    }

    await sleep(500 + Math.random() * 600);
  }

  /* ===== 2b. LƯỢT QUÉT BÙ: keyword bị "?" (ads không được serve) thử lại 1 lần cuối batch =====
     Amazon serve ads theo từng request — cùng phiên, vài phút sau thường được serve lại.
     Chỉ chạy khi user chưa bấm dừng; kết quả mới CHỈ thay thế nếu lần này thấy SP tile. */
  const missed = results
    .map((r, idx) => ({ r, idx }))
    .filter(({ r }) => !r.error && r.adsTilesServed === false);
  if (missed.length && !shouldStop() && opts.adsScan !== false) {
    log(`⟳ Quét bù ${missed.length} keyword bị "?" (ads không được serve ở lượt đầu)...`);
    for (const { r, idx } of missed) {
      if (shouldStop()) break;
      try {
        await sleep(1000 + Math.random() * 1000);
        let { pagesSlots, resultCount, adsTilesServed } = await scrapeKeyword(page, r.keyword, maxPages, log, opts.debug);
        if (adsTilesServed) {
          let record = checkAcrossPages(pagesSlots, asin, siblings);
          results[idx] = {
            keyword: r.keyword,
            resultCount,
            adsTilesServed: true,
            primary: record.primary,
            variants: record.variants,
            rankedAsins: record.rankedAsins,
            notFound: record.notFound,
            pagesScanned: record.pagesScanned,
            snapshot: opts.saveSnapshot ? record.competitorSnapshot : undefined
          };
          persistOne(results[idx]); // ghi đè kết quả mới (cùng keyword + cùng phiên → lần cuối thắng)
          log(`   ✅ "${r.keyword}" → ${fmt(record, true)} (quét bù thành công)`);
          record.competitorSnapshot = null;
          record = null;
        } else {
          log(`   ▪ "${r.keyword}" vẫn không được serve ads — giữ "?"`);
        }
        pagesSlots.length = 0;
        pagesSlots = null;
      } catch (e) {
        log(`   ⚠️ Quét bù "${r.keyword}" lỗi: ${e.message} — giữ kết quả cũ`);
      }
    }
  }

  /* ===== 3. Lưu kết quả ===== */
  const checkedAt = new Date().toISOString();
  const runId = store.saveRunResult({
    asin,
    image: asinImage,
    parentAsin: variantInfo?.parentAsin || null,
    siblingCount: siblings.length,
    checkedAt,
    opts: { maxPages, checkVariants: !!opts.checkVariants },
    results
  });
  // Chuỗi daily/competitor ĐÃ GHI TỪNG KEYWORD ngay trong lúc chạy (persistOne) — không ghi gộp lại
  if (asinImage) store.trackingSetImage(asin, asinImage);
  log(`💾 Đã lưu kết quả: ${runId} (${results.length} keyword) — chuỗi daily đã điền trực tiếp từng keyword`);
  return runId;
}

async function scrapeKeyword(page, keyword, maxPages, log, debug = false, adsScan = true) {
  const pagesSlots = [];
  let resultCount = null;
  for (let p = 1; p <= maxPages; p++) {
    const url = `https://www.amazon.com/s?k=${encodeURIComponent(keyword)}&page=${p}`;

    // Mỗi trang: tối đa 2 lượt load. Lượt 2 CHỈ khi lượt 1 ra 0 SP tile
    // (nghi Amazon không serve ads cho phiên — nguồn gốc lỗi ToS 0/0 giả, audit 16/07/2026).
    let best = null; // parse có nhiều SP tile nhất giữa các lượt
    const maxLoads = adsScan ? 2 : 1; // tắt quét ads → 1 lượt load, không reload kiểm chứng
    for (let load = 1; load <= maxLoads; load++) {
      let html = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        try {
          await page.waitForSelector('div[data-component-type="s-search-result"]', { timeout: 8000 });
        } catch {}
        html = await page.content();
        if (!isBotCheckPage(html)) break;
        log(`   🤖 Bot-check tại page ${p} — chờ rồi thử lại (${attempt}/2)...`);
        await sleep(6000 + Math.random() * 4000);
        html = null;
      }
      if (html === null) throw new Error(`Bot-check liên tục tại page ${p}`);

      // Chờ nhãn Sponsored render (ads inject async sau domcontentloaded) —
      // không có sau 3s = trang này thật sự không được serve tile, đi tiếp
      try {
        await page.waitForSelector(".puis-sponsored-label-text", { timeout: 3000 });
      } catch {}

      // Scroll để widget lazy-load (video/SB/carousel) render đủ + chờ ads inject xong
      await page.evaluate(async () => {
        await new Promise((resolve) => {
          let y = 0;
          const t = setInterval(() => {
            window.scrollBy(0, 700);
            y += 700;
            if (y >= document.body.scrollHeight) { clearInterval(t); resolve(); }
          }, 120);
        });
        window.scrollTo(0, 0); // về đầu trang — khối ToS render/ổn định lại
      });
      await sleep(1200);

      if (debug) {
        const slug = keyword.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);
        fs.mkdirSync("./data/debug", { recursive: true });
        fs.writeFileSync(`./data/debug/${slug}_p${p}${load > 1 ? `_retry${load}` : ""}.html`, await page.content());
      }

      const { slots, error, resultCount: rc } = await page.evaluate(serpParserSource());
      if (error) throw new Error(`Parser: ${error} tại page ${p}`);
      if (p === 1 && rc) resultCount = rc;

      const spTiles = slots.filter((s) => s.type === "SP_TILE").length;
      if (!best || spTiles > best.spTiles) best = { slots, spTiles };
      if (spTiles > 0) break; // có tile → nhận luôn, không cần lượt 2

      if (load === 1 && adsScan) {
        log(`   ⟳ Page ${p} không có SP tile nào — reload kiểm chứng (chống ToS 0/0 giả)...`);
        await sleep(1500 + Math.random() * 1500);
      }
    }

    pagesSlots.push(best.slots);
    await sleep(300 + Math.random() * 300);
  }

  // Cờ tin cậy: cả N trang đều 0 SP tile (sau retry) → Amazon không serve ads cho
  // phiên này (hoặc serve toàn bộ dạng carousel) → ToS/RoS KHÔNG kết luận được,
  // hiển thị "?" thay vì 0/0. Chỉ khi thấy ≥1 SP tile thì 0/0 mới là 0/0 thật.
  const spTilesSeen = pagesSlots.reduce(
    (n, slots) => n + slots.filter((s) => s.type === "SP_TILE").length, 0);
  return { pagesSlots, resultCount, adsTilesServed: spTilesSeen > 0 };
}

function fmt(record, adsTilesServed = true) {
  const pr = record.primary;
  const parts = [];
  if (pr.organicRank !== null) {
    parts.push(`Page ${pr.organicPage} No ${pr.organicPosInPage}` +
      (pr.ownPreviouslyViewed ? " ⚠️PV" : ""));
  } else if (record.variants.length) {
    parts.push(`variant rank: ${record.variants.map((v) => v.asin).join(",")}`);
  } else {
    parts.push("Not in top pages");
  }
  if (!adsTilesServed) parts.push("ToS ? (ads không được serve)");
  else if (pr.tosTotal > 0 || pr.tosPosition > 0) parts.push(`ToS ${pr.tosPosition}/${pr.tosTotal}`);
  if (pr.rosPresent) parts.push("RoS");
  if (pr.videoPresent) parts.push("Video");
  if (pr.sbPresent) parts.push("SB");
  return parts.join(" | ");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
