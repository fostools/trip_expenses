# TripEx

Split group trip costs without the settle-up headache. Start a trip on the web, drop the link in your WhatsApp group, and everyone adds what they pay by typing it or snapping a receipt. TripEx works out who owes whom. US dollars only for now.

Full product and technical spec: [docs/SPEC.md](docs/SPEC.md).

## Run it locally (2 minutes)

Needs Node 22.13+.

```bash
npm install
npm test          # money math tests
npm run dev       # http://localhost:3000
```

Open http://localhost:3000, start a trip, then open the trip link in a private window to join as a second person.

Add `ANTHROPIC_API_KEY` to a `.env` file (copy `.env.example`) so Claude fills in expenses from text like `dinner 142 skip Raj` and reads receipt photos. Without it, a simple offline parser handles text, and receipts are filled in by hand.

## How people use it

1. **Start:** enter a trip name and who's going: your row first, then **+ Add person** for each friend. Everyone needs a name and an email.
2. **Share:** tap *Share in WhatsApp* and pick the trip's group.
3. **Join:** friends tap the link and tap their name (or add themselves with name and email), with no accounts or app. Tapping a name always asks for that person's email: the first time it's saved (for anyone added without one), and after that it has to match. Wrong emails count toward the same 15-minute guessing limit as the receipt password, and the error never reveals the real email.
4. **Add:** type an expense, upload a receipt photo or PDF, or email the trip's address: forward a receipt, or just write "Dinner at Bell Tower for 199 dollars" in the subject or body. TripEx fills in the details, you check them, then save. Nothing counts until it's saved.
5. **Fix:** any expense can be edited or deleted from its *Edit* link.
6. **Settle:** the trip page always shows the fewest payments to square up.
7. **Remove someone (trip owner only):** tap *Remove* next to their name. It's blocked while they're on a saved expense, so balances never shift silently: edit or delete those first. Unsaved drafts they paid for are discarded, they're signed out everywhere, and their email can't rejoin or re-add them by emailing the trip.

Anyone with a trip's link can view and join it, so treat it like the group chat itself. Receipts are the exception: they're locked behind a password (below). Pages are no-index and send no referrer. Set `CREATE_PIN` to require a code for starting new trips, so strangers can't run up your AI bill.

## Receipt password

Receipts can show card numbers, names and addresses, so photos, PDFs and emailed receipts only open for people who know the trip's **receipt password** (like `cedar-lagoon-47`).

- **The creator** sees the password on the trip page, with *Copy* and *Change password*. Nobody else ever sees it. Send it to the group yourself, ideally not in the same message as the trip link.
- **Everyone else** enters it once per device, on the trip page or an expense page, to unlock receipts for 30 days. Capitals and spaces don't matter. Expense amounts, splits and balances stay visible to everyone without it.
- **Changing it** locks receipts again on every device that used the old one.
- **Signing in as the creator** on a new device (tapping their name, or joining with their email) asks for their email and the password, since that would show it.
- **Guessing** is slowed down: 8 wrong tries per device and 30 per trip every 15 minutes.
- **Lost it?** If the creator isn't signed in anywhere and has forgotten the password, print it from the server: `fly ssh console -a tripex-app -C "npm run receipt-password -- TAHOE-X7Q"`.

Sign-in cookies are now signed, so nobody can pretend to be someone else by editing one. Existing sign-ins keep working for two weeks, except the creator's, who signs in once with the password.

## Email receipts (optional)

Each trip gets its own private address, shown on the trip page. Forward a receipt email there (PDF attached or not) and it shows up under **From email, waiting for a check**. Anyone on the trip can check it and save it.

**Privacy:** people's email addresses are never shown in the app. Review notes use names only, the "Open the email" copy of a forwarded email has every address replaced with "[email hidden]", and server logs mask them (`a***@gmail.com`). The only address shown is the trip's own receiving address, so people can forward to it.

**Who sent it:** TripEx matches the sender by email (and by name for anyone who doesn't have an email yet). If there's no match, it adds them to the trip using the name on their email, but only if their email turned into an expense. Automated senders like `no-reply@…` are never added; their receipts are credited to the trip creator for a check.

**People named in an expense:** "I went to dinner with Sara and Anir for 120" splits it between you, Sara and Anir, and adds anyone not already on the trip. They're asked for their email when they first open the trip link. Names after "skip" or "except" never add anyone.

### With Resend (recommended: no domain or business email needed)

Resend gives you a free receiving address at `<something>.resend.app`, and every name at it is delivered. TripEx uses that to give each trip its own address, like `tahoe-x7q.085f9b3a@abc123.resend.app`. The last 8 characters are a per-trip secret, so addresses can't be guessed.

1. Sign up at resend.com.
2. Find your receiving address under **Receiving** in the dashboard. Note the part after the `@` (e.g. `abc123.resend.app`).
3. Create an **API key** (Full access).
4. Add a **webhook**: URL `https://tripex-app.fly.dev/inbound/resend`, event `email.received`. Copy its **signing secret** (starts with `whsec_`).
5. Tell TripEx:
   ```bash
   fly secrets set -a tripex-app INBOUND_DOMAIN=abc123.resend.app RESEND_API_KEY=re_... RESEND_WEBHOOK_SECRET=whsec_...
   ```
6. Reload a trip page: the address appears under the add box. Forward a receipt to it to test.

### Confirmation replies (optional)

TripEx can reply to whoever emailed a receipt: "Got your receipt… check and save it here," with links to the expense and the trip page. If the email had no receipt, the reply says so. It never replies to no-reply addresses. Replies are sent through Resend:

```bash
fly secrets set -a tripex-app REPLY_FROM="TripEx <trips@yourdomain.com>"
```

Resend only sends from a domain you've verified with them. Until you have one, `REPLY_FROM="TripEx <onboarding@resend.dev>"` works for testing, but Resend delivers those only to your own Resend account email. Leave `REPLY_FROM` unset to turn replies off.

### With Postmark (alternative)

Postmark's signup needs a business email address. If you have one: create a server, copy its inbound address from the **Default Inbound Stream** settings, set the webhook URL to `https://tripex-app.fly.dev/inbound/postmark?secret=<random string>`, then `fly secrets set -a tripex-app INBOUND_ADDRESS=<inbound address> INBOUND_SECRET=<same string>`.

## Host it on Fly.io

The repo includes a `Dockerfile` and `fly.toml` (app `tripex-app`). One always-on small machine plus a 1 GB volume for the database and receipt photos is enough.

```bash
brew install flyctl            # or see fly.io/docs/flyctl/install
fly auth signup                # or: fly auth login
fly apps create tripex-app     # change app = in fly.toml if the name is taken
fly volumes create tripex_data --size 1 --region iad -a tripex-app
fly secrets set -a tripex-app ANTHROPIC_API_KEY=sk-ant-... \
  PUBLIC_URL=https://tripex-app.fly.dev CREATE_PIN=1234
fly deploy
```

Then open https://tripex-app.fly.dev. Check it's up at `/health`. Back up data with `fly volumes snapshots list`.

The same Dockerfile works on Railway or Render: attach a volume or disk at `/data` and set the same environment variables.

## Code map

| File | Role |
| --- | --- |
| `src/server.ts` | Express app: health check, web app, and the parked WhatsApp webhook |
| `src/web.ts` | Routes: start trip, join, add/review/edit expenses, receipt files |
| `src/inbound.ts` | Inbound email (Resend or Postmark webhooks): emailed receipts become drafts |
| `src/drafts.ts` | Shared "text/photo/PDF/email → draft expense" step |
| `src/views.ts` | Server-rendered pages and styles |
| `src/ai.ts` | Claude reads text, photos, PDFs and emails into a draft expense (one strict tool call); offline fallback parser |
| `src/ledger.ts` | Cent-exact splits, balances, per-person totals, fewest-transfer settle-up |
| `src/db.ts` | SQLite via Node's built-in `node:sqlite` |
| `src/util.ts` | Trip links, receipt storage |
| `src/tools/receipt-password.ts` | Prints a trip's receipt password (`npm run receipt-password -- CODE`) |
| `src/handler.ts`, `src/whatsapp.ts`, `src/simulate.ts` | WhatsApp bot channel (parked) and its terminal simulator |

## WhatsApp bot (parked)

The WhatsApp bot code is still here and turns on automatically when `WHATSAPP_TOKEN` is set. It needs a Meta developer app with the WhatsApp product. See the build spec for setup. `npm run simulate -- demo.txt` exercises the bot logic in a terminal.

## Known limits

- **USD only.** Non-USD receipts are flagged, not converted.
- **Photo formats.** JPG, PNG, WebP, GIF and PDF. iPhone HEIC photos get a message asking for a screenshot instead.
- **No money movement.** Settle-up tells people who pays whom.
- **Light identity.** People pick their name on each device, so anyone with the link who knows someone's email could act as them (the creator also needs the password). That's fine among friends; real accounts come later.
- **Receipts at rest.** Receipt files sit unencrypted on the server's disk; the password controls who can download them in the app. Claude also reads them to fill in expenses.
