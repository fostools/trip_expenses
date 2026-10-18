// Pure money math. All amounts are integer cents to avoid floating-point drift.

export interface Share {
  phone: string;
  weight: number; // 1 = normal share, 2 = double (e.g. a couple), 0 = excluded
}

export interface LedgerExpense {
  payer: string;
  amountCents: number;
  shares: Share[];
}

export interface Transfer {
  from: string;
  to: string;
  amountCents: number;
}

/**
 * Split an amount across weighted shares. Leftover cents from rounding go to
 * the largest remainders first, so the parts always sum to the exact total.
 */
export function splitAmount(amountCents: number, shares: Share[]): Map<string, number> {
  const active = shares.filter((s) => s.weight > 0);
  const result = new Map<string, number>();
  if (active.length === 0) return result;

  const totalWeight = active.reduce((sum, s) => sum + s.weight, 0);
  const raw = active.map((s) => {
    const exact = (amountCents * s.weight) / totalWeight;
    return { phone: s.phone, floor: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });

  let leftover = amountCents - raw.reduce((sum, r) => sum + r.floor, 0);
  raw
    .slice()
    .sort((a, b) => b.remainder - a.remainder || a.phone.localeCompare(b.phone))
    .forEach((r) => {
      if (leftover > 0) {
        r.floor += 1;
        leftover -= 1;
      }
    });

  for (const r of raw) result.set(r.phone, r.floor);
  return result;
}

/** Net position per person: positive = is owed money, negative = owes money. */
export function netBalances(expenses: LedgerExpense[]): Map<string, number> {
  const net = new Map<string, number>();
  const add = (phone: string, cents: number) => net.set(phone, (net.get(phone) ?? 0) + cents);

  for (const e of expenses) {
    add(e.payer, e.amountCents);
    for (const [phone, cents] of splitAmount(e.amountCents, e.shares)) add(phone, -cents);
  }
  return net;
}

/** What each person paid out and what their fair share came to. net = paid - share. */
export function personTotals(expenses: LedgerExpense[]): Map<string, { paid: number; share: number }> {
  const totals = new Map<string, { paid: number; share: number }>();
  const get = (phone: string) => {
    if (!totals.has(phone)) totals.set(phone, { paid: 0, share: 0 });
    return totals.get(phone)!;
  };
  for (const e of expenses) {
    get(e.payer).paid += e.amountCents;
    for (const [phone, cents] of splitAmount(e.amountCents, e.shares)) get(phone).share += cents;
  }
  return totals;
}

/**
 * Greedy settlement: repeatedly match the biggest debtor with the biggest
 * creditor. Produces at most n-1 transfers and is easy to explain to users.
 */
export function settleUp(net: Map<string, number>): Transfer[] {
  const creditors = [...net].filter(([, c]) => c > 0).map(([phone, c]) => ({ phone, c }));
  const debtors = [...net].filter(([, c]) => c < 0).map(([phone, c]) => ({ phone, c: -c }));
  const transfers: Transfer[] = [];

  while (creditors.length && debtors.length) {
    creditors.sort((a, b) => b.c - a.c);
    debtors.sort((a, b) => b.c - a.c);
    const cr = creditors[0];
    const db = debtors[0];
    const amount = Math.min(cr.c, db.c);
    transfers.push({ from: db.phone, to: cr.phone, amountCents: amount });
    cr.c -= amount;
    db.c -= amount;
    if (cr.c === 0) creditors.shift();
    if (db.c === 0) debtors.shift();
  }
  return transfers;
}

export function formatMoney(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}
