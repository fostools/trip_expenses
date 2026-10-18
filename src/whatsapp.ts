import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

/** What the handler needs from a messaging channel. The simulator implements this too. */
export interface Messenger {
  sendText(to: string, body: string): Promise<void>;
  sendButtons(to: string, body: string, buttons: { id: string; title: string }[]): Promise<void>;
  downloadMedia(mediaId: string): Promise<{ data: Buffer; mimeType: string }>;
}

/** Normalized inbound message, independent of the webhook's nested JSON. */
export type Inbound =
  | { kind: "text"; from: string; name: string; text: string }
  | { kind: "image"; from: string; name: string; mediaId: string; mimeType: string; caption?: string }
  | { kind: "audio"; from: string; name: string; mediaId: string; mimeType: string }
  | { kind: "button"; from: string; name: string; buttonId: string }
  | { kind: "unsupported"; from: string; name: string; type: string };

const graph = (path: string) =>
  `https://graph.facebook.com/${config.whatsapp.graphVersion}/${path}`;

export class WhatsAppCloud implements Messenger {
  private async post(body: unknown) {
    const res = await fetch(graph(`${config.whatsapp.phoneNumberId}/messages`), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.whatsapp.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...body as object }),
    });
    if (!res.ok) {
      // Most common cause: the recipient's 24h service window is closed (error 131047).
      throw new Error(`WhatsApp send failed ${res.status}: ${await res.text()}`);
    }
  }

  sendText(to: string, body: string) {
    return this.post({ to, type: "text", text: { body, preview_url: true } });
  }

  sendButtons(to: string, body: string, buttons: { id: string; title: string }[]) {
    return this.post({
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body },
        action: {
          buttons: buttons.slice(0, 3).map((b) => ({
            type: "reply",
            reply: { id: b.id, title: b.title.slice(0, 20) },
          })),
        },
      },
    });
  }

  async downloadMedia(mediaId: string) {
    const auth = { Authorization: `Bearer ${config.whatsapp.token}` };
    const meta = await fetch(graph(mediaId), { headers: auth });
    if (!meta.ok) throw new Error(`Media lookup failed ${meta.status}`);
    const { url, mime_type } = (await meta.json()) as { url: string; mime_type: string };
    const file = await fetch(url, { headers: auth });
    if (!file.ok) throw new Error(`Media download failed ${file.status}`);
    return { data: Buffer.from(await file.arrayBuffer()), mimeType: mime_type };
  }
}

/** Verify Meta's X-Hub-Signature-256 header against the raw request body. */
export function verifySignature(rawBody: Buffer, header: string | undefined): boolean {
  if (!config.whatsapp.appSecret) return true; // allow local testing without a secret
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", config.whatsapp.appSecret).update(rawBody).digest("hex");
  const given = header.slice("sha256=".length);
  return expected.length === given.length && timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

/** Flatten a webhook payload into the messages it contains (ignores delivery statuses). */
export function parseWebhook(payload: any): Inbound[] {
  const out: Inbound[] = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      const names = new Map<string, string>(
        (value.contacts ?? []).map((c: any) => [c.wa_id, c.profile?.name ?? c.wa_id]),
      );
      for (const m of value.messages ?? []) {
        const from: string = m.from;
        const name = names.get(from) ?? from;
        switch (m.type) {
          case "text":
            out.push({ kind: "text", from, name, text: m.text.body });
            break;
          case "image":
            out.push({ kind: "image", from, name, mediaId: m.image.id, mimeType: m.image.mime_type, caption: m.image.caption });
            break;
          case "audio":
            out.push({ kind: "audio", from, name, mediaId: m.audio.id, mimeType: m.audio.mime_type });
            break;
          case "interactive":
            if (m.interactive?.type === "button_reply") {
              out.push({ kind: "button", from, name, buttonId: m.interactive.button_reply.id });
            }
            break;
          default:
            out.push({ kind: "unsupported", from, name, type: m.type });
        }
      }
    }
  }
  return out;
}

/** Link that opens a chat with the bot, prefilled with the join command. */
export function joinLink(code: string): string {
  return `https://wa.me/${config.whatsapp.botNumber || "<BOT_PHONE_NUMBER>"}?text=${encodeURIComponent(`join ${code}`)}`;
}
