/**
 * The fan payment rail, in both modes.
 *
 * Two halves, because they answer different questions:
 *
 *   1. **The two-phase approval, against the fake.** Does the checkout split
 *      behave? Specifically: is the request frozen BEFORE a hold exists, and does
 *      re-entering the card step reuse one intent rather than creating a second?
 *
 *   2. **The Stripe adapter, against test mode.** Does the real processor agree
 *      with the model? Test keys move no money, but every status, error code and
 *      idempotency semantic is genuine -- and the dangerous states are the whole
 *      point of testing against it rather than only against a double.
 *
 * Part 2 skips cleanly with no key, so this is safe to run anywhere.
 */
import 'dotenv/config';

import Stripe from 'stripe';

import { FakeAgnic } from '../src/agnic/fake';
import { toShipTo } from '../src/agnic/port';
import { prisma } from '../src/db/client';
import { computeShipToDigest } from '../src/fulfillment/binding';
import { writeCreatorAddress } from '../src/fulfillment/address-store';
import { approveAndAuthorize, beginPayment } from '../src/orders/checkout';
import { OUTBOX_TOPICS } from '../src/orders/outbox';
import { idempotencyKeyFor, FakePaymentProvider } from '../src/payments/port';
import { StripePaymentProvider } from '../src/payments/stripe';

const ADDRESS = {
  fullName: 'Creator Example',
  streetAddress: '1 Test Street',
  addressLocality: 'Toronto',
  addressRegion: 'ON',
  postalCode: 'M5H 1A1',
  addressCountry: 'CA',
  phone: null,
};

const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail = ''): void {
  checks.push({ name, pass, detail });
}

let counter = 0;

/** A draft order with a live quote, exactly as pricing would have left it. */
async function seedDraftOrder() {
  counter += 1;
  const creator = await prisma.creator.create({
    data: { displayName: 'Stripe Creator', publicSlug: `stripe-${Date.now()}-${counter}` },
  });

  const shipTo = toShipTo(ADDRESS);
  // Written through the store so the address is encrypted at rest (NFR-2.2).
  const address = await writeCreatorAddress(prisma, {
    creatorId: creator.id,
    ...ADDRESS,
    consentPolicyVersion: 'v1',
  });

  const item = await prisma.wishlistItem.create({
    data: {
      creatorId: creator.id,
      merchantId: 'merchant_stripe',
      sku: 'sku-stripe',
      title: 'Stripe Item',
      currency: 'CAD',
    },
  });

  const quote = await prisma.quote.create({
    data: {
      wishlistItemId: item.id,
      merchantId: 'merchant_stripe',
      state: 'valid_final',
      amountIsFinal: true,
      expectedAmountMinor: 1000,
      chargeCapMinor: 1000,
      currency: 'CAD',
      items: [{ sku: 'sku-stripe', quantity: 1 }],
      shipToDigest: computeShipToDigest(shipTo),
      selectedOptionId: null,
      expiresAt: new Date(Date.now() + 300_000),
    },
  });

  const order = await prisma.fanOrder.create({
    data: {
      fanId: 'fan_stripe',
      creatorId: creator.id,
      quoteId: quote.id,
      state: 'draft',
      fanTotalMinor: 1200,
      markupMinor: 200,
      merchantCapMinor: 1000,
      currency: 'CAD',
    },
  });

  return { creatorId: creator.id, addressId: address.id, itemId: item.id, fanOrderId: order.id };
}

async function reset(creatorId: string): Promise<void> {
  await prisma.outboxEvent.deleteMany({});
  await prisma.fanOrder.deleteMany({ where: { creatorId } });
  await prisma.quote.deleteMany({ where: { wishlistItem: { creatorId } } });
  await prisma.wishlistItem.deleteMany({ where: { creatorId } });
  await prisma.creatorAddress.deleteMany({ where: { creatorId } });
  await prisma.creator.delete({ where: { id: creatorId } });
}

await prisma.outboxEvent.deleteMany({});

// ---------------------------------------------------------------------------
// 1. Two-phase approval, against the fake
// ---------------------------------------------------------------------------

{
  const seed = await seedDraftOrder();
  const agnic = new FakeAgnic();
  const deps = {
    db: prisma,
    agnic,
    payments: new FakePaymentProvider(),
    markupPercent: 20,
  };

  const begun = await beginPayment(deps, {
    fanOrderId: seed.fanOrderId,
    fanConfirmationText: 'Yes, send this gift',
    approvedAt: new Date(),
  });

  check('phase 1: beginPayment is ready', begun.state === 'ready', begun.state);

  const frozen = await prisma.fanOrder.findUniqueOrThrow({
    where: { id: seed.fanOrderId },
    include: { approvedRequest: true, paymentEvents: true },
  });

  check(
    'phase 1: the request is frozen',
    frozen.approvedRequest !== null,
    frozen.approvedRequest === null ? 'no frozen request' : 'ApprovedRequest written',
  );

  check(
    'phase 1: the order advanced to approved',
    frozen.state === 'approved',
    frozen.state,
  );

  check(
    'phase 1: the intent reference was recorded',
    frozen.paymentIntentRef !== null,
    frozen.paymentIntentRef ?? '(null)',
  );

  // The ordering guarantee. A hold must never exist against a request we have
  // not committed to, so at this moment there must be no money held at all.
  check(
    'phase 1: NO money is held yet',
    frozen.paymentEvents.length === 0,
    `${frozen.paymentEvents.length} ledger entries`,
  );

  check(
    'phase 1: no dispatch was queued yet',
    (await prisma.outboxEvent.count()) === 0,
    `${await prisma.outboxEvent.count()} outbox rows`,
  );

  check(
    'phase 1: the frozen text is the fan\'s own words',
    frozen.approvedRequest?.fanApprovalText === 'Yes, send this gift',
    frozen.approvedRequest?.fanApprovalText ?? '(none)',
  );

  // Reloading the card form must not mint a second intent.
  const again = await beginPayment(deps, {
    fanOrderId: seed.fanOrderId,
    fanConfirmationText: 'Yes, send this gift',
    approvedAt: new Date(),
  });

  check(
    'reload: returns the same intent, not a new one',
    again.state === 'ready' && again.reference === frozen.paymentIntentRef,
    again.state === 'ready' ? again.reference : again.state,
  );

  check(
    'reload: did not prepare twice',
    deps.payments.countOf('prepare') === 1,
    `${deps.payments.countOf('prepare')} prepare calls`,
  );

  const verified = await approveAndAuthorize(deps, {
    fanOrderId: seed.fanOrderId,
    approvedAt: new Date(),
  });

  check('phase 2: verifies the hold', verified.state === 'authorized', verified.state);

  const authorized = await prisma.fanOrder.findUniqueOrThrow({
    where: { id: seed.fanOrderId },
    include: { paymentEvents: true, orderEvents: true, approvedRequest: true },
  });

  check(
    'phase 2: ledgered as authorized',
    authorized.paymentEvents.some((e) => e.type === 'authorized'),
    authorized.paymentEvents.map((e) => e.type).join(',') || '(empty)',
  );

  const queued = await prisma.outboxEvent.findMany({ select: { topic: true } });
  check(
    'phase 2: dispatch was queued',
    queued.some((o) => o.topic === OUTBOX_TOPICS.DISPATCH_MERCHANT_ORDER),
    queued.map((o) => o.topic).join(',') || '(none)',
  );

  check(
    'phase 2: the frozen request was not rewritten',
    authorized.approvedRequest !== null
      ? (await prisma.approvedRequest.count({ where: { fanOrderId: seed.fanOrderId } })) === 1
      : false,
    'exactly one ApprovedRequest row',
  );

  // Replaying phase 2 must not hold twice.
  const replayed = await approveAndAuthorize(deps, {
    fanOrderId: seed.fanOrderId,
    approvedAt: new Date(),
  });

  check(
    'phase 2: replay is refused, not repeated',
    replayed.state === 'not_draft',
    replayed.state,
  );

  check(
    'phase 2: only one authorize call reached the rail',
    deps.payments.countOf('authorize') === 1,
    `${deps.payments.countOf('authorize')} authorize calls`,
  );

  await reset(seed.creatorId);
}

// ---------------------------------------------------------------------------
// 2. The real adapter, against Stripe test mode
// ---------------------------------------------------------------------------

const secretKey = process.env.STRIPE_SECRET_KEY;

if (!secretKey) {
  console.log('\n(stripe half skipped: STRIPE_SECRET_KEY is not set)\n');
} else if (!secretKey.startsWith('sk_test_')) {
  // A live key here would move real money. Refuse outright.
  console.log('\n(stripe half REFUSED: STRIPE_SECRET_KEY is not a test key)\n');
  check('stripe: refuses a non-test key', false, 'refusing to run against a live key');
} else {
  const refs = new Map<string, string>();
  const orders = new Map<string, string>();

  const stripe = new StripePaymentProvider({
    secretKey,
    resolveAuthorizationRef: async (fanOrderId) => refs.get(fanOrderId) ?? null,
    returnUrl: 'https://example.invalid/checkout',
  });

  const op = (fanOrderId: string, amountMinor = 1000) => ({
    fanOrderId,
    idempotencyKey: idempotencyKeyFor('authorize', fanOrderId),
    amountMinor,
    currency: 'CAD',
  });

  // --- prepare ---
  const orderA = `order_${Date.now()}_a`;
  const prepared = await stripe.prepareAuthorization({
    fanOrderId: orderA,
    idempotencyKey: idempotencyKeyFor('prepare', orderA),
    amountMinor: 1000,
    currency: 'CAD',
    description: 'smoke test',
  });

  check('stripe: prepare returns an intent', prepared.state === 'ok', prepared.state);
  check(
    'stripe: prepare returns a client secret',
    prepared.state === 'ok' && typeof prepared.clientSecret === 'string',
    prepared.state === 'ok' ? (prepared.clientSecret === null ? 'null' : 'present') : '-',
  );

  if (prepared.state === 'ok') {
    refs.set(orderA, prepared.reference);

    const recovered = await stripe.clientSecretFor(orderA);
    check(
      'stripe: the secret is recoverable on reload',
      recovered === prepared.clientSecret,
      recovered === null ? 'null' : recovered === prepared.clientSecret ? 'same' : 'DIFFERENT',
    );

    // --- authorize (server-side confirm) ---
    const held = await stripe.authorize({
      ...op(orderA),
      idempotencyKey: idempotencyKeyFor('authorize', orderA),
      paymentMethodRef: 'pm_card_visa',
    });

    check('stripe: authorize places a hold', held.state === 'ok', held.state);

    // --- capture ---
    const captured = await stripe.capture({
      ...op(orderA),
      idempotencyKey: idempotencyKeyFor('capture', orderA),
    });

    check('stripe: capture succeeds', captured.state === 'ok', captured.state);

    check(
      'stripe: captured our amount',
      captured.state === 'ok' && captured.amountMinor === 1000,
      captured.state === 'ok' ? String(captured.amountMinor) : '-',
    );

    // Regression guard for the double-hold bug this test originally found.
    //
    // `authorize` used to create a fresh intent whenever a payment method was
    // named, even when `prepareAuthorization` had already made one, using a
    // different idempotency key. One order, two holds -- and only the second was
    // ever captured, so the first would have sat on the fan's card until it
    // expired. Asserted against the processor's own list rather than our
    // records, because our records are what missed it.
    const raw = new Stripe(secretKey);
    const listed = await raw.paymentIntents.list({ limit: 100 });
    const forOrder = listed.data.filter((p) => p.metadata?.fanOrderId === orderA);

    check(
      'stripe: one order produced exactly one intent',
      forOrder.length === 1,
      `${forOrder.length} intent(s) [${forOrder.map((p) => p.status).join(', ')}]`,
    );

    // The most important check here. Releasing a captured intent is impossible,
    // and reporting success would tell the reconciler a hold was dropped when the
    // fan has actually been charged.
    const releasedAfterCapture = await stripe.release({
      ...op(orderA),
      idempotencyKey: idempotencyKeyFor('release', orderA),
    });

    check(
      'stripe: refuses to release an already-captured intent',
      releasedAfterCapture.state === 'failed' && releasedAfterCapture.code === 'already_captured',
      releasedAfterCapture.state === 'failed'
        ? releasedAfterCapture.code
        : `reported ${releasedAfterCapture.state} - money-state lie`,
    );

    // --- the amount guard ---
    const orderB = `order_${Date.now()}_b`;
    const preparedB = await stripe.prepareAuthorization({
      fanOrderId: orderB,
      idempotencyKey: idempotencyKeyFor('prepare', orderB),
      amountMinor: 1000,
      currency: 'CAD',
    });

    if (preparedB.state === 'ok') {
      refs.set(orderB, preparedB.reference);
      await stripe.authorize({
        ...op(orderB),
        idempotencyKey: idempotencyKeyFor('authorize', orderB),
        paymentMethodRef: 'pm_card_visa',
      });

      const wrongAmount = await stripe.capture({
        ...op(orderB, 9999),
        idempotencyKey: idempotencyKeyFor('capture', orderB),
      });

      check(
        'stripe: refuses to capture an amount that was never authorized',
        wrongAmount.state === 'failed' && wrongAmount.code === 'amount_mismatch',
        wrongAmount.state === 'failed' ? wrongAmount.code : `captured ${wrongAmount.state}`,
      );

      // --- release, on an intent that is genuinely only held ---
      const released = await stripe.release({
        ...op(orderB),
        idempotencyKey: idempotencyKeyFor('release', orderB),
      });

      check('stripe: releases a held intent', released.state === 'ok', released.state);

      const twice = await stripe.release({
        ...op(orderB),
        idempotencyKey: idempotencyKeyFor('release', orderB),
      });

      check(
        'stripe: a repeated release reports already_done',
        twice.state === 'already_done',
        twice.state,
      );
    }
  }

  // A declined card must be a failure, not a hold.
  const orderC = `order_${Date.now()}_c`;
  const preparedC = await stripe.prepareAuthorization({
    fanOrderId: orderC,
    idempotencyKey: idempotencyKeyFor('prepare', orderC),
    amountMinor: 1000,
    currency: 'CAD',
  });

  if (preparedC.state === 'ok') {
    refs.set(orderC, preparedC.reference);

    const declined = await stripe.authorize({
      ...op(orderC),
      idempotencyKey: idempotencyKeyFor('authorize', orderC),
      // Stripe's canonical always-declined test card.
      paymentMethodRef: 'pm_card_visa_chargeDeclined',
    });

    check(
      'stripe: a declined card fails rather than holding',
      declined.state === 'failed',
      declined.state === 'failed' ? declined.code : `state ${declined.state}`,
    );

    check(
      'stripe: a decline is not reported as retryable',
      declined.state === 'failed' && declined.retryable !== true,
      declined.state === 'failed' ? String(declined.retryable) : '-',
    );
  }
}

// ---------------------------------------------------------------------------

const width = Math.max(...checks.map((c) => c.name.length));
console.log('');
for (const c of checks) {
  console.log(`${c.name.padEnd(width)}  ${c.pass ? 'ok  ' : 'FAIL'}  ${c.detail}`);
}

const failures = checks.filter((c) => !c.pass);
await prisma.outboxEvent.deleteMany({});
await prisma.$disconnect();

console.log(
  `\n${failures.length === 0 ? `All ${checks.length} checks passed.` : `${failures.length} of ${checks.length} FAILED.`}`,
);
