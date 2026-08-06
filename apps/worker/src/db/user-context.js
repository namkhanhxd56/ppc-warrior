// user-context.js — Phân vùng dữ liệu THEO USER bằng AsyncLocalStorage
//
// Nguyên tắc:
//   - Chưa có user nào đăng ký (chạy local 1 người như trước) → dùng gốc ./data (không đổi gì)
//   - User ĐẦU TIÊN đăng ký = ADMIN và "sở hữu" gốc ./data (legacyRoot) → toàn bộ dữ liệu cũ giữ nguyên
//   - Member đăng ký sau → phân vùng riêng ./data/users/<username>/
// Mọi hàm trong file-store.js resolve đường dẫn QUA ĐÂY tại thời điểm gọi.

import { AsyncLocalStorage } from "async_hooks";
import path from "path";

export const als = new AsyncLocalStorage();

const ROOT = "./data";

/** Chạy fn trong ngữ cảnh của user (route handler, scheduler, agent request). */
export function runAsUser(user, fn) {
  return als.run({ user }, fn);
}

export function currentUser() {
  return als.getStore()?.user || null;
}

/** Thư mục dữ liệu của user hiện tại. */
export function userDataDir() {
  const u = currentUser();
  if (!u || u.legacyRoot) return ROOT; // chưa đăng nhập (chế độ local cũ) hoặc admin đầu tiên
  const safe = String(u.name).toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return path.join(ROOT, "users", safe);
}
