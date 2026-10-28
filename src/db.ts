import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, randomInt } from "node:crypto";
import { config } from "./config.js";
import type { LedgerExpense, Share } from "./ledger.js";

export interface User {
  phone: string; // id: a phone number for WhatsApp users, w_… for web users
  name: string;
  active_trip_id: number | null;
  email: string | null;
}
export interface Trip {
  id: number;
  code: string;
  name: string;
  currency: string;
  created_by: string;
  view_token: string; // secret in the trip link
  email_token: string; // secret part of the trip's email address
  receipt_pin: string; // password for opening receipts; only the creator sees it
  created_at?: string;
}
export interface Payment {
  id: number;
  trip_id: number;
  from_id: string;
  to_id: string;
  amount_cents: number;
  marked_by: string;
  created_at: string;
}
export type ExpenseStatus = "pending" | "confirmed" | "cancelled" | "deleted";
export interface Expense {
  id: number;
  trip_id: number;
  payer: string;
  amount_cents: number;
  currency: string;
  description: string;
  source: "text" | "receipt" | "email";
  status: ExpenseStatus;
  created_by: string;
  created_at: string;
  items: string | null; // JSON [{name, amount}] read from a receipt
  receipt_file: string | null; // path to the saved receipt photo
  note: string | null; // warnings from parsing, shown while reviewing
}

export function openDb(path = config.dbPath): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      phone TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      active_trip_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS trips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      currency TEXT NOT NULL,
      created_by TEXT NOT NULL,
      view_token TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS members (
      trip_id INTEGER NOT NULL REFERENCES trips(id),
      phone TEXT NOT NULL REFERENCES users(phone),
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (trip_id, phone)
    );
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER NOT NULL REFERENCES trips(id),
      payer TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL,
      description TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      items TEXT,
      receipt_file TEXT,
      note TEXT
    );
    CREATE TABLE IF NOT EXISTS shares (
      expense_id INTEGER NOT NULL REFERENCES expenses(id),
      phone TEXT NOT NULL,
      weight REAL NOT NULL,
      PRIMARY KEY (expense_id, phone)
    );
  `);
  migrate(db);
  return db;
}

/** Add columns that older databases (like the one already on Fly) don't have yet. Safe to run every start. */
function migrate(db: DatabaseSync) {
  const has = (table: string, col: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
  if (!has("trips", "email_token")) db.exec("ALTER TABLE trips ADD COLUMN email_token TEXT");
  if (!has("expenses", "note")) db.exec("ALTER TABLE expenses ADD COLUMN note TEXT");
  if (!has("users", "email")) db.exec("ALTER TABLE users ADD COLUMN email TEXT");
  if (!has("trips", "receipt_pin")) db.exec("ALTER TABLE trips ADD COLUMN receipt_pin TEXT");
  db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  // Settle-up payments the trip owner marked as paid: "from" paid "to" this much.
  db.exec(`CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id INTEGER NOT NULL REFERENCES trips(id),
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    marked_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  // Emails of people the trip owner removed, so their emails don't quietly add them back.
  db.exec("CREATE TABLE IF NOT EXISTS removed_emails (trip_id INTEGER NOT NULL, email TEXT NOT NULL, PRIMARY KEY (trip_id, email))");
  // Existing trips get a receipt password too.
  const missing = db.prepare("SELECT id FROM trips WHERE receipt_pin IS NULL").all() as { id: number }[];
  for (const t of missing) db.prepare("UPDATE trips SET receipt_pin = ? WHERE id = ?").run(newReceiptPassword(), t.id);
  // Give every trip an email token (8 lowercase hex characters).
  db.exec("UPDATE trips SET email_token = lower(hex(randomblob(4))) WHERE email_token IS NULL");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS trips_email_token ON trips(email_token)");
}

// Short, friendly words so the password is easy to say out loud or type on a phone.
const WORDS = (
  "maple river cedar canyon harbor meadow summit lagoon pebble willow aspen coral ember falcon " +
  "glacier island juniper lantern mesa orchid prairie quartz redwood sierra tundra valley breeze " +
  "comet dune fern grove hollow iris kelp lotus marble nectar oasis pine reef sage tide birch " +
  "cliff delta fjord geyser heron jasper kayak lark moss otter pelican quail raven sparrow trail"
).split(" ");

/** e.g. "cedar-lagoon-47": about 2.5 million combinations, with failed tries rate-limited. */
export function newReceiptPassword(): string {
  const w = () => WORDS[randomInt(WORDS.length)];
  let a = w(), b = w();
  while (b === a) b = w();
  return `${a}-${b}-${randomInt(10, 100)}`;
}

/** Thin repository so the handler never writes SQL. */
export class Store {
  constructor(private db: DatabaseSync) {}

  upsertUser(phone: string, name: string): User {
    this.db
      .prepare(`INSERT INTO users (phone, name) VALUES (?, ?)
                ON CONFLICT(phone) DO UPDATE SET name = excluded.name`)
      .run(phone, name);
    return this.getUser(phone)!;
  }

  getUser(phone: string): User | undefined {
    return this.db.prepare("SELECT * FROM users WHERE phone = ?").get(phone) as User | undefined;
  }

  setActiveTrip(phone: string, tripId: number) {
    this.db.prepare("UPDATE users SET active_trip_id = ? WHERE phone = ?").run(tripId, phone);
  }

  createTrip(name: string, createdBy: string, currency: string): Trip {
    const code = this.uniqueCode(name);
    const token = randomBytes(12).toString("base64url");
    const emailToken = randomBytes(4).toString("hex"); // lowercase: email addresses aren't case-safe
    const res = this.db
      .prepare("INSERT INTO trips (code, name, currency, created_by, view_token, email_token, receipt_pin) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(code, name, currency, createdBy, token, emailToken, newReceiptPassword());
    const trip = this.getTrip(Number(res.lastInsertRowid))!;
    this.addMember(trip.id, createdBy);
    return trip;
  }

  /** Pick a new receipt password (anyone who unlocked with the old one has to enter the new one). */
  resetReceiptPassword(tripId: number): string {
    const pin = newReceiptPassword();
    this.db.prepare("UPDATE trips SET receipt_pin = ? WHERE id = ?").run(pin, tripId);
    return pin;
  }

  /** A random value kept in the database, created on first use. */
  setting(key: string, make: () => string): string {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    if (row) return row.value;
    const value = make();
    this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(key, value);
    return (this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string }).value;
  }

  getTrip(id: number): Trip | undefined {
    return this.db.prepare("SELECT * FROM trips WHERE id = ?").get(id) as Trip | undefined;
  }

  getTripByCode(code: string): Trip | undefined {
    return this.db.prepare("SELECT * FROM trips WHERE code = ?").get(code.toUpperCase()) as
      | Trip
      | undefined;
  }

  getTripByEmailToken(token: string): Trip | undefined {
    return this.db.prepare("SELECT * FROM trips WHERE email_token = ?").get(token.toLowerCase()) as Trip | undefined;
  }

  /** Expenses that arrived by email and are waiting for someone to check them. */
  emailInbox(tripId: number): Expense[] {
    return this.db
      .prepare("SELECT * FROM expenses WHERE trip_id = ? AND source = 'email' AND status = 'pending' ORDER BY id DESC")
      .all(tripId) as unknown as Expense[];
  }

  tripsFor(phone: string): Trip[] {
    return this.db
      .prepare(`SELECT t.* FROM trips t JOIN members m ON m.trip_id = t.id
                WHERE m.phone = ? ORDER BY t.id DESC`)
      .all(phone) as unknown as Trip[];
  }

  addMember(tripId: number, phone: string): boolean {
    const res = this.db
      .prepare("INSERT OR IGNORE INTO members (trip_id, phone) VALUES (?, ?)")
      .run(tripId, phone);
    this.setActiveTrip(phone, tripId);
    return res.changes > 0;
  }

  /** Take someone off a trip (only used to undo an automatic add that turned out to be unneeded). */
  removeMember(tripId: number, phone: string) {
    this.db.prepare("DELETE FROM members WHERE trip_id = ? AND phone = ?").run(tripId, phone);
  }

  /** Saved expenses this person paid for or shares in. Removing them would change everyone's balances. */
  savedExpensesWith(tripId: number, phone: string): Expense[] {
    return this.db
      .prepare(`SELECT * FROM expenses e WHERE e.trip_id = ? AND e.status = 'confirmed'
                AND (e.payer = ? OR EXISTS (SELECT 1 FROM shares s WHERE s.expense_id = e.id AND s.phone = ? AND s.weight > 0))
                ORDER BY e.id`)
      .all(tripId, phone, phone) as unknown as Expense[];
  }

  /**
   * Take someone off a trip (the owner's call). Drafts they paid for are discarded, they're dropped from
   * other drafts, and their email is remembered so it can't rejoin or re-add them. Returns drafts discarded.
   */
  removePerson(tripId: number, phone: string): number {
    const user = this.getUser(phone);
    this.db.exec("BEGIN");
    try {
      const dropped = this.db
        .prepare("UPDATE expenses SET status = 'cancelled' WHERE trip_id = ? AND status = 'pending' AND payer = ?")
        .run(tripId, phone).changes;
      this.db
        .prepare(`DELETE FROM shares WHERE phone = ? AND expense_id IN
                  (SELECT id FROM expenses WHERE trip_id = ? AND status = 'pending')`)
        .run(phone, tripId);
      this.removeMember(tripId, phone);
      if (user?.email) this.db.prepare("INSERT OR IGNORE INTO removed_emails (trip_id, email) VALUES (?, ?)").run(tripId, user.email.toLowerCase());
      this.db.exec("COMMIT");
      return Number(dropped);
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  wasRemoved(tripId: number, email: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM removed_emails WHERE trip_id = ? AND email = ?").get(tripId, email.trim().toLowerCase()));
  }

  members(tripId: number): User[] {
    return this.db
      .prepare(`SELECT u.* FROM users u JOIN members m ON m.phone = u.phone
                WHERE m.trip_id = ? ORDER BY m.joined_at`)
      .all(tripId) as unknown as User[];
  }

  createExpense(e: Omit<Expense, "id" | "created_at" | "note"> & { note?: string | null }, shares: Share[]): Expense {
    const res = this.db
      .prepare(`INSERT INTO expenses (trip_id, payer, amount_cents, currency, description, source, status, created_by, items, receipt_file, note)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(e.trip_id, e.payer, e.amount_cents, e.currency, e.description, e.source, e.status, e.created_by, e.items, e.receipt_file, e.note ?? null);
    const id = Number(res.lastInsertRowid);
    const insert = this.db.prepare("INSERT INTO shares (expense_id, phone, weight) VALUES (?, ?, ?)");
    for (const s of shares) insert.run(id, s.phone, s.weight);
    return this.getExpense(id)!;
  }

  getExpense(id: number): Expense | undefined {
    return this.db.prepare("SELECT * FROM expenses WHERE id = ?").get(id) as Expense | undefined;
  }

  sharesFor(expenseId: number): Share[] {
    return this.db
      .prepare("SELECT phone, weight FROM shares WHERE expense_id = ?")
      .all(expenseId) as unknown as Share[];
  }

  /** Save edits from the review/edit form and replace who's in. */
  updateExpense(
    id: number,
    fields: { payer: string; amount_cents: number; description: string; status: ExpenseStatus },
    shares: Share[],
  ) {
    this.db
      .prepare("UPDATE expenses SET payer = ?, amount_cents = ?, description = ?, status = ?, note = NULL WHERE id = ?")
      .run(fields.payer, fields.amount_cents, fields.description, fields.status, id);
    this.db.prepare("DELETE FROM shares WHERE expense_id = ?").run(id);
    const insert = this.db.prepare("INSERT INTO shares (expense_id, phone, weight) VALUES (?, ?, ?)");
    for (const s of shares) insert.run(id, s.phone, s.weight);
  }

  /** People who join on the web (or by email) get a random id in place of a phone number. */
  createWebUser(name: string, email?: string | null): User {
    const user = this.upsertUser(`w_${randomBytes(12).toString("base64url")}`, name);
    if (email) this.setEmail(user.phone, email);
    return this.getUser(user.phone)!;
  }

  setEmail(id: string, email: string) {
    this.db.prepare("UPDATE users SET email = ? WHERE phone = ?").run(email.trim().toLowerCase(), id);
  }

  /** The trip member with this email address, if any. */
  memberByEmail(tripId: number, email: string): User | undefined {
    return this.db
      .prepare(`SELECT u.* FROM users u JOIN members m ON m.phone = u.phone
                WHERE m.trip_id = ? AND lower(u.email) = lower(?)`)
      .get(tripId, email.trim()) as User | undefined;
  }

  isMember(tripId: number, phone: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM members WHERE trip_id = ? AND phone = ?").get(tripId, phone));
  }

  setExpenseStatus(id: number, status: ExpenseStatus) {
    this.db.prepare("UPDATE expenses SET status = ? WHERE id = ?").run(status, id);
  }

  lastConfirmedBy(tripId: number, phone: string): Expense | undefined {
    return this.db
      .prepare(`SELECT * FROM expenses WHERE trip_id = ? AND created_by = ? AND status = 'confirmed'
                ORDER BY id DESC LIMIT 1`)
      .get(tripId, phone) as Expense | undefined;
  }

  /** Saved expenses and unsaved drafts (not discarded or deleted), oldest first: what an export carries. */
  exportableExpenses(tripId: number): Expense[] {
    return this.db
      .prepare("SELECT * FROM expenses WHERE trip_id = ? AND status IN ('confirmed', 'pending') ORDER BY id")
      .all(tripId) as unknown as Expense[];
  }

  confirmedExpenses(tripId: number): Expense[] {
    return this.db
      .prepare("SELECT * FROM expenses WHERE trip_id = ? AND status = 'confirmed' ORDER BY id")
      .all(tripId) as unknown as Expense[];
  }

  payments(tripId: number): Payment[] {
    return this.db.prepare("SELECT * FROM payments WHERE trip_id = ? ORDER BY id").all(tripId) as unknown as Payment[];
  }

  addPayment(tripId: number, from: string, to: string, amountCents: number, markedBy: string): Payment {
    const r = this.db
      .prepare("INSERT INTO payments (trip_id, from_id, to_id, amount_cents, marked_by) VALUES (?, ?, ?, ?, ?)")
      .run(tripId, from, to, amountCents, markedBy);
    return this.db.prepare("SELECT * FROM payments WHERE id = ?").get(Number(r.lastInsertRowid)) as unknown as Payment;
  }

  deletePayment(tripId: number, id: number): boolean {
    return Number(this.db.prepare("DELETE FROM payments WHERE trip_id = ? AND id = ?").run(tripId, id).changes) > 0;
  }

  paymentsWith(tripId: number, phone: string): number {
    return Number((this.db.prepare("SELECT count(*) AS n FROM payments WHERE trip_id = ? AND (from_id = ? OR to_id = ?)").get(tripId, phone, phone) as { n: number }).n);
  }

  /** Expenses plus recorded payments: what balances and settle-up are computed from. A payment from X to Y
   *  is an entry X paid that only Y shares, which moves X up and Y down by the amount. */
  balanceLedger(tripId: number): LedgerExpense[] {
    return [
      ...this.ledger(tripId),
      ...this.payments(tripId).map((p) => ({ payer: p.from_id, amountCents: p.amount_cents, shares: [{ phone: p.to_id, weight: 1 }] })),
    ];
  }

  ledger(tripId: number): LedgerExpense[] {
    return this.confirmedExpenses(tripId).map((e) => ({
      payer: e.payer,
      amountCents: e.amount_cents,
      shares: this.sharesFor(e.id),
    }));
  }

  private uniqueCode(name: string): string {
    const prefix = name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) || "TRIP";
    const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no 0/O/1/I confusion
    for (;;) {
      let suffix = "";
      for (let i = 0; i < 3; i++) suffix += alphabet[randomInt(alphabet.length)];
      const code = `${prefix}-${suffix}`;
      if (!this.getTripByCode(code)) return code;
    }
  }
}
