// run-batch.js — Chạy check ranking 1 ASIN × N keyword (tuần tự, giải phóng bộ nhớ từng keyword)

import fs from "fs";
import { serpParserSource, isBotCheckPage } from "../parser/serp-parser.js";
import { adsMode, countSpTiles, adsServed, needsAdsRetry, waitForRender, shouldVerifyReload } from "../parser/ads-scan.js";
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
export async function runBatch({ page: page0, asin, keywords, opts, log, shouldStop, onBatch, renewPage }) {
  // page có thể bị THAY giữa chừng khi làm mới trình duyệt (xem "làm mới định kỳ" bên dưới)
  let page = page0;
  // Chế độ COMPETITOR: chỉ cần ads + top 10 organic → quét 1 trang, luôn lưu snapshot
  if (opts.competitorMode) { opts = { ...opts, maxPages: 1, saveSnapshot: true }; }
  const maxPages = Math.min(Number(opts.maxPages) || 3, 5);
  const mode = adsMode(opts.adsScan); // BẬT/TẮT quét ads theo cờ 📢 của ASIN (mặc định bật)

  /* ===== 1. Resolve nhóm biến thể (cache file, TTL 7 ngày) ===== */
  let siblings = [];
  let variantInfo = null;
  let asinImage = null; // ảnh sản phẩm — ưu tiên nhặt từ tile SERP, không có thì lấy ở trang /dp/
  if (opts.checkVariants) {
    variantInfo = store.getProductVariants(asin);
    const fresh = variantInfo &&
      (Date.now() - new Date(variantInfo.checkedAt).getTime()) / 86400000 < VARIANT_TTL_DAYS;
    if (!fresh) {
      log(`🧬 Kiểm tra biến thể của ${asin} (mở product page)...`);
      try {
        await page.goto(`https://www.amazon.com/dp/${asin}`, { waitUntil: "domcontentloaded", timeout: 30000 });
        const html = await page.content();
        // Trang sản phẩm đang mở sẵn → nhặt luôn ảnh, khỏi phải mở lại ở bước 2c
        asinImage = await page.evaluate(() => document.querySelector("#landingImage")?.getAttribute("src")
          || document.querySelector("#imgTagWrapperId img")?.getAttribute("src") || null).catch(() => null);
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

  /* ===== 2. Check từng keyword tuần tự, ĐIỀN KẾT QUẢ THEO LÔ =====
     Luật lô (chốt 07/08/2026): cứ đủ BATCH_SIZE keyword thì điền 1 lần; phần dư cuối ASIN
     điền nốt theo đúng số còn lại rồi mới sang ASIN kế.
       3 keyword  → 1 lô (3)
       13 keyword → 5 + 5 + 3
     Vì sao không ghi từng keyword: mỗi lần ghi là đọc+ghi lại TOÀN BỘ daily-rank.json, và
     với agent còn là 1 request lên Railway (~0,42s RTT). Lô 5 giảm 5 lần cả hai.
     Vì sao không dồn tới cuối ASIN: 1 ASIN có thể 200 keyword (~20 phút) — đứt là mất sạch,
     và bảng trên web đứng im suốt lượt quét. */
  const BATCH_SIZE = Math.max(1, Number(opts.batchSize) || 5);
  const RECYCLE_PAGES = Math.max(50, Number(opts.recycleAfterPages) || 400); // làm mới trình duyệt sau ngần này trang
  let pagesScannedSinceRenew = 0;
  const results = [];
  let buf = [];
  async function flushBatch(why) {
    if (!buf.length) return;
    const batch = buf; buf = [];
    const now = new Date().toISOString();
    if (opts.competitorMode) {
      store.saveCompetitorAgg(asin, opts.dateKey || now.slice(0, 10), batch);
    } else {
      store.saveDailyRanks(asin, now, batch, opts.dateKey); // tự đăng ký tracking + gộp competitor nếu có snapshot
    }
    log(`💾 Điền ${batch.length} keyword vào bảng${why ? ` (${why})` : ""}`);
    // onBatch: agent đẩy lô này lên server ngay → bảng trên web nhích theo từng lô, và
    // agent chết giữa ASIN cũng chỉ mất tối đa BATCH_SIZE keyword.
    if (onBatch) {
      try { await onBatch(batch); }
      catch (e) { log(`⚠️ Đẩy lô lên server lỗi: ${e.message} — dữ liệu vẫn nằm ở máy agent`); }
    }
  }
  const queueResult = (res) => { if (res && !res.error) buf.push(res); };
  const groupAsins = new Set([asin, ...siblings]);
  for (let i = 0; i < keywords.length; i++) {
    if (shouldStop()) { log("⏹ Đã dừng theo yêu cầu."); break; }
    const kw = keywords[i];
    let pagesThisKw = 0;

    try {
      let { pagesSlots, resultCount, adsTilesServed } = await scrapeKeyword(page, kw, maxPages, log, opts.debug, mode);
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

      const display = fmt(record, adsTilesServed, mode.on);
      log(`🔍 [${i + 1}/${keywords.length}] "${kw}" → ${display}`);

      results.push({
        keyword: kw,
        resultCount, // "over 30,000" — số sản phẩm cạnh tranh
        adsScanned: mode.on, // false = user tắt 📢 → cột ads ghi "_" (không quét), khác "?" (không kết luận được)
        adsTilesServed, // false = 0 SP tile cả N trang sau retry → ToS/RoS không tin được
        primary: record.primary,
        variants: record.variants,
        rankedAsins: record.rankedAsins,
        notFound: record.notFound,
        pagesScanned: record.pagesScanned,
        snapshot: opts.saveSnapshot ? record.competitorSnapshot : undefined
      });
      queueResult(results[results.length - 1]);
      if (buf.length >= BATCH_SIZE) await flushBatch();
      pagesThisKw = pagesSlots.length; // đếm trước khi giải phóng bộ nhớ ở dưới

      /* ===== Giải phóng bộ nhớ trước keyword kế ===== */
      pagesSlots.length = 0;
      pagesSlots = null;
      record.competitorSnapshot = null;
      record = null;
    } catch (e) {
      log(`⚠️ [${i + 1}/${keywords.length}] "${kw}" lỗi: ${e.message}`);
      results.push({ keyword: kw, error: e.message });
    }

    /* LÀM MỚI TRÌNH DUYỆT ĐỊNH KỲ (đếm theo SỐ TRANG, không theo số ASIN):
       1 ASIN có thể là 15 trang hoặc 600 trang (200 keyword × 3 trang), nên "cứ N ASIN thì
       recycle" là sai đơn vị. Chrome sống lâu qua hàng trăm lượt tải trang sẽ phình bộ nhớ.
       Chỉ làm mới GIỮA 2 KEYWORD (điểm an toàn) và sau khi đã điền hết lô đang chờ. */
    pagesScannedSinceRenew += Number(pagesThisKw) || maxPages;
    if (renewPage && pagesScannedSinceRenew >= RECYCLE_PAGES && i < keywords.length - 1 && !shouldStop()) {
      await flushBatch("trước khi làm mới trình duyệt");
      log(`♻️ Đã quét ${pagesScannedSinceRenew} trang — làm mới trình duyệt cho nhẹ bộ nhớ`);
      try {
        page = await renewPage();
        pagesScannedSinceRenew = 0;
      } catch (e) {
        log(`⚠️ Làm mới trình duyệt lỗi: ${e.message} — chạy tiếp với trình duyệt cũ`);
      }
    }

    await sleep(500 + Math.random() * 600);
  }
  await flushBatch("lô cuối của ASIN"); // phần dư: 13 keyword → 5 + 5 + 3

  /* ===== 2b. LƯỢT QUÉT BÙ (chỉ khi BẬT quét ads): keyword bị "?" thử lại 1 lần cuối ASIN =====
     Amazon serve ads theo từng request — cùng phiên, vài phút sau thường được serve lại.
     Chỉ chạy khi user chưa bấm dừng; kết quả mới CHỈ thay thế nếu lần này thấy SP tile. */
  const missed = results
    .map((r, idx) => ({ r, idx }))
    .filter(({ r }) => needsAdsRetry(r));
  if (missed.length && !shouldStop() && mode.retrySweep) {
    log(`⟳ Quét bù ${missed.length} keyword bị "?" (ads không được serve ở lượt đầu)...`);
    for (const { r, idx } of missed) {
      if (shouldStop()) break;
      try {
        await sleep(1000 + Math.random() * 1000);
        let { pagesSlots, resultCount, adsTilesServed } = await scrapeKeyword(page, r.keyword, maxPages, log, opts.debug, mode);
        if (adsTilesServed) {
          let record = checkAcrossPages(pagesSlots, asin, siblings);
          results[idx] = {
            keyword: r.keyword,
            resultCount,
            adsScanned: true, // quét bù chỉ chạy khi đang BẬT quét ads
            adsTilesServed: true,
            primary: record.primary,
            variants: record.variants,
            rankedAsins: record.rankedAsins,
            notFound: record.notFound,
            pagesScanned: record.pagesScanned,
            snapshot: opts.saveSnapshot ? record.competitorSnapshot : undefined
          };
          queueResult(results[idx]); // ghi đè kết quả mới (cùng keyword + cùng phiên → lần cuối thắng)
          if (buf.length >= BATCH_SIZE) await flushBatch("quét bù");
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
    await flushBatch("quét bù, lô cuối");
  }

  /* ===== 2c. ẢNH SẢN PHẨM khi ASIN KHÔNG xuất hiện trên SERP =====
     Ảnh vốn chỉ nhặt được từ tile của chính mình trên SERP. ASIN MỚI (chưa lên rank, chưa
     chạy ads) thì không có tile nào → ảnh null vĩnh viễn, bảng theo dõi trống ảnh (gặp thật
     06/08/2026: B0H8RQC42P notFound cả 19 keyword). Mở trang sản phẩm 1 lần để lấy ảnh —
     chỉ tốn ~2s và chỉ chạy khi thực sự chưa có ảnh. */
  if (!asinImage && !shouldStop()) {
    try {
      await page.goto(`https://www.amazon.com/dp/${asin}`, { waitUntil: "domcontentloaded", timeout: 30000 });
      asinImage = await page.evaluate(() => document.querySelector("#landingImage")?.getAttribute("src")
        || document.querySelector("#imgTagWrapperId img")?.getAttribute("src") || null);
      log(asinImage ? "🖼 Lấy ảnh từ trang sản phẩm (ASIN chưa xuất hiện trên SERP)"
        : "⚠️ Không đọc được ảnh ở trang sản phẩm");
    } catch (e) {
      log(`⚠️ Không lấy được ảnh sản phẩm: ${e.message}`);
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
  // Chuỗi daily/competitor ĐÃ GHI THEO LÔ ngay trong lúc chạy (flushBatch) — không ghi gộp lại
  if (asinImage) store.trackingSetImage(asin, asinImage);
  log(`💾 Đã lưu kết quả: ${runId} (${results.length} keyword) — chuỗi daily đã điền theo lô ${BATCH_SIZE} keyword`);
  return runId;
}

async function scrapeKeyword(page, keyword, maxPages, log, debug = false, mode = adsMode(true)) {
  const pagesSlots = [];
  let resultCount = null;
  for (let p = 1; p <= maxPages; p++) {
    const url = `https://www.amazon.com/s?k=${encodeURIComponent(keyword)}&page=${p}`;

    // Mỗi trang: tối đa 2 lượt load (chỉ khi BẬT quét ads). Lượt 2 CHỈ khi lượt 1 ra 0 SP
    // tile — nghi Amazon không serve ads cho phiên (nguồn gốc lỗi ToS 0/0 giả, audit 16/07).
    let best = null; // parse có nhiều SP tile nhất giữa các lượt
    for (let load = 1; load <= mode.maxLoads; load++) {
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

      // Chờ ads render + cuộn cho widget lazy-load. Tắt quét ads → bỏ chờ nhãn Sponsored
      // (tiết kiệm tới 3s/trang) và rút thời gian chờ inject xuống 300ms.
      await waitForRender(page, mode);

      if (debug) {
        const slug = keyword.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);
        fs.mkdirSync("./data/debug", { recursive: true });
        fs.writeFileSync(`./data/debug/${slug}_p${p}${load > 1 ? `_retry${load}` : ""}.html`, await page.content());
      }

      const { slots, error, resultCount: rc } = await page.evaluate(serpParserSource());
      if (error) throw new Error(`Parser: ${error} tại page ${p}`);
      if (p === 1 && rc) resultCount = rc;

      const spTiles = countSpTiles(slots);
      if (!best || spTiles > best.spTiles) best = { slots, spTiles };
      if (spTiles > 0) break; // có tile → nhận luôn, không cần lượt 2

      if (shouldVerifyReload(mode, load, spTiles)) {
        log(`   ⟳ Page ${p} không có SP tile nào — reload kiểm chứng (chống ToS 0/0 giả)...`);
        await sleep(1500 + Math.random() * 1500);
      }
    }

    pagesSlots.push(best.slots);
    await sleep(300 + Math.random() * 300);
  }

  // Cờ tin cậy: cả N trang đều 0 SP tile → Amazon không serve ads cho phiên này (hoặc serve
  // toàn bộ dạng carousel) → ToS/RoS KHÔNG kết luận được, hiển thị "?" thay vì 0/0 giả.
  return { pagesSlots, resultCount, adsTilesServed: adsServed(pagesSlots) };
}

function fmt(record, adsTilesServed = true, adsScanned = true) {
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
  if (!adsScanned) parts.push("ToS _ (không quét ads)");
  else if (!adsTilesServed) parts.push("ToS ? (ads không được serve)");
  else if (pr.tosTotal > 0 || pr.tosPosition > 0) parts.push(`ToS ${pr.tosPosition}/${pr.tosTotal}`);
  if (pr.rosPresent) parts.push("RoS");
  if (pr.videoPresent) parts.push("Video");
  if (pr.sbPresent) parts.push("SB");
  return parts.join(" | ");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
