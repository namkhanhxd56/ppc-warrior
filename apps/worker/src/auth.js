// auth.js — Hệ thống user: đăng ký / đăng nhập / phiên / phân quyền admin·member
//
// - users.json (GỐC ./data — dùng chung, không theo phân vùng): { username: {hash, salt, role, legacyRoot, createdAt} }
// - sessions.json: { token: {user, exp} } — cookie ppcw_sid, hạn 30 ngày, dọn phiên hết hạn khi ghi
// - Mật khẩu: scrypt + salt riêng (crypto chuẩn Node, không cần thư viện ngoài)
// - User ĐẦU TIÊN đăng ký = admin + legacyRoot (giữ nguyên toàn bộ dữ liệu cũ ở gốc ./data)

import fs from "fs";
import crypto from "crypto";

const USERS_FILE = "./data/users.json";
const SESS_FILE = "./data/sessions.json";
const SESSION_TTL = 30 * 24 * 3600 * 1000; // 30 ngày

function readJson(f, fb) {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fb; }
}
// Ghi NGUYÊN TỬ: ghi ra file tạm rồi rename đè lên (rename là thao tác nguyên tử của hệ
// thống file). Ghi thẳng bằng writeFileSync mà tiến trình chết/hết đĩa giữa chừng là file
// users.json/sessions.json hỏng JSON → mất toàn bộ tài khoản hoặc mọi phiên đăng nhập.
function writeJson(f, v) {
  fs.mkdirSync("./data", { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 1));
  fs.renameSync(tmp, f);
}

export function getUsers() { return readJson(USERS_FILE, {}); }

/* ===== MÃ MỜI: sau khi có admin đầu tiên, đăng ký PHẢI có mã (chặn người lạ trên URL công khai) ===== */
const INVITE_FILE = "./data/invite.json";
export function getInviteCode() {
  let v = readJson(INVITE_FILE, null);
  if (!v?.code) {
    v = { code: crypto.randomBytes(4).toString("hex").toUpperCase(), createdAt: new Date().toISOString() };
    writeJson(INVITE_FILE, v);
  }
  return v.code;
}
export function regenInviteCode() {
  const v = { code: crypto.randomBytes(4).toString("hex").toUpperCase(), createdAt: new Date().toISOString() };
  writeJson(INVITE_FILE, v);
  return v.code;
}
export function hasUsers() { return Object.keys(getUsers()).length > 0; }

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString("hex");
}

const NAME_RE = /^[a-z0-9_-]{3,20}$/;

export function register(username, password, invite) {
  const name = String(username || "").trim().toLowerCase();
  if (!NAME_RE.test(name)) throw new Error("Tên đăng nhập: 3-20 ký tự a-z 0-9 _ - (không dấu, không khoảng trắng)");
  if (name === "users" || name === "sessions") throw new Error("Tên này không dùng được");
  if (String(password || "").length < 6) throw new Error("Mật khẩu tối thiểu 6 ký tự");
  const users = getUsers();
  if (users[name]) throw new Error("Tên đăng nhập đã tồn tại");
  const first = Object.keys(users).length === 0;
  // Người ĐẦU TIÊN (admin) không cần mã; sau đó bắt buộc mã mời do admin cấp
  if (!first && String(invite || "").trim().toUpperCase() !== getInviteCode()) {
    throw new Error("Sai mã mời — xin mã từ admin (nút 👥 trên trang chính)");
  }
  const salt = crypto.randomBytes(16).toString("hex");
  users[name] = {
    salt, hash: hashPassword(password, salt),
    role: first ? "admin" : "member",
    legacyRoot: first, // admin đầu tiên sở hữu dữ liệu cũ ở gốc ./data
    createdAt: new Date().toISOString()
  };
  writeJson(USERS_FILE, users);
  return publicUser(name, users[name]);
}

export function verify(username, password) {
  const name = String(username || "").trim().toLowerCase();
  const u = getUsers()[name];
  if (!u) return null;
  const ok = crypto.timingSafeEqual(
    Buffer.from(u.hash, "hex"),
    Buffer.from(hashPassword(password, u.salt), "hex")
  );
  return ok ? publicUser(name, u) : null;
}

function publicUser(name, u) {
  return { name, role: u.role, legacyRoot: !!u.legacyRoot };
}

/* ===== Phiên (cookie ppcw_sid) ===== */
export function createSession(user) {
  const token = crypto.randomBytes(24).toString("hex");
  const sess = readJson(SESS_FILE, {});
  const now = Date.now();
  for (const [t, s] of Object.entries(sess)) if (s.exp < now) delete sess[t]; // dọn phiên hết hạn
  sess[token] = { user, exp: now + SESSION_TTL };
  writeJson(SESS_FILE, sess);
  return token;
}

export function getSession(token) {
  if (!token) return null;
  const s = readJson(SESS_FILE, {})[token];
  if (!s || s.exp < Date.now()) return null;
  // role/legacyRoot có thể đã đổi sau khi cấp phiên → đọc lại từ users.json
  const u = getUsers()[s.user.name];
  return u ? publicUser(s.user.name, u) : null;
}

/** Admin chuyển "dự án": phiên ghi nhớ đang thao tác trên phân vùng user nào. */
export function setActAs(token, name) {
  const sess = readJson(SESS_FILE, {});
  if (!sess[token]) throw new Error("Phiên không hợp lệ");
  const target = getUsers()[String(name).toLowerCase()];
  if (!target) throw new Error("User không tồn tại");
  sess[token].actAs = String(name).toLowerCase();
  writeJson(SESS_FILE, sess);
}
export function getActAs(token) {
  const s = readJson(SESS_FILE, {})[token];
  if (!s?.actAs) return null;
  const u = getUsers()[s.actAs];
  return u ? publicUser(s.actAs, u) : null;
}

export function destroySession(token) {
  const sess = readJson(SESS_FILE, {});
  if (sess[token]) { delete sess[token]; writeJson(SESS_FILE, sess); }
}

export function parseCookie(req) {
  const m = String(req.headers.cookie || "").match(/(?:^|;\s*)ppcw_sid=([a-f0-9]+)/);
  return m ? m[1] : null;
}

/* ===== KHÔI PHỤC MẬT KHẨU KHI QUÊN =====
   Mật khẩu lưu bằng scrypt + salt nên không giải ngược được, và users.json nằm trên volume
   của Railway nên máy cá nhân không với tới. Lối khôi phục duy nhất phải đi qua chính tiến
   trình server.
   CỐ Ý KHÔNG LÀM ENDPOINT HTTP: một đường reset mở ra internet là một cửa tấn công mới, dù
   có gác bằng khoá bí mật. Thay vào đó kích hoạt bằng BIẾN MÔI TRƯỜNG — ai vào được Railway
   Variables thì vốn đã toàn quyền với hệ thống, nên cách này không nới lỏng bảo mật thêm. */

/** Đặt lại mật khẩu KHÔNG cần mật khẩu cũ. Chỉ dùng cho luồng khôi phục bên dưới. */
export function forceSetPassword(username, password) {
  const name = String(username || "").trim().toLowerCase();
  const users = getUsers();
  if (!users[name]) {
    const e = new Error(`Không có tài khoản "${name}"`);
    e.names = Object.keys(users); // để log gợi ý khi quên luôn cả tên đăng nhập
    throw e;
  }
  if (String(password || "").length < 6) throw new Error("Mật khẩu tối thiểu 6 ký tự");
  const salt = crypto.randomBytes(16).toString("hex");
  users[name] = { ...users[name], salt, hash: hashPassword(password, salt), passwordResetAt: new Date().toISOString() };
  writeJson(USERS_FILE, users);
  // Huỷ mọi phiên cũ của tài khoản: đã phải đi đường khôi phục thì cookie cũ cũng không nên
  // còn hiệu lực (có thể đang nằm trên máy/trình duyệt mà bạn không còn kiểm soát).
  const sess = readJson(SESS_FILE, {});
  let killed = 0;
  for (const [t, s] of Object.entries(sess)) if (s?.user?.name === name) { delete sess[t]; killed++; }
  if (killed) writeJson(SESS_FILE, sess);
  return { user: publicUser(name, users[name]), sessionsKilled: killed };
}

/** Chạy MỘT LẦN lúc khởi động nếu có biến ADMIN_RESET="tên_đăng_nhập:mật_khẩu_mới".
 *  Mật khẩu được phép chứa dấu ":" (chỉ tách ở dấu hai chấm ĐẦU TIÊN). */
export function applyAdminResetFromEnv(raw) {
  const v = String(raw || "").trim();
  if (!v) return null;
  const i = v.indexOf(":");
  if (i < 1) {
    console.error('🚨 ADMIN_RESET sai định dạng — cần "tên_đăng_nhập:mật_khẩu_mới"');
    return null;
  }
  try {
    const r = forceSetPassword(v.slice(0, i), v.slice(i + 1));
    console.log(`🔑 ADMIN_RESET: đã đặt lại mật khẩu cho "${r.user.name}" (${r.user.role})`
      + (r.sessionsKilled ? ` · huỷ ${r.sessionsKilled} phiên đăng nhập cũ` : ""));
    console.log("   ⚠️  XOÁ biến ADMIN_RESET trong Railway Variables ngay sau khi đăng nhập được —");
    console.log("       để nguyên thì mỗi lần server khởi động lại sẽ đặt lại mật khẩu về giá trị đó.");
    return r.user;
  } catch (e) {
    console.error(`🚨 ADMIN_RESET thất bại: ${e.message}`);
    if (e.names) console.error(`   Tài khoản đang có: ${e.names.join(", ") || "(chưa có tài khoản nào)"}`);
    return null;
  }
}

/* ===== Quản trị (admin) ===== */
export function listUsers() {
  return Object.entries(getUsers()).map(([name, u]) => ({
    name, role: u.role, legacyRoot: !!u.legacyRoot, createdAt: u.createdAt
  }));
}

export function setRole(name, role) {
  const users = getUsers();
  if (!users[name]) throw new Error("User không tồn tại");
  if (!["admin", "member"].includes(role)) throw new Error("Role không hợp lệ");
  // không cho hạ cấp admin cuối cùng
  const admins = Object.values(users).filter((u) => u.role === "admin").length;
  if (users[name].role === "admin" && role === "member" && admins <= 1) throw new Error("Không thể hạ cấp admin cuối cùng");
  users[name].role = role;
  writeJson(USERS_FILE, users);
}

export function deleteUser(name) {
  const users = getUsers();
  if (!users[name]) throw new Error("User không tồn tại");
  if (users[name].legacyRoot) throw new Error("Không thể xoá admin gốc (sở hữu dữ liệu chính)");
  delete users[name];
  writeJson(USERS_FILE, users);
  // phân vùng dữ liệu giữ lại trên đĩa (data/users/<name>) — xoá tay nếu chắc chắn
}

/* ===== Xác thực Basic cho AGENT (tài khoản user thật) ===== */
export function verifyBasic(req) {
  const auth = String(req.headers.authorization || "");
  if (!auth.startsWith("Basic ")) return null;
  const [name, ...rest] = Buffer.from(auth.slice(6), "base64").toString().split(":");
  return verify(name, rest.join(":"));
}

/* ===== AGENT TOKEN: máy chạy agent KHÔNG lưu user/pass =====
   agent-tokens.json: { token: { user, label, createdAt, lastSeen, revoked } }
   - Mỗi user tự tạo token cho máy của mình (web → 🖥 Agent) — admin thấy/thu hồi được tất cả
   - Agent gửi header x-agent-token → server resolve ra user → job/data vào đúng phân vùng
   - Mất máy/lộ token → thu hồi, không phải đổi mật khẩu */
const AGENT_TOKENS_FILE = "./data/agent-tokens.json";

function readTokens() { return readJson(AGENT_TOKENS_FILE, {}); }
function writeTokens(t) { writeJson(AGENT_TOKENS_FILE, t); }

export function createAgentToken(userName, label) {
  const tokens = readTokens();
  const token = "pwa_" + crypto.randomBytes(18).toString("hex");
  tokens[token] = { user: userName, label: String(label || "máy chưa đặt tên").slice(0, 40),
    createdAt: new Date().toISOString(), lastSeen: null, revoked: false };
  writeTokens(tokens);
  return token;
}

export function resolveAgentToken(token) {
  if (!token || !String(token).startsWith("pwa_")) return null;
  const tokens = readTokens();
  const t = tokens[token];
  if (!t || t.revoked) return null;
  const u = getUsers()[t.user];
  if (!u) return null;
  // cập nhật lastSeen (throttle 60s để đỡ ghi file liên tục)
  if (!t.lastSeen || Date.now() - new Date(t.lastSeen).getTime() > 60000) {
    t.lastSeen = new Date().toISOString();
    writeTokens(tokens);
  }
  return publicUser(t.user, u);
}

export function listAgentTokens(userName, isAdmin) {
  return Object.entries(readTokens())
    .filter(([, t]) => isAdmin || t.user === userName)
    .map(([token, t]) => ({
      token: token.slice(0, 10) + "…", tokenFull: undefined, // không trả token đầy đủ khi liệt kê
      id: token.slice(-8), user: t.user, label: t.label,
      createdAt: t.createdAt, lastSeen: t.lastSeen, revoked: !!t.revoked
    }));
}

/** Đổi tên máy đã cấp token. Cùng quy tắc quyền như thu hồi: chủ token hoặc admin. */
export function renameAgentToken(idSuffix, label, userName, isAdmin) {
  const suffix = String(idSuffix || "");
  if (suffix.length < 8) throw new Error("Mã token không hợp lệ");
  const name = String(label || "").trim().slice(0, 40);
  if (!name) throw new Error("Tên máy không được để trống");
  const tokens = readTokens();
  const entry = Object.entries(tokens).find(([token, t]) => token.endsWith(suffix) && (isAdmin || t.user === userName));
  if (!entry) throw new Error("Không tìm thấy token (hoặc không có quyền)");
  entry[1].label = name;
  writeTokens(tokens);
  return name;
}

export function revokeAgentToken(idSuffix, userName, isAdmin) {
  // Phải đủ dài: endsWith("") khớp MỌI token → gọi với id rỗng là thu hồi nhầm token bất kỳ
  // (với admin là token của người khác). listAgentTokens luôn trả id 8 ký tự cuối.
  const suffix = String(idSuffix || "");
  if (suffix.length < 8) throw new Error("Mã token không hợp lệ");
  const tokens = readTokens();
  const entry = Object.entries(tokens).find(([token, t]) => token.endsWith(suffix) && (isAdmin || t.user === userName));
  if (!entry) throw new Error("Không tìm thấy token (hoặc không có quyền)");
  entry[1].revoked = true;
  writeTokens(tokens);
}
