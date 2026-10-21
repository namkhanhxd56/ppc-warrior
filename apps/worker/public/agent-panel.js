/* agent-panel.js — BẢNG QUẢN LÝ AGENT DÙNG CHUNG.
   Trước đây có HAI bản: một bản đầy đủ nằm trong index.html nhưng KHÔNG NÚT NÀO MỞ ĐƯỢC
   (code chết), và một bản rút gọn ở trang Tài khoản — bản người dùng thật sự nhìn thấy —
   thiếu nút đổi tên, thiếu nút xoá, và chỉ in lệnh cài cho macOS nên người dùng Windows
   copy nhầm "curl | bash" vào PowerShell. Giờ chỉ còn một bản, gắn vào trang Tài khoản.

   Dùng: AgentPanel.mount(document.getElementById('agentPanel')) */
window.AgentPanel = (function () {
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const BTN = "padding:4px 10px;border:1px solid #d6dbe6;border-radius:7px;cursor:pointer;"
    + "font-size:11.5px;font-weight:600;background:#f4f6fa;color:#1b2330";
  const CODE = "background:#0b1020;color:#7ef0a8;border-radius:8px;padding:10px 12px;"
    + "font:11.5px/1.6 ui-monospace,Menlo,monospace;word-break:break-all;white-space:pre-wrap";
  const HINT = "font-size:11.5px;color:#667;line-height:1.6";

  async function post(url, body) {
    const r = await (await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body) })).json();
    if (!r.ok) { alert("🚨 " + (r.message || r.error || "Lỗi")); return null; }
    return r;
  }

  async function mount(el) {
    el.innerHTML = `
      <div style="${HINT};margin-bottom:10px">
        Agent là tiến trình quét chạy ngầm trên máy tính (dùng IP dân cư của máy đó).
        Máy <b>không lưu mật khẩu</b> — chỉ giữ 1 token gắn với tài khoản này. Cần Node.js 20+ và Google Chrome.</div>
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
        <input type="text" class="agLabel" placeholder="tên máy (VD: Win – H10)" style="max-width:220px;padding:7px 9px;border:1px solid #ccd3e0;border-radius:7px;font-size:13px">
        <button class="agNew" style="${BTN};background:#2455e6;color:#fff;border-color:#2455e6;padding:7px 14px;font-size:12.5px">➕ Tạo lệnh cài / cập nhật</button>
      </div>
      <div class="agCmd"></div>
      <div style="margin-top:14px"><b style="font-size:12.5px">Máy đã cấp</b><div class="agList"></div></div>
      <div style="${HINT};margin-top:10px;border-top:1px dashed #e3e8f0;padding-top:8px">
        <b>Thu hồi</b> = chặn máy đó dùng tiếp nhưng <i>giữ lại dòng</i> để còn biết máy nào từng được cấp.
        <b>🗑 Xoá</b> = bỏ hẳn khỏi danh sách (máy đó cũng ngừng nhận việc luôn). <b>✏️</b> = đổi tên máy.</div>`;
    el.querySelector(".agNew").onclick = () => newToken(el);
    el.querySelector(".agLabel").onkeydown = (e) => { if (e.key === "Enter") newToken(el); };
    await refresh(el);
  }

  async function refresh(el) {
    const r = await (await fetch("/api/agent-tokens")).json();
    const list = el.querySelector(".agList");
    /* Dữ liệu đi qua data-* rồi gắn sự kiện SAU khi dựng, không nhét vào onclick: tên máy do
       người dùng đặt, chỉ cần một dấu nháy kép là thuộc tính HTML đứt và nút chết câm. */
    list.innerHTML = (r.tokens || []).map((t) => `
      <div style="display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid #f0f2f6;font-size:12.5px;${t.revoked ? "opacity:.45" : ""}">
        <b style="flex:1">🖥 ${esc(t.label)}</b>
        <span style="${HINT}">${esc(t.user)}</span>
        <span style="${HINT}" title="Hoạt động gần nhất">${t.lastSeen ? t.lastSeen.slice(0, 16).replace("T", " ") : "chưa chạy"}</span>
        ${t.revoked ? '<span style="color:#c0392b;font-size:11.5px;font-weight:600">đã thu hồi</span>'
          : `<button class="agRevoke" data-id="${esc(t.id)}" style="${BTN};color:#c0392b" title="Chặn máy này dùng tiếp, vẫn giữ dòng">Thu hồi</button>`}
        <button class="agRename" data-id="${esc(t.id)}" data-label="${esc(t.label)}" style="${BTN}" title="Đổi tên máy">✏️</button>
        <button class="agDelete" data-id="${esc(t.id)}" data-label="${esc(t.label)}" style="${BTN};color:#c0392b" title="Xoá hẳn khỏi danh sách">🗑</button>
      </div>`).join("") || `<div style="${HINT}">chưa có máy nào</div>`;

    list.querySelectorAll(".agRename").forEach((b) => {
      b.onclick = async () => {
        const label = prompt('Tên máy (VD "Win – H10", "Mac – ranking"):', b.dataset.label || "");
        if (label === null || !label.trim()) return;
        if (await post("/api/agent-tokens/rename", { id: b.dataset.id, label })) refresh(el);
      };
    });
    list.querySelectorAll(".agRevoke").forEach((b) => {
      b.onclick = async () => {
        if (!confirm("Thu hồi? Máy này sẽ không quét được nữa, nhưng vẫn còn trong danh sách.")) return;
        if (await post("/api/agent-tokens/revoke", { id: b.dataset.id })) refresh(el);
      };
    });
    list.querySelectorAll(".agDelete").forEach((b) => {
      b.onclick = async () => {
        if (!confirm(`Xoá hẳn "${b.dataset.label}" khỏi danh sách?\n\nMáy đó đang chạy agent sẽ ngừng nhận việc.`)) return;
        if (await post("/api/agent-tokens/delete", { id: b.dataset.id })) refresh(el);
      };
    });
  }

  async function newToken(el) {
    const r = await (await fetch("/api/agent-tokens", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: el.querySelector(".agLabel").value }) })).json();
    if (!r.ok) return alert("🚨 " + (r.error || "Không tạo được token"));
    const base = location.origin;
    /* MỘT lệnh duy nhất: tải script rồi chạy thẳng trong phiên hiện tại. Bản hai bước
       (iwr -OutFile rồi powershell -File) hay bị chạy sót một bước và để lại thư mục trống
       mà không ai biết hỏng ở đâu. Chạy từ scriptblock cũng không dính ExecutionPolicy vì
       không nạp file .ps1 từ đĩa. */
    const win = `& ([scriptblock]::Create((iwr -useb "${base}/setup-agent.ps1").Content)) -Server "${base}" -Token "${r.token}"`;
    const copyBtn = (cmd, label) => `<button style="${BTN}" data-c="${esc(cmd)}"
      onclick="navigator.clipboard.writeText(this.dataset.c).then(()=>{const o=this.textContent;this.textContent='✓ đã copy';setTimeout(()=>this.textContent=o,2000)})">${label}</button>`;
    el.querySelector(".agCmd").innerHTML = `
      <div style="${HINT};background:#fff8e6;border:1px solid #f0dca8;border-radius:8px;padding:8px 10px;margin-bottom:10px">
        Lệnh này dùng cho <b>cả cài mới lẫn cập nhật code</b>. Máy đã cài rồi thì chạy lại chính lệnh này:
        trình cài <b>giữ nguyên file .env cũ</b> (token, tên máy, cấu hình không đổi), chỉ thay code mới.</div>
      <div style="font-size:11.5px;font-weight:700;margin:0 0 4px">🪟 Windows — dán vào PowerShell</div>
      <div style="${CODE}">${esc(win)}</div>
      <div style="display:flex;gap:8px;margin-top:6px;align-items:center;flex-wrap:wrap">
        ${copyBtn(win, "📋 Copy lệnh Windows")}
        <span style="${HINT}">xong chạy: <b>cd "$env:USERPROFILE\\ppc-warrior-agent"</b> rồi <b>npm.cmd run agent</b>
          — PowerShell không hiểu <b>&amp;&amp;</b>, và <b>npm</b> bị ExecutionPolicy chặn nên phải gọi <b>npm.cmd</b></span>
      </div>
      <div style="font-size:11.5px;font-weight:700;margin:14px 0 4px">🍎 macOS / Linux — dán vào Terminal</div>
      <div style="${CODE}">${esc(r.command)}</div>
      <div style="display:flex;gap:8px;margin-top:6px;align-items:center;flex-wrap:wrap">
        ${copyBtn(r.command, "📋 Copy lệnh macOS")}
        <span style="${HINT}">xong chạy: <b>cd ~/ppc-warrior-agent &amp;&amp; npm run agent</b></span>
      </div>`;
    refresh(el);
  }

  return { mount, refresh };
})();
