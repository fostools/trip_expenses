import { test } from "node:test";
import assert from "node:assert/strict";
import { netBalances, settleUp, splitAmount } from "./ledger.js";

test("equal split distributes leftover cents and sums exactly", () => {
  const parts = splitAmount(1000, [
    { phone: "a", weight: 1 },
    { phone: "b", weight: 1 },
    { phone: "c", weight: 1 },
  ]);
  const values = [...parts.values()];
  assert.equal(values.reduce((s, v) => s + v, 0), 1000);
  assert.deepEqual(values.sort(), [333, 333, 334]);
});

test("weight 0 excludes someone, weight 2 doubles a share", () => {
  const parts = splitAmount(900, [
    { phone: "a", weight: 2 },
    { phone: "b", weight: 1 },
    { phone: "c", weight: 0 },
  ]);
  assert.equal(parts.get("a"), 600);
  assert.equal(parts.get("b"), 300);
  assert.equal(parts.has("c"), false);
});

test("balances net to zero and settle-up clears them", () => {
  const everyone = ["a", "b", "c", "d"].map((phone) => ({ phone, weight: 1 }));
  const net = netBalances([
    { payer: "a", amountCents: 40000, shares: everyone }, // cabin
    { payer: "b", amountCents: 12000, shares: everyone.filter((s) => s.phone !== "d") }, // dinner, d skipped
    { payer: "c", amountCents: 6250, shares: [{ phone: "c", weight: 1 }, { phone: "a", weight: 1 }] }, // gas
  ]);
  assert.equal([...net.values()].reduce((s, v) => s + v, 0), 0);

  const transfers = settleUp(net);
  assert.ok(transfers.length <= 3);
  const after = new Map(net);
  for (const t of transfers) {
    after.set(t.from, (after.get(t.from) ?? 0) + t.amountCents);
    after.set(t.to, (after.get(t.to) ?? 0) - t.amountCents);
  }
  for (const v of after.values()) assert.equal(v, 0);
});
