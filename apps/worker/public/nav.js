/* nav.js — THANH ĐIỀU HƯỚNG + CHIP TÀI KHOẢN DÙNG CHUNG cho mọi trang.
   Trước đây mỗi trang tự chép lại danh sách menu nên chúng trôi dạt mỗi nơi một kiểu:
   trang Tài khoản thiếu hẳn Danh mục / Phân tích Keyword / Data, còn chip tài khoản ở góc
   phải thì chỉ trang Check Ranking mới có. Thêm trang mới giờ chỉ sửa mảng PAGES dưới đây. */

/* keepUi(el, render) — VẼ LẠI 1 VÙNG mà GIỮ trạng thái người dùng đang thao tác.
   Lỗi hệ thống từng gặp: tick 1 dòng / gõ 1 ký tự → cả vùng dựng lại bằng innerHTML → mục <details>
   đang xổ đóng lại, nội dung ngắn đi nên khung cuộn nhảy lên đầu, ô đang gõ mất focus.
   Giữ lại: vị trí cuộn của vùng + mọi khung cuộn bao ngoài + trang; <details> đang xổ (theo data-key,
   không có thì theo thứ tự); ô đang focus (theo id, hoặc theo dòng data-k/data-kw/data-key + class) + con trỏ.
   Dùng: keepUi($('bvKws'), () => { $('bvKws').innerHTML = html; }). Trang gọi qua (window.keepUi || ((e, f) => f())). */
window.keepUi = function (el, render) {
  if (!el) return render();
  const scrollers = [];
  for (let p = el; p && p !== document.body && p !== document.documentElement; p = p.parentElement)
    if (p.scrollHeight > p.clientHeight) scrollers.push([p, p.scrollTop]);
  const winY = window.scrollY, winX = window.scrollX;
  const keyOf = (d, i) => (d.dataset.key ? "k:" + d.dataset.key : "i:" + i);
  const open = new Map([...el.querySelectorAll("details")].map((d, i) => [keyOf(d, i), d.open]));
  const a = document.activeElement;
  let foc = null;
  if (a && a !== el && el.contains(a)) {
    const row = a.closest("[data-k],[data-kw],[data-key]");
    const rowSel = row ? ["data-k", "data-kw", "data-key"].filter((n) => row.hasAttribute(n))
      .map((n) => `[${n}="${CSS.escape(row.getAttribute(n))}"]`).join("") : "";
    let s = null, e = null; try { s = a.selectionStart; e = a.selectionEnd; } catch {}
    foc = { id: a.id, tag: a.tagName.toLowerCase(), cls: [...a.classList].map((c) => "." + CSS.escape(c)).join(""), rowSel, s, e };
  }
  const out = render();
  [...el.querySelectorAll("details")].forEach((d, i) => { const k = keyOf(d, i); if (open.has(k)) d.open = open.get(k); });
  for (const [p, t] of scrollers) p.scrollTop = t;
  if (window.scrollY !== winY || window.scrollX !== winX) window.scrollTo(winX, winY);
  if (foc) {
    let t = foc.id ? document.getElementById(foc.id) : null;
    if (!t && foc.rowSel) { const row = el.querySelector(foc.rowSel); if (row) t = row.querySelector(foc.tag + foc.cls); }
    if (t && el.contains(t)) {
      t.focus({ preventScroll: true });
      if (foc.s != null) try { t.setSelectionRange(foc.s, foc.e); } catch {}
    }
  }
  return out;
};

(function () {
  const PAGES = [
    ["/", "📊 Check Ranking"],
    ["/catalog.html", "📋 Danh mục Tài sản"],
    ["/kwlists.html", "🗂 Danh mục Target"],
    ["/keywords.html", "🔑 Phân tích Keyword"],
    ["/launching.html", "🚀 Tạo Campaign"],
    ["/bulk.html", "📦 Bulk Create"],
    ["/adjust.html", "⚙️ Điều chỉnh Campaign"],
    ["/data.html", "📈 Data"]
  ];
  const header = document.querySelector("header");
  if (!header) return;
  const here = location.pathname === "/index.html" ? "/" : location.pathname;

  function renderNav() {
    let nav = header.querySelector("nav");
    if (!nav) { nav = document.createElement("nav"); header.insertBefore(nav, header.children[1] || null); }
    nav.removeAttribute("hidden"); // trang Tài khoản để sẵn hidden cho tới khi biết đã đăng nhập
    nav.style.cssText = "display:flex;gap:4px;margin-left:10px;flex-wrap:wrap";
    /* Style nội tuyến chứ KHÔNG dựa vào CSS của từng trang: mỗi trang một bộ class riêng,
       bám vào đó thì menu lại mỗi nơi một kiểu — đúng lỗi vừa phải sửa. */
    nav.innerHTML = PAGES.map(([href, label]) => {
      const on = href === here;
      return `<a href="${href}" data-on="${on}" style="text-decoration:none;font-size:13px;padding:6px 14px;`
        + `border-radius:8px;white-space:nowrap;${on ? "color:#fff;background:#2455e6;font-weight:600" : "color:#9fb0c8"}">${label}</a>`;
    }).join("");
    nav.querySelectorAll('a[data-on="false"]').forEach((a) => {
      a.onmouseenter = () => { a.style.background = "#1d2739"; };
      a.onmouseleave = () => { a.style.background = ""; };
    });
  }

  function addChip(me) {
    /* Chip luôn nằm CUỐI header, trên mọi trang. Trang Check Ranking có sẵn #status mang
       margin-left:auto nên chip chỉ cần cách ra; trang khác thì chip tự đẩy sang phải. */
    const st = document.getElementById("status");
    // Dọn sạch chip cũ trước khi gắn: trang nào còn sót đoạn tự dựng chip thì cũng chỉ còn
    // lại MỘT cái. (Đã dính thật: adjust/data/launching giữ bản chép riêng → hiện 2 chip.)
    header.querySelectorAll('a[href="/user"]').forEach((e) => e.remove());
    const chip = document.createElement("a");
    chip.href = "/user";
    chip.title = "Tài khoản · agent · đăng xuất";
    chip.style.cssText = (st ? "margin-left:12px" : "margin-left:auto")
      + ";font-size:12px;text-decoration:none;color:#fff;font-weight:700;border-radius:9px;padding:3px 12px;background:"
      + (me.user.role === "admin" ? "#e5a400" : "#2455e6");
    chip.textContent = "👤 " + me.user.name + (me.actAs && me.actAs !== me.user.name ? " → 📁" + me.actAs : "");
    header.appendChild(chip);
  }

  // Hỏi trước rồi mới vẽ: vẽ ngay thì màn hình đăng nhập loé lên cả thanh menu rồi mới mất
  fetch("/api/auth/me").then((r) => r.json()).catch(() => ({}))
    .then((me) => {
      if (me.user || !me.hasUsers) renderNav();   // chưa đăng nhập mà hệ thống có user: giấu menu
      if (me.user) addChip(me);                   // chế độ local 1 người: không có chip
    });
})();
