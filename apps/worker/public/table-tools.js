/* table-tools.js — tiện ích dùng chung cho các trang dạng bảng (Danh mục Tài sản, Danh mục Target).
   1. CO KÉO CỘT: mọi <table data-resizable> dàn cột cố định (table-layout:fixed), tay kéo ở mép
      phải ô tiêu đề. Kéo chỉ chia lại bề rộng với cột KẾ BÊN PHẢI — bề rộng bảng giữ nguyên.
      Độ rộng đã kéo nhớ theo trang (localStorage, lưu %); nhấp đúp tay kéo = về mặc định.
   2. DROPDOWN CÓ Ô TÌM: bấm vào <select> là mở danh sách tự vẽ có ô tìm ở đầu thay cho danh
      sách gốc của trình duyệt. Bỏ qua <select multiple>, select bị khoá, và select có
      data-nosearch (VD ô FBA/FBM — 2 lựa chọn thì tìm làm gì). Bàn phím trên select gốc (↑↓,
      gõ chữ) vẫn chạy như cũ. Chọn xong bắn sự kiện change như người dùng tự chọn.
   3. LƯỚI Ô KIỂU EXCEL cho <table data-grid> (ô = <td> chứa input/select):
      - Bấm 1 ô = ô neo; Shift + click ô khác = chọn cả vùng chữ nhật.
      - Cmd/Ctrl + C copy vùng (dạng TSV dán thẳng vào Excel); dán 1 giá trị khi đang chọn vùng
        = điền cả vùng; Delete/Backspace xoá cả vùng; Esc bỏ chọn.
      - Ô vuông nhỏ góc dưới phải vùng chọn: kéo lên/xuống để điền (lặp lại giá trị nguồn).
      - Nút ⧉ trên tiêu đề cột: copy toàn bộ cột.
      - Kéo chuột qua các ô = chọn vùng; Cmd/Ctrl + C khi không bôi đen chữ = copy nguyên ô.
      - Chuột phải vào ô: menu Copy ô (vùng chọn) / Copy dòng / Copy cột — dòng/cột theo vùng chọn.
      Ô chữ thường (không phải ô nhập) chọn + copy được, chỉ không ghi được.
      Trang có dữ liệu riêng (VD bảng vẽ lại sau mỗi lần sửa) bắt sự kiện "tt-setcells" /
      "tt-copycol" trên <table> để tự xử lý theo lô (xem kwlists.html).
   Gắn bằng <script src="/table-tools.js"></script>; bảng/ô dựng thêm sau vẫn ăn (bắt sự kiện ở document). */
(function () {
  const css = `
  table[data-resizable] { table-layout:fixed; }
  table[data-resizable] td { overflow:hidden; }
  th .tt-rz { position:absolute; right:-3px; top:0; bottom:0; width:7px; cursor:col-resize; z-index:3; }
  th .tt-rz:hover, th .tt-rz.on { background:rgba(36,85,230,.35); }
  .tt-pop { position:fixed; z-index:9999; background:#fff; border:1px solid #ccd3e0; border-radius:8px;
    box-shadow:0 8px 24px rgba(0,0,0,.18); font:13px -apple-system,Segoe UI,Arial,sans-serif; color:#1b2330;
    display:flex; flex-direction:column; max-height:320px; }
  .tt-pop input { margin:6px; padding:6px 8px; border:1px solid #ccd3e0; border-radius:6px; font:inherit; outline:none; }
  .tt-pop input:focus { border-color:#2455e6; box-shadow:0 0 0 2px #c7d5ff; }
  .tt-list { overflow:auto; padding:0 4px 4px; }
  .tt-opt { padding:5px 8px; border-radius:5px; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .tt-opt.sel { font-weight:700; color:#2455e6; }
  .tt-opt.hi { background:#eef2f9; }
  .tt-empty { padding:6px 8px; color:#98a2b3; }
  table[data-grid] td.tt-sel { background:#dde7ff !important; }
  table[data-grid] td.tt-sel input, table[data-grid] td.tt-sel select { background:transparent; }
  table[data-grid] td.tt-anc { box-shadow:inset 0 0 0 2px #2455e6; }
  table[data-grid] td.tt-fill { background:#eef3ff !important; box-shadow:inset 0 0 0 1px #9db4f5; }
  .tt-fh { position:absolute; right:0; bottom:0; width:8px; height:8px; background:#2455e6; border:1px solid #fff; cursor:crosshair; z-index:4; }
  th .tt-cp { position:absolute; right:9px; top:50%; transform:translateY(-50%); display:none; cursor:copy; font-size:12px;
    background:#fff; border:1px solid #ccd3e0; border-radius:4px; padding:0 4px; line-height:16px; color:#2455e6; z-index:3; }
  table[data-grid] th:hover .tt-cp { display:inline-block; }
  .tt-menu { position:fixed; z-index:9999; background:#fff; border:1px solid #ccd3e0; border-radius:8px; padding:4px; min-width:200px;
    box-shadow:0 8px 24px rgba(0,0,0,.18); font:13px -apple-system,Segoe UI,Arial,sans-serif; color:#1b2330; }
  .tt-mi { display:flex; justify-content:space-between; gap:18px; padding:6px 10px; border-radius:5px; cursor:pointer; white-space:nowrap; }
  .tt-mi:hover { background:#eef2f9; }
  .tt-mi kbd { font:inherit; font-size:11.5px; color:#98a2b3; }
  .tt-toast { position:fixed; left:50%; bottom:24px; transform:translateX(-50%); background:#101828; color:#fff; padding:8px 14px;
    border-radius:8px; font:13px -apple-system,Segoe UI,Arial,sans-serif; z-index:10000; box-shadow:0 6px 20px rgba(0,0,0,.25); }`;
  const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");

  /* ===== 1. Co kéo cột ===== */
  // Cột dữ liệu = có chữ tiêu đề và không phải cột ô tick (cột ✕ để trống tiêu đề)
  const dataThs = (t) => [...t.querySelectorAll("thead th")].filter((th) => th.textContent.trim() && !th.querySelector("input[type=checkbox]"));
  const wKey = (t) => `tt-cols:${location.pathname}#${t.id || [...document.querySelectorAll("table[data-resizable]")].indexOf(t)}`;
  function saveWidths(table) {
    const tw = table.getBoundingClientRect().width;
    if (!tw) return;
    const rz = new Set(dataThs(table)), out = {};
    [...table.querySelectorAll("thead th")].forEach((th, i) => {
      if (!rz.has(th)) return; // cột tick / ✕ giữ px như markup
      th.style.width = out[i] = (th.getBoundingClientRect().width / tw * 100).toFixed(2) + "%"; // % → đổi cỡ cửa sổ vẫn vừa bảng
    });
    try { localStorage.setItem(wKey(table), JSON.stringify(out)); } catch {}
  }
  function resetWidths(table) {
    for (const th of table.querySelectorAll("thead th")) th.style.width = th.dataset.ttW0 || "";
    try { localStorage.removeItem(wKey(table)); } catch {}
  }
  function addHandles(table) {
    const ths = [...table.querySelectorAll("thead th")];
    ths.forEach((th) => { if (th.dataset.ttW0 === undefined) th.dataset.ttW0 = th.style.width; });
    try {
      const saved = JSON.parse(localStorage.getItem(wKey(table)) || "null");
      if (saved) for (const [i, w] of Object.entries(saved)) if (ths[i]) ths[i].style.width = w;
    } catch {}
    const cols = dataThs(table);
    cols.forEach((th, k) => {
      const nb = cols[k + 1]; // cột cuối không có tay kéo — kéo nó là đổi bề rộng bảng
      if (!nb || th.querySelector(".tt-rz")) return;
      if (getComputedStyle(th).position === "static") th.style.position = "relative";
      const h = document.createElement("span"); h.className = "tt-rz"; h.title = "Kéo để đổi độ rộng cột · nhấp đúp = về mặc định";
      h.addEventListener("click", (e) => e.stopPropagation()); // kéo xong không tính là bấm tiêu đề (sắp xếp)
      h.addEventListener("dblclick", (e) => { e.stopPropagation(); resetWidths(table); });
      h.addEventListener("mousedown", (e) => {
        e.preventDefault(); e.stopPropagation();
        // Khoá px mọi cột theo đúng bề rộng đang hiện (tổng = bề rộng bảng), rồi chỉ chuyển phần
        // chênh giữa cột này và cột kế bên → bảng không phình/co.
        const all = [...table.querySelectorAll("thead th")];
        const ws = all.map((x) => x.getBoundingClientRect().width);
        all.forEach((x, i) => { x.style.width = ws[i] + "px"; });
        const x0 = e.pageX, a0 = ws[all.indexOf(th)], b0 = ws[all.indexOf(nb)], MIN = 36;
        h.classList.add("on"); document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none";
        const move = (ev) => {
          const d = Math.max(MIN - a0, Math.min(b0 - MIN, ev.pageX - x0));
          th.style.width = a0 + d + "px"; nb.style.width = b0 - d + "px";
        };
        const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
          h.classList.remove("on"); document.body.style.cursor = ""; document.body.style.userSelect = "";
          saveWidths(table); };
        document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
      });
      th.appendChild(h);
    });
  }
  const initTables = () => document.querySelectorAll("table[data-resizable]").forEach(addHandles);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initTables); else initTables();

  /* ===== 2. Dropdown có ô tìm ===== */
  let pop = null, sel = null, hi = -1, shown = [];
  function close() { if (pop) { pop.remove(); pop = null; sel = null; } }
  function render(q) {
    q = q.trim().toLowerCase();
    shown = [...sel.options].filter((o) => !o.disabled && !o.hidden && (!q || o.textContent.toLowerCase().includes(q)));
    hi = Math.max(0, shown.findIndex((o) => o.selected));
    pop.querySelector(".tt-list").innerHTML = shown.map((o, i) =>
      `<div class="tt-opt${o.selected ? " sel" : ""}${i === hi ? " hi" : ""}" data-i="${i}" title="${esc(o.textContent)}">${esc(o.textContent) || "&nbsp;"}</div>`).join("")
      || '<div class="tt-empty">Không có kết quả</div>';
  }
  function setHi(i) {
    if (!shown.length) return;
    hi = (i + shown.length) % shown.length;
    pop.querySelectorAll(".tt-opt").forEach((el, j) => el.classList.toggle("hi", j === hi));
    pop.querySelector(`.tt-opt[data-i="${hi}"]`)?.scrollIntoView({ block: "nearest" });
  }
  function pick(o) {
    const s = sel; close();
    if (!o || o.selected) { s.focus(); return; }
    s.value = o.value; o.selected = true;
    s.dispatchEvent(new Event("input", { bubbles: true }));
    s.dispatchEvent(new Event("change", { bubbles: true }));
    s.focus();
  }
  function open(s) {
    close(); sel = s;
    pop = document.createElement("div"); pop.className = "tt-pop";
    pop.innerHTML = '<input type="text" placeholder="🔎 Tìm…" autocomplete="off"><div class="tt-list"></div>';
    document.body.appendChild(pop);
    const r = s.getBoundingClientRect();
    const w = Math.min(460, Math.max(r.width, 200));
    pop.style.minWidth = w + "px"; pop.style.maxWidth = Math.max(w, 460) + "px";
    pop.style.left = Math.min(r.left, window.innerWidth - w - 8) + "px";
    const below = window.innerHeight - r.bottom;
    if (below < 220 && r.top > below) { pop.style.bottom = (window.innerHeight - r.top + 2) + "px"; pop.style.maxHeight = Math.min(320, r.top - 10) + "px"; }
    else { pop.style.top = (r.bottom + 2) + "px"; pop.style.maxHeight = Math.min(320, below - 10) + "px"; }
    const q = pop.querySelector("input");
    render("");
    pop.querySelector(".tt-opt.sel")?.scrollIntoView({ block: "nearest" });
    q.addEventListener("input", () => render(q.value));
    q.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); setHi(hi + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setHi(hi - 1); }
      else if (e.key === "Enter") { e.preventDefault(); pick(shown[hi]); }
      else if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); const s2 = sel; close(); s2?.focus(); }
    });
    pop.addEventListener("mousedown", (e) => { const el = e.target.closest(".tt-opt"); if (el) { e.preventDefault(); pick(shown[+el.dataset.i]); } });
    q.focus();
  }
  // Bắt ở pha capture để chặn danh sách gốc của trình duyệt trước khi nó kịp mở
  document.addEventListener("mousedown", (e) => {
    if (pop && pop.contains(e.target)) return;
    const s = e.target.closest && e.target.closest("select");
    const wasOpenFor = sel;
    close();
    // Shift + click = chọn vùng ô (lưới) — không mở danh sách
    if (!s || s.multiple || s.disabled || s.dataset.nosearch !== undefined || e.button !== 0 || e.shiftKey) return;
    e.preventDefault();
    if (wasOpenFor === s) { s.focus(); return; } // bấm lại vào chính ô đang mở → đóng
    s.focus(); open(s);
  }, true);
  window.addEventListener("resize", close);
  document.addEventListener("scroll", (e) => { if (pop && !pop.contains(e.target)) close(); }, true);

  /* ===== 3. Lưới ô kiểu Excel ===== */
  const editorOf = (td) => td && td.querySelector("input:not([type=checkbox]):not([type=file]):not([type=radio]), select");
  const gridOf = (el) => el && el.closest && el.closest("table[data-grid]");
  const isCell = (td) => !!(td && td.tagName === "TD" && gridOf(td) && td.closest("tbody") && editorOf(td));
  const dataCols = (t) => dataThs(t).map((th) => th.cellIndex);
  // Chọn/copy được cả ô chữ thường; GHI chỉ vào ô nhập (isCell)
  const isSel = (td) => !!(td && td.tagName === "TD" && gridOf(td) && td.closest("tbody") && dataCols(gridOf(td)).includes(td.cellIndex));
  const rowsOf = (t) => [...(t.tBodies[0]?.children || [])];
  const coord = (td) => ({ r: rowsOf(gridOf(td)).indexOf(td.parentElement), c: td.cellIndex });
  const tdAt = (t, r, c) => rowsOf(t)[r]?.children[c];
  // td[data-copy] = giá trị copy khi ô là chữ thường hoặc ô nhập đang trống (VD bid theo group chỉ hiện ở placeholder)
  const cellText = (td) => {
    if (!td) return "";
    const ed = editorOf(td);
    if (td.dataset.copy !== undefined && (!ed || ed.value === "")) return td.dataset.copy;
    if (!ed) return td.innerText.trim();
    if (ed.tagName === "SELECT") return ed.value === "" ? "" : (ed.selectedOptions[0]?.textContent || "").trim(); // "—" = trống
    return ed.value;
  };
  let G = null; // { t, a:{r,c}, b:{r,c} } — vùng chọn hiện tại
  const R = () => G && ({ r1: Math.min(G.a.r, G.b.r), r2: Math.max(G.a.r, G.b.r), c1: Math.min(G.a.c, G.b.c), c2: Math.max(G.a.c, G.b.c) });
  const multi = () => { const x = R(); return !!x && (x.r1 !== x.r2 || x.c1 !== x.c2); };
  function toast(msg) {
    const el = document.createElement("div"); el.className = "tt-toast"; el.textContent = msg;
    document.body.appendChild(el); setTimeout(() => el.remove(), 1800);
  }
  function paint() {
    document.querySelectorAll(".tt-sel,.tt-anc,.tt-fill").forEach((x) => x.classList.remove("tt-sel", "tt-anc", "tt-fill"));
    document.querySelectorAll(".tt-fh").forEach((x) => x.remove());
    if (!G || !G.t.isConnected) return;
    const x = R();
    if (multi()) for (let r = x.r1; r <= x.r2; r++) for (let c = x.c1; c <= x.c2; c++) tdAt(G.t, r, c)?.classList.add("tt-sel");
    tdAt(G.t, G.a.r, G.a.c)?.classList.add("tt-anc");
    const br = tdAt(G.t, x.r2, x.c2); // tay kéo điền ở góc dưới phải vùng chọn
    if (br && isCell(br)) {
      if (getComputedStyle(br).position === "static") br.style.position = "relative";
      const h = document.createElement("div"); h.className = "tt-fh"; h.title = "Kéo lên/xuống để điền giá trị";
      h.addEventListener("mousedown", startFill);
      br.appendChild(h);
    }
  }
  // Bảng vẽ lại tbody (sắp xếp/lọc/sửa) → tô lại vùng chọn theo toạ độ
  new MutationObserver(() => { if (G && G.t.isConnected && !document.querySelector(".tt-fh")) paint(); })
    .observe(document.documentElement, { childList: true, subtree: true });

  /** Ghi giá trị vào nhiều ô. Trang có thể chặn (preventDefault) để tự ghi theo lô. */
  function setCells(t, cells) {
    cells = cells.filter((x) => x.el && !x.el.readOnly && !x.el.disabled);
    if (!cells.length) return 0;
    const ev = new CustomEvent("tt-setcells", { detail: { cells }, cancelable: true, bubbles: true });
    t.dispatchEvent(ev);
    if (ev.defaultPrevented) return cells.length;
    let n = 0;
    for (const { el, value } of cells) {
      if (!el.isConnected) continue;
      if (el.tagName === "SELECT") {
        const v = String(value ?? "").trim().toLowerCase();
        const o = [...el.options].find((o) => o.value.toLowerCase() === v) || [...el.options].find((o) => o.textContent.trim().toLowerCase() === v);
        if (!o) continue;
        el.value = o.value;
      } else el.value = value ?? "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      n++;
    }
    return n;
  }
  const valOf = (td) => { const ed = editorOf(td); return ed ? ed.value : ""; };

  // Chọn ô / Shift + click chọn vùng / kéo chuột chọn vùng (capture: chạy trước dropdown có ô tìm)
  let drag = null; // { t } — đang giữ chuột trái từ một ô
  document.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.target.closest(".tt-fh, .tt-pop, .tt-cp, .tt-rz, .tt-menu")) return;
    const td = e.target.closest && e.target.closest("td");
    if (!isSel(td)) { if (G && !e.target.closest("table[data-grid]")) { G = null; paint(); } return; }
    const t = gridOf(td), co = coord(td);
    if (e.shiftKey && G && G.t === t) { e.preventDefault(); G.b = co; paint(); return; }
    G = { t, a: co, b: co }; paint();
    drag = { t };
  }, true);
  document.addEventListener("mousemove", (e) => {
    if (!drag) return;
    if (!(e.buttons & 1)) { drag = null; return; }
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const td = el && el.closest && el.closest("td");
    if (!isSel(td) || gridOf(td) !== drag.t || !G || G.t !== drag.t) return;
    const co = coord(td);
    if (co.r === G.b.r && co.c === G.b.c) return;
    G.b = co; paint();
    if (multi()) { close(); window.getSelection()?.removeAllRanges(); } // kéo ra khỏi ô đầu → bỏ bôi đen chữ, đóng dropdown
  });
  document.addEventListener("mouseup", () => { drag = null; });
  document.addEventListener("focusin", (e) => {
    const td = e.target.closest && e.target.closest("td");
    if (!isCell(td)) return;
    const t = gridOf(td), co = coord(td);
    if (G && G.t === t && multi() && td.classList.contains("tt-sel")) return; // focus nằm trong vùng đang chọn → giữ vùng
    G = { t, a: co, b: co }; paint();
  });

  document.addEventListener("keydown", (e) => {
    if (!G || !G.t.isConnected) return;
    const ae = document.activeElement;
    const typingSel = ae && ae.tagName === "INPUT" && ae.selectionStart !== ae.selectionEnd && !multi();
    if (e.key === "Escape" && multi()) { G.b = G.a; paint(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c" && multi() && !typingSel) {
      e.preventDefault(); copyRange(); return;
    }
    // 1 ô: copy nguyên ô khi không bôi đen chữ (đang bôi đen thì để trình duyệt copy đoạn chữ đó)
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c" && !multi()) {
      const td = tdAt(G.t, G.a.r, G.a.c);
      const editing = ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT" || ae.isContentEditable);
      const textSel = ae && ae.tagName === "INPUT" && ae.selectionStart !== ae.selectionEnd;
      if (!td || (editing ? !td.contains(ae) || textSel : String(window.getSelection() || "").length > 0)) return;
      e.preventDefault(); copyRange(); return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && multi()) {
      e.preventDefault();
      const x = R(), cells = [];
      for (let r = x.r1; r <= x.r2; r++) for (let c = x.c1; c <= x.c2; c++) { const td = tdAt(G.t, r, c); if (isCell(td)) cells.push({ td, el: editorOf(td), value: "" }); }
      const n = setCells(G.t, cells); if (n) toast(`🗑 Đã xoá ${n} ô`);
    }
  });
  // Dán 1 giá trị khi đang chọn vùng → điền cả vùng (dán nhiều dòng/cột thì để trang tự xử lý)
  document.addEventListener("paste", (e) => {
    if (!G || !multi() || !gridOf(e.target)) return;
    const txt = (e.clipboardData || window.clipboardData).getData("text").replace(/\r?\n$/, "");
    if (/[\t\n]/.test(txt)) return;
    e.preventDefault(); e.stopPropagation();
    const x = R(), cells = [];
    for (let r = x.r1; r <= x.r2; r++) for (let c = x.c1; c <= x.c2; c++) { const td = tdAt(G.t, r, c); if (isCell(td)) cells.push({ td, el: editorOf(td), value: txt }); }
    const n = setCells(G.t, cells); if (n) toast(`✓ Đã điền ${n} ô`);
  }, true);

  // Kéo tay điền (fill handle)
  function startFill(e) {
    e.preventDefault(); e.stopPropagation();
    const t = G.t, src = R();
    let to = null;
    document.body.style.cursor = "crosshair"; document.body.style.userSelect = "none";
    const mark = () => {
      document.querySelectorAll(".tt-fill").forEach((x) => x.classList.remove("tt-fill"));
      if (to === null) return;
      const [a, b] = to > src.r2 ? [src.r2 + 1, to] : [to, src.r1 - 1];
      for (let r = a; r <= b; r++) for (let c = src.c1; c <= src.c2; c++) tdAt(t, r, c)?.classList.add("tt-fill");
    };
    const move = (ev) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const td = el && el.closest && el.closest("td");
      if (!td || gridOf(td) !== t) return;
      const r = coord(td).r;
      to = (r > src.r2 || r < src.r1) ? r : null;
      mark();
      // tự cuộn khung bảng khi kéo sát mép
      const sc = t.closest(".scroll");
      if (sc) { const b = sc.getBoundingClientRect(); if (ev.clientY > b.bottom - 24) sc.scrollTop += 18; else if (ev.clientY < b.top + 30) sc.scrollTop -= 18; }
    };
    const up = () => {
      document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
      document.body.style.cursor = ""; document.body.style.userSelect = "";
      document.querySelectorAll(".tt-fill").forEach((x) => x.classList.remove("tt-fill"));
      if (to === null) return;
      const h = src.r2 - src.r1 + 1, cells = [];
      const srcVal = {};
      for (let r = src.r1; r <= src.r2; r++) for (let c = src.c1; c <= src.c2; c++) srcVal[(r - src.r1) + ":" + c] = valOf(tdAt(t, r, c));
      const [a, b] = to > src.r2 ? [src.r2 + 1, to] : [to, src.r1 - 1];
      for (let r = a; r <= b; r++) for (let c = src.c1; c <= src.c2; c++) {
        const td = tdAt(t, r, c); if (!isCell(td)) continue;
        const k = (((r - src.r1) % h) + h) % h; // lặp lại mẫu nguồn (kéo lên cũng đúng chiều)
        cells.push({ td, el: editorOf(td), value: srcVal[k + ":" + c] });
      }
      const n = setCells(t, cells);
      G = { t, a: { r: Math.min(src.r1, a), c: src.c1 }, b: { r: Math.max(src.r2, b), c: src.c2 } };
      paint();
      if (n) toast(`✓ Đã điền ${n} ô`);
    };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  }

  /* ===== 4. Copy ô / dòng / cột ===== */
  const clip = (text, msg) => navigator.clipboard.writeText(text).then(() => toast(msg), () => toast("✕ Trình duyệt chặn copy"));
  const colName = (t, c) => t.querySelector("thead tr")?.children[c]?.firstChild?.textContent?.trim() || "";
  /** Text cả cột — trang có thể đưa toàn bộ dữ liệu qua "tt-copycol" (kể cả dòng chưa vẽ / đang ẩn vì phân trang) */
  function colText(t, c) {
    const ev = new CustomEvent("tt-copycol", { detail: { col: c, text: null }, bubbles: true });
    t.dispatchEvent(ev);
    return ev.detail.text ?? rowsOf(t).map((tr) => cellText(tr.children[c])).join("\n");
  }
  function copyRange() {
    const x = R(), lines = [];
    for (let r = x.r1; r <= x.r2; r++) { const row = []; for (let c = x.c1; c <= x.c2; c++) row.push(cellText(tdAt(G.t, r, c))); lines.push(row.join("\t")); }
    const n = (x.r2 - x.r1 + 1) * (x.c2 - x.c1 + 1);
    clip(lines.join("\n"), n > 1 ? `📋 Đã copy ${n} ô` : "📋 Đã copy ô");
  }
  function copyRows() {
    const x = R(), cols = dataCols(G.t), lines = [];
    for (let r = x.r1; r <= x.r2; r++) lines.push(cols.map((c) => cellText(tdAt(G.t, r, c))).join("\t"));
    clip(lines.join("\n"), `📋 Đã copy ${lines.length} dòng (${cols.length} cột)`);
  }
  function copyCols() {
    const x = R(), cols = dataCols(G.t).filter((c) => c >= x.c1 && c <= x.c2);
    const data = cols.map((c) => colText(G.t, c).split("\n"));
    const n = Math.max(0, ...data.map((d) => d.length));
    const lines = Array.from({ length: n }, (_, i) => data.map((d) => d[i] ?? "").join("\t"));
    clip(lines.join("\n"), cols.length > 1 ? `📋 Đã copy ${cols.length} cột — ${n} dòng` : `📋 Đã copy cột "${colName(G.t, cols[0])}" — ${n} dòng`);
  }

  // Menu chuột phải trong ô
  let menu = null;
  const closeMenu = () => { if (menu) { menu.remove(); menu = null; } };
  document.addEventListener("contextmenu", (e) => {
    closeMenu();
    const td = e.target.closest && e.target.closest("td");
    if (!isSel(td)) return;
    if (e.target.tagName === "INPUT" && e.target.selectionStart !== e.target.selectionEnd) return; // đang bôi đen chữ → menu gốc
    e.preventDefault();
    const t = gridOf(td), co = coord(td), x0 = G && G.t === t && R();
    if (!x0 || co.r < x0.r1 || co.r > x0.r2 || co.c < x0.c1 || co.c > x0.c2) { G = { t, a: co, b: co }; paint(); } // ngoài vùng chọn → chọn ô đó
    const x = R(), nr = x.r2 - x.r1 + 1, nc = dataCols(t).filter((c) => c >= x.c1 && c <= x.c2).length;
    const items = [
      [multi() ? `📋 Copy vùng chọn (${nr * (x.c2 - x.c1 + 1)} ô)` : "📋 Copy ô", "⌘/Ctrl C", copyRange],
      [nr > 1 ? `↔ Copy ${nr} dòng` : "↔ Copy dòng", "", copyRows],
      [nc > 1 ? `↕ Copy ${nc} cột` : "↕ Copy cột", "cả cột", copyCols]
    ];
    menu = document.createElement("div"); menu.className = "tt-menu";
    menu.innerHTML = items.map(([l, k], i) => `<div class="tt-mi" data-i="${i}"><span>${esc(l)}</span><kbd>${esc(k)}</kbd></div>`).join("");
    document.body.appendChild(menu);
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = Math.min(e.clientX, window.innerWidth - mw - 6) + "px";
    menu.style.top = Math.min(e.clientY, window.innerHeight - mh - 6) + "px";
    menu.addEventListener("mousedown", (ev) => {
      const it = ev.target.closest(".tt-mi"); if (!it) return;
      ev.preventDefault(); ev.stopPropagation();
      closeMenu(); items[+it.dataset.i][2]();
    });
  });
  document.addEventListener("mousedown", (e) => { if (menu && !menu.contains(e.target)) closeMenu(); }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
  document.addEventListener("scroll", closeMenu, true);
  window.addEventListener("resize", closeMenu);

  // Nút ⧉ copy cả cột trên tiêu đề
  function addCopyBtns(table) {
    const ths = [...table.querySelectorAll("thead th")];
    ths.forEach((th) => {
      if (th.querySelector(".tt-cp") || !th.textContent.trim() || th.querySelector("input[type=checkbox]")) return;
      if (getComputedStyle(th).position === "static") th.style.position = "relative";
      const b = document.createElement("span"); b.className = "tt-cp"; b.textContent = "⧉"; b.title = "Copy cả cột";
      b.addEventListener("mousedown", (e) => e.stopPropagation());
      b.addEventListener("click", (e) => {
        e.stopPropagation(); e.preventDefault();
        const text = colText(table, th.cellIndex);
        const n = text ? text.split("\n").length : 0;
        clip(text, `📋 Đã copy cột "${th.firstChild?.textContent?.trim() || ""}" — ${n} dòng`);
      });
      th.insertBefore(b, th.querySelector(".tt-rz"));
    });
  }
  const initGrids = () => document.querySelectorAll("table[data-grid]").forEach(addCopyBtns);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initGrids); else initGrids();
})();
