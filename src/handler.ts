import { config } from "./config.js";
import { parseExpense, type ParsedExpense } from "./ai.js";
import type { Store, Trip, User } from "./db.js";
import { formatMoney, netBalances, settleUp, type Share } from "./ledger.js";
import { joinLink, type Inbound, type Messenger } from "./whatsapp.js";
import { saveReceipt, tripLink } from "./util.js";

const HELP = [
  "*TripEx*",
  "• `new trip <name>` start a trip and get a join link",
  "• Log spend by text: `dinner 142 skip Raj`",
  "• Or send a receipt photo (add a caption like `skip Amy`)",
  "• `balance` who's up and who's down",
  "• `settle` fewest payments to square up",
  "• `dashboard` link to the full trip page",
  "• `undo` remove your last expense",
  "• `members`, `trips`, `switch <code>`",
].join("\n");

const dashboardLink = tripLink;

const usd = (cents: number) => formatMoney(cents, config.currency);

export class Bot {
  constructor(private store: Store, private wa: Messenger) {}

  async handle(msg: Inbound): Promise<void> {
    const user = this.store.upsertUser(msg.from, msg.name);
    try {
      switch (msg.kind) {
        case "text":
          return await this.onText(user, msg.text.trim());
        case "image":
          return await this.onReceipt(user, msg.mediaId, msg.caption);
        case "button":
          return await this.onButton(user, msg.buttonId);
        case "audio":
          return await this.wa.sendText(user.phone, "I can't listen to voice notes yet. Type it, like `gas 62.50`, or send a receipt photo.");
        default:
          return await this.wa.sendText(user.phone, "I can read text and receipt photos. Send `help` for commands.");
      }
    } catch (err) {
      console.error("handler error", err);
      await this.wa.sendText(user.phone, "Sorry, something went wrong on my side. Try again in a moment.");
    }
  }

  // ---------- text commands ----------

  private async onText(user: User, text: string) {
    const lower = text.toLowerCase();

    if (/^(help|hi|hello|start|\?)$/.test(lower)) return this.wa.sendText(user.phone, HELP);

    const newTrip = text.match(/^new trip\s+(.+)$/i);
    if (newTrip) return this.createTrip(user, newTrip[1].trim());

    const join = text.match(/^join\s+([A-Z0-9]+-[A-Z0-9]+)$/i);
    if (join) return this.joinTrip(user, join[1]);

    const sw = text.match(/^switch\s+([A-Z0-9]+-[A-Z0-9]+)$/i);
    if (sw) return this.switchTrip(user, sw[1]);

    if (lower === "trips") return this.listTrips(user);

    const trip = this.activeTrip(user);
    if (!trip) {
      return this.wa.sendText(user.phone, "You're not in a trip yet. Send `new trip <name>` or tap a join link from your group.");
    }

    if (lower === "members") return this.listMembers(user, trip);
    if (lower === "balance" || lower === "balances") return this.showBalance(user, trip);
    if (lower === "settle" || lower === "settle up") return this.showSettle(user, trip);
    if (lower === "undo") return this.undo(user, trip);
    if (["dashboard", "link", "details"].includes(lower)) {
      return this.wa.sendText(user.phone, `Full details for *${trip.name}*:\n${dashboardLink(trip)}\n\nAnyone with this link can view the trip, so share it only with the group.`);
    }

    return this.proposeExpense(user, trip, { text, source: "text" });
  }

  private async createTrip(user: User, name: string) {
    const trip = this.store.createTrip(name, user.phone, config.currency);
    const link = joinLink(trip.code);
    await this.wa.sendText(user.phone, `Created *${trip.name}* (code ${trip.code}).\nTrip page: ${dashboardLink(trip)}\n\nForward the next message to your trip's WhatsApp group 👇`);
    await this.wa.sendText(
      user.phone,
      `Join *${trip.name}* on TripEx to split trip expenses. Tap to join, no app needed:\n${link}`,
    );
  }

  private async joinTrip(user: User, code: string) {
    const trip = this.store.getTripByCode(code);
    if (!trip) return this.wa.sendText(user.phone, `I couldn't find trip ${code.toUpperCase()}. Check the code?`);
    const isNew = this.store.addMember(trip.id, user.phone);
    if (!isNew) return this.wa.sendText(user.phone, `You're already in *${trip.name}*. It's now your active trip.`);
    await this.wa.sendText(user.phone, `You're in *${trip.name}* 🎉\nTrip page: ${dashboardLink(trip)}\n\n${HELP}`);
    await this.broadcast(trip, `${user.name} joined *${trip.name}*.`, user.phone);
  }

  private async switchTrip(user: User, code: string) {
    const trip = this.store.getTripByCode(code);
    if (!trip || !this.store.members(trip.id).some((m) => m.phone === user.phone)) {
      return this.wa.sendText(user.phone, `You're not a member of ${code.toUpperCase()}.`);
    }
    this.store.setActiveTrip(user.phone, trip.id);
    return this.wa.sendText(user.phone, `Switched to *${trip.name}*.`);
  }

  private async listTrips(user: User) {
    const trips = this.store.tripsFor(user.phone);
    if (!trips.length) return this.wa.sendText(user.phone, "No trips yet. Send `new trip <name>`.");
    const lines = trips.map((t) => `${t.id === user.active_trip_id ? "▶" : "•"} ${t.name} (${t.code})`);
    return this.wa.sendText(user.phone, lines.join("\n"));
  }

  private async listMembers(user: User, trip: Trip) {
    const names = this.store.members(trip.id).map((m) => `• ${m.name}`);
    return this.wa.sendText(user.phone, `*${trip.name}* members:\n${names.join("\n")}`);
  }

  // ---------- receipts ----------

  private async onReceipt(user: User, mediaId: string, caption?: string) {
    const trip = this.activeTrip(user);
    if (!trip) return this.wa.sendText(user.phone, "Join a trip first, then send the receipt.");
    await this.wa.sendText(user.phone, "Reading the receipt…");
    const image = await this.wa.downloadMedia(mediaId);
    return this.proposeExpense(user, trip, { text: caption, image, source: "receipt" });
  }

  // ---------- expenses ----------

  private async proposeExpense(
    user: User,
    trip: Trip,
    input: { text?: string; image?: { data: Buffer; mimeType: string }; source: "text" | "receipt" },
  ) {
    const members = this.store.members(trip.id);
    const parsed = await parseExpense({
      text: input.text,
      files: input.image ? [input.image] : [],
      members: members.map((m) => m.name),
      sender: user.name,
      currency: config.currency,
    });

    if (!parsed.is_expense || !(parsed.amount > 0)) {
      return this.wa.sendText(user.phone, "I didn't catch an amount. Try `dinner 142` or send `help`.");
    }

    const { payer, shares, unknown } = resolvePeople(parsed, user, members);
    if (shares.every((s) => s.weight === 0)) {
      return this.wa.sendText(user.phone, "That leaves nobody to split with. Try again?");
    }

    const expense = this.store.createExpense(
      {
        trip_id: trip.id,
        payer: payer.phone,
        amount_cents: Math.round(parsed.amount * 100),
        currency: config.currency,
        description: parsed.description || "Expense",
        source: input.source,
        status: "pending",
        created_by: user.phone,
        items: parsed.items?.length ? JSON.stringify(parsed.items) : null,
        receipt_file: input.image ? saveReceipt(trip, input.image) : null,
      },
      shares,
    );

    const warnings: string[] = [];
    if (parsed.currency && parsed.currency.toUpperCase() !== config.currency) {
      warnings.push(`⚠️ This looks like ${parsed.currency}. Trips are in USD for now, so I recorded the number as dollars. Cancel and resend the USD amount if that's wrong.`);
    }
    if (unknown.length) warnings.push(`⚠️ I don't know ${unknown.join(", ")} on this trip, so I left them out.`);
    if (parsed.note) warnings.push(`ℹ️ ${parsed.note}`);

    const summary = this.describe(expense.id, trip) + (warnings.length ? `\n\n${warnings.join("\n")}` : "");
    return this.wa.sendButtons(user.phone, summary, [
      { id: `confirm:${expense.id}`, title: "✅ Add it" },
      { id: `cancel:${expense.id}`, title: "✖️ Cancel" },
    ]);
  }

  private async onButton(user: User, buttonId: string) {
    const [action, idStr] = buttonId.split(":");
    const expense = this.store.getExpense(Number(idStr));
    if (!expense || expense.created_by !== user.phone) return;
    if (expense.status !== "pending") {
      return this.wa.sendText(user.phone, "Already handled 👍");
    }
    const trip = this.store.getTrip(expense.trip_id)!;

    if (action === "cancel") {
      this.store.setExpenseStatus(expense.id, "cancelled");
      return this.wa.sendText(user.phone, "Cancelled. Nothing was added.");
    }
    if (action === "confirm") {
      this.store.setExpenseStatus(expense.id, "confirmed");
      await this.wa.sendText(user.phone, `Added to *${trip.name}* ✅`);
      return this.broadcast(trip, `🧾 ${user.name} added:\n${this.describe(expense.id, trip)}\n\nNot right? Reply \`balance\` or tell ${user.name}.`, user.phone);
    }
  }

  private async undo(user: User, trip: Trip) {
    const last = this.store.lastConfirmedBy(trip.id, user.phone);
    if (!last) return this.wa.sendText(user.phone, "You haven't added anything to undo.");
    this.store.setExpenseStatus(last.id, "deleted");
    await this.wa.sendText(user.phone, `Removed "${last.description}" (${usd(last.amount_cents)}).`);
    return this.broadcast(trip, `↩️ ${user.name} removed "${last.description}" (${usd(last.amount_cents)}).`, user.phone);
  }

  // ---------- balances ----------

  private async showBalance(user: User, trip: Trip) {
    const net = netBalances(this.store.ledger(trip.id));
    const members = this.store.members(trip.id);
    const total = this.store.confirmedExpenses(trip.id).reduce((s, e) => s + e.amount_cents, 0);
    const lines = members.map((m) => {
      const c = net.get(m.phone) ?? 0;
      if (c > 0) return `• ${m.name}: is owed ${usd(c)}`;
      if (c < 0) return `• ${m.name}: owes ${usd(-c)}`;
      return `• ${m.name}: even`;
    });
    return this.wa.sendText(user.phone, `*${trip.name}*: ${usd(total)} spent\n${lines.join("\n")}`);
  }

  private async showSettle(user: User, trip: Trip) {
    const names = new Map(this.store.members(trip.id).map((m) => [m.phone, m.name]));
    const transfers = settleUp(netBalances(this.store.ledger(trip.id)));
    if (!transfers.length) return this.wa.sendText(user.phone, "Everyone's even. Nothing to settle 🎉");
    const lines = transfers.map((t) => `• ${names.get(t.from)} → ${names.get(t.to)}: ${usd(t.amountCents)}`);
    const text = `*Settle up ${trip.name}* (${transfers.length} payment${transfers.length > 1 ? "s" : ""})\n${lines.join("\n")}\n\nPay with Venmo, Zelle, PayPal or cash.\nEvery expense: ${dashboardLink(trip)}`;
    await this.wa.sendText(user.phone, text);
    return this.broadcast(trip, text, user.phone);
  }

  // ---------- helpers ----------

  private activeTrip(user: User): Trip | undefined {
    const fresh = this.store.getUser(user.phone);
    return fresh?.active_trip_id ? this.store.getTrip(fresh.active_trip_id) : undefined;
  }

  private describe(expenseId: number, trip: Trip): string {
    const e = this.store.getExpense(expenseId)!;
    const shares = this.store.sharesFor(e.id).filter((s) => s.weight > 0);
    const names = new Map(this.store.members(trip.id).map((m) => [m.phone, m.name]));
    const who = shares.length === names.size && shares.every((s) => s.weight === 1)
      ? `everyone (${shares.length})`
      : shares.map((s) => `${names.get(s.phone)}${s.weight !== 1 ? ` ×${s.weight}` : ""}`).join(", ");
    const each = shares.every((s) => s.weight === 1) ? ` · ${usd(Math.round(e.amount_cents / shares.length))} each` : "";
    return `*${e.description}* ${usd(e.amount_cents)}\nPaid by ${names.get(e.payer)}\nSplit: ${who}${each}`;
  }

  /** Tell everyone else on the trip. Failures (e.g. closed 24h window) are logged, not fatal. */
  private async broadcast(trip: Trip, text: string, exceptPhone: string) {
    const others = this.store.members(trip.id).filter((m) => m.phone !== exceptPhone);
    await Promise.all(
      others.map((m) => this.wa.sendText(m.phone, text).catch((err) => console.warn(`notify ${m.phone} failed:`, err.message))),
    );
  }
}

/** Turn names from the parser into member phones and weights. */
export function resolvePeople(parsed: ParsedExpense, sender: User, members: User[]) {
  const unknown: string[] = [];
  const find = (name: string): User | undefined => {
    const n = name.trim().toLowerCase();
    if (["me", "i", "myself", sender.name.toLowerCase()].includes(n)) return sender;
    return (
      members.find((m) => m.name.toLowerCase() === n) ??
      members.find((m) => m.name.toLowerCase().split(" ")[0] === n.split(" ")[0]) ??
      members.find((m) => m.name.toLowerCase().startsWith(n))
    );
  };
  const lookup = (names: string[]) =>
    names.flatMap((n) => {
      const m = find(n);
      if (!m) unknown.push(n);
      return m ? [m] : [];
    });

  const payer = (parsed.payer && find(parsed.payer)) || sender;

  let included: User[];
  if (parsed.split_mode === "only") included = lookup(parsed.people);
  else if (parsed.split_mode === "except") {
    const excluded = new Set(lookup(parsed.people).map((m) => m.phone));
    included = members.filter((m) => !excluded.has(m.phone));
  } else included = members;

  const weightFor = new Map<string, number>();
  for (const w of parsed.weights ?? []) {
    const m = find(w.name);
    if (m) weightFor.set(m.phone, w.weight);
  }
  const includedSet = new Set(included.map((m) => m.phone));
  const shares: Share[] = members.map((m) => ({
    phone: m.phone,
    weight: includedSet.has(m.phone) ? weightFor.get(m.phone) ?? 1 : 0,
  }));
  return { payer, shares, unknown };
}
