import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";

/** What Claude extracts from a message or receipt photo. Names are as written by the user. */
export interface ParsedExpense {
  is_expense: boolean;
  amount: number; // major units, e.g. 62.5
  currency: string | null;
  description: string;
  payer: string | null; // "me", a member name, or null (= sender)
  split_mode: "everyone" | "only" | "except";
  people: string[]; // for "only"/"except"; may include "me"
  weights: { name: string; weight: number }[];
  items: { name: string; amount: number }[];
  note: string; // anything the bot should flag back (e.g. "total was blurry")
}

// Strict schema: every field required, no extra keys, no nulls (empty string = "not stated").
// Sonnet/Opus 5.5 don't allow forcing a tool, so we use tool_choice "auto" + strict, as Anthropic recommends.
const TOOL = {
  name: "record_expense",
  description: "Record one shared trip expense extracted from the user's message or receipt photo. Always call this exactly once.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      is_expense: { type: "boolean", description: "False if the message is not describing a purchase." },
      amount: { type: "number", description: "Total paid, in major currency units. For receipts use the final total including tax and tip." },
      currency: { type: "string", description: "ISO 4217 code if stated or visible on the receipt, else empty string." },
      description: { type: "string", description: "Short label, e.g. 'Dinner at Rosie's' or 'Gas'. Max 40 chars. For receipts, use the merchant name." },
      payer: { type: "string", description: "Who paid: 'me' for the sender, a member name, or empty string if not stated (the sender paid)." },
      split_mode: {
        type: "string",
        enum: ["everyone", "only", "except"],
        description: "'everyone' = all trip members; 'only' = just the listed people; 'except' = everyone but the listed people.",
      },
      people: { type: "array", items: { type: "string" }, description: "Names for 'only'/'except'. Use 'me' for the sender. Empty for 'everyone'." },
      weights: {
        type: "array",
        description: "Only when someone should pay a multiple share, e.g. 'Sam and Lee count double' -> weight 2. Usually empty.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: { name: { type: "string" }, weight: { type: "number" } },
          required: ["name", "weight"],
        },
      },
      items: {
        type: "array",
        description: "Line items read from a receipt (include tax and tip as their own lines). Empty for text messages.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: { name: { type: "string" }, amount: { type: "number" } },
          required: ["name", "amount"],
        },
      },
      note: { type: "string", description: "Short warning for the user if anything is uncertain; empty string otherwise." },
    },
    required: ["is_expense", "amount", "currency", "description", "payer", "split_mode", "people", "weights", "items", "note"],
  },
} as unknown as Anthropic.Tool;

function systemPrompt(members: string[], sender: string, currency: string) {
  return [
    "You extract shared expenses for TripEx, a group trip expense tracker.",
    `Trip members: ${members.join(", ")}. The sender is ${sender}.`,
    `The trip currency is ${currency}. Written-out amounts like "sixty two fifty" mean 62.50.`,
    "Map nicknames or obvious misspellings to the closest member name, but if a name clearly isn't a trip member, keep it exactly as written (TripEx adds new people to the trip). Never force a stranger's name onto a member.",
    'When the sender says they did something "with" people (e.g. "dinner with Sara and Anir"), use split_mode "only" with people = ["me", "Sara", "Anir"].',
    "Default to split_mode 'everyone' unless the message narrows it.",
    "Always call record_expense exactly once.",
  ].join("\n");
}

const anthropic = config.ai.anthropicKey ? new Anthropic({ apiKey: config.ai.anthropicKey }) : null;

export type Attachment = { data: Buffer; mimeType: string };

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
/** Claude reads these directly: photos and PDFs. */
export const isReadableFile = (mimeType: string) => {
  const t = mimeType.split(";")[0].toLowerCase();
  return IMAGE_TYPES.includes(t) || t === "application/pdf";
};

export class UnsupportedFileError extends Error {}

export async function parseExpense(input: {
  text?: string;
  files?: Attachment[]; // receipt photos and PDFs
  kind?: "message" | "upload" | "email";
  subject?: string; // email subject, for kind "email"
  members: string[];
  sender: string;
  currency: string;
}): Promise<ParsedExpense> {
  const files = input.files ?? [];
  const kind = input.kind ?? (files.length ? "upload" : "message");
  const bad = files.find((f) => !isReadableFile(f.mimeType));
  if (bad) throw new UnsupportedFileError(`${bad.mimeType.split(";")[0] || "That file type"} isn't supported`);
  if (!anthropic) {
    // Without Claude, only short typed notes can be read (e.g. an email that just says "Dinner 199").
    const typed = kind === "email" ? `${(input.subject ?? "").replace(/^(fwd?|re):\s*/i, "")} ${input.text ?? ""}`.trim() : input.text ?? "";
    if (files.length || (kind === "email" && typed.length > 300)) throw new Error("Receipt reading needs ANTHROPIC_API_KEY");
    return fallbackParse(typed, input.members);
  }

  const content: Anthropic.ContentBlockParam[] = [];
  for (const f of files) {
    const t = f.mimeType.split(";")[0].toLowerCase();
    if (t === "application/pdf") {
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: f.data.toString("base64") } });
    } else if (IMAGE_TYPES.includes(t)) {
      content.push({ type: "image", source: { type: "base64", media_type: t as "image/jpeg", data: f.data.toString("base64") } });
    } else {
      throw new UnsupportedFileError(`${t || "That file type"} isn't supported`);
    }
  }

  const text = (input.text ?? "").trim();
  let prompt: string;
  if (kind === "email") {
    prompt = [
      `An email sent to the trip by ${input.sender}. It is either a receipt (forwarded, or attached as a photo/PDF)`,
      `or a short note describing an expense, e.g. "Dinner at Bell Tower for 199 dollars" or "Gas 62.50, skip Raj".`,
      "For a receipt, use its final total including tax and tip; a forwarded merchant email sits inside the body.",
      "For a typed note, treat it like a message from the sender: they paid unless they name someone else, and apply any split instructions.",
      "The expense may be stated only in the subject. Ignore email signatures, disclaimers and quoted older replies.",
      `Subject: ${input.subject || "(none)"}`,
      files.length ? "The attachments above came with the email." : "",
      "Email body:",
      text.slice(0, 20000) || "(empty)",
    ].filter(Boolean).join("\n");
  } else if (files.length) {
    prompt = `Receipt from ${input.sender} (photo or PDF above). Note from them: ${text || "(none)"}`;
  } else {
    prompt = `Message from ${input.sender}: ${text}`;
  }
  content.push({ type: "text", text: prompt });

  const res = await anthropic.messages.create({
    model: config.ai.claudeModel,
    max_tokens: 4096, // room for the model's own reasoning before the tool call
    system: systemPrompt(input.members, input.sender, input.currency),
    tools: [TOOL],
    tool_choice: { type: "auto" },
    messages: [{ role: "user", content }],
  });

  const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!call) throw new Error("Claude answered without filling in the expense");
  const out = call.input as ParsedExpense;
  // Empty strings mean "not stated".
  return { ...out, currency: out.currency || null, payer: out.payer || null };
}

/** Turn an AI failure into a sentence the person can act on (shown on the review page). */
export function explainAiError(err: unknown): string {
  if (err instanceof UnsupportedFileError) return `${err.message}. Upload a JPG, PNG or PDF instead (on iPhone, a screenshot works).`;
  if (!anthropic) return "Receipts are read automatically once ANTHROPIC_API_KEY is set. Fill in the details below.";
  const status = (err as { status?: number })?.status;
  const msg = String((err as Error)?.message ?? err);
  if (status === 401) return "Claude rejected the API key (it's invalid or was deleted). Check ANTHROPIC_API_KEY.";
  if (status === 403) return "This API key isn't allowed to use Claude. Check the key's workspace in the Claude Console.";
  if (status === 404) return `The model "${config.ai.claudeModel}" wasn't found. Check CLAUDE_MODEL.`;
  if (/credit balance/i.test(msg)) return "Your Anthropic account is out of credit. Add credit under Billing in the Claude Console.";
  if (status === 429) return "Claude is rate-limiting this key. Wait a minute and try again.";
  if (status === 413 || /too large|exceeds/i.test(msg)) return "That file is too large to read. Try a smaller photo or a shorter PDF.";
  if (/pdf|document/i.test(msg) && status === 400) return "Claude couldn't open that PDF (it may be password-protected). Try a screenshot instead.";
  if (status && status >= 500) return "Claude is temporarily unavailable. Try again in a minute.";
  return `Couldn't read that automatically (${msg.slice(0, 120)}). Fill in the details below.`;
}

/**
 * Offline parser so the simulator works without API keys. Handles the basics:
 * "dinner 120 skip raj", "gas 62.50 just me and priya", "sam paid 300 cabin".
 */
export function fallbackParse(text: string, members: string[]): ParsedExpense {
  const amountMatch = text.match(/(\d+(?:[.,]\d{1,2})?)/);
  const lower = text.toLowerCase();
  const findNames = (fragment: string) =>
    members.filter((m) => fragment.includes(m.toLowerCase().split(" ")[0])).concat(/\bme\b/.test(fragment) ? ["me"] : []);

  let split_mode: ParsedExpense["split_mode"] = "everyone";
  let people: string[] = [];
  const except = lower.match(/\b(?:skip|except|without|not)\b(.*)$/);
  const only = lower.match(/\b(?:just|only|split with|between|with)\b(.*)$/);
  if (except) {
    split_mode = "except";
    people = findNames(except[1]);
  } else if (only) {
    split_mode = "only";
    people = findNames(only[1]);
    // New names listed right after the keyword ("with Sara and Anir", "between Sara, Anir & Raj").
    const list = text.match(/\b(?:with|between|just|only)\s+((?:[A-Z][a-z]{1,20})(?:\s*(?:,|and|&)\s*(?:me|[A-Z][a-z]{1,20}))*)/);
    for (const w of list?.[1].match(/\b[A-Z][a-z]{1,20}\b/g) ?? []) {
      if (!people.some((p) => p.toLowerCase().split(" ")[0] === w.toLowerCase())) people.push(w);
    }
    if (/\b(split with|with)\b/.test(lower) && !people.includes("me")) people.push("me");
  }

  const paidBy = lower.match(/^(\w+)\s+paid/);
  const payer = paidBy && paidBy[1] !== "i" ? members.find((m) => m.toLowerCase().startsWith(paidBy[1])) ?? null : null;

  const description =
    text
      .replace(/^\w+\s+paid\s*/i, "")
      .replace(/^(i|we)\s+(went|had|got|grabbed)\s+(to\s+)?/i, "")
      .replace(amountMatch?.[0] ?? "", "")
      .replace(/[$€£]/g, "")
      .replace(/\b(dollars?|bucks|usd)\b/gi, "")
      .replace(/\b(skip|except|without|just|only|split with|between|with)\b.*$/i, "")
      .replace(/^\s*for\s+/i, "")
      .replace(/\s+(for|of|at)\s*$/i, "")
      .replace(/\s+/g, " ")
      .trim() || "Expense";

  return {
    is_expense: Boolean(amountMatch),
    amount: amountMatch ? Number(amountMatch[1].replace(",", ".")) : 0,
    currency: null,
    description: (description.charAt(0).toUpperCase() + description.slice(1)).slice(0, 40),
    payer,
    split_mode,
    people,
    weights: [],
    items: [],
    note: "",
  };
}
