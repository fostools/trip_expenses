import { config } from "./config.js";
import type { Expense, Store, Trip, User } from "./db.js";
import { formatMoney, netBalances, personTotals, settleUp, splitAmount } from "./ledger.js";
import { hideEmails, tripEmail, tripLink } from "./util.js";

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const usd = (cents: number) => formatMoney(cents, config.currency);
const q = (trip: Trip) => `k=${encodeURIComponent(trip.view_token)}`;

/** Whether this viewer can open receipts, and (creator only) the password to share. */
export interface ReceiptState {
  unlocked: boolean;
  creator: string; // name of the person to ask for the password
  password?: string; // only set for the trip's creator
  message?: string; // feedback after an unlock attempt or a password change
}

function shortDate(sqlUtc: string) {
  const d = new Date(sqlUtc.replace(" ", "T") + "Z");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

// ---------------- home ----------------

export type HomeForm = { tripName?: string; people?: { name: string; email: string }[] };

export function homePage(error?: string, form: HomeForm = {}): string {
  // Row 1 is you; "+ Add person" adds a row per friend (every row needs a name and an email).
  const people = form.people?.length ? [...form.people] : [{ name: "", email: "" }];
  const row = (p: { name: string; email: string }, i: number) => `
      <li class="person-row">
        <input name="memberName" required maxlength="30" value="${esc(p.name)}" ${i === 0 ? 'placeholder="Your name" autocomplete="given-name"' : 'placeholder="Name"'} aria-label="${i === 0 ? "Your name" : "Name"}">
        <input name="memberEmail" type="email" required maxlength="120" value="${esc(p.email)}" placeholder="${i === 0 ? "Your email" : "Email"}" aria-label="${i === 0 ? "Your email" : "Email"}" ${i === 0 ? 'autocomplete="email"' : 'autocomplete="off"'}>
        ${i === 0 ? '<span class="you-tag">You</span>' : '<button type="button" class="remove" aria-label="Remove this person">×</button>'}
      </li>`;
  return layout(
    "TripEx",
    `<header>
      <p class="brand">TripEx</p>
      <h1>Split the trip, not the friendship.</h1>
      <p class="lede">Start a trip, drop the link in your WhatsApp group, and everyone adds what they pay. TripEx works out who owes whom.</p>
    </header>
    <form class="panel" method="post" action="/">
      ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
      <label>Trip name<input name="tripName" required maxlength="40" value="${esc(form.tripName ?? "")}" placeholder="Tahoe 2026" autocomplete="off"></label>
      <fieldset>
        <legend>Who's going</legend>
        <ul class="people-rows" id="people">${people.map(row).join("")}</ul>
        <button type="button" class="button small add-person" id="add-person">+ Add person</button>
        <p class="hint">Emails match receipts people send to the trip and are never shown in the app. Anyone you leave out can join from the link later.</p>
      </fieldset>
      ${config.createPin ? `<label>Access code<input name="pin" required autocomplete="off" inputmode="numeric"></label>` : ""}
      <button class="primary" type="submit">Start trip</button>
    </form>
    <script>
      (function () {
        var list = document.getElementById("people");
        document.getElementById("add-person").addEventListener("click", function () {
          var li = list.lastElementChild.cloneNode(true);
          li.querySelectorAll("input").forEach(function (i) { i.value = ""; });
          if (!li.querySelector(".remove")) {
            li.querySelector(".you-tag").outerHTML = '<button type="button" class="remove" aria-label="Remove this person">×</button>';
            li.querySelectorAll("input").forEach(function (i) { i.removeAttribute("autocomplete"); });
            li.querySelector("[name=memberName]").placeholder = "Name";
            li.querySelector("[name=memberName]").setAttribute("aria-label", "Name");
            li.querySelector("[name=memberEmail]").placeholder = "Email";
            li.querySelector("[name=memberEmail]").setAttribute("aria-label", "Email");
          }
          list.appendChild(li);
          li.querySelector("input").focus();
        });
        list.addEventListener("click", function (e) {
          if (e.target.classList.contains("remove")) e.target.closest("li").remove();
        });
      })();
    </script>`,
  );
}

// ---------------- join ----------------

export function joinPage(trip: Trip, members: User[], error?: string, next?: string, claim?: User, creatorCheck = false): string {
  const action = `/t/${trip.code}/join?${q(trip)}${next ? `&next=${encodeURIComponent(next)}` : ""}`;
  const header = `<header>
      <p class="brand">TripEx</p>
      <h1>${esc(trip.name)}</h1>
      <p class="lede">${claim && creatorCheck ? `Hi ${esc(claim.name)}! You started this trip, so enter your email and the trip's receipt password to sign in on this device. The password is on the trip page of any device you're already signed in on.` : claim && claim.email ? `Hi ${esc(claim.name)}! Enter the email you joined with to confirm it's you. It's never shown to anyone.` : claim ? `Hi ${esc(claim.name)}! Add your email to finish joining. It's how TripEx matches receipts you email to the trip, and it's never shown to anyone.` : "You've been invited to split costs for this trip."}</p>
    </header>`;

  if (claim) {
    return layout(
      `Join ${trip.name}`,
      `${header}
      <form class="panel" method="post" action="${action}">
        ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
        <input type="hidden" name="memberId" value="${esc(claim.phone)}">
        <label>Your email<input name="email" type="email" required maxlength="120" autocomplete="email" autofocus></label>
        ${creatorCheck ? `<label>Receipt password<input name="password" required maxlength="60" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="like cedar-lagoon-47"></label>` : ""}
        <button class="primary" type="submit">${creatorCheck ? "Sign in" : "Join"} as ${esc(claim.name)}</button>
        <p class="hint"><a href="/t/${trip.code}?${q(trip)}${next ? `&next=${encodeURIComponent(next)}` : ""}">Not ${esc(claim.name)}? Go back</a></p>
      </form>`,
    );
  }

  const pick = members.length
    ? `<section aria-labelledby="h-pick">
        <h2 id="h-pick">Already on the trip? Tap your name</h2>
        <form method="post" action="${action}" class="names">
          ${members.map((m) => `<button type="submit" name="memberId" value="${esc(m.phone)}">${esc(m.name)}</button>`).join("")}
        </form>
      </section>`
    : "";
  return layout(
    `Join ${trip.name}`,
    `${header}
    ${pick}
    <form class="panel" method="post" action="${action}">
      <p class="panel-title">New here?</p>
      ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
      <label>Your name<input name="name" required maxlength="30" autocomplete="given-name" placeholder="How the group knows you"></label>
      <label>Your email<input name="email" type="email" required maxlength="120" autocomplete="email"></label>
      <p class="hint">Your email matches receipts you send to the trip. It's never shown to anyone.</p>
      <button class="primary" type="submit">Join trip</button>
    </form>`,
  );
}

// ---------------- trip ----------------

export function tripPage(store: Store, trip: Trip, me: User, base?: string, rs: ReceiptState = { unlocked: true, creator: "" }, peopleMessage?: string): string {
  const owner = me.phone === trip.created_by;
  const members = store.members(trip.id);
  const name = new Map(members.map((m) => [m.phone, m.name]));
  const expenses = store.confirmedExpenses(trip.id);
  const ledger = store.ledger(trip.id);
  const net = netBalances(ledger);
  const totals = personTotals(ledger);
  const transfers = settleUp(net);
  const spent = expenses.reduce((s, e) => s + e.amount_cents, 0);
  const maxNet = Math.max(1, ...[...net.values()].map(Math.abs));
  const link = tripLink(trip, base);
  const shareText = `Join our ${trip.name} trip on TripEx so we can split costs: ${link}`;

  const settleHtml = transfers.length
    ? `<ol class="settle">${transfers
        .map(
          (t) =>
            `<li><span class="who">${esc(name.get(t.from) ?? "?")}</span> <span class="verb">pays</span> <span class="who">${esc(
              name.get(t.to) ?? "?",
            )}</span> <span class="amt">${usd(t.amountCents)}</span></li>`,
        )
        .join("")}</ol>`
    : `<p class="even">${expenses.length ? "Everyone is even. Nothing to settle." : "Nothing to settle yet."}</p>`;

  const peopleHtml = members
    .map((m) => {
      const t = totals.get(m.phone) ?? { paid: 0, share: 0 };
      const n = net.get(m.phone) ?? 0;
      const pct = Math.round((Math.abs(n) / maxNet) * 50);
      const status = n > 0 ? `gets back ${usd(n)}` : n < 0 ? `owes ${usd(-n)}` : "even";
      const cls = n > 0 ? "up" : n < 0 ? "down" : "flat";
      return `<li class="person ${cls}">
        <div class="pname">${esc(m.name)}${m.phone === me.phone ? ' <span class="you">(you)</span>' : ""}${
          owner && m.phone !== trip.created_by
            ? ` <a class="remove-person" href="/t/${trip.code}/people/${encodeURIComponent(m.phone)}/remove?${q(trip)}">Remove</a>`
            : ""
        }</div>
        <div class="pstatus">${status}</div>
        <div class="bar" aria-hidden="true"><span style="width:${pct}%"></span></div>
        <div class="pmeta">Paid ${usd(t.paid)}, share ${usd(t.share)}</div>
      </li>`;
    })
    .join("");

  const expensesHtml = expenses.length
    ? expenses
        .slice()
        .reverse()
        .map((e) => renderExpense(store, trip, e, members, name, rs))
        .join("")
    : `<li class="empty">No expenses yet. Add the first one above.</li>`;

  return layout(
    `${trip.name} · TripEx`,
    `<header>
      <p class="brand">TripEx</p>
      <h1>${esc(trip.name)}</h1>
      <p class="lede">${members.length} ${members.length === 1 ? "person has" : "people have"} spent <strong>${usd(spent)}</strong> across ${expenses.length} ${expenses.length === 1 ? "expense" : "expenses"}.</p>
      <p class="me">You're ${esc(me.name)}. <a href="/t/${trip.code}/leave?${q(trip)}">Not you?</a></p>
      <div class="share">
        <a class="button" href="https://wa.me/?text=${encodeURIComponent(shareText)}" target="_blank" rel="noopener">Share in WhatsApp</a>
        <button type="button" class="button" data-copy="${esc(link)}">Copy link</button>
      </div>
    </header>

    <form class="panel add" method="post" action="/t/${trip.code}/expenses?${q(trip)}" enctype="multipart/form-data">
      <label for="add-text">Add an expense</label>
      <input id="add-text" name="text" maxlength="200" autocomplete="off" placeholder="dinner 142 skip Raj">
      <label class="file">Or a receipt photo or PDF <input type="file" name="receipt" accept="image/*,application/pdf"></label>
      <button class="primary" type="submit">Add expense</button>
      <p class="hint">You'll check the details before it's saved.</p>
    </form>

    ${emailBlock(trip)}
    ${passwordBlock(trip, rs)}
    ${inboxBlock(store, trip, name)}

    <section aria-labelledby="h-settle">
      <h2 id="h-settle">Settle up</h2>
      ${settleHtml}
    </section>

    <section aria-labelledby="h-people" id="people">
      <h2 id="h-people">People</h2>
      ${peopleMessage ? `<p class="hint" role="status">${esc(peopleMessage)}</p>` : ""}
      <ul class="people">${peopleHtml}</ul>
    </section>

    <section aria-labelledby="h-exp">
      <h2 id="h-exp">Expenses</h2>
      ${!rs.unlocked && (rs.message || expenses.some((e) => e.receipt_file)) ? unlockForm(trip, rs, `/t/${trip.code}`) : ""}
      <ul class="expenses" id="receipts">${expensesHtml}</ul>
    </section>

    ${owner ? `<section aria-labelledby="h-export" id="export">
      <h2 id="h-export">Export</h2>
      <p class="hint">Download everything as a .zip: expenses, receipts, people with emails, and who pays whom, plus a trip.json file TripEx can import later. Only you see this.</p>
      <p><a class="button small" href="/t/${trip.code}/export?${q(trip)}" download>Export trip</a></p>
    </section>` : ""}

    <footer>Amounts are in US dollars. Anyone with this trip's link can view it and join, so share it only with the group.</footer>
    <script>
      document.querySelectorAll("[data-copy]").forEach(function (b) {
        b.addEventListener("click", function () {
          navigator.clipboard.writeText(b.dataset.copy).then(function () { b.textContent = "Copied"; });
        });
      });
    </script>`,
  );
}

function renderExpense(store: Store, trip: Trip, e: Expense, members: User[], name: Map<string, string>, rs: ReceiptState) {
  const shares = store.sharesFor(e.id);
  const included = shares.filter((s) => s.weight > 0);
  const left = members.filter((m) => !included.some((s) => s.phone === m.phone));
  const weighted = included.some((s) => s.weight !== 1);

  let split: string;
  if (weighted) {
    const parts = splitAmount(e.amount_cents, shares);
    split = included.map((s) => `${esc(name.get(s.phone) ?? "?")} ${usd(parts.get(s.phone) ?? 0)}`).join(", ");
  } else if (!left.length) {
    split = `Split evenly between everyone, about ${usd(Math.round(e.amount_cents / included.length))} each`;
  } else {
    const sat = left.map((m) => esc(m.name)).join(" and ");
    split = `Split ${included.length} ways, about ${usd(Math.round(e.amount_cents / included.length))} each. ${sat} sat out`;
  }

  const items: { name: string; amount: number }[] = e.items ? JSON.parse(e.items) : [];
  const receipt =
    e.receipt_file || items.length
      ? `<details>
          <summary>${e.receipt_file ? "Show receipt" : "Show items"}</summary>
          ${receiptBlock(trip, e, items, rs.unlocked)}
        </details>`
      : "";

  return `<li class="expense">
    <div class="erow"><span class="edesc">${esc(hideEmails(e.description))}</span><span class="eamt">${usd(e.amount_cents)}</span></div>
    <p class="emeta">${esc(name.get(e.payer) ?? "?")} paid on ${shortDate(e.created_at)}. ${split}. <a href="/t/${trip.code}/e/${e.id}?${q(trip)}">Edit</a></p>
    ${receipt}
  </li>`;
}

/** Creator only: the receipt password to pass on, and a way to change it. */
function passwordBlock(trip: Trip, rs: ReceiptState): string {
  if (!rs.password) return "";
  return `<section class="panel pw" id="receipt-password" aria-labelledby="h-pw">
      <p class="panel-title" id="h-pw">Receipt password</p>
      ${rs.message ? `<p class="hint" role="status">${esc(rs.message)}</p>` : ""}
      <p class="pw-row"><span class="pw-code">${esc(rs.password)}</span>
        <button type="button" class="button small" data-copy="${esc(rs.password)}">Copy</button></p>
      <p class="hint">Receipts can show card numbers and names, so they're locked. Only you see this password. Send it to the group yourself, ideally not in the same message as the trip link. You'll also need it to sign in as yourself on a new device.</p>
      <form method="post" action="/t/${trip.code}/receipt-password?${q(trip)}">
        <button type="submit" class="button small" onclick="return confirm('Pick a new password? Everyone will need the new one to open receipts.')">Change password</button>
      </form>
    </section>`;
}

/** Everyone else: one box to unlock receipts on this device. */
function unlockForm(trip: Trip, rs: ReceiptState, back: string): string {
  return `<form class="panel unlock" id="unlock" method="post" action="/t/${trip.code}/unlock?${q(trip)}">
      <p class="panel-title">Receipts are locked</p>
      <p class="hint">Receipts can show card numbers and names. Ask ${esc(rs.creator)} for the trip's receipt password.</p>
      ${rs.message ? `<p class="error" role="alert">${esc(rs.message)}</p>` : ""}
      <input type="hidden" name="next" value="${esc(back)}">
      <label>Receipt password<input name="password" required maxlength="60" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="like cedar-lagoon-47"></label>
      <button class="primary" type="submit">Unlock receipts</button>
    </form>`;
}

function emailBlock(trip: Trip): string {
  const address = tripEmail(trip);
  if (!address) return "";
  return `<p class="mailto">Or forward receipt emails to this trip:
      <span class="addr">${esc(address)}</span>
      <button type="button" class="button small" data-copy="${esc(address)}">Copy address</button></p>`;
}

function inboxBlock(store: Store, trip: Trip, name: Map<string, string>): string {
  const inbox = store.emailInbox(trip.id);
  if (!inbox.length) return "";
  return `<section aria-labelledby="h-inbox">
    <h2 id="h-inbox">From email, waiting for a check (${inbox.length})</h2>
    <ul class="expenses inbox">${inbox
      .map(
        (e) => `<li class="expense">
          <div class="erow"><span class="edesc">${esc(hideEmails(e.description))}</span><span class="eamt">${e.amount_cents ? usd(e.amount_cents) : "amount?"}</span></div>
          <p class="emeta">Emailed${name.get(e.created_by) ? ` by ${esc(name.get(e.created_by)!)}` : ""} on ${shortDate(e.created_at)}. <a href="/t/${trip.code}/e/${e.id}?${q(trip)}">Check and save</a></p>
        </li>`,
      )
      .join("")}</ul>
  </section>`;
}

function receiptBlock(trip: Trip, e: Expense, items: { name: string; amount: number }[], unlocked: boolean, lockNote = true) {
  const url = `/t/${trip.code}/r/${e.id}?${q(trip)}`;
  const f = e.receipt_file ?? "";
  const file = !f ? "" :
    !unlocked ? !lockNote ? "" : `<p class="locked">Receipt locked. <a href="#unlock">Enter the receipt password</a> to open it.</p>` :
    f.endsWith(".pdf") ? `<p><a class="button small" href="${url}" target="_blank" rel="noopener">Open receipt (PDF)</a></p>` :
    f.endsWith(".txt") ? `<p><a class="button small" href="${url}" target="_blank" rel="noopener">Open the email</a></p>` :
    `<img src="${url}" alt="Receipt for ${esc(hideEmails(e.description))}" loading="lazy">`;
  return `${file}
    ${
      items.length
        ? `<table class="items"><tbody>${items
            .map((i) => `<tr><td>${esc(i.name)}</td><td>${usd(Math.round(i.amount * 100))}</td></tr>`)
            .join("")}</tbody></table>`
        : ""
    }`;
}

// ---------------- review / edit an expense ----------------

export function editPage(store: Store, trip: Trip, e: Expense, error?: string, rs: ReceiptState = { unlocked: true, creator: "" }): string {
  const members = store.members(trip.id);
  const weights = new Map(store.sharesFor(e.id).map((s) => [s.phone, s.weight]));
  const isNew = e.status === "pending";
  const items: { name: string; amount: number }[] = e.items ? JSON.parse(e.items) : [];
  const amount = e.amount_cents ? (e.amount_cents / 100).toFixed(2) : "";
  const action = `/t/${trip.code}/e/${e.id}?${q(trip)}`;

  const rows = members
    .map((m) => {
      const w = weights.get(m.phone) ?? 0;
      return `<li class="who-row">
        <label class="check"><input type="checkbox" name="in_${esc(m.phone)}" ${w > 0 ? "checked" : ""}> ${esc(m.name)}</label>
        <label class="weight">shares <input type="number" name="w_${esc(m.phone)}" min="1" max="10" step="1" value="${w > 0 ? w : 1}"></label>
      </li>`;
    })
    .join("");

  return layout(
    `${isNew ? "Check expense" : "Edit expense"} · ${trip.name}`,
    `<header>
      <p class="brand"><a href="/t/${trip.code}?${q(trip)}">← ${esc(trip.name)}</a></p>
      <h1>${isNew ? (e.source === "email" ? "Check this emailed receipt" : "Check this expense") : "Edit expense"}</h1>
      ${isNew ? `<p class="lede">Fix anything that's off, then save. Nothing counts until you do.</p>` : ""}
    </header>
    <form class="panel" method="post" action="${action}">
      ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
      ${e.note ? `<p class="note">${esc(hideEmails(e.note))}</p>` : ""}
      <label>What for<input name="description" required maxlength="60" value="${esc(hideEmails(e.description))}"></label>
      <label>Amount in USD<input name="amount" required inputmode="decimal" value="${amount}" placeholder="0.00"></label>
      <label>Paid by<select name="payer">${members
        .map((m) => `<option value="${esc(m.phone)}" ${m.phone === e.payer ? "selected" : ""}>${esc(m.name)}</option>`)
        .join("")}</select></label>
      <fieldset>
        <legend>Who's in</legend>
        <ul class="who">${rows}</ul>
        <p class="hint">Uncheck anyone who sat this one out. Use shares for someone covering two people.</p>
      </fieldset>
      <button class="primary" type="submit" name="action" value="save">Save expense</button>
      ${
        isNew
          ? `<button class="quiet" type="submit" name="action" value="discard" formnovalidate>Discard</button>`
          : `<button class="danger" type="submit" name="action" value="delete" formnovalidate onclick="return confirm('Delete this expense for everyone?')">Delete expense</button>`
      }
    </form>
    ${e.receipt_file || items.length ? `<section aria-labelledby="h-r" id="receipts"><h2 id="h-r">Receipt</h2>${e.receipt_file && !rs.unlocked ? unlockForm(trip, rs, `/t/${trip.code}/e/${e.id}`) : ""}${receiptBlock(trip, e, items, rs.unlocked, false)}</section>` : ""}`,
  );
}

/** Trip owner only: confirm removing someone. The one place an email is shown, so the owner knows who it is. */
export function removePage(trip: Trip, person: User, savedCount: number): string {
  const back = `/t/${trip.code}?${q(trip)}#people`;
  const email = person.email
    ? `<p class="hint">Email on file</p><p class="confirm-email">${esc(person.email)}</p>`
    : `<p class="confirm-email">No email on file for ${esc(person.name)}.</p><p class="hint">They were added from an expense and haven't opened the trip link yet.</p>`;
  const body = savedCount
    ? `<p class="error" role="alert">${esc(person.name)} is on ${savedCount} saved ${savedCount === 1 ? "expense" : "expenses"}. Edit or delete ${savedCount === 1 ? "it" : "those"} first so balances stay right, then remove them.</p>
       <p><a class="button" href="${back}">Back to the trip</a></p>`
    : `<p class="hint">They'll be signed out and lose access. Unsaved drafts they paid for are discarded, and emails from them will be ignored.</p>
       <form method="post" action="/t/${trip.code}/people/${encodeURIComponent(person.phone)}/remove?${q(trip)}">
         <button class="danger" type="submit">Remove ${esc(person.name)}</button>
       </form>
       <p class="hint"><a href="${back}">Cancel</a></p>`;
  return layout(
    `Remove ${person.name} · ${trip.name}`,
    `<header><p class="brand"><a href="${back}">← ${esc(trip.name)}</a></p><h1>Remove ${esc(person.name)}?</h1></header>
    <section class="panel">${email}${body}</section>`,
  );
}

/** Someone opened a receipt link without the password (or without being on the trip). */
export function lockedPage(trip: Trip, e: Expense, member: boolean): string {
  const back = member ? `/t/${trip.code}/e/${e.id}?${q(trip)}#unlock` : `/t/${trip.code}?${q(trip)}`;
  return layout(
    "Receipt locked",
    `<header><p class="brand"><a href="/t/${trip.code}?${q(trip)}">← ${esc(trip.name)}</a></p><h1>Receipt locked</h1>
    <p class="lede">Receipts can show card numbers and names, so they need the trip's receipt password.</p>
    <p><a class="button" href="${back}">${member ? "Enter the password" : "Join the trip first"}</a></p></header>`,
  );
}

export function notFoundPage(): string {
  return layout(
    "Trip not found",
    `<header><p class="brand"><a href="/">TripEx</a></p><h1>Trip not found</h1><p class="lede">This link is incomplete or out of date. Ask whoever started the trip to share the link again.</p></header>`,
  );
}

const CSS = `
:root{
  --paper:#F2F4F1; --ink:#17201B; --muted:#5C6A62; --rule:#D5DAD3; --field:#FFFFFF;
  --up:#1F6F5C; --down:#8A3B63; --on-up:#FFFFFF;
  --display:"Bricolage Grotesque", system-ui, sans-serif;
  --text:"IBM Plex Sans", system-ui, sans-serif;
}
@media (prefers-color-scheme: dark){
  :root{ --paper:#121815; --ink:#E8EDE9; --muted:#9AA8A0; --rule:#2A332E; --field:#1A221E;
         --up:#6CC5A6; --down:#DE93B8; --on-up:#0E1512; }
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 var(--text);font-variant-numeric:tabular-nums}
main{max-width:640px;margin:0 auto;padding:28px 20px 64px}
a{color:var(--up)}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--up);outline-offset:2px}
.brand{font:700 1rem/1 var(--display);margin:0 0 20px;color:var(--muted)}
.brand a{color:inherit;text-decoration:none}
h1{font:700 clamp(2.2rem,9vw,3.4rem)/1.02 var(--display);letter-spacing:-.02em;margin:0 0 12px;overflow-wrap:anywhere}
h2{font:600 1rem/1.3 var(--text);color:var(--muted);margin:0 0 12px}
.lede{margin:0;color:var(--muted);max-width:34em}
.lede strong{color:var(--ink);font-weight:600}
.me{margin:8px 0 0;font-size:.9rem;color:var(--muted)}
.you{color:var(--muted);font-weight:400}
section{margin-top:40px}

.share{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
.button,button{font:600 .95rem/1 var(--text);padding:12px 16px;border-radius:10px;border:1px solid var(--rule);background:transparent;color:var(--ink);text-decoration:none;cursor:pointer;display:inline-block}
button.primary{background:var(--up);border-color:var(--up);color:var(--on-up);width:100%}
button.quiet{border-color:transparent;color:var(--muted);width:100%;margin-top:6px}
button.danger{border-color:var(--down);color:var(--down);width:100%;margin-top:10px}

.panel{margin-top:28px;padding:18px;border:1px solid var(--rule);border-radius:14px;display:grid;gap:14px}
.panel.add{margin-top:28px}
label{display:grid;gap:6px;font-weight:600;font-size:.95rem}
input,select{font:400 1rem/1.3 var(--text);padding:11px 12px;border:1px solid var(--rule);border-radius:8px;background:var(--field);color:var(--ink);width:100%}
input[type=checkbox]{width:20px;height:20px;accent-color:var(--up);padding:0}
input[type=file]{padding:8px;font-size:.9rem}
.file{font-weight:500;color:var(--muted)}
.panel-title{margin:0;font-weight:600}
.optional{font-weight:400;color:var(--muted);font-size:.85rem}
.hint{margin:0;color:var(--muted);font-size:.85rem}
.error{margin:0;color:var(--down);font-weight:600}
.note{margin:0;padding:10px 12px;border-left:3px solid var(--down);background:color-mix(in srgb,var(--down) 8%,transparent);font-size:.9rem}
fieldset{border:0;padding:0;margin:0}
legend{font-weight:600;font-size:.95rem;margin-bottom:6px}
.who{list-style:none;margin:0 0 8px;padding:0}
.who-row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:8px 0;border-top:1px solid var(--rule)}
.check{display:flex;align-items:center;gap:10px;font-weight:500}
.weight{display:flex;align-items:center;gap:8px;font-weight:400;color:var(--muted);font-size:.85rem}
.weight input{width:64px;padding:6px 8px}

.names{display:flex;flex-wrap:wrap;gap:8px}
.people-rows{list-style:none;margin:0 0 10px;padding:0;display:grid;gap:8px}
.person-row{display:grid;grid-template-columns:1fr 1.3fr 36px;gap:8px;align-items:center}
.you-tag{font-size:.8rem;color:var(--muted);text-align:center}
.remove{padding:0;width:36px;height:36px;font-size:1.2rem;line-height:1;color:var(--muted)}
.add-person{margin-bottom:6px}
@media (max-width:480px){.person-row{grid-template-columns:1fr 36px}.person-row input[type=email]{grid-column:1;grid-row:2}}

.settle{list-style:none;margin:0;padding:0}
.settle li{font:500 clamp(1.4rem,5.6vw,1.95rem)/1.2 var(--display);letter-spacing:-.01em;padding:12px 0;border-top:1px solid var(--rule);display:flex;flex-wrap:wrap;gap:0 .3em;align-items:baseline}
.settle li:last-child{border-bottom:1px solid var(--rule)}
.settle .verb{color:var(--muted)}
.settle .amt{margin-left:auto;font-weight:700;color:var(--down);font-family:var(--text);font-size:.85em}
.even{font:500 1.35rem/1.3 var(--display);margin:0}

.people,.expenses{list-style:none;margin:0;padding:0}
.person{display:grid;grid-template-columns:1fr auto;gap:2px 12px;padding:14px 0;border-top:1px solid var(--rule)}
.person:last-child,.expense:last-child{border-bottom:1px solid var(--rule)}
.pname{font-weight:600}
.pstatus{text-align:right;font-weight:600}
.up .pstatus{color:var(--up)} .down .pstatus{color:var(--down)} .flat .pstatus{color:var(--muted)}
.pmeta{grid-column:1/-1;color:var(--muted);font-size:.875rem}
.bar{grid-column:1/-1;position:relative;height:6px;margin:6px 0 2px;background:linear-gradient(var(--rule),var(--rule)) center/1px 100% no-repeat}
.bar span{position:absolute;top:0;bottom:0;border-radius:3px}
.up .bar span{left:50%;background:var(--up)}
.down .bar span{right:50%;background:var(--down)}

.expense{padding:16px 0;border-top:1px solid var(--rule)}
.erow{display:flex;justify-content:space-between;gap:16px;align-items:baseline}
.edesc,.eamt{font-weight:600}
.eamt{white-space:nowrap}
.emeta{margin:4px 0 0;color:var(--muted);font-size:.9rem;max-width:36em}
.empty{padding:16px 0;color:var(--muted);border-top:1px solid var(--rule)}
details{margin-top:8px}
summary{cursor:pointer;color:var(--up);font-weight:500;font-size:.9rem;width:max-content}
img{display:block;max-width:100%;max-height:520px;margin-top:10px;border:1px solid var(--rule);border-radius:8px}
.items{width:100%;border-collapse:collapse;margin-top:10px;font-size:.9rem}
.items td{padding:5px 0;border-bottom:1px dashed var(--rule)}
.items td:last-child{text-align:right;white-space:nowrap}
.mailto{margin:12px 0 0;color:var(--muted);font-size:.9rem;display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px}
.addr{font-weight:600;color:var(--ink);overflow-wrap:anywhere}
.button.small{padding:7px 11px;font-size:.85rem}
.inbox .expense{border-color:var(--rule)}
.remove-person{margin-left:6px;color:var(--muted);font-weight:400;font-size:.8rem}
.remove-person:hover{color:var(--down)}
.confirm-email{margin:0;font-weight:600;overflow-wrap:anywhere}
#people .hint{margin:0 0 8px}
.pw{gap:10px}
.pw-row{margin:0;display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}
.pw-code{font:600 1.25rem/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.02em;overflow-wrap:anywhere}
.pw form{margin:0}
.unlock{margin:0 0 16px}
.locked{margin:10px 0 0;color:var(--muted);font-size:.9rem}
footer{margin-top:48px;color:var(--muted);font-size:.875rem;max-width:36em}
@media (prefers-reduced-motion: reduce){*{transition:none!important}}
`;
