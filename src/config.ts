import "dotenv/config";

const env = (key: string, fallback = "") => process.env[key] ?? fallback;

export const config = {
  whatsapp: {
    token: env("WHATSAPP_TOKEN"),
    phoneNumberId: env("WHATSAPP_PHONE_NUMBER_ID"),
    verifyToken: env("WHATSAPP_VERIFY_TOKEN"),
    appSecret: env("WHATSAPP_APP_SECRET"),
    botNumber: env("BOT_PHONE_NUMBER"),
    graphVersion: env("GRAPH_API_VERSION", "v25.0"),
  },
  ai: {
    anthropicKey: env("ANTHROPIC_API_KEY"),
    claudeModel: env("CLAUDE_MODEL", "claude-sonnet-5-5"),
  },
  port: Number(env("PORT", "3000")),
  // Where people reach the dashboard, e.g. https://trips.example.com (no trailing slash)
  // Set this in production. If it's missing, the web app falls back to the address people opened.
  publicUrl: env("PUBLIC_URL").replace(/\/$/, ""),
  receiptsDir: env("RECEIPTS_DIR", "./data/receipts"),
  // Optional: require this code to start a new trip, so strangers can't run up your AI bill.
  createPin: env("CREATE_PIN"),
  inbound: {
    // Resend (recommended, no domain needed): your receiving domain, e.g. abc123.resend.app.
    // Each trip gets <trip>.<token>@<domain>.
    domain: env("INBOUND_DOMAIN"),
    resendApiKey: env("RESEND_API_KEY"),
    resendWebhookSecret: env("RESEND_WEBHOOK_SECRET"), // whsec_… from the webhook's page in Resend
    resendApiBase: env("RESEND_API_BASE", "https://api.resend.com"), // only changed in tests
    // Postmark (alternative): its inbound address, e.g. 4f2a...@inbound.postmarkapp.com; trips get +<trip>.<token>.
    address: env("INBOUND_ADDRESS"),
    secret: env("INBOUND_SECRET"), // shared secret in the Postmark webhook URL
  },
  reply: {
    // Confirmation replies to people who email receipts (sent through Resend). Leave blank to turn off.
    // Needs an address Resend lets you send from, e.g. "TripEx <trips@yourdomain.com>" once your domain is verified.
    from: env("REPLY_FROM"),
  },
  dbPath: env("DB_PATH", "./data/tripex.db"),
  // MVP: every trip is in US dollars. Multi-currency is on the roadmap.
  currency: "USD" as const,
};
