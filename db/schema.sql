-- PPC Warrior — Schema v0 (draft từ PPC-WARRIOR-KNOWLEDGE.md mục 7)
-- Mọi bảng dữ liệu gắn project_id (RLS). ID Amazon lưu TEXT (15 chữ số).

-- ===== Quản trị (role thiết kế mở — thêm role mới không sửa schema) =====
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'operator',  -- 'admin' | 'operator' | (mở rộng sau)
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  name TEXT NOT NULL,
  marketplace TEXT DEFAULT 'amazon.com',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id),
  enabled BOOLEAN DEFAULT true,
  run_time TIME,                 -- giờ chạy daily, riêng từng project
  timezone TEXT DEFAULT 'America/New_York'
);

-- ===== Sản phẩm & keyword =====
CREATE TABLE products (
  asin TEXT,
  project_id UUID REFERENCES projects(id),
  parent_asin TEXT,
  sku TEXT,
  title TEXT,
  portfolio_id TEXT,
  target_acos NUMERIC,           -- user cung cấp từ margin (rule P3/P4)
  PRIMARY KEY (project_id, asin)
);

CREATE TABLE keywords (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword_text TEXT NOT NULL,    -- normalized (lowercase, trim)
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE keyword_asin (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id),
  keyword_id UUID REFERENCES keywords(id),
  asin TEXT NOT NULL,
  tag TEXT NOT NULL DEFAULT 'manual',  -- 'PPC' | 'manual' | custom | 'removal'
                                       -- dedup ưu tiên: removal > PPC > manual
  source TEXT,                          -- 'helium10' | 'manual' | 'launching'
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (project_id, keyword_id, asin)
);

-- ===== Launching =====
CREATE TABLE naming_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id),
  name TEXT,
  pattern TEXT  -- VD: "{ASIN} - SP - {Keyword} - {MatchType} {Bid} - {SKU} - {Name} - {Note}"
);

CREATE TABLE bid_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id),
  name TEXT,
  mode TEXT,          -- 'suggest' | 'fixed' | 'intent'
  params JSONB        -- default_bid, max_bid_cap, bid_multiplier, intent_keywords[],
                      -- phrase/broad ratio+cap, ladder {step, levels}/match, pb_offset_days...
                      -- config = default, override được từng lần chạy
);

CREATE TABLE camp_defaults (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id),
  daily_budget NUMERIC,
  bidding_strategy TEXT DEFAULT 'down_only',  -- down_only | up_and_down | fixed
  placement_top NUMERIC DEFAULT 0,
  placement_product NUMERIC DEFAULT 0,
  placement_ros NUMERIC DEFAULT 0,
  adgroup_default_bid NUMERIC DEFAULT 0.25
);

CREATE TABLE campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id),
  amazon_campaign_id TEXT,       -- ID thật sau khi Amazon cấp (từ file bulk tải về)
  name TEXT NOT NULL,            -- đồng thời là external id khi Create
  type TEXT,                     -- SP_KW | SP_AUTO | SP_PT | SB | SD
  match_type TEXT,               -- exact | phrase | broad | null
  ad_type TEXT,                  -- substitutes|loose-match|close-match|complements|loose+close|3type|all
  objective TEXT DEFAULT 'PROFIT', -- RANK | PROFIT | HARVEST (từ {Note} naming template)
  bid NUMERIC, budget NUMERIC, bidding_strategy TEXT, state TEXT,
  asin TEXT, sku TEXT, portfolio_id TEXT, manager_code TEXT, note TEXT,
  start_date DATE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE exports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id),
  type TEXT,                     -- 'SP_bulk' | 'SB_bulk' | 'adjust_update'
  file_snapshot JSONB,           -- lưu để đối chiếu
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ===== Tracking / Ranking =====
CREATE TABLE rank_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id),
  keyword_asin_id UUID REFERENCES keyword_asin(id),
  checked_at TIMESTAMPTZ DEFAULT now(),
  organic_rank INT, organic_page INT,
  ranked_asin TEXT,                      -- ASIN con thực sự rank (check theo nhóm biến thể)
  indexed BOOLEAN,                       -- phân biệt "rank sâu" vs "không được index"
  result_count TEXT,                     -- "over 30,000 results" từ SERP (sản phẩm cạnh tranh)
  tos_position INT, tos_total INT,       -- ToS x/y — CHỈ khối ads đầu page 1 (0/0 = không có ToS)
                                         -- sponsored page 2/3 kể cả đầu trang = Rest of Search
  ros_present BOOLEAN, video_present BOOLEAN, sb_present BOOLEAN,
  sp_carousel_present BOOLEAN,
  variants JSONB  -- TOÀN BỘ ASIN cùng parent có rank: [{asin, organic_rank, tos, ros...}]
                  -- quy tắc: primary không rank → quét sibling; nhiều ASIN rank → lưu hết
);

CREATE TABLE serp_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rank_check_id UUID REFERENCES rank_checks(id),
  position_type TEXT,            -- ToS | RoS | organic | video | sb
  position_index INT,
  competitor_asin TEXT,
  price NUMERIC,
  is_own BOOLEAN DEFAULT false
);

CREATE TABLE worker_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id),
  type TEXT DEFAULT 'rank_check',
  status TEXT DEFAULT 'pending', -- pending | running | done | error
  payload JSONB,
  claimed_by TEXT,               -- worker id (máy operator nào)
  created_at TIMESTAMPTZ DEFAULT now(),
  finished_at TIMESTAMPTZ
);

-- ===== Adjust (ETL từ file bulk) =====
CREATE TABLE import_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id),
  kind TEXT,                     -- 'adjust_snapshot' | 'daily_tracking' | 'search_term' | 'business'
  account_id TEXT,
  window_start DATE, window_end DATE,  -- từ tên file; date = window_start
  uploaded_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (project_id, account_id, window_start, window_end, kind)
);

CREATE TABLE campaigns_daily (
  import_id UUID REFERENCES import_files(id),
  project_id UUID, date DATE,
  campaign_id TEXT, campaign_name TEXT,
  -- cột parse từ tên campaign (naming template):
  parsed_asin TEXT, parsed_type TEXT, parsed_keyword TEXT, parsed_bid NUMERIC,
  parsed_start DATE, parsed_manager TEXT, days_running INT,
  state TEXT, daily_budget NUMERIC, bidding_strategy TEXT, targeting_type TEXT,
  impressions BIGINT, clicks INT, spend NUMERIC, sales NUMERIC, orders INT, units INT,
  PRIMARY KEY (import_id, campaign_id)
);

CREATE TABLE targets_daily (
  import_id UUID REFERENCES import_files(id),
  project_id UUID, date DATE,
  campaign_id TEXT, target_id TEXT,
  entity TEXT,                   -- Keyword | Product Targeting
  keyword_text TEXT, match_type TEXT, expression TEXT,
  bid NUMERIC, state TEXT,
  impressions BIGINT, clicks INT, spend NUMERIC, sales NUMERIC, orders INT,
  PRIMARY KEY (import_id, target_id)
);

CREATE TABLE placements_daily (
  import_id UUID REFERENCES import_files(id),
  project_id UUID, date DATE,
  campaign_id TEXT, placement TEXT, percentage NUMERIC,
  impressions BIGINT, clicks INT, spend NUMERIC, sales NUMERIC, orders INT,
  PRIMARY KEY (import_id, campaign_id, placement)
);

-- ===== Rule engine =====
CREATE TABLE rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id),
  name TEXT,
  objective_scope TEXT DEFAULT 'ALL',  -- RANK | PROFIT | HARVEST | ALL
  entity_scope TEXT,                   -- campaign | keyword | targeting | placement
  condition JSONB,                     -- {metric, op, value, window_days, min_data}
  action JSONB,                        -- {field, change_type, value, guardrails}
  priority INT DEFAULT 100,
  enabled BOOLEAN DEFAULT true
);

CREATE TABLE proposed_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id),
  rule_id UUID REFERENCES rules(id),
  entity TEXT, entity_id TEXT,
  field TEXT, old_value TEXT, new_value TEXT,
  status TEXT DEFAULT 'pending',       -- pending | approved | rejected | exported
  created_at TIMESTAMPTZ DEFAULT now(),
  reviewed_by UUID REFERENCES users(id)
);

-- ===== Report =====
CREATE TABLE business_data (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id),
  date DATE, asin TEXT,
  sessions INT, units INT, sales_total NUMERIC,
  import_id UUID REFERENCES import_files(id)
);

-- ===== Audit =====
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID,
  user_id UUID,
  action TEXT, entity TEXT, entity_id TEXT,
  old_value JSONB, new_value JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes chính
CREATE INDEX idx_ka_project_tag ON keyword_asin(project_id, tag);
CREATE INDEX idx_rc_ka_time ON rank_checks(keyword_asin_id, checked_at);
CREATE INDEX idx_cd_proj_date ON campaigns_daily(project_id, date);
CREATE INDEX idx_td_proj_date ON targets_daily(project_id, date);
CREATE INDEX idx_jobs_status ON worker_jobs(status, project_id);
