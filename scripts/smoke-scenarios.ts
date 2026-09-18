/**
 * End-to-end smoke check across the domain logic and the provider fake.
 *
 * This is not the test suite. It is a single readable run that answers one
 * question: given each of the failures this product has to survive, what does
 * the state machine decide, and what does the fan actually read?
 *
 * It also asserts the one invariant that matters most — that dispatch is issued
 * exactly once per approved order.
 */
import { chaos } from '../src/agnic/fake';
import type { FakeAgnic } from '../src/agnic/fake';
import { toProviderOrder } from '../src/agnic/port';
import type { DispatchInput } from '../src/agnic/port';
import { nextOrderAction } from '../src/domain/order-action';
import type { OrderAction } from '../src/domain/order-action';
import { presentOrder } from '../src/domain/presentation';

const request: DispatchInput['request'] = {
  merchant_id: 'm1',
  items: [{ sku: 'sku-1', quantity: 1 }],
  ship_to: {
    name: 'Creator Example',
    street_address: '1 Test Street',
    address_locality: 'Toronto',
    address_region: 'ON',
    postal_code: 'M5H 1A1',
    address_country: 'CA',
  },
  amount_minor: 1000,
  currency: 'CAD',
  user_confirmation_text: 'yes, buy it',
  user_approved_at_iso: '2026-09-16T12:00:00.000Z',
};

interface Row {
  scenario: string;
  provider: string;
  action: string;
  payment: string;
  fanSees: string;
}

const rows: Row[] = [];
let failures = 0;

async function run(scenario: string, fake: FakeAgnic): Promise<void> {
  const outcome = await fake.dispatch({ request });

  let provider: string = outcome.state;
  // Kept as the decision union rather than a bare string, so the `presentOrder`
  // call below can only ever be handed an action the reconciler could really
  // have produced.
  let action: OrderAction | 'n/a' = 'n/a';
  let payment = 'n/a';
  let fanSees = 'n/a';

  if (outcome.state === 'poll') {
    let order = toProviderOrder(await fake.getOrder(outcome.orderId));
    let decision = nextOrderAction(order);

    // Keep polling while the provider says the order is still running, exactly
    // as the reconciler does. Bounded here only because this is a smoke run.
    // Note this polls via getOrder and never re-dispatches -- which is the
    // behaviour the invariant check below is really guarding.
    let polls = 1;
    while (decision === 'poll_later' && polls < 5) {
      order = toProviderOrder(await fake.getOrder(outcome.orderId));
      decision = nextOrderAction(order);
      polls += 1;
    }

    provider = `${order.status}${order.retry_action ? ` / ${order.retry_action}` : ''}`;

    action = decision;
    const presentation = presentOrder(action);
    payment = presentation.payment;
    fanSees = presentation.title;
  } else if (outcome.state === 'approval_required') {
    provider = outcome.reason;
    fanSees = outcome.reason === 'currency_mismatch' ? '(config fault)' : '(step-up)';
  } else if (outcome.state === 'refused') {
    provider = `refused: ${outcome.code}`;
  } else if (outcome.state === 'reconcile') {
    action = 'reconcile';
    payment = 'unknown';
    fanSees = presentOrder('reconcile').title;
  }

  rows.push({ scenario, provider, action, payment, fanSees });

  // The invariant: one approved order, one dispatch. Always.
  const dispatches = fake.countCalls('dispatch');
  if (dispatches !== 1) {
    failures += 1;
    console.error(`  !! ${scenario}: dispatch called ${dispatches} times`);
  }
}

await run('success', chaos.success());
await run('in-flight (retryable:null is normal)', chaos.inFlight());
await run('price changed', chaos.priceChanged());
await run('out of stock', chaos.outOfStock());
await run('handoff needed', chaos.handoffRequired());
await run('unknown money state', chaos.unknownMoneyState());
await run('lost response', chaos.lostResponse());
await run('cvv refresh required', chaos.cvvRefreshRequired());
await run('currency mismatch', chaos.currencyMismatch());

const width = (values: string[]): number => Math.max(...values.map((v) => v.length));

const c = {
  scenario: width(rows.map((r) => r.scenario)),
  provider: width(rows.map((r) => r.provider)),
  action: width(rows.map((r) => r.action)),
  payment: width(rows.map((r) => r.payment)),
};

const pad = (v: string, n: number): string => v.padEnd(n);

console.log(
  `${pad('scenario', c.scenario)}  ${pad('provider', c.provider)}  ${pad('action', c.action)}  ${pad('payment', c.payment)}  fan sees`,
);
console.log(
  `${'-'.repeat(c.scenario)}  ${'-'.repeat(c.provider)}  ${'-'.repeat(c.action)}  ${'-'.repeat(c.payment)}  ${'-'.repeat(30)}`,
);

for (const row of rows) {
  console.log(
    `${pad(row.scenario, c.scenario)}  ${pad(row.provider, c.provider)}  ${pad(row.action, c.action)}  ${pad(row.payment, c.payment)}  ${row.fanSees}`,
  );
}

console.log(`\ndispatch-once invariant: ${failures === 0 ? 'held for all scenarios' : `${failures} VIOLATION(S)`}`);
