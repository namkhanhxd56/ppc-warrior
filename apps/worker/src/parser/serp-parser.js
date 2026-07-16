// serp-parser.js — Parser SERP Amazon v1
// Đã xác minh trên DOM thật: "positive pickle jar" page 1 (14/07/2026)
// - Sponsored tile: .puis-sponsored-label-text (12/12 chính xác)
// - ToS = khối sponsored LIÊN TIẾP trước organic đầu tiên (page 1)
// - Organic rank = chỉ đếm tile không-sponsored (loại mọi ads/widget), kể cả tile không giá
// - 1 ASIN có thể xuất hiện cả sponsored LẪN organic → trả về cả hai
//
// Hàm parseSerpPage chạy trong browser context (page.evaluate).
// KHÔNG sửa logic ở nơi khác — mọi thay đổi selector chỉ ở file này.

/**
 * @returns {{
 *   slots: Array<{type:string, asin:string|null, sponsored:boolean, hasPrice:boolean,
 *                 price:number|null, title:string|null, asins:string[]|null}>,
 *   summary: object
 * }}
 */
export function serpParserSource() {
  // Trả về function dạng string-able để đưa vào page.evaluate
  return function parseSerpPage() {
    const main = document.querySelector("div.s-main-slot, div.s-search-results");
    if (!main) return { error: "NO_MAIN_SLOT", slots: [], summary: null };

    // Số sản phẩm cạnh tranh: "1-48 of over 30,000 results" (info bar đầu trang)
    let resultCount = null;
    const infoBar = document.querySelector('[data-component-type="s-result-info-bar"]');
    if (infoBar) {
      const m = infoBar.innerText.match(/of\s+(over\s+[\d,]+|[\d,]+)\s+results/i);
      if (m) resultCount = m[1];
    }

    const slots = [];

    const isSponsoredTile = (t) =>
      !!t.querySelector(".puis-sponsored-label-text") ||
      [...t.querySelectorAll("span")].some(
        (s) => s.childElementCount === 0 && s.textContent.trim() === "Sponsored"
      );

    const parsePrice = (t) => {
      const el = t.querySelector(".a-price .a-offscreen");
      if (!el) return null;
      const v = parseFloat(el.textContent.replace(/[^0-9.]/g, ""));
      return isNaN(v) ? null : v;
    };

    // Badge/tag của tile: Overall Pick, Amazon's Choice, Best Seller, Save x%, Ends in...
    // (phát hiện 16/07/2026 từ 2 SERP thật: badge nằm ở .a-badge[aria-label] hoặc .a-badge-text;
    //  "Best Seller" có khi CHỈ có trong aria-label, .a-badge-text rỗng)
    const getBadges = (t) => {
      const set = new Set();
      const norm = (v) => {
        if (/^overall pick/i.test(v)) return "Overall Pick";
        if (/^amazon'?s choice/i.test(v)) return "Amazon's Choice";
        if (/^best seller/i.test(v)) return "Best Seller";
        if (/^new release/i.test(v)) return "New Release";
        if (/previously viewed/i.test(v)) return "Previously viewed";
        return v;
      };
      for (const b of t.querySelectorAll(".a-badge")) {
        const v = (b.getAttribute("aria-label") || "").trim();
        if (v) set.add(norm(v));
      }
      for (const b of t.querySelectorAll(".a-badge-text")) {
        const v = (b.textContent || "").trim();
        if (v) set.add(norm(v));
      }
      // Climate Pledge Friendly KHÔNG dùng hệ .a-badge — marker ổn định là link
      // /climatepledgefriendly ở footer tile (verify 16/07/2026: 8/48 tile "gift for women")
      if (t.querySelector('a[href*="climatepledgefriendly"]')) set.add("Climate Pledge Friendly");
      return [...set].slice(0, 5);
    };

    for (const k of main.children) {
      if (k.tagName !== "DIV") continue;
      const ct = k.getAttribute("data-component-type") || "";
      const cls = k.className || "";

      if (ct === "s-search-result") {
        const sponsored = isSponsoredTile(k);
        const badges = getBadges(k);
        // Badge personalization "Previously viewed" — vị trí bị đẩy theo lịch sử xem
        const previouslyViewed = badges.includes("Previously viewed");
        slots.push({
          type: sponsored ? "SP_TILE" : "ORGANIC",
          asin: k.getAttribute("data-asin") || null,
          sponsored,
          previouslyViewed,
          badges, // Overall Pick / Amazon's Choice / Best Seller / Save x% / ...
          hasPrice: !!k.querySelector(".a-price"),
          price: parsePrice(k),
          title: (k.querySelector("h2")?.innerText || "").trim().slice(0, 120) || null,
          img: k.querySelector("img.s-image")?.getAttribute("src") || null, // src có trong DOM kể cả khi chặn tải ảnh
          asins: null
        });
        continue;
      }

      // ===== Widget (ngoài lưới s-search-result) =====
      const text = k.innerText || "";
      const hasSponsoredText = /(^|\s)Sponsored(\s|$)/.test(text);
      const hasVideo = !!k.querySelector("video") || /\bsbv\b|video-single-product/i.test(cls + " " + k.innerHTML.slice(0, 2000));
      const widgetAsins = [...new Set(
        [...k.querySelectorAll("[data-asin]")]
          .map((a) => a.getAttribute("data-asin"))
          .filter((a) => a && a.length === 10)
      )];

      const sspaLinks = k.querySelectorAll('a[href*="/sspa/click"]').length;

      if (hasSponsoredText && hasVideo) {
        slots.push({ type: "VIDEO_AD", asin: widgetAsins[0] || null, sponsored: true, hasPrice: false, price: null, title: text.trim().slice(0, 120), asins: widgetAsins });
      } else if (hasSponsoredText && sspaLinks > 0) {
        // Carousel chứa SP ads ("Recently bought and rated", "Trending now"...) — marker: link /sspa/click
        // Đã xác minh 14/07/2026: keyword lớn có thể serve TOÀN BỘ SP ads dạng carousel, lưới 0 sponsored tile
        slots.push({ type: "SP_CAROUSEL", asin: null, sponsored: true, hasPrice: false, price: null, title: text.trim().slice(0, 120), asins: widgetAsins });
      } else if (hasSponsoredText && (cls.includes("AdHolder") || widgetAsins.length >= 2 || /Shop\s/.test(text))) {
        // SB banner thật (Kilyhome, Preserved flowers, Brands related...) — không có link /sspa/
        slots.push({ type: "SB_WIDGET", asin: null, sponsored: true, hasPrice: false, price: null, title: text.trim().slice(0, 120), asins: widgetAsins });
      }
      // Widget không sponsored (Results header, More results, pagination, Alexa house-ad...) → bỏ qua
    }

    return { slots, resultCount, summary: null };
  };
}

/**
 * Tính ranking cho 1 ASIN từ slots đã parse (chạy phía Node, ngoài browser).
 * @param {Array} slots  - kết quả parseSerpPage của 1 trang
 * @param {string} asin  - ASIN cần check (TODO: hỗ trợ nhóm parent/child sau khi user confirm)
 * @param {number} pageNum - trang hiện tại (1-based)
 * @param {number} organicOffset - số organic đã đếm ở các trang trước
 */
export function computeRanking(slots, asin, pageNum, organicOffset = 0, opts = {}) {
  const result = {
    page: pageNum,
    organicRank: null,        // thứ tự organic tích lũy qua các trang (thô, như shopper này thấy)
    organicRankClean: null,   // rank sau khi loại tile "Previously viewed" (personalization)
    ownPreviouslyViewed: false, // tile của chính mình bị PV-boost → rank không tin được
    organicPage: null,
    tosPosition: 0,           // x trong x/y — ToS = CHỈ khối ads đầu page 1
    tosTotal: 0,              // y
    rosPresent: false,        // ASIN có ở sponsored ngoài ToS không
    rosPositions: [],         // vị trí nội bộ trong chuỗi sponsored RoS
    videoPresent: false,      // ASIN có trong video ad không
    sbPresent: false,         // ASIN có trong SB banner (brand) không
    spCarouselPresent: false, // ASIN có trong carousel SP ads không
    ownBadges: [],            // badge trên tile của CHÍNH mình (Overall Pick, Amazon's Choice...)
    pageStats: { organicCount: 0, sponsoredTiles: 0, videoAds: 0, sbWidgets: 0, spCarousels: 0, previouslyViewedCount: 0, cleanOrganicCount: 0 },
    competitorSnapshot: []    // toàn bộ slot để lưu serp_snapshots
  };

  // ĐỊNH NGHĨA ToS (chốt lại 14/07/2026): CHỈ là khối sponsored tile liên tiếp
  // TRƯỚC organic đầu tiên của PAGE 1. Sponsored ở page 2/3 — kể cả đứng đầu trang —
  // đều là Rest of Search. KHÔNG có khái niệm "ToS page 2/3".
  //
  // ✏️ Bổ sung 16/07/2026 (case "positive pickle emotional support affirmation cards"):
  // Amazon có thể GHIM 1 tile organic mang badge (Overall Pick / Amazon's Choice /
  // Best Seller) LÊN TRƯỚC khối sponsored đầu trang. Tile ghim này KHÔNG phá khối ToS —
  // nếu break tại đây sẽ ra ToS 0/0 giả dù có 5 sponsored ngay sau.
  // ⚠️ CẬP NHẬT 16/07 (audit run thực tế): badge là thứ CÁ NHÂN HÓA — phiên sạch
  // của worker có thể KHÔNG được Amazon gắn badge lên tile ghim → KHÔNG dùng badge
  // trong logic boundary (keyword "emotional support" ra 0/0 giả 2 run liền vì thế;
  // ngược lại nếu skip theo badge sẽ đếm lấn khi tile giữa lưới có Best Seller —
  // regression "laptop decal letters" 0/3 sai). Rule chốt (verify 6/6 fixture,
  // kể cả mô phỏng xóa toàn bộ badge):
  //   - Organic ĐẦU TIÊN của trang KHÔNG phá khối — có thể là tile GHIM
  //     (Overall Pick/Amazon's Choice/Best Seller ghim trước ads, badge có thể ẩn)
  //   - Gặp organic THỨ HAI → khối ToS chắc chắn đã kết thúc
  // An toàn vì khối ads đầu trang luôn LIÊN TIẾP và Amazon chỉ ghim tối đa 1 tile;
  // RoS giữa lưới chỉ xuất hiện sau nhiều organic liền nhau nên không bị đếm lấn.
  let tosEndIndex = -1;
  if (pageNum === 1) {
    let organicPassed = 0;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (s.type === "ORGANIC") {
        organicPassed++;
        if (organicPassed >= 2) break; // organic thứ 2 → hết khối ToS
        continue; // organic ĐẦU TIÊN: chưa break — có thể là tile ghim (badge có thể ẩn)
      }
      if (s.type === "SP_TILE") tosEndIndex = i;
      // SB_WIDGET/VIDEO_AD đứng trước không phá khối (nằm ngoài lưới tile)
    }
  }

  let organicCount = organicOffset;
  let cleanCount = opts.cleanOffset ?? organicOffset;
  let tosCount = 0;
  let rosCount = 0;

  slots.forEach((s, i) => {
    const isToS = pageNum === 1 && s.type === "SP_TILE" && i <= tosEndIndex;

    // Badge của tile chính mình — tile organic ưu tiên (tag hiển thị cho shopper),
    // chưa có thì lấy từ tile sponsored của mình
    if (s.asin === asin && (s.badges || []).length &&
        (result.ownBadges.length === 0 || s.type === "ORGANIC")) {
      result.ownBadges = s.badges;
    }

    if (s.type === "SP_TILE") {
      result.pageStats.sponsoredTiles++;
      if (isToS) {
        tosCount++;
        if (s.asin === asin) result.tosPosition = tosCount;
      } else {
        rosCount++;
        if (s.asin === asin) {
          result.rosPresent = true;
          result.rosPositions.push(rosCount);
        }
      }
    } else if (s.type === "ORGANIC") {
      organicCount++;
      result.pageStats.organicCount++;
      if (!s.previouslyViewed) {
        cleanCount++;
      } else {
        result.pageStats.previouslyViewedCount++;
      }
      if (s.asin === asin && result.organicRank === null) {
        result.organicRank = organicCount;
        result.organicPage = pageNum;
        // Rank "sạch" (loại tile Previously viewed — vị trí cá nhân hóa, shopper khác không thấy):
        // nếu chính tile của mình bị PV-boost → rank sạch không xác định được
        result.organicRankClean = s.previouslyViewed ? null : cleanCount;
        result.ownPreviouslyViewed = s.previouslyViewed;
      }
    } else if (s.type === "VIDEO_AD") {
      result.pageStats.videoAds++;
      if (s.asin === asin || (s.asins || []).includes(asin)) result.videoPresent = true;
    } else if (s.type === "SB_WIDGET") {
      result.pageStats.sbWidgets++;
      if ((s.asins || []).includes(asin)) result.sbPresent = true;
    } else if (s.type === "SP_CAROUSEL") {
      result.pageStats.spCarousels++;
      if ((s.asins || []).includes(asin)) result.spCarouselPresent = true;
    }

    result.competitorSnapshot.push({
      index: i,
      positionType: isToS ? "ToS" : s.type === "SP_TILE" ? "RoS" : s.type,
      positionIndex: isToS ? tosCount : s.type === "SP_TILE" ? rosCount
                    : s.type === "ORGANIC" ? organicCount : null,
      asin: s.asin,
      asins: s.asins || undefined,
      price: s.price,
      badges: (s.badges || []).length ? s.badges : undefined, // Overall Pick, Best Seller... — hiển thị ở snapshot/hover
      isOwn: s.asin === asin || (s.asins || []).includes(asin)
    });
  });

  result.tosTotal = tosCount;
  result.pageStats.cleanOrganicCount = cleanCount - (opts.cleanOffset ?? organicOffset);
  return result;
}

/**
 * Check theo NHÓM BIẾN THỂ (parent/child) — quy tắc đã chốt 14/07/2026:
 * - Check ASIN chính (primaryAsin) trước
 * - Nếu keyword không rank cho ASIN chính → quét các ASIN khác cùng parent (siblingAsins)
 * - Nhiều ASIN rank → LƯU TOÀN BỘ (UI xử lý hiển thị sau)
 *
 * @param {Array}  slots        - slots của 1 trang (parseSerpPage)
 * @param {string} primaryAsin  - ASIN được yêu cầu check
 * @param {string[]} siblingAsins - các ASIN con khác cùng parent
 * @returns {{ primary: object, variants: Array<{asin: string, result: object}> }}
 *   variants: TẤT CẢ ASIN trong nhóm có xuất hiện (organic hoặc sponsored/widget bất kỳ)
 */
export function computeGroupRanking(slots, primaryAsin, siblingAsins, pageNum, organicOffset = 0, opts = {}) {
  const hasPresence = (r) =>
    r.organicRank !== null || r.tosPosition > 0 || r.rosPresent ||
    r.videoPresent || r.sbPresent || r.spCarouselPresent;

  const primary = computeRanking(slots, primaryAsin, pageNum, organicOffset, opts);

  const variants = [];
  for (const a of siblingAsins || []) {
    if (a === primaryAsin) continue;
    const r = computeRanking(slots, a, pageNum, organicOffset, opts);
    if (hasPresence(r)) {
      // bỏ competitorSnapshot của variant cho nhẹ (snapshot đầy đủ đã có ở primary)
      const { competitorSnapshot, ...light } = r;
      variants.push({ asin: a, result: light });
    }
  }

  return { primary, variants, primaryRanked: hasPresence(primary) };
}

/**
 * Nhận diện trang bot-check/bm-verify của Amazon (file chỉ ~2KB, meta refresh).
 * Worker gặp trang này → KHÔNG parse, retry sau delay.
 */
export function isBotCheckPage(html) {
  return (
    html.length < 50000 &&
    (/bm-verify/i.test(html) || /http-equiv="refresh"/i.test(html)) &&
    !html.includes("s-search-result")
  );
}
