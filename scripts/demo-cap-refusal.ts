/**
 * The controlled refusal demo: a spending cap that the shop's price exceeds.
 *
 * This is one of the explicitly-scored demo paths. It is also the cleanest
 * demonstration of the product's safety posture, because the refusal happens
 * **before any card is touched** — there is nothing to unwind, no hold to
 * release, no fan money involved.
 *
 * Run against the live sandbox, so the refusal and the figures in it are real.
 */
import 'dotenv/config';

import { checkSetup, describeSetup } from '../src/agnic/setup-check';
import { AgnicHttpClient } from '../src/agnic/http';
import type { Constraints } from '../src/agnic/types';
import { resolveSandboxItem, SANDBOX_MERCHANT_ID } from './sandbox-item';

const SHIP_TO = {
  name: 'Test Creator',
  street_address: '1 Test Street',
  address_locality: 'Toronto',
  address_region: 'ON',
  postal_code: 'M5H 1A1',
  address_country: 'CA',
};

const token = process.env.AGNIC_TOKEN;
if (!token) {
  console.error('AGNIC_TOKEN is not set.');
  process.exit(1);
}

const setup = await checkSetup(token);
console.log(describeSetup(setup));
if (!setup.ready) {
  console.log('\nSetup incomplete - refusing to run.');
  process.exit(1);
}

const agnic = new AgnicHttpClient({ token });

// Resolve a buyable item rather than trusting a hardcoded SKU. The sandbox shop's
// stock changes: the Hex Token Fidget sold out on 2026-09-19 and made this script
// fail at step 1 — before demonstrating the refusal it exists to show.
const ITEM = await resolveSandboxItem(agnic, SHIP_TO);

function line(label: string, value: unknown): void {
  console.log(`  ${label.padEnd(22)} ${String(value)}`);
}

// ---------------------------------------------------------------------------
// 1. Price it normally, so we know what it actually costs
// ---------------------------------------------------------------------------

console.log('\n1. quoting with no cap, to establish the real price\n');
line('item', `${ITEM.title} (${ITEM.sku})`);

const uncapped = await agnic.quoteGift({
  merchant_id: SANDBOX_MERCHANT_ID,
  items: [{ sku: ITEM.sku, quantity: 1 }],
  ship_to: SHIP_TO,
});

if (uncapped.state === 'choose_delivery') {
  const cheapest = uncapped.deliveryOptions[0];
  console.log('   the shop needs a delivery choice first:');
  for (const option of uncapped.deliveryOptions) {
    console.log(`     ${option.title ?? 'option'} - ${option.price_minor} minor`);
  }
  console.log(`   taking the cheapest, ${cheapest?.title ?? '?'}\n`);
}

// Re-quote with a delivery option so the total is known.
const priced = await agnic.quoteGift({
  merchant_id: SANDBOX_MERCHANT_ID,
  items: [{ sku: ITEM.sku, quantity: 1 }],
  ship_to: SHIP_TO,
  fulfillment_option_id:
    uncapped.state === 'choose_delivery' ? uncapped.deliveryOptions[0]?.id : undefined,
});

if (priced.state !== 'ready') {
  console.log(`   could not price it: ${priced.state}`);
  process.exit(1);
}

const realCost = priced.quote.expected_amount_minor ?? 0;
line('real merchant total', `${realCost} minor ${priced.quote.currency}`);
line('final or ceiling?', priced.quote.amount_is_final ? 'final' : 'ceiling');
line('subtotal', `${priced.quote.subtotal_minor ?? '?'} minor`);

// ---------------------------------------------------------------------------
// 2. Now set a cap below that price and ask again
// ---------------------------------------------------------------------------

const cap = 500; // 5.00 CAD, deliberately below the real total
console.log(`\n2. re-quoting with a cap of ${cap} minor\n`);

const constraints: Constraints = { max_total_minor: cap };

const refused = await agnic.quoteGift({
  merchant_id: SANDBOX_MERCHANT_ID,
  items: [{ sku: ITEM.sku, quantity: 1 }],
  ship_to: SHIP_TO,
  constraints,
  fulfillment_option_id:
    uncapped.state === 'choose_delivery' ? uncapped.deliveryOptions[0]?.id : undefined,
});

console.log('   outcome\n');
line('state', refused.state);

if (refused.state === 'refused') {
  line('http status', refused.httpStatus);
  line('code', refused.code);
  if (refused.detail) line('detail', refused.detail);
  console.log('\n   This is the demo:');
  console.log(`     the shop wanted ${realCost}, the cap was ${cap},`);
  console.log('     and the refusal arrived BEFORE any card was involved.');
  console.log('     Nothing to unwind. No hold to release. No fan money moved.');
} else {
  console.log('\n   NOT refused - the cap was not enforced as expected.');
  console.log(`   ${JSON.stringify(refused).slice(0, 400)}`);
}

// ---------------------------------------------------------------------------
// 3. And confirm nothing was created
// ---------------------------------------------------------------------------

console.log('\n3. checking the provider recorded nothing\n');

const orders = await fetch('https://api.agnic.ai/api/autofill/orders', {
  headers: { 'X-Agnic-Token': token },
});

if (orders.ok) {
  const body = (await orders.json()) as { orders?: Array<{ status?: string }> };
  const recent = (body.orders ?? []).slice(0, 5);
  console.log(`   most recent provider orders: ${recent.map((o) => o.status ?? '?').join(', ') || '(none)'}`);
  console.log('   (a refusal creates no order at all)');
}
