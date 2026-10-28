# Trip export format (version 1)

The trip owner can download a trip from the trip page (**Export trip**). The download is a zip:

| File | What it is |
| --- | --- |
| `trip.json` | Everything, machine-readable. The file an import reads |
| `summary.txt` | Totals, who pays whom, and each person's balance, in plain words |
| `expenses.csv` | One row per expense, for spreadsheets |
| `people.csv` | People, emails and balances |
| `settle-up.csv` | Who still pays whom, and payments already made |
| `receipts/` | Receipt photos, PDFs and saved email text, named `e<N>-<description>.<ext>` |

The zip holds people's emails and receipts, which is why only the trip owner can download it.

## `trip.json`

```json
{
  "format": "tripex-trip-export",
  "version": 1,
  "exported_at": "2026-10-26T18:04:05.000Z",
  "currency": "USD",
  "trip": { "code": "TAHOE-X7Q", "name": "Tahoe", "created_at": "2026-10-20T16:00:00Z" },
  "people": [
    { "id": "p1", "name": "Kiran", "email": "kiran@example.com", "owner": true, "on_trip": true },
    { "id": "p2", "name": "Raj", "email": "raj@example.com", "owner": false, "on_trip": true }
  ],
  "expenses": [
    {
      "id": "e1",
      "status": "saved",
      "description": "Dinner",
      "amount_cents": 9000,
      "paid_by": "p1",
      "added_by": "p1",
      "added_at": "2026-10-21T02:10:00Z",
      "source": "receipt",
      "split": [
        { "person": "p1", "weight": 1, "share_cents": 4500 },
        { "person": "p2", "weight": 1, "share_cents": 4500 }
      ],
      "items": [{ "name": "Pasta", "amount_cents": 2400 }],
      "note": null,
      "receipt": { "file": "receipts/e1-dinner.pdf", "type": "application/pdf" }
    }
  ],
  "balances": [
    { "person": "p1", "paid_cents": 9000, "share_cents": 4500, "net_cents": 2500 },
    { "person": "p2", "paid_cents": 0, "share_cents": 4500, "net_cents": -2500 }
  ],
  "payments": [{ "from": "p2", "to": "p1", "amount_cents": 2000, "paid_at": "2026-10-28T15:00:00Z" }],
  "settle_up": [{ "from": "p2", "to": "p1", "amount_cents": 2500 }]
}
```

### Rules

- **`format` and `version`** identify the file. An importer should refuse anything else and accept older versions it knows. New optional fields may be added within version 1; anything that changes meaning bumps the version.
- **Ids are local to the file.** `p1`, `e1` and so on link people and expenses inside this export only. They aren't database ids and don't need to survive an import.
- **Money** is integer cents in `currency` (always `USD` today). There are no floats anywhere.
- **Times** are ISO 8601 in UTC.
- **People** include everyone on the trip, plus anyone an expense still points at who has since left (`on_trip: false`). `email` is `null` for people added from an expense who never joined. Exactly one person has `owner: true`.
- **Expenses** include saved ones (`status: "saved"`) and unsaved drafts (`"draft"`). Discarded and deleted ones aren't exported.
- **`split`** lists only people who are in (weight above 0). `weight` is the share count (2 means covering two people). `share_cents` is the exact cents that person owes, summing to `amount_cents`.
- **`source`** is how the expense came in: `text`, `receipt` (photo or PDF upload) or `email`.
- **`receipt.file`** is the path of the receipt inside the zip, or `receipt` is `null`.
- **`payments`** are settle-up payments the trip owner marked as made: `from` paid `to`. Added within version 1, so older files may not have it; treat a missing list as empty.
- **`balances` and `settle_up`** are computed from saved expenses and `payments`, as the trip page shows them. `paid_cents` and `share_cents` count expenses only; `net_cents` also counts payments. They're for reading; an importer should recompute them from the expenses and payments rather than trust them.
- **Not exported:** the trip link's secret key, the receipt password and the trip's email address. An import creates a new trip with new ones.

### Importing later (notes for the importer)

1. Check `format` and `version`.
2. Create a trip with `trip.name` and new secrets. The importing person becomes the owner, or the `owner: true` person if their email matches.
3. Create people, keeping a map from `p<N>` to the new user ids. Re-apply emails so email receipts keep matching.
4. Create expenses with their status, payer, split weights, items and note, and copy each receipt file into receipt storage.
5. Re-create `payments`.
6. Recompute balances, and compare them with `balances` as a check.
