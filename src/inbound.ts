import express, { Router, type Request } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { isReadableFile, type Attachment } from "./ai.js";
import type { Expense, Store, Trip, User } from "./db.js";
import { createDraft } from "./drafts.js";
import { emailTokenFromTag, hideEmails, maskEmail } from "./util.js";

/** One email, whichever provider delivered it. */
export interface InboundMail {
  messageId?: string; // provider's id, for de-duplication
  headerMessageId?: string; // the email's own Message-ID, so our reply threads under it
  fromName?: string;
  fromEmail?: string;
  recipients: string[]; // every To/Cc/Bcc/original-recipient address
  subject?: string;
  text?: string;
  html?: string;
  attachments: { data: Buffer; mimeType: string; size: number; inline: boolean }[];
}

/**
 * Receipts emailed to a trip's address become drafts in the trip's "From email" list.
 *  - Resend (no domain or business email needed):  POST /inbound/resend
 *  - Postmark:                                      POST /inbound/postmark?secret=…
 */
export function inboundRouter(store: Store): Router {
  const r = Router();
  const seen = new Set<string>(); // providers retry; don't make duplicates
  const once = (id?: string) => {
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > 2000) seen.clear();
    return true;
  };

  // ---- Resend: signed webhook with metadata; body and attachments fetched by API ----
  r.post("/inbound/resend", express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
    if (!config.inbound.resendWebhookSecret || !verifySvix(req)) return res.sendStatus(401);
    res.sendStatus(200); // acknowledge now; fetching and reading the receipt takes a few seconds
    let event: ResendEvent;
    try {
      event = JSON.parse(req.body.toString("utf8"));
    } catch {
      return;
    }
    if (event.type !== "email.received" || !once(event.data?.email_id)) return;
    fetchResendEmail(event.data)
      .then((mail) => handleEmail(store, mail))
      .catch((err) => console.error("inbound email (resend) failed:", err));
  });

  // ---- Postmark: everything in one JSON post ----
  r.post("/inbound/postmark", express.json({ limit: "40mb" }), (req, res) => {
    if (!config.inbound.secret || !secretMatches(req)) return res.sendStatus(403); // 403 stops Postmark retrying
    const mail = req.body as PostmarkInbound;
    res.sendStatus(200);
    if (!once(mail.MessageID)) return;
    handleEmail(store, fromPostmark(mail)).catch((err) => console.error("inbound email (postmark) failed:", err));
  });

  return r;
}

// ---------------- shared handling ----------------

export async function handleEmail(store: Store, mail: InboundMail) {
  const trip = findTrip(store, mail.recipients);
  if (!trip) return console.warn(`inbound email for no trip (to: ${mail.recipients.join(", ")})`);

  const automated = isAutomated(mail.fromEmail);
  const who = resolveSender(store, trip, mail.fromName, mail.fromEmail, automated);
  // Only the sender's display name is ever shown in the app, never their address.
  const from = mail.fromName && !mail.fromName.includes("@") ? mail.fromName : "an automated sender";

  const files: Attachment[] = mail.attachments
    .filter((a) => isReadableFile(a.mimeType) && a.size <= 10 * 1024 * 1024)
    // Skip logos and signature images embedded in the email; keep real photos and every PDF.
    .filter((a) => a.mimeType.includes("pdf") || (!a.inline && a.size > 15_000))
    .map((a) => ({ data: a.data, mimeType: a.mimeType }));

  const text = stripReplyNoise(mail.text?.trim() || htmlToText(mail.html ?? "")).slice(0, 20_000);
  // Claude reads the full text; the copy kept on the trip page has addresses blanked out.
  const keptText = hideEmails(text);

  const notes: Record<SenderMatch, string> = {
    email: `Emailed by ${who.user.name}. Check who paid and who's in, then save.`,
    name: `Emailed by ${who.user.name}. Check who paid and who's in, then save.`,
    added: `Emailed by ${who.user.name}, who was just added to the trip. Check who paid and who's in, then save.`,
    creator: `Sent by ${from}, which isn't a person on the trip. Check who paid, then save.`,
  };

  const draft = await createDraft(store, trip, {
    actor: who.user,
    text,
    files,
    kind: "email",
    keepText: keptText,
    subject: mail.subject,
    fallbackDescription: (mail.subject ?? "Emailed receipt").replace(/^(fwd?|re):\s*/i, "").slice(0, 60),
    extraNotes: [notes[who.how]],
    keepIfNotExpense: files.length > 0, // a text-only email that isn't a receipt is dropped
  });
  console.log(draft ? `email draft #${draft.id} for ${trip.code} (sender: ${who.how})` : `email for ${trip.code} wasn't a receipt; skipped`);
  // Only keep a newly added sender if their email actually became an expense.
  if (!draft && who.how === "added") store.removeMember(trip.id, who.user.phone);

  if (!automated && mail.fromEmail) {
    await replyToSender(trip, mail, who, draft).catch((err) => console.warn("reply failed:", err.message));
  }
}

type SenderMatch = "email" | "name" | "added" | "creator";

/**
 * Who sent this? Match by email, then by name. Otherwise add them to the trip using the name
 * on their email, and save their email. Automated senders (no-reply@…) fall back to the trip creator.
 */
function resolveSender(store: Store, trip: Trip, fromName = "", fromEmail = "", automated = false): { user: User; how: SenderMatch } {
  const members = store.members(trip.id);
  const creator = members.find((m) => m.phone === trip.created_by) ?? members[0];
  const email = fromEmail.trim().toLowerCase();

  const byEmail = email ? store.memberByEmail(trip.id, email) : undefined;
  if (byEmail) return { user: byEmail, how: "email" };
  if (automated) return { user: creator, how: "creator" };

  const byName = matchSender(members.filter((m) => !m.email || m.email === email), fromName, email);
  if (byName) {
    if (email && !byName.email) store.setEmail(byName.phone, email);
    return { user: store.getUser(byName.phone)!, how: "name" };
  }
  if (!email) return { user: creator, how: "creator" };

  const user = store.createWebUser(uniqueName(members, displayName(fromName, email)), email);
  store.addMember(trip.id, user.phone);
  return { user, how: "added" };
}

/** "Amy Lee" from the email header, or "Amy" from amy.lee@gmail.com. */
function displayName(fromName: string, email: string): string {
  const clean = fromName.replace(/["']/g, "").trim();
  if (clean && !clean.includes("@")) return clean.slice(0, 30);
  const first = (email.split("@")[0] ?? "friend").split(/[._+-]/)[0].replace(/\d+/g, "") || "Friend";
  return first.charAt(0).toUpperCase() + first.slice(1, 30);
}

function uniqueName(members: User[], name: string): string {
  const taken = new Set(members.map((m) => m.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name} ${i}`.toLowerCase())) return `${name} ${i}`;
}

/** Don't add or reply to robots: no-reply addresses, bounces, or our own addresses. */
function isAutomated(fromEmail = ""): boolean {
  const e = fromEmail.toLowerCase();
  const local = e.split("@")[0] ?? "";
  const domain = e.split("@")[1] ?? "";
  return (
    !e ||
    /^(no-?reply|do-?not-?reply|donotreply|notifications?|mailer-daemon|postmaster|bounces?)\b/.test(local) ||
    (Boolean(config.inbound.domain) && domain === config.inbound.domain.toLowerCase()) ||
    (Boolean(config.reply.from) && e === (parseAddress(config.reply.from).email ?? "").toLowerCase())
  );
}

// ---------------- replies ----------------

const fmtUsd = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

async function replyToSender(trip: Trip, mail: InboundMail, who: { user: User; how: SenderMatch }, draft?: Expense) {
  if (!config.reply.from || !config.inbound.resendApiKey) return; // replies are optional
  const base = config.publicUrl;
  const tripUrl = base ? `${base}/t/${trip.code}?k=${trip.view_token}` : undefined;
  const checkUrl = base && draft ? `${base}/t/${trip.code}/e/${draft.id}?k=${trip.view_token}` : undefined;
  const hi = `Hi ${who.user.name.split(" ")[0]},`;
  const added = who.how === "added" ? `We've added you to ${trip.name} as ${who.user.name}.` : "";

  let lines: string[];
  if (draft) {
    const what = draft.amount_cents ? `"${draft.description}" for ${fmtUsd(draft.amount_cents)}` : `"${draft.description}"`;
    lines = [
      hi, "",
      `Got your receipt. We read it as ${what} and added it to ${trip.name} for a quick check.`,
      added,
      checkUrl ? `Check and save it: ${checkUrl}` : "Open the trip page to check and save it.",
      tripUrl ? `Trip page: ${tripUrl}` : "",
      "", "It doesn't count toward anyone's balance until someone saves it.", "", "TripEx",
    ];
  } else {
    lines = [
      hi, "",
      `We got your email to ${trip.name} but couldn't find a receipt in it. Forward the receipt email itself, or attach a photo or PDF of the receipt.`,
      tripUrl ? `Trip page: ${tripUrl}` : "",
      "", "TripEx",
    ];
  }
  const text = lines.filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n").trim();
  const html = text
    .split("\n")
    .map((l) => esc(l).replace(/(https?:\/\/\S+)/g, '<a href="$1">$1</a>'))
    .join("<br>");

  const subject = /^re:/i.test(mail.subject ?? "") ? mail.subject! : `Re: ${mail.subject || trip.name}`;
  const res = await fetch(`${config.inbound.resendApiBase}/emails`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.inbound.resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: config.reply.from,
      to: [mail.fromEmail],
      subject,
      text,
      html,
      ...(mail.headerMessageId ? { headers: { "In-Reply-To": mail.headerMessageId, References: mail.headerMessageId } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Resend send ${res.status}: ${(await res.text()).slice(0, 300)}`);
  console.log(`replied to ${maskEmail(mail.fromEmail)} for ${trip.code}`);
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Trip addresses end in ".<8 hex>" before the @ (or after a + for Postmark). */
function findTrip(store: Store, recipients: string[]): Trip | undefined {
  for (const addr of recipients) {
    const local = addr.replace(/^.*</, "").split("@")[0] ?? "";
    for (const tag of [local.split("+")[1], local].filter(Boolean) as string[]) {
      const token = emailTokenFromTag(tag);
      const trip = token && store.getTripByEmailToken(token);
      if (trip) return trip;
    }
  }
  return undefined;
}

/** Match "Kiran Rao <kiran@x.com>" to the trip member named Kiran. */
function matchSender(members: User[], fromName = "", fromEmail = ""): User | undefined {
  const name = fromName.trim().toLowerCase();
  const local = fromEmail.split("@")[0]?.toLowerCase() ?? "";
  const first = (s: string) => s.toLowerCase().split(/\s+/)[0];
  return (
    members.find((m) => m.name.toLowerCase() === name) ??
    members.find((m) => name && first(m.name) === first(name)) ??
    members.find((m) => local && first(m.name).length > 2 && local.startsWith(first(m.name)))
  );
}

/**
 * Drop what follows a typed note: signatures, "Sent from my iPhone", and quoted older replies.
 * Forwarded messages are kept whole, since that's where a forwarded receipt lives.
 */
export function stripReplyNoise(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^-+\s*(forwarded message|original message)\s*-+$/i.test(t) || /^begin forwarded message:?$/i.test(t)) {
      out.push(...lines.slice(lines.indexOf(line)));
      break;
    }
    if (/^on .+wrote:$/i.test(t) || t === "--" || t === "-- " || /^sent from my (iphone|ipad|android|phone)/i.test(t)) break;
    if (t.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").trim() || text.trim();
}

/** Good-enough HTML-to-text for receipt emails (Claude does the real reading). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d|table)>/gi, "\n")
    .replace(/<\/t[dh]>/gi, "  ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/** "Amy Lee <amy@x.com>" -> { name: "Amy Lee", email: "amy@x.com" } */
function parseAddress(s = ""): { name?: string; email?: string } {
  const m = s.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>/);
  return m ? { name: m[1].trim() || undefined, email: m[2].trim() } : { email: s.trim() || undefined };
}

// ---------------- Resend ----------------

interface ResendEvent {
  type: string;
  data: { email_id: string; message_id?: string; from?: string; to?: string[]; cc?: string[]; bcc?: string[]; received_for?: string[]; subject?: string };
}

const resendApi = async (path: string) => {
  const res = await fetch(`${config.inbound.resendApiBase}${path}`, { headers: { Authorization: `Bearer ${config.inbound.resendApiKey}` } });
  if (!res.ok) throw new Error(`Resend ${path} failed ${res.status}: ${await res.text()}`);
  return res.json() as Promise<any>;
};

async function fetchResendEmail(meta: ResendEvent["data"]): Promise<InboundMail> {
  const email = await resendApi(`/emails/receiving/${meta.email_id}`);
  const list = await resendApi(`/emails/receiving/${meta.email_id}/attachments`);
  const attachments: InboundMail["attachments"] = [];
  for (const a of (list?.data ?? []) as any[]) {
    if (!isReadableFile(a.content_type ?? "") || (a.size ?? 0) > 10 * 1024 * 1024) continue; // only download what we'll use
    const file = await fetch(a.download_url);
    if (!file.ok) continue;
    attachments.push({
      data: Buffer.from(await file.arrayBuffer()),
      mimeType: a.content_type,
      size: a.size ?? 0,
      inline: a.content_disposition === "inline" || Boolean(a.content_id),
    });
  }
  const from = parseAddress(email.from ?? meta.from);
  return {
    messageId: meta.email_id,
    headerMessageId: email.message_id ?? meta.message_id,
    fromName: from.name,
    fromEmail: from.email,
    recipients: [...(email.to ?? meta.to ?? []), ...(meta.received_for ?? email.received_for ?? []), ...(meta.cc ?? []), ...(meta.bcc ?? [])],
    subject: email.subject ?? meta.subject,
    text: email.text ?? undefined,
    html: email.html ?? undefined,
    attachments,
  };
}

/** Resend signs webhooks the Svix way: HMAC-SHA256 over "id.timestamp.body" with the whsec_ secret. */
function verifySvix(req: Request): boolean {
  const id = req.get("svix-id");
  const ts = req.get("svix-timestamp");
  const sigs = req.get("svix-signature");
  if (!id || !ts || !sigs || !Buffer.isBuffer(req.body)) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 5 * 60) return false; // replay guard
  const key = Buffer.from(config.inbound.resendWebhookSecret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${req.body.toString("utf8")}`).digest();
  return sigs.split(" ").some((part) => {
    const given = Buffer.from(part.split(",")[1] ?? "", "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

// ---------------- Postmark ----------------

type Addr = { Email?: string; Name?: string; MailboxHash?: string };
export interface PostmarkInbound {
  MessageID?: string;
  From?: string;
  FromName?: string;
  To?: string;
  ToFull?: Addr[];
  CcFull?: Addr[];
  BccFull?: Addr[];
  OriginalRecipient?: string;
  MailboxHash?: string;
  Subject?: string;
  TextBody?: string;
  HtmlBody?: string;
  Attachments?: { Name: string; Content: string; ContentType: string; ContentLength?: number; ContentID?: string }[];
}

function fromPostmark(m: PostmarkInbound): InboundMail {
  const addrs = [...(m.ToFull ?? []), ...(m.CcFull ?? []), ...(m.BccFull ?? [])];
  return {
    messageId: m.MessageID,
    fromName: m.FromName,
    fromEmail: m.From,
    recipients: [
      ...addrs.map((a) => a.Email ?? ""),
      // Postmark also hands over just the tag after "+"; make it look like an address so findTrip can read it.
      ...[m.MailboxHash, ...addrs.map((a) => a.MailboxHash)].filter(Boolean).map((h) => `x+${h}@postmark`),
      m.OriginalRecipient ?? "",
    ].filter(Boolean),
    subject: m.Subject,
    text: m.TextBody,
    html: m.HtmlBody,
    attachments: (m.Attachments ?? []).map((a) => ({
      data: Buffer.from(a.Content, "base64"),
      mimeType: a.ContentType,
      size: a.ContentLength ?? 0,
      inline: Boolean(a.ContentID),
    })),
  };
}

function secretMatches(req: Request): boolean {
  const given =
    (typeof req.query.secret === "string" && req.query.secret) ||
    Buffer.from((req.get("authorization") ?? "").replace(/^Basic\s+/i, ""), "base64").toString().split(":")[1] ||
    "";
  const a = Buffer.from(given);
  const b = Buffer.from(config.inbound.secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
