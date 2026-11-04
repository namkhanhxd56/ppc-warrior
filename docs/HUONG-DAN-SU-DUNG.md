# PPC Warrior — Hướng dẫn sử dụng

Tài liệu này hướng dẫn cách dùng 4 chức năng chính của tool, theo đúng menu trên header:
📋 **Danh mục Tài sản** · 🗂 **Danh mục Target** · 📦 **Bulk Create** & ⚙️ **Điều chỉnh Campaign** · 🚀 **Tạo Campaign**.

> Mẹo đọc nhanh: 4 trang này liên kết chặt với nhau theo luồng
> **Danh mục Tài sản** (ASIN/SKU/Portfolio) → **Danh mục Target** (keyword + ASIN đối thủ theo list) → **Tạo Campaign / Bulk Create** (xuất file bulk để tạo campaign mới trên Amazon) → chạy quảng cáo → **Điều chỉnh Campaign** (import số liệu thật về, sửa bid/budget/state, xuất file Update).

---

## 1. 📋 Danh mục Tài sản (`/catalog.html`)

Đây là nơi khai báo "tài sản" dùng chung cho mọi trang khác: ASIN, SKU, Portfolio, Acc (tài khoản seller).

### 1.1 Mặc định tài khoản
- Ô **Mã cá nhân (≤5 ký tự)**: mã riêng của người tạo campaign (VD `KHANH`), tự động điền vào placeholder `{NameID}` trong tên mọi campaign — đặt 1 lần, khỏi gõ lại.

### 1.2 Danh mục sản phẩm
Mỗi dòng = 1 sản phẩm (ASIN), gồm các cột:
- **Type**: `FBA` hay `FBM` — quyết định tiền tố tên campaign qua `{Type}`.
- **Acc**: tài khoản seller của ASIN này. Nếu Portfolio mặc định của dòng đã được gán Acc ở bảng Portfolio bên dưới thì ô này **tự điền và khoá** (chữ xanh); chưa gán thì gõ tay. Tạo Campaign **sẽ chặn xuất file** nếu trộn ASIN của nhiều Acc khác nhau trong cùng 1 lần xuất.
- **ASIN / SKU**: khi sang trang Tạo Campaign chọn ASIN, SKU và Portfolio mặc định sẽ tự điền theo dòng này.
- **Portfolio mặc định**: gõ hoặc dán Portfolio ID; nếu ID đã có trong Danh mục portfolio, tool tự hiện thêm `(tên portfolio)` bên cạnh.
- **List keyword**: chọn 1 list đã tạo ở 🗂 Danh mục Target. Sang Tạo Campaign bấm "⬇ Kéo từ list" sẽ đổ keyword + Target ASIN của list này vào form.

**Cách nhập nhanh:**
- Dán thẳng từ Excel: copy 3 cột `ASIN | SKU | Portfolio ID` rồi bấm vào ô ASIN và dán; nếu thêm cột `Acc` phía trước thì dán vào ô Acc; thêm cả `Type · Acc` thì dán vào ô Type.
- Bảng hoạt động như Excel: kéo mép tiêu đề đổi độ rộng cột; kéo chuột hoặc Shift+click để chọn vùng ô rồi Cmd/Ctrl+C copy, dán 1 giá trị để điền cả vùng, Delete để xoá; chuột phải để copy ô/dòng/cột; kéo ô vuông xanh ở góc để điền xuống; nút ⧉ trên tiêu đề cột để copy cả cột.
- Tick ô đầu dòng (Shift+click để chọn nhiều dòng liên tiếp) để hiện thanh chức năng: 🗑 Xoá, đổi Type (FBA/FBM), gán List keyword cho nhiều dòng cùng lúc.
- Nút **📋 Copy ASIN | SKU | Portfolio**: copy toàn bộ bảng hiện tại ra 3 cột để dán ngược vào Excel.
- Bấm **💾 Lưu danh mục** để lưu (trang này **không** tự lưu).

### 1.3 Danh mục portfolio
- Nạp **Portfolio ID**, **Tên portfolio**, **Acc** (dán được 3 cột từ Excel cùng lúc).
  - Ô Acc để trống → tool tự tra Acc từ các sản phẩm đang dùng portfolio này (chữ xanh = khớp; chữ đỏ = các sản phẩm đang ghi Acc khác nhau, cần soát lại).
  - Gõ Acc vào đây → áp luôn cho mọi sản phẩm dùng portfolio này (ưu tiên hơn Acc gõ tay ở bảng sản phẩm).
- Sau khi lưu, các ô "Portfolio" ở trang Tạo Campaign đổi từ gõ ID sang **chọn theo tên** — tránh nhầm ID.
- **Bộ budget**: đặt tên cho một bộ số budget (VD "Đầu ngày $1", "Giữa ngày"); đổi bộ đang chọn ở dropdown là cột Budget đổi theo; gõ số là tự lưu vào bộ đang chọn. Có thể tạo bộ mới (chép từ bộ hiện tại), đổi tên, xoá bộ.
- **⬇ Xuất Bulk-port**: xuất file bulk đổi budget portfolio (Operation = Update) để upload lên Amazon Ads.
  - Chọn **Budget Start Date** (và tick thêm Budget End Date nếu cần giới hạn ngày kết thúc).
  - Ô Budget để trống = **No Cap**.
  - Xuất **mỗi Acc 1 file riêng** (tên file có dạng `bulk-port-<ngày start>-<tên bộ>-<acc>.xlsx`); portfolio chưa gán Acc thì **không được xuất**.
  - Nếu có tick dòng trước khi xuất, tool chỉ xuất các dòng đã tick; không tick thì xuất tất cả.

---

## 2. 🗂 Danh mục Target (`/kwlists.html`)

Quản lý **list keyword + Target ASIN** theo từng chủ đề (niche), để tái sử dụng khi tạo campaign hàng loạt. Trang này **tự lưu sau mỗi thay đổi** (không có nút Lưu) — cứ gõ, tool sẽ debounce rồi lưu ngầm.

### 2.1 Mô hình dữ liệu
```
List (VD "Pickle ornament")
 ├─ Group 1 (VD "Root - pickle")   → bid mặc định + n ngày so với ngày launch chính
 ├─ Group 2 (VD "Gift")            → bid mặc định + n ngày
 ├─ ...
 ├─ Keyword (mỗi keyword thuộc 1 group, bid có thể sửa tay riêng)
 └─ Target ASIN (ASIN đối thủ / ASIN dùng cho Product Targeting)
```
- **Group dùng CHUNG cho mọi list**: đổi tên, bid mặc định, +n ngày, hoặc xoá 1 group ở bất kỳ list nào sẽ áp dụng cho toàn bộ list khác đang dùng group đó.
- **+n ngày** có tác dụng thật khi tạo campaign: campaign của keyword thuộc group đó sẽ bắt đầu trễ hơn Ngày tạo chính n ngày (trống = chạy theo Ngày tạo).
- Cùng 1 keyword có thể nằm ở nhiều list khác nhau.
- Phần này **độc lập** với trang 🔑 Phân tích Keyword.

### 2.2 Thao tác với List
- **➕ List mới / ✎ Đổi tên / 🗑 Xoá list** ở thanh trên cùng.
- **🕘 Lịch sử**: xem các bản đã tự lưu trước đó (tối đa 1 bản/10 phút, giữ 50 bản gần nhất) và khôi phục lại nếu sửa nhầm.
- **⬇ Xuất file**: tải **list đang mở** ra Excel (3 sheet Keywords / Groups / Target ASIN) để tự lưu trữ.
- **⬇ Xuất toàn bộ List**: tải **tất cả list** đang có trong Danh mục Target vào **1 file duy nhất** — sheet "Keywords" gồm `List | Keyword | Search Volume | Group` (mỗi dòng ghi rõ thuộc list nào). Tick ô **"kèm Target ASIN"** cạnh nút để xuất thêm sheet "Target ASIN" (`List | Target ASIN`) của mọi list; không tick thì file chỉ có sheet Keywords. Dùng để backup/soát toàn bộ dữ liệu một lần, khác với "⬇ Xuất file" chỉ xuất 1 list đang mở.
- **📤 Nạp list từ file**: nạp lại file đã xuất ở trên (của 1 list) để **tạo list mới**.
- Nếu 2 tab/máy cùng sửa 1 list, tool phát hiện xung đột và cho chọn: **⟳ Tải bản mới nhất** hoặc **Ghi đè bằng bản ở đây** (bản bị ghi đè vẫn được giữ trong Lịch sử, không mất hẳn).

### 2.3 Group + Nạp keyword
- Thêm group mới: gõ tên (VD "Root - pickle", "Phân loại - gift") rồi **➕ Thêm group**; mỗi group có ô Bid mặc định và +n ngày riêng.
- **Nạp file keyword**: hỗ trợ H10 (Cerebro/Magnet), Amazon SQP (Search Query Performance), hoặc CSV/Excel có cột keyword (+ search volume) — tool tự nhận dạng định dạng. Chọn group đích rồi bấm **Nạp file**. Keyword đã có trong list chỉ cập nhật lại volume, giữ nguyên group/bid đang gán.
- **📋 Dán keyword**: dán trực tiếp danh sách `keyword | search volume` (hoặc chỉ keyword) vào ô textarea, mỗi dòng 1 keyword.

### 2.4 Target ASIN
- **📋 Dán ASIN**: dán danh sách ASIN hoặc cả link Amazon lẫn bảng Excel — tool tự lọc ra mã `B0…`.
- **Copy** toàn bộ ASIN, **⬇ Tải ASIN** ra file, hoặc **Xoá hết**.

### 2.5 Bảng Keyword
- Tìm theo tên keyword, lọc theo Group.
- Sửa Group/Bid từng keyword trực tiếp trong bảng, hoặc tick nhiều dòng rồi dùng khu **"Keyword đã tick"**:
  - **Gán group** (gõ tên group chưa có → tự tạo group mới rồi gán luôn),
  - **Bỏ group** (đưa về "chưa phân group"),
  - **Theo bid group** (bỏ bid sửa tay, quay lại dùng bid mặc định của group),
  - **Xoá**.
- **⬇ Tải keyword**: có tick → tải các keyword đã tick; không tick → tải theo bộ lọc đang hiển thị.
- Bảng hỗ trợ thao tác kiểu Excel: kéo chọn vùng, copy/dán, Delete, kéo ô vuông góc để điền xuống, phím tắt Shift+↑/↓ để chọn nhiều dòng, Space để tick/bỏ tick.

### 2.6 🔗 Share — chia sẻ list ra ngoài tool
- Bấm **🔗 Share** ở thanh trên cùng (cạnh "📤 Nạp list từ file") rồi **➕ Tạo link chia sẻ**: tool sinh ra 1 link dạng `/kwlist/ten-list`, xem được **keyword (kèm Search Volume, Group) + Target ASIN** của đúng list đang mở — **không cần đăng nhập**, gửi được cho người ngoài tool (VA, freelancer viết content...). Link **không** lộ Bid hay cấu hình chiến lược.
- Trang chia sẻ có nút **📋 Copy keyword** và **📋 Copy ASIN** để người nhận link dán thẳng sang nơi khác.
- Slug được **gắn cố định vào list** khi tạo lần đầu — đổi tên list sau đó **không** làm hỏng link đã gửi.
- Bấm **🔒 Dừng chia sẻ** để tắt: link cũ sẽ báo "không tìm thấy", tạo lại ra link khác.
- Mỗi list chỉ có 1 link chia sẻ tại một thời điểm; chưa bấm Tạo link thì list không công khai ở đâu cả.

### 2.7 Liên kết sang các trang khác
- Gán 1 list cho ASIN ở cột **List keyword** của 📋 Danh mục Tài sản.
- Sang 🚀 Tạo Campaign / 📦 Bulk Create, bấm **"⬇ Kéo từ list"** → tool tự đổ `keyword | bid | +n` vào ô Keywords và Target ASIN vào ô Target ASINs (phải chọn ít nhất 1 group muốn lấy, không tick sẵn để tránh lấy nhầm cả list).

---

## 3. 📦 Bulk Create và ⚙️ Điều chỉnh Campaign

### 3.1 Bulk Create (`/bulk.html`)

Bulk Create thực chất là **trang Tạo Campaign chạy ở chế độ nhiều ASIN cùng lúc** — mọi cấu hình bid/loại campaign/tên campaign ở mục 3 và 4 (xem chi tiết ở phần 4 bên dưới) **giống hệt** trang Tạo Campaign. Khác biệt duy nhất là bước chọn sản phẩm:

- Thay vì chọn 1 ASIN, Bulk Create cho **tick chọn nhiều ASIN** cùng lúc từ Danh mục Tài sản (tìm theo Acc/ASIN/SKU/tên list; có thể lọc "chỉ hiện ASIN đã có list" để tránh chọn nhầm ASIN chưa gán Target).
- Chọn 1 **Ngày tạo** chung và nhóm Group keyword muốn lấy — tool sẽ chạy cấu hình campaign (mục 3) cho **từng ASIN một**, rồi gộp kết quả lại thành 1 danh sách campaign preview chung.
- Mục **💲 Lowest Cost** (chỉ có ở Bulk Create): với mỗi ASIN đã chọn, tạo **1 campaign SP keyword duy nhất** gom **tất cả keyword** (theo ASIN · group đã chọn) vào 1 ad group, dùng chung 1 mức bid. Tên campaign theo mẫu SP Keyword ở mục 4 với `{Keyword}` = "Lowest Cost". Xuất file thẳng ngay (không cộng vào danh sách ở mục 5), mỗi Acc 1 file riêng.
- Sau khi preview, vẫn dùng chung nút **📦 Xuất bulk XLSX** ở mục 5 như trang Tạo Campaign để xuất toàn bộ các campaign vừa tạo cho nhiều ASIN.

➡️ Dùng Bulk Create khi cần launch **nhiều ASIN cùng một cấu hình bid/chiến lược** (VD: cùng một đợt launch cho cả chục ASIN trong 1 niche).

### 3.2 Điều chỉnh Campaign (`/adjust.html`)

Dùng để **đọc số liệu thật** từ Amazon Ads và sửa bid/budget/state hàng loạt, xuất file Update để upload ngược lại.

**Bước 1 — Import file bulk (ảnh chụp tài khoản)**
- Tải file bulk từ Amazon Ads (nên chọn giai đoạn 14–60 ngày, tick kèm Search Term Report khi tải). File lớn (~30-40MB) xử lý mất khoảng 10-30 giây.
- Mỗi lần import tạo ra 1 **dataset** riêng, chọn qua dropdown "Dataset"; có thể đặt tên dataset (✎ Đặt tên) để dễ phân biệt các lần import.
- Số liệu 1 ngày quá nhiễu để quyết định bid/budget — luôn dùng file tổng cả giai đoạn.

**Bước 2 — Làm việc trên bảng, có 4 tab:**

1. **🎯 Campaigns & Targets** — bảng tất cả Campaign/Ad Group/Keyword/Product Targeting/Product Ad/Placement, kèm chỉ số Impression/Click/Spend/Sales/Orders/ACoS/ROAS/CTR/CR/CPC.
   - Lọc theo Entity (gộp nhiều loại), theo từ khoá tìm kiếm, hoặc thêm filter tuỳ chỉnh (nút "＋ Thêm filter").
   - Sửa trực tiếp từng dòng: Bid, Budget, Placement %, State (enabled/paused), tên Campaign/Ad Group — mỗi sửa được tô màu "đã sửa" và ghi vào tab 📋 Thay đổi.
   - **Bulk edit** (tick nhiều dòng): chọn trường (Bid/Budget/Placement %/State) + cách áp (Đặt =, Tăng +$, Giảm −$, Tăng +%, Giảm −%) + giá trị, rồi **Áp dụng**. Có nút **↩ Undo** để hoàn tác lần bulk gần nhất.
2. **🔍 Search Terms → Negative / Tạo Campaign** — xem các search term thực tế đã lên đơn/tốn tiền.
   - Tick term rồi bấm **🚫 Negative Exact** / **🚫 Negative Phrase** để thêm negative keyword ở **ad group nguồn** (chỉ chặn đúng ad group sinh ra term đó).
   - Hoặc bấm **🚀 Tạo Campaign** để mở popup: mỗi search term đã tick sẽ thành **1 campaign Exact mới** cho đúng ASIN đó, bid mặc định = CPC thực tế (sửa được), đặt tên theo đúng mẫu đã lưu ở trang Tạo Campaign, chọn Portfolio + Note + Chế độ campaign (1 campaign/1 ad group hay 1 campaign/nhiều ad group). Có thể tick thêm "Đồng thời negative term này vào ad group nguồn". Bấm xong chỉ **xếp vào 📋 Thay đổi**, chưa xuất file ngay — gom nhiều lần rồi xuất 1 lượt.
3. **📋 Thay đổi** — nơi tổng hợp **tất cả** thay đổi đang chờ, chia 3 khối:
   - 🚀 Campaign mới từ search term (sửa Bid/Note ngay tại đây trước khi xuất),
   - ✍️ Sửa bid/budget/state/tên,
   - 🚫 Negative keyword.
   - Mỗi dòng có nút hoàn tác riêng; có nút **🗑 Xoá toàn bộ danh sách** nếu muốn làm lại từ đầu.
   - Bấm **📦 Xuất file bulk (tất cả thay đổi)** để xuất **1 file Excel duy nhất**: dòng Update (sửa + negative) và dòng Create (campaign mới), đúng theo định dạng Amazon Ads Bulk Operations đọc theo cột Operation. Nếu có giá trị vượt ngưỡng an toàn (⚠️), tool sẽ hỏi lại trước khi xuất. Sau khi tải file, có thể chọn xoá danh sách đang chờ hoặc giữ lại.
4. **⚙️ Rules / Đề xuất (dry-run)** — chạy gợi ý tự động, **không tự sửa gì**, chỉ đề xuất để người dùng duyệt:
   - **🎯 Target ACoS theo ASIN**: nhập % ACoS mục tiêu cho từng ASIN (cần cho các rule dựa theo biên lợi nhuận) — ASIN chưa có target sẽ bị các rule liên quan bỏ qua.
   - **⚙️ Rule Set v1**: danh sách rule (tick bật/tắt từng rule, xoá rule, có nút reset về mặc định), mỗi rule hiện rõ phạm vi áp dụng (ALL/khác), loại entity, mô tả và mức ưu tiên.
   - **▶ Chạy rule trên dataset đang chọn**: chạy thử (dry-run) để xem danh sách đề xuất, duyệt rồi mới đưa vào 📋 Thay đổi để xuất file.

**Nhật ký chỉnh sửa**: mọi lần bấm xuất file Update đều được ghi log (thời điểm, dataset, nguồn tự sửa/rule, số thay đổi + negative). Có thể lọc chỉ xem nhật ký của dataset đang chọn, và bấm vào 1 dòng để xem chi tiết old → new.

---

## 4. 🚀 Tạo Campaign (`/launching.html`)

Trang tạo campaign mới cho **1 ASIN**, theo 5 bước:

### Bước 1️⃣ — Thông tin sản phẩm
- Chọn **ASIN** từ Danh mục Tài sản (SKU và Portfolio chung tự điền theo); có thể tìm theo Acc/ASIN/SKU.
- **Ngày tạo (Exact)**: ngày launch chính — mọi offset `+n ngày` của group/loại campaign tính từ ngày này.
- (Tuỳ chọn, chỉ cần cho SB Video) **Brand Entity ID** và **Video Media ID**.

### Bước 2️⃣ — Keyword & Target ASIN
- Ô **Keywords**: mỗi dòng 1 keyword, có thể ghi kèm bid và offset ngày theo cú pháp:
  `keyword` · `keyword | bid` · `keyword | bid | +n` (n = campaign bắt đầu sau Ngày tạo n ngày).
- Có thể gõ tay hoặc bấm **"⬇ Kéo từ list"** (chọn Group muốn lấy) để tự đổ keyword từ 🗂 Danh mục Target vào — kèm tick **🎯 Target ASIN** nếu muốn lấy luôn Target ASIN của list đó.
- Ô **Target ASINs**: mỗi dòng 1 ASIN (đối thủ để tấn công, hoặc ASIN chính mình để defend). Có công cụ lấy keyword đối thủ qua H10 (nhập ASIN của mình, khoảng số keyword muốn lấy, tuỳ chọn lấy cả competitor đã tắt theo dõi 🙈 trong Library).

### Bước 3️⃣ — Chiến lược bid & loại campaign
Tick chọn các loại campaign muốn tạo (mỗi loại có khung riêng, tick mới mở khung sáng):
- **Exact / Phrase / Broad** (SP Keyword): số mức bid, bước nhảy giữa các mức, Phrase/Broad tính bid theo % so với Exact hoặc theo giá trị cố định, giới hạn số từ tối đa, chạy sau Exact bao nhiêu ngày.
- **Product Targeting (1 ASIN)** và **Product Targeting (ASINs — nhóm)**: bid Exact/Expanded riêng (asin="..." so với asin-expanded="..."), số mức, bước nhảy; bản nhóm còn có tên nhóm `{Group}` để đặt tên campaign.
- **Auto campaign**: chọn các ad type cần tạo (close-match/loose-match/substitutes/complements/loose+close/3 type/all — 4 nhóm targeting luôn được tạo đủ, nhóm không chọn sẽ để paused, bật lại sau không cần tạo mới), các mức bid cách nhau bằng dấu phẩy.
- **SB Video Keyword** và **SB Video Product Target (ASINs)**: cần Brand Entity ID + Video Media ID ở bước 1.
- **SD Remarketing** (bid riêng theo mốc 7/14/30/60 ngày), **SD Product Target (1 ASIN)**, **SD Product Target (ASINs — nhóm)** (có tuỳ chọn dùng asin-expanded).
- Mỗi loại đều có ô **Portfolio riêng** (trống = dùng Portfolio chung) và **Note/chiến lược** (VD: RANK, HARVEST, ATTACK, DEFEND, VIDEO, RETARGET — đi vào tên campaign qua `{Note}`).
- **⚙️ Cài đặt campaign** (chung): Daily Budget riêng cho KW/PT và cho Auto, Bidding Strategy, % Placement (Top/Product Page/Amazon Business/Rest of Search), Ad Group Default Bid.
- **🔀 Chế độ campaign** (áp dụng cho SP Keyword Exact/Phrase/Broad, và được dùng lại ở nút "🚀 Tạo Campaign" trong Điều chỉnh Campaign):
  - **single**: mỗi keyword × mỗi mức bid = 1 campaign riêng (kiểu truyền thống).
  - **multi**: TẤT CẢ keyword vào **1 campaign**, mỗi keyword là 1 ad group riêng với bid riêng — bỏ qua thang bid (số mức/bước nhảy).

### Bước 4️⃣ — Tên campaign
Mỗi loại campaign có 1 mẫu tên riêng, dùng placeholder: `{ASIN} {SKU} {Keyword} {MatchType} {Bid} {StartDate} {NameID} {TargetAsin} {Group} {AdType} {Category} {Note}` — placeholder nào không có dữ liệu sẽ tự bỏ. Có thể sửa mẫu tuỳ ý, xem trước kết quả ở dòng gợi ý ngay dưới.

### Bước 5️⃣ — Create Campaign
- **➕ Tạo campaign**: build preview danh sách campaign theo cấu hình ở bước 1-4 — có thể bấm nhiều lần với ASIN/keyword khác nhau, kết quả sẽ **cộng dồn** vào danh sách (không mất kết quả cũ, chỉ mất khi reload trang hoặc bấm 🗑 Xoá toàn bộ).
- Sửa được từng cột trực tiếp trong bảng preview (Start/End date, keyword, bid, ASIN, SKU Product Ad...); tick nhiều dòng để Bulk edit; nút − để bỏ chạy 1 dòng (↩ để khôi phục).
- Tick **"Lưu keyword vào kho (tag PPC)"** nếu muốn giữ lại keyword đã dùng để tái sử dụng sau.
- **💾 Lưu cấu hình**: ghi nhớ mẫu đặt tên, cấu hình bid, portfolio và note cho lần sau (khỏi phải cấu hình lại từ đầu).
- **📦 Xuất bulk XLSX**: xuất file bulk cuối cùng để upload lên Amazon Ads (Bulk Operations), **chặn xuất** nếu các ASIN trong danh sách thuộc nhiều Acc khác nhau.

---

## Luồng làm việc gợi ý (end-to-end)

1. Khai báo ASIN/SKU/Portfolio/Acc ở **📋 Danh mục Tài sản**.
2. Chuẩn bị keyword + Target ASIN theo list ở **🗂 Danh mục Target**, rồi gán list cho từng ASIN ở Danh mục Tài sản.
3. Launch campaign mới:
   - 1 ASIN → **🚀 Tạo Campaign**.
   - Nhiều ASIN cùng cấu hình → **📦 Bulk Create**.
   - Xuất file bulk, upload lên Amazon Ads.
4. Sau khi campaign chạy được một thời gian (khuyên 14–60 ngày), tải file bulk báo cáo từ Amazon Ads (kèm Search Term Report) và import vào **⚙️ Điều chỉnh Campaign** để sửa bid/budget/state, chặn search term xấu bằng negative, launch thêm campaign từ search term tốt, hoặc chạy Rule đề xuất — rồi xuất file Update ngược lại Amazon Ads. Lặp lại định kỳ.
