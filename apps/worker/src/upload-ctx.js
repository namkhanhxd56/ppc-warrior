// upload-ctx.js
import { als } from "./db/user-context.js";

/* GIỮ PHÂN VÙNG USER QUA MULTER (23/11/2026): multer nhận file qua stream (busboy) rồi gọi next() từ
   sự kiện của stream — file lớn (vài MB trở lên) thì lúc đó đã RỜI ngữ cảnh AsyncLocalStorage của
   request → userDataDir()/store.* đọc-ghi nhầm ./data (phân vùng gốc của admin). Đã dính thật: Lọc
   Bulk với file 20MB đọc Danh mục gốc → "chưa có ASIN nào" dù user có 228 ASIN Acc Shinavie.
   Bọc .single() để next() chạy lại trong đúng ngữ cảnh user. Mọi multer() trong server.js phải qua đây. */
export function keepUserCtx(m) {
  const single = m.single.bind(m);
  m.single = (field) => {
    const mw = single(field);
    return (req, res, next) => {
      const st = als.getStore();
      mw(req, res, (err) => (st ? als.run(st, () => next(err)) : next(err)));
    };
  };
  return m;
}
