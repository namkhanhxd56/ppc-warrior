# PPC Warrior

Công cụ vận hành Amazon PPC: lên camp (Launching) → kho keyword + check ranking (Tracking) → phân tích & điều chỉnh ads (Adjust) → báo cáo tổng hợp (Report).

> Tài liệu yêu cầu: `../PPC-WARRIOR-KNOWLEDGE.md` và `../PPC-WARRIOR-ADJUST-KNOWLEDGE.md`

## Kiến trúc

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────────┐
│  apps/web   │ ←→  │  DB online   │ ←→  │  apps/worker        │
│  Web UI+API │     │  (Postgres/  │     │  Chạy LOCAL máy mỗi │
│  multi-user │     │   Supabase)  │     │  operator: Puppeteer│
└─────────────┘     └──────────────┘     │  + cookies riêng    │
                                         └─────────────────────┘
```

- **apps/web** — giao diện web + API. Multi-tenant: admin thấy tất cả, operator thấy project của mình.
- **apps/worker** — agent cài trên máy operator. Poll job từ DB (đúng project, đúng lịch) → scrape ranking Amazon bằng Chrome headless + cookies local → đẩy kết quả lên DB. Kế thừa cơ chế của check-ranking-amazon-v7 (cookies persistent, verify session, mode continue).
- **packages/shared** — logic dùng chung cho web + worker: parser bulk file, rule engine, naming template, bid rules.
- **db** — schema + migrations (mọi bảng có project_id, RLS).

## Cấu trúc thư mục

```
ppc-warrior/
├── apps/
│   ├── web/                  # Web app (UI + API)
│   │   └── src/
│   │       ├── modules/
│   │       │   ├── launching/   # Import H10, bid rules, rải bid, naming template, xuất bulk SP/Auto/SB
│   │       │   ├── tracking/    # Kho keyword (tag PPC/manual/removal), dedup, lịch check, kết quả ranking
│   │       │   ├── adjust/      # Upload bulk → ETL → filter/rule → preview → export Update
│   │       │   ├── report/      # Ranking + sale ads + sale thực + chỉ số, quy ước #N/A / 0 / -
│   │       │   └── admin/       # (v2) Quản trị user/project/role — bổ sung sau
│   │       ├── components/      # UI components dùng chung
│   │       └── lib/             # DB client, auth, helpers
│   └── worker/               # Local worker agent (Node + Puppeteer)
│       └── src/
│           ├── scraper/         # Điều khiển Chrome, cookies, verify session, search Amazon
│           ├── parser/          # Parse SERP: organic rank, ToS x/y, RoS, Video/SB, competitor snapshot
│           └── jobs/            # Poll queue từ DB, schedule, mode continue, đẩy kết quả
├── packages/
│   └── shared/
│       └── src/
│           ├── bulk-parser/     # Đọc/ghi bulk xlsx 54 cột, ETL 3 bảng gọn, parse tên file lấy date window
│           ├── rule-engine/     # Rule Set v1 (RANK/PROFIT/HARVEST), guardrails, dry-run
│           ├── naming-template/ # Render {ASIN} - SP - {Keyword}... theo template user
│           ├── bid-rules/       # Tạo bid (suggest/fixed/intent), rải bid ladder, quy tắc cách ngày
│           └── types/           # TypeScript types dùng chung
├── db/
│   ├── schema.sql            # Schema đầy đủ (từ file kiến thức mục 7)
│   └── migrations/
├── docs/                     # Tài liệu kỹ thuật bổ sung
└── .env.example
```

## Nguyên tắc code
1. Parser SERP (worker/src/parser) là MODULE RIÊNG, dễ sửa selector khi Amazon đổi layout
2. Mọi giá trị thiết lập (budget, placement, bid rules...) là config có default — KHÔNG hard-code
3. Rule chỉ ĐỀ XUẤT — user duyệt mới sinh file Update (dry-run bắt buộc)
4. Audit log mọi hành động ghi/sửa/xóa
5. Campaign ID lưu string; số tiền chuẩn hóa dấu chấm thập phân

## Lộ trình
- P1: db + tracking + worker (parser ranking mới)
- P2: launching (SP Keyword + SP Auto + Tạo thông số)
- P3: adjust (ETL + filter + rule engine)
- P4: report
- P5: scheduler nâng cao, cảnh báo cookie, API Amazon Ads
