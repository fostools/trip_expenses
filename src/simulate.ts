/**
 * Chat with the bot in your terminal as several people, no Meta account needed.
 *
 *   npm run simulate
 *   > @Kiran new trip Tahoe
 *   > @Amy join TAHOE-ABC
 *   > @Kiran dinner 142 skip Raj
 *   > !confirm            (taps the last "Add it" button you were sent)
 *
 * Without ANTHROPIC_API_KEY a simple offline parser is used; receipt photos need a real number.
 * The web app is served too, so you can open the trip page in a browser.
 * Pass a script file to replay a conversation: npm run simulate -- demo.txt
 */
import express from "express";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { config } from "./config.js";
import { openDb, Store } from "./db.js";
import { Bot } from "./handler.js";
import { tripLink } from "./util.js";
import { webRouter } from "./web.js";
import type { Inbound, Messenger } from "./whatsapp.js";

const people = new Map<string, string>(); // name -> fake phone
const phoneFor = (name: string) => {
  if (!people.has(name)) people.set(name, `1555000${String(people.size + 1).padStart(4, "0")}`);
  return people.get(name)!;
};
const nameFor = (phone: string) => [...people].find(([, p]) => p === phone)?.[0] ?? phone;
const lastButtons = new Map<string, string[]>(); // phone -> button ids

const messenger: Messenger = {
  async sendText(to, body) {
    console.log(`\n  → ${nameFor(to)}:\n${indent(body)}`);
  },
  async sendButtons(to, body, buttons) {
    lastButtons.set(to, buttons.map((b) => b.id));
    console.log(`\n  → ${nameFor(to)}:\n${indent(body)}\n    [${buttons.map((b) => b.title).join("] [")}]`);
  },
  async downloadMedia() {
    throw new Error("The simulator can't download media. Test receipts with a real number.");
  },
};
const indent = (s: string) => s.split("\n").map((l) => `    ${l}`).join("\n");

// Trip codes are random, so scripts can write {CODE} and we substitute the latest one.
let latestCode = "";
const realSend = messenger.sendText.bind(messenger);
messenger.sendText = async (to, body) => {
  const m = body.match(/code ([A-Z0-9]+-[A-Z0-9]+)/);
  if (m) latestCode = m[1];
  return realSend(to, body);
};

const store = new Store(openDb(":memory:"));
const bot = new Bot(store, messenger);

// Serve the dashboard from the same in-memory trip so you can open it in a browser.
express().use(webRouter(store)).listen(config.port);

async function run(line: string) {
  const m = line.match(/^@(\w+)\s+(.*)$/);
  if (!m) return console.log("Format: @Name message   (or @Name !confirm / !cancel)");
  const [, name, rawText] = m;
  const text = rawText.replace("{CODE}", latestCode);
  const from = phoneFor(name);
  console.log(`\n${name}: ${text}`);

  let msg: Inbound;
  if (text === "!confirm" || text === "!cancel") {
    const ids = lastButtons.get(from) ?? [];
    const id = ids.find((b) => b.startsWith(text.slice(1)));
    if (!id) return console.log("  (no button to press)");
    msg = { kind: "button", from, name, buttonId: id };
  } else {
    msg = { kind: "text", from, name, text };
  }
  await bot.handle(msg);
}

const script = process.argv[2];
if (script) {
  for (const line of readFileSync(script, "utf8").split("\n")) {
    if (line.trim() && !line.startsWith("#")) await run(line.trim());
  }
  const trip = latestCode ? store.getTripByCode(latestCode) : undefined;
  if (trip) console.log(`\nTrip page: ${tripLink(trip)}\n(Ctrl+C to quit)`);
} else {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log("TripEx simulator. Type `@Name message`. Ctrl+C to quit.");
  for await (const line of rl) if (line.trim()) await run(line.trim());
}
