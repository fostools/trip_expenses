import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import type { Expense, Store, Trip, User } from "./db.js";
import { formatMoney, netBalances, personTotals, settleUp, splitAmount } from "./ledger.js";
import { hideEmails } from "./util.js";
import { buildZip } from "./zip.js";

/**
 * Trip export, format version 1 (see docs/EXPORT.md). `trip.json` is the source of truth and is what a
 * future import reads; the CSVs and summary are for people. Ids (p1, e1…) are local to the export, money is
 * in integer cents, times are ISO 8601 UTC, and receipts are referenced by their path inside the zip.
 */
export const EXPORT_FORMAT = "tripex-trip-export";
export const EXPORT_VERSION = 1;

export interface TripExportV1 {
  format: typeof EXPORT_FORMAT;
  version: 1;
  exported_at: string;
  currency: string;
  trip: { code: string; name: string; created_at: string | null };
  people: { id: string; name: string; email: string | null; owner: boolean; on_trip: boolean }[];
  expenses: {
    id: string;
    status: "saved" | "draft";
    description: string;
    amount_cents: number;
    paid_by: string;
    added_by: string;
    added_at: string;
    source: Expense["source"];
    split: { person: string; weight: number; share_cents: number }[];
    items: { name: string; amount_cents: number }[];
    note: string | null;
    receipt: { file: string; type: string } | null;
  }[];
  balances: { person: string; paid_cents: number; share_cents: number; net_cents: number }[];
  settle_up: { from: string; to: string; amount_cents: number }[];
}

const TYPES: Record<string, string> = {
  ".pdf": "application/pdf", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".txt": "text/plain",
};

/** sqlite "2026-10-26 18:04:05" (UTC) → "2026-10-26T18:04:05Z" */
const iso = (t: string | null | undefined) => (t ? `${t.replace(" ", "T")}${t.endsWith("Z") ? "" : "Z"}` : null);

export function buildTripExport(store: Store, trip: Trip, now = new Date()): { json: TripExportV1; files: { name: string; data: Buffer }[] } {
  const members = store.members(trip.id);
  const expenses = store.exportableExpenses(trip.id);

  // People: everyone on the trip, plus anyone a kept expense still points at (e.g. removed later).
  const ids = new Map<string, string>();
  const people: TripExportV1["people"] = [];
  const addPerson = (u: User | undefined, onTrip: boolean) => {
    if (!u || ids.has(u.phone)) return;
    const id = `p${people.length + 1}`;
    ids.set(u.phone, id);
    people.push({ id, name: u.name, email: u.email ?? null, owner: u.phone === trip.created_by, on_trip: onTrip });
  };
  const owner = members.find((m) => m.phone === trip.created_by);
  addPerson(owner, true);
  members.forEach((m) => addPerson(m, true));
  const sharesOf = new Map(expenses.map((e) => [e.id, store.sharesFor(e.id)]));
  for (const e of expenses) {
    for (const uid of [e.payer, e.created_by, ...sharesOf.get(e.id)!.map((s) => s.phone)]) {
      if (!ids.has(uid)) addPerson(store.getUser(uid), false);
    }
  }
  const pid = (uid: string) => ids.get(uid) ?? "unknown";

  const files: { name: string; data: Buffer }[] = [];
  const out: TripExportV1["expenses"] = expenses.map((e, i) => {
    const id = `e${i + 1}`;
    const shares = sharesOf.get(e.id)!.filter((s) => s.weight > 0);
    const parts = splitAmount(e.amount_cents, shares);
    let receipt: { file: string; type: string } | null = null;
    if (e.receipt_file && existsSync(e.receipt_file)) {
      const ext = extname(e.receipt_file).toLowerCase() || ".jpg";
      const file = `receipts/${id}-${slug(e.description)}${ext}`;
      let data = readFileSync(e.receipt_file);
      if (ext === ".txt") data = Buffer.from(hideEmails(data.toString("utf8"))); // same as the app shows
      files.push({ name: file, data });
      receipt = { file, type: TYPES[ext] ?? "application/octet-stream" };
    }
    const items: { name: string; amount: number }[] = e.items ? safeJson(e.items) : [];
    return {
      id,
      status: e.status === "confirmed" ? "saved" : "draft",
      description: e.description,
      amount_cents: e.amount_cents,
      paid_by: pid(e.payer),
      added_by: pid(e.created_by),
      added_at: iso(e.created_at)!,
      source: e.source,
      split: shares.map((s) => ({ person: pid(s.phone), weight: s.weight, share_cents: parts.get(s.phone) ?? 0 })),
      items: items.map((it) => ({ name: String(it.name), amount_cents: Math.round(Number(it.amount) * 100) })),
      note: e.note ? hideEmails(e.note) : null,
      receipt,
    };
  });

  // Balances and settle-up come from saved expenses only, exactly as the trip page shows them.
  const ledger = store.ledger(trip.id);
  const net = netBalances(ledger);
  const totals = personTotals(ledger);
  const balances = members.map((m) => {
    const t = totals.get(m.phone) ?? { paid: 0, share: 0 };
    return { person: pid(m.phone), paid_cents: t.paid, share_cents: t.share, net_cents: net.get(m.phone) ?? 0 };
  });
  const settle = settleUp(net).map((t) => ({ from: pid(t.from), to: pid(t.to), amount_cents: t.amountCents }));

  const json: TripExportV1 = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exported_at: now.toISOString(),
    currency: trip.currency,
    trip: { code: trip.code, name: trip.name, created_at: iso(trip.created_at) },
    people,
    expenses: out,
    balances,
    settle_up: settle,
  };
  return { json, files };
}

/** The downloadable zip: trip.json, CSVs, a readable summary, and receipts/. */
export function tripExportZip(store: Store, trip: Trip, now = new Date()): Buffer {
  const { json, files } = buildTripExport(store, trip, now);
  const name = new Map(json.people.map((p) => [p.id, p.name]));
  const usd = (c: number) => (c / 100).toFixed(2);
  const who = (id: string) => name.get(id) ?? "?";

  const peopleCsv = csv(
    ["Name", "Email", "Trip owner", "On trip", "Paid (USD)", "Share (USD)", "Balance (USD)"],
    json.people.map((p) => {
      const b = json.balances.find((x) => x.person === p.id);
      return [p.name, p.email ?? "", p.owner ? "yes" : "", p.on_trip ? "yes" : "no", b ? usd(b.paid_cents) : "", b ? usd(b.share_cents) : "", b ? usd(b.net_cents) : ""];
    }),
  );
  const expensesCsv = csv(
    ["Date (UTC)", "Description", "Amount (USD)", "Paid by", "Split", "Status", "Added by", "Source", "Receipt file"],
    json.expenses.map((e) => [
      e.added_at.slice(0, 10), e.description, usd(e.amount_cents), who(e.paid_by),
      e.split.map((s) => `${who(s.person)} ${usd(s.share_cents)}`).join("; "),
      e.status, who(e.added_by), e.source, e.receipt?.file ?? "",
    ]),
  );
  const settleCsv = csv(["From", "To", "Amount (USD)"], json.settle_up.map((t) => [who(t.from), who(t.to), usd(t.amount_cents)]));

  const saved = json.expenses.filter((e) => e.status === "saved");
  const drafts = json.expenses.length - saved.length;
  const total = saved.reduce((s, e) => s + e.amount_cents, 0);
  const summary = [
    `${json.trip.name} (${json.trip.code})`,
    `Exported ${json.exported_at.slice(0, 16).replace("T", " ")} UTC from TripEx. Amounts in US dollars.`,
    "",
    `${saved.length} saved ${saved.length === 1 ? "expense" : "expenses"}, ${formatMoney(total)} total.${drafts ? ` ${drafts} unsaved ${drafts === 1 ? "draft" : "drafts"} not counted.` : ""}`,
    "",
    "Who pays whom",
    ...(json.settle_up.length ? json.settle_up.map((t) => `  ${who(t.from)} pays ${who(t.to)} ${formatMoney(t.amount_cents)}`) : ["  Everyone is even."]),
    "",
    "People",
    ...json.balances.map((b) => {
      const n = b.net_cents;
      return `  ${who(b.person)}: paid ${formatMoney(b.paid_cents)}, share ${formatMoney(b.share_cents)}, ${n > 0 ? `gets back ${formatMoney(n)}` : n < 0 ? `owes ${formatMoney(-n)}` : "even"}`;
    }),
    "",
    "Files",
    "  trip.json      everything, for re-importing later (format described in docs/EXPORT.md)",
    "  expenses.csv   one row per expense",
    "  people.csv     people, emails and balances",
    "  settle-up.csv  who pays whom",
    "  receipts/      receipt photos, PDFs and emails, named by expense",
    "",
    "This file contains people's emails and receipts. Share it carefully.",
    "",
  ].join("\n");

  return buildZip([
    { name: "trip.json", data: Buffer.from(JSON.stringify(json, null, 2) + "\n") },
    { name: "summary.txt", data: Buffer.from(summary) },
    { name: "expenses.csv", data: Buffer.from(expensesCsv) },
    { name: "people.csv", data: Buffer.from(peopleCsv) },
    { name: "settle-up.csv", data: Buffer.from(settleCsv) },
    ...files,
  ].map((f) => ({ ...f, date: now })));
}

/** UTF-8 with a byte-order mark so Excel shows names correctly; every cell quoted when needed. */
function csv(header: string[], rows: (string | number)[][]): string {
  const cell = (v: string | number) => {
    let s = String(v);
    if (/^[=+\-@]/.test(s) && !/^-?\d/.test(s)) s = `'${s}`; // don't let a description run as a spreadsheet formula
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "receipt";

function safeJson<T>(s: string): T[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
