// rank-aggregator.js — Gộp kết quả check ranking qua NHIỀU TRANG (tối đa MAX_PAGES, mặc định 3)
//
// Nguyên tắc đã chốt:
// - KHÔNG dừng sớm khi tìm thấy ASIN (khác tool v7): spec cần sponsored info của cả 3 trang
//   + variants có thể rank ở trang sau → luôn quét đủ số trang rồi gộp
// - Offset kép: organicOffset (rank thô) và cleanOffset (rank loại Previously-viewed)
//   truyền tích lũy qua từng trang
// - ToS = CHỈ khối ads đầu page 1 (định nghĩa chốt); mọi sponsored page 2/3 là RoS; video/SB/carousel = OR các trang

import { computeGroupRanking } from "./serp-parser.js";

/**
 * Chạy computeGroupRanking tuần tự qua các trang với offset tích lũy, rồi gộp.
 * @param {Array<Array>} pagesSlots - slots của từng trang theo thứ tự [page1, page2, ...]
 * @param {string} primaryAsin
 * @param {string[]} siblingAsins
 * @returns bản ghi khớp schema rank_checks + variants
 */
export function checkAcrossPages(pagesSlots, primaryAsin, siblingAsins = [], opts = {}) {
  const perPage = [];
  let organicOffset = 0;
  let cleanOffset = 0;

  pagesSlots.forEach((slots, idx) => {
    const pageNum = idx + 1;
    const g = computeGroupRanking(slots, primaryAsin, siblingAsins, pageNum, organicOffset, {
      ...opts,
      cleanOffset
    });
    perPage.push({ pageNum, group: g });
    organicOffset += g.primary.pageStats.organicCount;
    cleanOffset += g.primary.pageStats.cleanOrganicCount;
  });

  return mergePageResults(perPage, primaryAsin);
}

/** Gộp mảng kết quả từng trang thành 1 bản ghi cuối. */
export function mergePageResults(perPage, primaryAsin) {
  // Số organic từng trang → tính vị trí TRONG TRANG (hiển thị "Page X No Y" như sheet cũ)
  const pageCounts = perPage.map(({ group }) => group.primary.pageStats.organicCount);
  const posInPage = (globalRank, pageNum) => {
    let before = 0;
    for (let i = 0; i < pageNum - 1; i++) before += pageCounts[i] || 0;
    return globalRank - before;
  };
  const empty = () => ({
    asin: null,
    organicRank: null, organicRankClean: null, organicPage: null, organicPosInPage: null,
    ownPreviouslyViewed: false,
    tosPosition: 0, tosTotal: 0,           // ToS = CHỈ khối ads đầu page 1
    rosPresent: false, rosDetail: {},      // { "1": [4], "2": [2,7] } vị trí RoS theo trang (gồm cả ads đầu trang 2/3)
    videoPresent: false, videoPages: [],
    sbPresent: false, sbPages: [],
    spCarouselPresent: false, spCarouselPages: [],
    ownBadges: [],             // badge trên tile của chính mình (Overall Pick, Amazon's Choice...)
    foundInPages: false        // "indexed trong phạm vi quét": có mặt bất kỳ dạng nào trong N trang
  });

  const mergeOne = (acc, r, pageNum) => {
    // Organic: lấy lần xuất hiện ĐẦU TIÊN (rank đã cộng dồn offset nên là rank toàn cục)
    if (r.organicRank !== null && acc.organicRank === null) {
      acc.organicRank = r.organicRank;
      acc.organicRankClean = r.organicRankClean;
      acc.organicPage = r.organicPage;
      acc.organicPosInPage = posInPage(r.organicRank, r.organicPage); // "Page X No Y"
      acc.ownPreviouslyViewed = r.ownPreviouslyViewed;
    }
    if (pageNum === 1) {
      acc.tosPosition = r.tosPosition;
      acc.tosTotal = r.tosTotal;
    }
    if (r.rosPresent) {
      acc.rosPresent = true;
      acc.rosDetail[String(pageNum)] = r.rosPositions;
    }
    if ((r.ownBadges || []).length && acc.ownBadges.length === 0) acc.ownBadges = r.ownBadges;
    if (r.videoPresent) { acc.videoPresent = true; acc.videoPages.push(pageNum); }
    if (r.sbPresent) { acc.sbPresent = true; acc.sbPages.push(pageNum); }
    if (r.spCarouselPresent) { acc.spCarouselPresent = true; acc.spCarouselPages.push(pageNum); }
    acc.foundInPages = acc.foundInPages || acc.organicRank !== null ||
      acc.tosPosition > 0 || r.rosPresent || r.videoPresent || r.sbPresent || r.spCarouselPresent;
    return acc;
  };

  // Primary
  const primary = empty();
  primary.asin = primaryAsin;
  for (const { pageNum, group } of perPage) mergeOne(primary, group.primary, pageNum);

  // Variants: gộp theo ASIN qua các trang
  const variantMap = new Map();
  for (const { pageNum, group } of perPage) {
    for (const v of group.variants) {
      if (!variantMap.has(v.asin)) {
        const a = empty();
        a.asin = v.asin;
        variantMap.set(v.asin, a);
      }
      mergeOne(variantMap.get(v.asin), v.result, pageNum);
    }
  }

  // Snapshot đối thủ: nối tuần tự các trang (đánh dấu trang)
  const competitorSnapshot = perPage.flatMap(({ pageNum, group }) =>
    group.primary.competitorSnapshot.map((s) => ({ page: pageNum, ...s }))
  );

  const pagesScanned = perPage.length;
  return {
    primary,
    variants: [...variantMap.values()],
    rankedAsins: [primary, ...variantMap.values()]
      .filter((x) => x.foundInPages)
      .map((x) => x.asin),
    pagesScanned,
    // Không tìm thấy dạng nào trong N trang → hiển thị "Not in top N pages"
    // (phân biệt indexed-rank-sâu vs not-indexed cần check riêng, ngoài phạm vi quét này)
    notFound: !primary.foundInPages && variantMap.size === 0,
    competitorSnapshot
  };
}
