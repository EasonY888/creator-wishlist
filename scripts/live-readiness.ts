/**
 * Is this machine ready to do the thing the rubric scores?
 *
 * The build track scores a **live dispatch** and a **controlled cap refusal**.
 * Both depend on account state that cannot be seen from the code, and the failure
 * mode is nasty: over HTTP the provider does not refuse a dispatch for an
 * incomplete account. It proceeds, reaches the shop's checkout, and fails there
 * as `CHECKOUT_INCOMPLETE` with `charge_state: attempted` — which reads like a
 * broken shop and is actually a missing profile field.
 *
 * So this answers, in one command and before anything is on stage:
 *
 *   1. does the token work
 *   2. is the buyer profile complete (the merchant requires nine fields)
 *   3. is a card vaulted
 *   4. is the sandbox shop still there, at the SKU we seed
 *
 * It spends nothing and creates no orders.
 *
 *   npx tsx scripts/live-readiness.ts
 */
import 'dotenv/config';

import { checkSetup } from '../src/agnic/setup-check';

const token = process.env.AGNIC_TOKEN;

if (!token) {
  console.error('AGNIC_TOKEN is not set. Nothing can be checked.');
  process.exit(1);
}

const merchantQuery = process.argv[2] ?? 'untitled-fidget';

console.log('');
console.log(`mode          AGNIC_MODE=${process.env.AGNIC_MODE ?? '(unset, defaults to live)'}`);
console.log(`merchant      searching for "${merchantQuery}"`);
console.log('');

// ---------------------------------------------------------------------------
// 1-3. Token, profile, cards
// ---------------------------------------------------------------------------

const setup = await checkSetup(token);

console.log(`token         ${setup.problems.some((p) => p.includes('profile read')) ? 'FAILED' : 'ok'}`);
console.log(`profile       ${setup.missingProfileFields.length === 0 ? 'complete' : 'INCOMPLETE'}`);

if (setup.missingProfileFields.length > 0) {
  console.log(`  missing     ${setup.missingProfileFields.join(', ')}`);
}

console.log(
  `cards         ${setup.cards.length === 0 ? 'NONE VAULTED' : setup.cards.map((c) => `${c.brand ?? '?'} ****${c.lastFour ?? '????'}${c.isDefault ? ' (default)' : ''}`).join(', ')}`,
);

for (const problem of setup.problems) {
  console.log(`  problem     ${problem}`);
}

// ---------------------------------------------------------------------------
// 4. The sandbox shop
// ---------------------------------------------------------------------------

interface MerchantRow {
  id?: string;
  name?: string;
  rail?: string;
  default_currency?: string;
  is_test?: boolean;
}

interface MerchantList {
  merchants?: MerchantRow[];
}

let merchants: MerchantRow[] = [];
try {
  const response = await fetch(
    `https://api.agnic.ai/api/autofill/merchants?q=${encodeURIComponent(merchantQuery)}`,
    { headers: { 'X-Agnic-Token': token } },
  );
  if (response.ok) {
    merchants = ((await response.json()) as MerchantList).merchants ?? [];
  } else {
    console.log(`merchants     HTTP ${response.status}`);
  }
} catch (error) {
  console.log(`merchants     unreachable: ${String((error as Error).message ?? error)}`);
}

console.log(
  `merchants     ${merchants.length === 0 ? 'none matched' : merchants.map((m) => `${m.id} [${m.rail}] ${m.default_currency}${m.is_test ? ' test' : ''}`).join(' | ')}`,
);

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

const blockers: string[] = [];

if (setup.missingProfileFields.length > 0) {
  blockers.push(
    'the account profile is incomplete — a live dispatch will reach the shop and fail at checkout',
  );
}
if (setup.cards.length === 0) {
  blockers.push('no card is vaulted — a live dispatch cannot be funded');
}
if (merchants.length === 0) {
  blockers.push('the sandbox shop did not come back — check the merchant id before seeding');
}

console.log('');
if (blockers.length === 0) {
  console.log('READY: a live dispatch has everything it needs.');
  console.log('');
  console.log('Still unverifiable from here, and worth one dry run before judging:');
  console.log('  - the spending mandate currency. It must be CAD. The policy engine does not');
  console.log('    convert, so a non-CAD mandate returns currency_mismatch on EVERY dispatch,');
  console.log('    permanently — it is a configuration fault, not a retryable failure.');
  console.log('  - whether the token\'s own spending caps (maxPerTransaction etc.) apply to a');
  console.log('    card-funded merchant purchase.');
} else {
  console.log('NOT READY — these will show up as a failed demo:');
  for (const blocker of blockers) console.log(`  - ${blocker}`);
}
console.log('');
