// default-rules.js — Rule Set v1 (PPC-WARRIOR-ADJUST-KNOWLEDGE.md §5), dạng object cho rule-engine.
//
// Quy ước đơn vị:
// - acos / ctr / cr trong record là TỶ LỆ (0.82 = 82%). target_acos (products) nhập theo % → engine chia 100.
// - condition.min_data: ngưỡng dữ liệu tối thiểu (clicks/orders) mới chạy rule (đủ tin cậy).
// - action.change_type: 'pct' (±% giá trị hiện tại) | 'add' (±điểm % / ±$) | 'set' (gán) .
// - entity_scope: 'target' (Keyword+Product Targeting) | 'campaign' | 'placement' | 'adgroup' | 'productad'.
//
// enabled=false cho các rule cần LỊCH SỬ DAILY (R2–R4) hoặc cần chốt thêm (H0/H1/H2, P5) — seed sẵn, bật khi đủ dữ liệu.

export const DEFAULT_RULES = [
  // ===== PROFIT (theo metrics tổng giai đoạn) =====
  {
    name: "P1 · Đốt click không đơn → giảm bid 20%",
    objective_scope: "PROFIT", entity_scope: "target", priority: 20, enabled: true,
    condition: { all: [{ metric: "orders", op: "==", value: 0 }], min_data: { clicks: 12 } },
    action: { field: "bid", change_type: "pct", value: -20, guardrails: { min_bid: 0.05, max_bid: 5, max_change_pct: 50 } },
    description: "clicks ≥ 12 & orders = 0 → bid −20%"
  },
  {
    name: "P2 · Đốt nhiều click không đơn → tắt",
    objective_scope: "PROFIT", entity_scope: "target", priority: 10, enabled: true,
    condition: { all: [{ metric: "orders", op: "==", value: 0 }], min_data: { clicks: 25 } },
    action: { field: "st", change_type: "set", value: "paused" },
    description: "clicks ≥ 25 & orders = 0 → pause"
  },
  {
    name: "P3 · ACoS cao & có đơn → giảm bid 15%",
    objective_scope: "PROFIT", entity_scope: "target", priority: 30, enabled: true,
    condition: { all: [{ metric: "acos", op: ">", value: { ref: "target_acos", mul: 1.5 } }], min_data: { orders: 2 } },
    action: { field: "bid", change_type: "pct", value: -15, guardrails: { min_bid: 0.05, max_change_pct: 50 } },
    description: "ACoS > target×1.5 & orders ≥ 2 → bid −15%"
  },
  {
    name: "P4 · ACoS thấp & có đơn → tăng bid 10%",
    objective_scope: "PROFIT", entity_scope: "target", priority: 40, enabled: true,
    condition: { all: [{ metric: "acos", op: "<", value: { ref: "target_acos", mul: 0.7 } }], min_data: { orders: 2 } },
    action: { field: "bid", change_type: "pct", value: 10, guardrails: { max_bid: 5, max_change_pct: 30 } },
    description: "ACoS < target×0.7 & orders ≥ 2 → bid +10% (trần max_bid)"
  },
  {
    name: "P5 · ToS hiệu quả hơn RoS → đẩy placement Top",
    objective_scope: "PROFIT", entity_scope: "placement", priority: 55, enabled: false,
    condition: { all: [], note: "Cần tách ACoS theo placement (ToS vs RoS) — bật sau" },
    action: { field: "pct", change_type: "add", value: 25, guardrails: { max_pct: 900 } },
    description: "ACoS ToS < ½ ACoS RoS & ToS orders ≥ 2 → placementTop +25đ%"
  },
  {
    name: "P6 · Nhiều hiển thị CTR quá thấp → tắt (sai đối tượng)",
    objective_scope: "PROFIT", entity_scope: "target", priority: 25, enabled: true,
    condition: { all: [{ metric: "impressions", op: ">", value: 1000 }, { metric: "ctr", op: "<", value: 0.0015 }] },
    action: { field: "st", change_type: "set", value: "paused" },
    description: "impressions > 1,000 & CTR < 0.15% → pause"
  },

  // ===== VỆ SINH ACCOUNT =====
  {
    name: "H0 · Enabled nhưng 0 hiển thị → tăng bid",
    objective_scope: "ALL", entity_scope: "target", priority: 60, enabled: false,
    condition: { all: [{ metric: "state", op: "==", value: "enabled" }, { metric: "impressions", op: "==", value: 0 }] },
    action: { field: "bid", change_type: "pct", value: 15, guardrails: { max_bid: 5 } },
    description: "enabled & impressions = 0 → tăng bid (⚠️ chốt thêm ngưỡng/phạm vi)"
  },
  {
    name: "H1 · 0 hiển thị kéo dài → tăng bậc / archive",
    objective_scope: "ALL", entity_scope: "target", priority: 70, enabled: false,
    condition: { all: [], note: "Cần lịch sử 14–30 ngày" },
    action: { field: "bid", change_type: "pct", value: 20, guardrails: { max_bid: 5 } },
    description: "enabled & impressions = 0 liên tục 14–30 ngày → +1 bậc hoặc archive"
  },

  // ===== RANK (join module Ranking — điểm độc quyền) =====
  {
    name: "R1 · Chưa vào ToS → đẩy placement Top",
    objective_scope: "RANK", entity_scope: "placement", priority: 50, enabled: true,
    condition: { all: [{ metric: "tosPos", op: "==", value: 0 }], placementOnly: "placementTop" },
    action: { field: "pct", change_type: "add", value: 30, guardrails: { max_pct: 900 } },
    description: "Keyword RANK chưa vào ToS (x=0) → placementTop +30đ% (trần 900%)"
  },
  {
    name: "R2 · Giữ ToS #1 ổn định → bid decay",
    objective_scope: "RANK", entity_scope: "target", priority: 80, enabled: false,
    condition: { all: [], note: "Cần lịch sử ≥ 5–7 ngày giữ ToS #1" },
    action: { field: "bid", change_type: "pct", value: -5, guardrails: { min_bid: 0.05, cooldown_days: 3 } },
    description: "Giữ ToS #1 ≥ 5–7 ngày → bid −5%/lần (tìm giá sàn)"
  },
  {
    name: "R3 · Rơi khỏi ToS sau khi giảm → khôi phục",
    objective_scope: "RANK", entity_scope: "target", priority: 15, enabled: false,
    condition: { all: [], note: "Cần lịch sử + rule-run trước đó" },
    action: { field: "bid", change_type: "set", value: null, guardrails: { cooldown_days: 7 } },
    description: "Rơi khỏi ToS sau lần giảm → khôi phục mức trước, khóa 7 ngày"
  },
  {
    name: "R4 · Spend ≥ 80% budget → cảnh báo tăng budget",
    objective_scope: "RANK", entity_scope: "campaign", priority: 90, enabled: false,
    condition: { all: [], note: "Cần metrics 1 ngày (spend vs budget/ngày)" },
    action: { field: "bud", change_type: "pct", value: 20, guardrails: {} },
    description: "Spend ≥ 80% budget trong ngày → tăng budget (đứt budget = mất slot)"
  }
];
