import express from "express";
import { config } from "./config.js";
import { openDb, Store } from "./db.js";
import { Bot } from "./handler.js";
import { inboundRouter } from "./inbound.js";
import { webRouter } from "./web.js";
import { parseWebhook, verifySignature, WhatsAppCloud } from "./whatsapp.js";

const store = new Store(openDb());
const app = express();
app.set("trust proxy", true); // Fly terminates HTTPS in front of us; needed for secure cookies

app.get("/health", (_req, res) => res.json({ ok: true }));

// WhatsApp bot channel: parked until a Meta app is set up. Turns on when WHATSAPP_TOKEN is present.
if (config.whatsapp.token) {
  const bot = new Bot(store, new WhatsAppCloud());
  const seen = new Set<string>(); // Meta retries deliveries; skip ones we've handled

  app.get("/webhook", (req, res) => {
    const ok = req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === config.whatsapp.verifyToken;
    ok ? res.status(200).send(req.query["hub.challenge"]) : res.sendStatus(403);
  });

  app.post("/webhook", express.json({ verify: (req: any, _res, buf) => (req.rawBody = buf) }), (req: any, res) => {
    if (!verifySignature(req.rawBody, req.get("x-hub-signature-256"))) return res.sendStatus(401);
    res.sendStatus(200);
    const ids: string[] = (req.body?.entry ?? []).flatMap((e: any) =>
      (e.changes ?? []).flatMap((c: any) => (c.value?.messages ?? []).map((m: any) => m.id)),
    );
    if (ids.length && ids.every((id) => seen.has(id))) return;
    ids.forEach((id) => seen.add(id));
    if (seen.size > 5000) seen.clear();
    for (const msg of parseWebhook(req.body)) bot.handle(msg).catch((err) => console.error("unhandled", err));
  });
  console.log("WhatsApp channel on");
}

// Receipts emailed to a trip's address (via Postmark). Off until INBOUND_SECRET is set.
app.use(inboundRouter(store));

// The web app: home, trips, expenses, receipts.
app.use(webRouter(store));

app.listen(config.port, () => console.log(`TripEx listening on :${config.port}${config.publicUrl ? ` (${config.publicUrl})` : ""}`));
