import { config } from "./config.js";
import { explainAiError, isReadableFile, parseExpense, type Attachment, type ParsedExpense } from "./ai.js";
import type { Expense, Store, Trip, User } from "./db.js";
import { resolvePeople } from "./handler.js";
import { hideEmails, saveReceipt } from "./util.js";

/**
 * Turn text, a receipt (photo/PDF) or an email into a *pending* expense that someone checks and saves.
 * Never throws for AI problems: the draft just carries a note explaining what to fill in by hand.
 */
export async function createDraft(
  store: Store,
  trip: Trip,
  input: {
    actor: User; // who added it (web) or the member we matched as the sender (email)
    text?: string;
    files?: Attachment[];
    kind: "message" | "upload" | "email";
    subject?: string;
    keepText?: string; // what to store as the "Open the email" copy (addresses already hidden)
    fallbackDescription?: string;
    extraNotes?: string[];
    keepIfNotExpense?: boolean; // web: always show the form; email: drop obvious non-receipts
  },
): Promise<Expense | undefined> {
  const members = store.members(trip.id);
  const files = (input.files ?? []).slice(0, 3);
  const notes: string[] = [...(input.extraNotes ?? [])];

  let parsed: ParsedExpense | undefined;
  let failed = false;
  // An email can carry the whole expense in its subject ("Firewood 36"), so read it even with an empty body.
  if (input.text?.trim() || files.length || (input.kind === "email" && input.subject?.trim())) {
    try {
      parsed = await parseExpense({
        text: input.text,
        files,
        kind: input.kind,
        subject: input.subject,
        members: members.map((m) => m.name),
        sender: input.actor.name,
        currency: config.currency,
      });
    } catch (err) {
      failed = true;
      console.warn("parse failed:", (err as { status?: number }).status ?? "", (err as Error).message);
      notes.push(explainAiError(err));
    }
  }

  if (parsed && !parsed.is_expense && !input.keepIfNotExpense && !failed) return undefined;

  // Start from the parse if we got one, otherwise a blank "everyone, paid by the actor" expense.
  const base: ParsedExpense =
    parsed && parsed.is_expense
      ? parsed
      : {
          is_expense: true, amount: 0, currency: null,
          description: input.fallbackDescription || input.text?.trim().slice(0, 60) || (files.length ? "Receipt" : ""),
          payer: null, split_mode: "everyone", people: [], weights: [], items: parsed?.items ?? [], note: "",
        };
  // People named as part of the split who aren't on the trip yet ("dinner with Sara and Anir") get added.
  let current = members;
  let { payer, shares, unknown } = resolvePeople(base, input.actor, current);
  if (base.split_mode === "only" && unknown.length) {
    const added = addNamedPeople(store, trip, unknown, current);
    if (added.length) {
      current = store.members(trip.id);
      ({ payer, shares, unknown } = resolvePeople(base, input.actor, current));
      notes.push(`Added ${listNames(added)} to the trip. They'll be asked for an email when they open the trip link.`);
    }
  }
  if (base.currency && base.currency.toUpperCase() !== config.currency) {
    notes.push(`This looks like ${base.currency}. TripEx uses US dollars for now, so enter the USD amount.`);
  }
  if (unknown.length) notes.push(`${listNames(unknown)} ${unknown.length > 1 ? "aren't" : "isn't"} on this trip, so they were left out.`);
  if (base.note) notes.push(base.note);
  if (parsed && !parsed.is_expense) notes.push("That didn't look like an expense. Fill in the details below.");

  // Keep the first readable file as the receipt; for emails without one, keep the email text.
  const keep = files.find((f) => isReadableFile(f.mimeType));
  const receipt = keep
    ? saveReceipt(trip, keep)
    : input.kind === "email" && (input.keepText ?? input.text)
      ? saveReceipt(trip, { data: Buffer.from((input.keepText ?? input.text ?? "").slice(0, 100_000)), mimeType: "text/plain" })
      : null;

  return store.createExpense(
    {
      trip_id: trip.id,
      payer: payer.phone,
      amount_cents: Math.max(0, Math.round((base.amount || 0) * 100)),
      currency: config.currency,
      description: (base.description || "Expense").slice(0, 60),
      source: input.kind === "email" ? "email" : files.length ? "receipt" : "text",
      status: "pending",
      created_by: input.actor.phone,
      items: base.items?.length ? JSON.stringify(base.items) : null,
      receipt_file: receipt,
      note: hideEmails(notes.join(" ")) || null,
    },
    shares,
  );
}

const NOT_NAMES = new Set(["everyone", "everybody", "all", "us", "them", "group", "friends", "family", "the", "and", "kids", "guys", "team", "me", "i", "myself"]);

/** Add plausible new names as trip members (without an email until they join). Returns the names added. */
function addNamedPeople(store: Store, trip: Trip, names: string[], members: User[]): string[] {
  const taken = new Set(members.map((m) => m.name.toLowerCase()));
  const added: string[] = [];
  for (const raw of names) {
    const name = raw.trim().replace(/\s+/g, " ");
    if (!/^[A-Za-z][A-Za-z .'-]{0,29}$/.test(name) || NOT_NAMES.has(name.toLowerCase())) continue;
    const pretty = name.replace(/\b[a-z]/g, (c) => c.toUpperCase());
    if (taken.has(pretty.toLowerCase())) continue;
    const user = store.createWebUser(pretty);
    store.addMember(trip.id, user.phone);
    taken.add(pretty.toLowerCase());
    added.push(pretty);
  }
  return added;
}

const listNames = (names: string[]) =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
