// Print a trip's receipt password, for a trip creator who's lost it and every signed-in device.
// On Fly:  fly ssh console -a tripex-app -C "npx tsx src/tools/receipt-password.ts TAHOE-X7Q"
import { openDb, Store } from "../db.js";

const code = (process.argv[2] ?? "").toUpperCase();
const trip = code ? new Store(openDb()).getTripByCode(code) : undefined;
if (!trip) {
  console.error(code ? `No trip with code ${code}.` : "Usage: receipt-password <TRIP-CODE>");
  process.exit(1);
}
console.log(`${trip.name} (${trip.code}): ${trip.receipt_pin}`);
