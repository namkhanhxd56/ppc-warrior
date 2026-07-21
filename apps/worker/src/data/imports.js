// imports.js — Module DATA: pipeline import chỉ số theo ngày (ads / business / inventory).
//
// - Ads: nhấc nguyên ETL từ /api/import-bulk (aggregate Campaign rows per ASIN).
// - Business Report / Inventory: qua flex-import (ánh xạ cột linh hoạt, UI xác nhận).
// Ngày (date) = start_date trong tên file bulk, hoặc user nhập (report không có cột ngày).

import * as XLSX from "xlsx";
import * as store from "../db/file-store.js";
import { readTable, mapRows, previewColumns, num } from "./flex-import.js";

const round2 = (n) => Math.round(n * 100) / 100;

/* ===== Field specs cho từng loại report ===== */
export const BUSINESS_FIELDS = [
  { key: "asin", label: "ASIN", type: "asin", aliases: ["(Child) ASIN", "Child ASIN", "ASIN", "(Parent) ASIN", "Parent ASIN"] },
  { key: "sessions", label: "Sessions", type: "int", aliases: ["Sessions - Total", "Sessions – Total", "Sessions", "Sessions - Total - B2B"] },
  { key: "units", label: "Units Ordered", type: "int", aliases: ["Units Ordered", "Total Order Items", "Units Ordered - B2B"] },
  { key: "salesTotal", label: "Ordered Product Sales", type: "num", aliases: ["Ordered Product Sales", "Ordered Product Sales - B2B", "Sales"] }
];

export const INVENTORY_FIELDS = [
  { key: "asin", label: "ASIN", type: "asin", aliases: ["asin", "ASIN"] },
  { key: "unitsAvailable", label: "Available", type: "int", aliases: ["Available", "Afn Fulfillable Quantity", "afn-fulfillable-quantity", "Sellable On Hand Units", "Available Quantity", "Quantity Available"] },
  { key: "inbound", label: "Inbound", type: "int", aliases: ["Inbound", "Afn Inbound Working Quantity", "afn-inbound-working-quantity", "afn-inbound-shipped-quantity", "Inbound Quantity"] },
  { key: "reserved", label: "Reserved", type: "int", aliases: ["Reserved", "Afn Reserved Quantity", "afn-reserved-quantity", "Reserved Quantity"] },
  { key: "daysOfSupply", label: "Days of Supply", type: "num", aliases: ["Days of Supply", "days-of-supply", "Days of supply (based on Available + Inbound)", "Days of Supply (based on Available and Inbound Quantity)"] }
];

export const FIELD_SPECS = { business: BUSINESS_FIELDS, inventory: INVENTORY_FIELDS };

/** Ngày từ tên file bulk-{acc}-{start}-{end}-{ts} (date = start), hoặc user nhập. */
export function dateFromFilename(filename) {
  const fm = String(filename || "").match(/-(\d{8})-(\d{8})-/) || String(filename || "").match(/(\d{4})[-_]?(\d{2})[-_]?(\d{2})/);
  if (!fm) return null;
  if (fm.length === 3) return `${fm[1].slice(0, 4)}-${fm[1].slice(4, 6)}-${fm[1].slice(6, 8)}`;
  return `${fm[1]}-${fm[2]}-${fm[3]}`;
}

/* ===== ADS (file bulk daily → chỉ số ads theo ASIN) ===== */
export function importAdsBulk(buffer, filename, dateInput) {
  let date = String(dateInput || "").trim();
  if (!date) date = dateFromFilename(filename);
  if (!date) throw new Error("Không xác định được ngày — nhập tay");

  const wb = XLSX.read(buffer, { type: "buffer" });
  const ws = wb.Sheets["Sponsored Products Campaigns"];
  if (!ws) throw new Error("Thiếu sheet Sponsored Products Campaigns");
  const rows = XLSX.utils.sheet_to_json(ws);

  const agg = {};
  for (const r of rows) {
    if (r["Entity"] !== "Campaign") continue;
    const name = r["Campaign Name (Informational only)"] || r["Campaign Name"] || "";
    const am = String(name).match(/B0[A-Z0-9]{8}/i);
    if (!am) continue;
    const a = am[0].toUpperCase();
    agg[a] = agg[a] || { spent: 0, salesAds: 0, ordersAds: 0, impressions: 0, clicks: 0 };
    agg[a].spent += Number(r["Spend"]) || 0;
    agg[a].salesAds += Number(r["Sales"]) || 0;
    agg[a].ordersAds += Number(r["Orders"]) || 0;
    agg[a].impressions += Number(r["Impressions"]) || 0;
    agg[a].clicks += Number(r["Clicks"]) || 0;
  }
  for (const [a, m] of Object.entries(agg)) {
    store.saveAdsMetrics(a, date, {
      impressions: m.impressions, clicks: m.clicks,
      spent: round2(m.spent), salesAds: round2(m.salesAds), ordersAds: m.ordersAds
    });
  }
  const asinCount = Object.keys(agg).length;
  store.recordImport({ kind: "ads", filename, date, asinCount });
  return { date, asinCount };
}

/* ===== BUSINESS REPORT (sale thực tế / sessions / units theo ASIN) ===== */
export function importBusiness(buffer, filename, dateInput, mappingOverride = {}) {
  const date = String(dateInput || "").trim() || dateFromFilename(filename);
  if (!date) throw new Error("Không xác định được ngày — nhập tay");
  const { header, dataRows } = readTable(buffer);
  const { records, mapping } = mapRows(header, dataRows, BUSINESS_FIELDS, mappingOverride);
  if (mapping.asin < 0) throw new Error("Không tìm thấy cột ASIN — chọn cột thủ công");

  let applied = 0;
  for (const rec of records) {
    if (!rec.asin) continue;
    store.saveBusinessData(rec.asin, date, {
      sessions: rec.sessions, units: rec.units, salesTotal: rec.salesTotal
    });
    applied++;
  }
  store.recordImport({ kind: "business", filename, date, asinCount: applied });
  return { date, asinCount: applied, mapping };
}

/* ===== INVENTORY (tồn kho theo ASIN) ===== */
export function importInventory(buffer, filename, dateInput, mappingOverride = {}) {
  const date = String(dateInput || "").trim() || dateFromFilename(filename);
  if (!date) throw new Error("Không xác định được ngày — nhập tay");
  const { header, dataRows } = readTable(buffer);
  const { records, mapping } = mapRows(header, dataRows, INVENTORY_FIELDS, mappingOverride);
  if (mapping.asin < 0) throw new Error("Không tìm thấy cột ASIN — chọn cột thủ công");

  let applied = 0;
  for (const rec of records) {
    if (!rec.asin) continue;
    store.saveInventory(rec.asin, date, {
      unitsAvailable: rec.unitsAvailable, inbound: rec.inbound,
      reserved: rec.reserved, daysOfSupply: rec.daysOfSupply, source: filename
    });
    applied++;
  }
  store.recordImport({ kind: "inventory", filename, date, asinCount: applied });
  return { date, asinCount: applied, mapping };
}

/** Preview ánh xạ cột cho business/inventory (UI xác nhận). */
export function preview(kind, buffer) {
  const specs = FIELD_SPECS[kind];
  if (!specs) throw new Error("Loại không hỗ trợ preview: " + kind);
  return previewColumns(buffer, specs);
}
