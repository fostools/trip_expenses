import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import type { Trip } from "./db.js";

/**
 * The private link to a trip. Anyone with it can view and join.
 * `requestBase` (e.g. https://tripex-app.fly.dev) is used when PUBLIC_URL isn't set.
 */
export const tripLink = (trip: Trip, requestBase?: string) => {
  const base = config.publicUrl || requestBase || `http://localhost:${config.port}`;
  return `${base}/t/${trip.code}?k=${trip.view_token}`;
};

/** The trip's private email address, or undefined when email isn't set up. */
export function tripEmail(trip: Trip): string | undefined {
  if (!trip.email_token) return undefined;
  if (config.inbound.domain) return `${trip.code.toLowerCase()}.${trip.email_token}@${config.inbound.domain}`;
  const at = config.inbound.address.indexOf("@");
  if (at < 1 || !trip.email_token) return undefined;
  const local = config.inbound.address.slice(0, at);
  return `${local}+${trip.code.toLowerCase()}.${trip.email_token}${config.inbound.address.slice(at)}`;
}

/** Find the trip token in a plus-address tag like "tahoe-8et.3f9a1c2b". */
export function emailTokenFromTag(tag: string): string | undefined {
  const m = tag.toLowerCase().match(/\.([0-9a-f]{8})$/);
  return m?.[1];
}

/** Keep a receipt (photo, PDF, or an email's text) on disk so it shows on the trip page. Returns the file path. */
export function saveReceipt(trip: Trip, file: { data: Buffer; mimeType: string }): string {
  const dir = join(config.receiptsDir, trip.code);
  mkdirSync(dir, { recursive: true });
  const t = file.mimeType;
  const ext = t.includes("pdf") ? "pdf" : t.includes("text/plain") ? "txt" : t.includes("png") ? "png" : t.includes("webp") ? "webp" : t.includes("gif") ? "gif" : "jpg";
  const path = join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`);
  writeFileSync(path, file.data);
  return path;
}

/** Replace any email address with a placeholder, so people's addresses never show in the app. */
export const hideEmails = (s: string) => s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/g, "[email hidden]");

/** Show j***@gmail.com in server logs instead of the full address. */
export const maskEmail = (e = "") => e.replace(/^(.)[^@]*(@.*)$/, "$1***$2");
