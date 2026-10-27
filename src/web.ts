import express, { type Request, type Response, Router } from "express";
import multer from "multer";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { createDraft } from "./drafts.js";
import { hideEmails } from "./util.js";
import type { Store, Trip, User } from "./db.js";
import type { Share } from "./ledger.js";
import type { ReceiptState } from "./views.js";
import { editPage, homePage, joinPage, lockedPage, notFoundPage, tripPage } from "./views.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  // Accept any file: unsupported types (e.g. HEIC) get a clear message on the review page instead of vanishing.
});

/** Web app: create a trip, join from a shared link, add and edit expenses. No accounts. */
export function webRouter(store: Store): Router {
  const r = Router();
  r.use(express.urlencoded({ extended: false, limit: "50kb" }));
  r.use((_req, res, next) => {
    res.set("Referrer-Policy", "no-referrer"); // keep trip keys out of other sites' logs
    res.set("X-Robots-Tag", "noindex");
    next();
  });

  // ---- helpers ----
  const authorize = (code: string, key: unknown): Trip | undefined => {
    const trip = store.getTripByCode(code);
    if (!trip || typeof key !== "string") return undefined;
    const a = Buffer.from(trip.view_token);
    const b = Buffer.from(key);
    return a.length === b.length && timingSafeEqual(a, b) ? trip : undefined;
  };
  const cookieName = (trip: Trip) => `tx_${trip.code}`;
  const readCookie = (req: Request, name: string) =>
    (req.headers.cookie ?? "")
      .split(";")
      .map((c) => c.trim().split("="))
      .find(([k]) => k === name)?.[1];
  // Cookies are signed so nobody can sign in as someone else by editing a cookie.
  const secret = store.setting("cookie_secret", () => randomBytes(32).toString("base64url"));
  const sign = (v: string) => createHmac("sha256", secret).update(v).digest("base64url").slice(0, 32);
  const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  // Sign-ins from before cookies were signed keep working for two weeks after this version first runs,
  // except for the trip's creator: an old cookie is just a member id, which is easy to copy.
  const signedSince = Number(store.setting("signed_cookies_since", () => String(Date.now())));
  const legacyOk = () => Date.now() - signedSince < 14 * 24 * 3600 * 1000;

  const currentMember = (req: Request, trip: Trip, res?: Response): User | undefined => {
    const raw = readCookie(req, cookieName(trip));
    if (!raw) return undefined;
    const value = decodeURIComponent(raw);
    const dot = value.lastIndexOf(".");
    let uid: string;
    if (dot > 0) {
      uid = value.slice(0, dot);
      if (!same(value.slice(dot + 1), sign(`m:${trip.code}:${uid}`))) return undefined;
    } else {
      if (!legacyOk() || value === trip.created_by) return undefined;
      uid = value;
    }
    const user = store.isMember(trip.id, uid) ? store.getUser(uid) : undefined;
    if (user && dot < 0 && res) remember(req, res, trip, user); // upgrade an old cookie
    return user;
  };
  const cookieOpts = (req: Request, days: number) => ({
    httpOnly: true,
    sameSite: "lax" as const,
    secure: req.secure,
    maxAge: days * 24 * 3600 * 1000,
  });
  const remember = (req: Request, res: Response, trip: Trip, user: User) =>
    res.cookie(cookieName(trip), `${user.phone}.${sign(`m:${trip.code}:${user.phone}`)}`, cookieOpts(req, 365));

  // ---- receipt password ----
  // The creator always sees receipts. Everyone else enters the trip's receipt password once per device.
  const unlockCookie = (trip: Trip) => `txr_${trip.code}`;
  const unlockValue = (trip: Trip) => sign(`r:${trip.code}:${trip.receipt_pin}`); // changes when the password does
  const isCreator = (trip: Trip, me?: User) => !!me && me.phone === trip.created_by;
  const canSeeReceipts = (req: Request, trip: Trip, me?: User) => {
    if (!me) return false;
    if (isCreator(trip, me)) return true;
    const v = readCookie(req, unlockCookie(trip));
    return !!v && same(decodeURIComponent(v), unlockValue(trip));
  };
  const normalize = (v: unknown) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60);
  const passwordMatches = (trip: Trip, typed: unknown) => {
    const a = normalize(typed);
    return a.length > 0 && same(a, normalize(trip.receipt_pin));
  };
  // Slow down guessing: 8 wrong tries per device per trip, and 30 per trip, every 15 minutes.
  const tries = new Map<string, { n: number; until: number }>();
  const limitKeys = (req: Request, trip: Trip) => [`${trip.id}:${req.ip}`, `${trip.id}:*`];
  const blocked = (req: Request, trip: Trip) =>
    limitKeys(req, trip).some((k, i) => {
      const t = tries.get(k);
      return !!t && t.until > Date.now() && t.n >= (i === 0 ? 8 : 30);
    });
  const failed = (req: Request, trip: Trip) => {
    for (const k of limitKeys(req, trip)) {
      const t = tries.get(k);
      if (!t || t.until < Date.now()) tries.set(k, { n: 1, until: Date.now() + 15 * 60 * 1000 });
      else t.n++;
    }
    if (tries.size > 10_000) tries.clear();
  };
  /** Check a typed receipt password. Returns an error message, or undefined if it's right. */
  const checkPassword = (req: Request, trip: Trip, typed: unknown): string | undefined => {
    if (blocked(req, trip)) return "Too many wrong tries. Wait 15 minutes and try again.";
    if (passwordMatches(trip, typed)) return undefined;
    failed(req, trip);
    return String(typed ?? "").trim() ? "That password isn't right." : "Enter the receipt password.";
  };

  const tripUrl = (trip: Trip) => `/t/${trip.code}?k=${encodeURIComponent(trip.view_token)}`;
  const page = (res: Response, html: string, status = 200) => res.status(status).type("html").send(html);
  const cleanEmail = (v: unknown) => {
    const e = String(v ?? "").trim().toLowerCase().slice(0, 120);
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : undefined;
  };
  // Only follow "next" links back into the same trip.
  const safeNext = (trip: Trip, v: unknown) => {
    const n = typeof v === "string" ? v : "";
    return n.startsWith(`/t/${trip.code}/`) && !n.includes("//") ? n : undefined;
  };

  // ---- start a trip ----
  r.get("/", (_req, res) => page(res, homePage()));

  r.post("/", (req, res) => {
    const list = (v: unknown) => (Array.isArray(v) ? v : v === undefined ? [] : [v]).map((x) => String(x ?? ""));
    const tripName = String(req.body.tripName ?? "").trim().slice(0, 40);
    // Row 1 is the creator. Older forms sent yourName/yourEmail; still accept those.
    const names = req.body.memberName !== undefined ? list(req.body.memberName) : [String(req.body.yourName ?? "")];
    const emails = req.body.memberEmail !== undefined ? list(req.body.memberEmail) : [String(req.body.yourEmail ?? "")];
    const people = names
      .map((n, i) => ({ name: n.trim().slice(0, 30), email: (emails[i] ?? "").trim() }))
      .filter((p, i) => i === 0 || p.name || p.email)
      .slice(0, 40);
    const form = { tripName, people };
    const again = (msg: string, status = 400) => page(res, homePage(msg, form), status);

    if (config.createPin) {
      // Slow down guessing the access code: 5 wrong tries per device and 50 overall every 15 minutes.
      const keys = [`pin:${req.ip}`, "pin:*"];
      const now = Date.now();
      const over = keys.some((k, i) => { const t = tries.get(k); return !!t && t.until > now && t.n >= (i === 0 ? 5 : 50); });
      if (over) return again("Too many wrong access codes. Wait 15 minutes and try again.", 429);
      if (!same(String(req.body.pin ?? ""), config.createPin)) {
        for (const k of keys) {
          const t = tries.get(k);
          if (!t || t.until < now) tries.set(k, { n: 1, until: now + 15 * 60 * 1000 });
          else t.n++;
        }
        return again("That access code isn't right.", 403);
      }
    }
    if (!tripName || !people[0]?.name) return again("Add a trip name and your name.");
    const missing = people.find((p) => !p.name);
    if (missing) return again(`Add a name for ${missing.email ? "the person with that email" : "each person"}, or remove the row.`);
    const noEmail = people.find((p) => !p.email);
    if (noEmail) return again(`Add an email for ${noEmail.name}. Emails are how TripEx matches receipts to people.`);
    const badEmail = people.find((p) => !cleanEmail(p.email));
    if (badEmail) return again(`${badEmail.name}'s email doesn't look right.`);
    const seenNames = new Set<string>();
    const seenEmails = new Set<string>();
    for (const p of people) {
      const n = p.name.toLowerCase();
      const e = cleanEmail(p.email);
      if (seenNames.has(n)) return again(`${p.name} is listed twice. Use a last initial to tell them apart.`);
      if (e && seenEmails.has(e)) return again(`Two people have the same email. Each person needs their own.`);
      seenNames.add(n);
      if (e) seenEmails.add(e);
    }

    const me = store.createWebUser(people[0].name, cleanEmail(people[0].email));
    const trip = store.createTrip(tripName, me.phone, config.currency);
    for (const p of people.slice(1)) {
      const u = store.createWebUser(p.name, cleanEmail(p.email));
      store.addMember(trip.id, u.phone);
    }
    remember(req, res, trip, me);
    res.redirect(303, tripUrl(trip));
  });

  // ---- trip page (or join page for newcomers) ----
  r.get("/t/:code", (req, res) => {
    const trip = authorize(req.params.code, req.query.k);
    if (!trip) return page(res, notFoundPage(), 404);
    const me = currentMember(req, trip, res);
    if (!me) return page(res, joinPage(trip, store.members(trip.id), undefined, safeNext(trip, req.query.next)));
    page(res, tripPage(store, trip, me, `${req.protocol}://${req.get("host")}`, receiptState(req, trip, me), typeof req.query.pm === "string" ? req.query.pm.slice(0, 300) : undefined));
  });

  r.post("/t/:code/join", (req, res) => {
    const trip = authorize(req.params.code, req.query.k);
    if (!trip) return page(res, notFoundPage(), 404);
    const next = safeNext(trip, req.query.next);
    const members = store.members(trip.id);
    const again = (msg?: string, claim?: User, creatorCheck = false) =>
      page(res, joinPage(trip, members, msg, next, claim, creatorCheck), msg ? 400 : 200);
    const typed = String(req.body.email ?? "").trim();
    const email = cleanEmail(typed);
    let me: User | undefined;

    if (req.body.memberId) {
      // Tapped their name: always confirm with their email. First time, it's saved; after that, it must match.
      const id = String(req.body.memberId);
      const picked = store.isMember(trip.id, id) ? store.getUser(id) : undefined;
      if (!picked) return again("Pick your name or add a new one.");
      const gate = isCreator(trip, picked); // the creator also needs the receipt password
      if (req.body.email === undefined) return again(undefined, picked, gate);
      if (blocked(req, trip)) return again("Too many wrong tries. Wait 15 minutes and try again.", picked, gate);
      if (!email) return again(typed ? "That email doesn't look right." : "Enter your email.", picked, gate);
      if (picked.email) {
        if (!same(email, picked.email.toLowerCase())) {
          failed(req, trip);
          return again(`That email doesn't match the one ${picked.name} joined with.`, picked, gate);
        }
      } else {
        const other = store.memberByEmail(trip.id, email);
        if (other && other.phone !== picked.phone) return again(`That email belongs to ${other.name} on this trip. Use your own.`, picked, gate);
      }
      if (gate) {
        const err = checkPassword(req, trip, req.body.password);
        if (err) return again(err, picked, gate);
      }
      if (!picked.email) store.setEmail(picked.phone, email);
      me = store.getUser(picked.phone);
    } else {
      const name = String(req.body.name ?? "").trim().slice(0, 30);
      if (!name || !typed) return again("Add your name and email to join.");
      if (!email) return again("That email doesn't look right.");
      if (store.wasRemoved(trip.id, email)) return again(`The trip's owner removed this email from ${trip.name}. Ask them if that was a mistake.`);
      const byEmail = store.memberByEmail(trip.id, email);
      const taken = members.find((m) => m.name.toLowerCase() === name.toLowerCase());
      // Same check as tapping the creator's name.
      if (byEmail && isCreator(trip, byEmail)) return again(undefined, byEmail, true);
      if (!byEmail && taken && !taken.email && isCreator(trip, taken)) return again(undefined, taken, true);
      if (byEmail) me = byEmail; // already on the trip with this email
      else if (taken && !taken.email) { store.setEmail(taken.phone, email); me = store.getUser(taken.phone); } // claim a name added from a receipt
      else if (taken) return again(`${name} is already on this trip. Tap your name below if that's you.`);
      else {
        me = store.createWebUser(name, email);
        store.addMember(trip.id, me.phone);
      }
    }
    if (!me) return again("Pick your name or add a new one.");
    remember(req, res, trip, me);
    res.redirect(303, next ? `${next}${next.includes("?") ? "&" : "?"}k=${encodeURIComponent(trip.view_token)}` : tripUrl(trip));
  });

  r.get("/t/:code/leave", (req, res) => {
    const trip = authorize(req.params.code, req.query.k);
    if (!trip) return page(res, notFoundPage(), 404);
    res.clearCookie(cookieName(trip));
    res.clearCookie(unlockCookie(trip));
    res.redirect(303, tripUrl(trip));
  });

  // ---- add an expense: parse text and/or receipt, then review ----
  r.post("/t/:code/expenses", upload.single("receipt"), async (req, res) => {
    const trip = authorize(req.params.code, req.query.k);
    if (!trip) return page(res, notFoundPage(), 404);
    const me = currentMember(req, trip);
    if (!me) return res.redirect(303, tripUrl(trip));

    const text = String(req.body.text ?? "").trim().slice(0, 200);
    const file = req.file ? { data: req.file.buffer, mimeType: req.file.mimetype } : undefined;
    const expense = (await createDraft(store, trip, {
      actor: me,
      text,
      files: file ? [file] : [],
      kind: file ? "upload" : "message",
      keepIfNotExpense: true,
    }))!;
    res.redirect(303, `/t/${trip.code}/e/${expense.id}?k=${encodeURIComponent(trip.view_token)}`);
  });

  // ---- review / edit ----
  const loadExpense = (req: Request) => {
    const trip = authorize(req.params.code, req.query.k);
    const me = trip && currentMember(req, trip);
    const e = trip && store.getExpense(Number(req.params.id));
    if (!trip || !me || !e || e.trip_id !== trip.id || e.status === "deleted" || e.status === "cancelled") return undefined;
    return { trip, me, e };
  };

  r.get("/t/:code/e/:id", (req, res) => {
    const trip = authorize(req.params.code, req.query.k);
    if (trip && !currentMember(req, trip)) {
      // Arrived from an email reply on a new device: pick your name, then land back here.
      return res.redirect(303, `${tripUrl(trip)}&next=${encodeURIComponent(`/t/${trip.code}/e/${req.params.id}`)}`);
    }
    const ctx = loadExpense(req);
    if (!ctx) return page(res, notFoundPage(), 404);
    page(res, editPage(store, ctx.trip, ctx.e, undefined, receiptState(req, ctx.trip, ctx.me)));
  });

  r.post("/t/:code/e/:id", (req, res) => {
    const ctx = loadExpense(req);
    if (!ctx) return page(res, notFoundPage(), 404);
    const { trip, e } = ctx;
    const action = String(req.body.action ?? "save");

    if (action === "discard" && e.status === "pending") {
      store.setExpenseStatus(e.id, "cancelled");
      return res.redirect(303, tripUrl(trip));
    }
    if (action === "delete" && e.status === "confirmed") {
      store.setExpenseStatus(e.id, "deleted");
      return res.redirect(303, tripUrl(trip));
    }

    const members = store.members(trip.id);
    const amountCents = Math.round(Number(String(req.body.amount ?? "").replace(/[$,\s]/g, "")) * 100);
    const description = String(req.body.description ?? "").trim().slice(0, 60);
    const payer = String(req.body.payer ?? "");
    const shares: Share[] = members.map((m) => {
      const inIt = req.body[`in_${m.phone}`] !== undefined;
      const w = Math.min(10, Math.max(1, Math.round(Number(req.body[`w_${m.phone}`]) || 1)));
      return { phone: m.phone, weight: inIt ? w : 0 };
    });

    const error =
      !description ? "Add what this was for." :
      !(amountCents > 0) ? "Enter an amount more than $0, like 42.50." :
      !members.some((m) => m.phone === payer) ? "Pick who paid." :
      !shares.some((s) => s.weight > 0) ? "Check at least one person who's in." : undefined;
    if (error) {
      // Re-render with what they typed so nothing is lost.
      store.updateExpense(e.id, { payer: members.some((m) => m.phone === payer) ? payer : e.payer, amount_cents: Math.max(0, amountCents || 0), description: description || e.description, status: e.status }, shares);
      return page(res, editPage(store, trip, store.getExpense(e.id)!, error, receiptState(req, trip, ctx.me)), 400);
    }

    store.updateExpense(e.id, { payer, amount_cents: amountCents, description, status: "confirmed" }, shares);
    res.redirect(303, tripUrl(trip));
  });

  // ---- receipt password: unlock on this device, or (creator) pick a new one ----
  r.post("/t/:code/unlock", (req, res) => {
    const trip = authorize(req.params.code, req.query.k);
    if (!trip) return page(res, notFoundPage(), 404);
    const me = currentMember(req, trip);
    if (!me) return res.redirect(303, tripUrl(trip));
    const back = safeNext(trip, req.body.next) ?? `/t/${trip.code}`;
    const url = (extra = "") => `${back}?k=${encodeURIComponent(trip.view_token)}${extra}`;
    const err = checkPassword(req, trip, req.body.password);
    if (err) return res.redirect(303, url(`&pw=${err.startsWith("Too many") ? "wait" : "wrong"}#unlock`));
    res.cookie(unlockCookie(trip), unlockValue(trip), cookieOpts(req, 30));
    res.redirect(303, url("#receipts"));
  });

  r.post("/t/:code/receipt-password", (req, res) => {
    const trip = authorize(req.params.code, req.query.k);
    if (!trip) return page(res, notFoundPage(), 404);
    if (!isCreator(trip, currentMember(req, trip))) return res.sendStatus(403);
    store.resetReceiptPassword(trip.id);
    res.redirect(303, `${tripUrl(trip)}&pw=changed#receipt-password`);
  });

  // ---- trip owner removes someone ----
  r.post("/t/:code/people/:id/remove", (req, res) => {
    const trip = authorize(req.params.code, req.query.k);
    if (!trip) return page(res, notFoundPage(), 404);
    if (!isCreator(trip, currentMember(req, trip))) return res.sendStatus(403);
    const id = String(req.params.id);
    const back = (msg: string) => res.redirect(303, `${tripUrl(trip)}&pm=${encodeURIComponent(msg)}#people`);
    if (id === trip.created_by) return back("You started this trip, so you can't remove yourself.");
    const person = store.isMember(trip.id, id) ? store.getUser(id) : undefined;
    if (!person) return back("That person isn't on this trip anymore.");
    const saved = store.savedExpensesWith(trip.id, id);
    if (saved.length) {
      const n = saved.length;
      return back(`${person.name} is on ${n} saved ${n === 1 ? "expense" : "expenses"}. Edit or delete ${n === 1 ? "it" : "those"} first so balances stay right, then remove them.`);
    }
    const dropped = store.removePerson(trip.id, id);
    back(`Removed ${person.name} from the trip.${dropped ? ` ${dropped} unsaved ${dropped === 1 ? "draft" : "drafts"} they paid for ${dropped === 1 ? "was" : "were"} discarded.` : ""}`);
  });

  // ---- receipt files (photos, PDFs, emails): members who know the receipt password ----
  r.get("/t/:code/r/:id", (req, res) => {
    const trip = authorize(req.params.code, req.query.k);
    const expense = trip ? store.getExpense(Number(req.params.id)) : undefined;
    if (!trip || !expense || expense.trip_id !== trip.id || !expense.receipt_file) return res.sendStatus(404);
    res.set("Cache-Control", "private, no-store"); // don't leave copies in shared caches or the back button
    const me = currentMember(req, trip);
    if (!canSeeReceipts(req, trip, me)) return page(res, lockedPage(trip, expense, !!me), 403);
    const file = resolve(expense.receipt_file);
    if (!existsSync(file)) return res.sendStatus(404);
    res.set("X-Content-Type-Options", "nosniff");
    if (file.endsWith(".txt")) {
      // Forwarded email text: plain text only, with any email addresses hidden.
      return res.type("text/plain; charset=utf-8").send(hideEmails(readFileSync(file, "utf8")));
    }
    res.set("Content-Disposition", "inline");
    res.sendFile(file);
  });

  /** What the pages need to show receipts, the unlock form, or (for the creator) the password. */
  const receiptState = (req: Request, trip: Trip, me: User): ReceiptState => ({
    unlocked: canSeeReceipts(req, trip, me),
    creator: store.getUser(trip.created_by)?.name ?? "the trip's creator",
    password: isCreator(trip, me) ? trip.receipt_pin : undefined,
    message:
      req.query.pw === "wrong" ? "That password isn't right." :
      req.query.pw === "wait" ? "Too many wrong tries. Wait 15 minutes and try again." :
      req.query.pw === "changed" ? "New password set. Anyone who unlocked receipts with the old one will need this one." :
      undefined,
  });

  return r;
}
