/**
 * The Stripe webhook route.
 *
 * This is the one part of the payment integration that no live event has ever
 * reached. The Stripe CLI would be the real way to exercise it, but signature
 * verification can be tested honestly without it: sign a payload the way Stripe
 * signs one, and check the route accepts it -- then tamper with it and check the
 * route refuses.
 *
 * The signature is the entire security boundary here. Without it, anyone who can
 * reach the URL can tell us a fan paid.
 */
import 'dotenv/config';

import crypto from 'node:crypto';

const WEBHOOK_SECRET = 'whsec_test_only_not_a_real_secret';

// Set before the route is imported, because the route reads them per request.
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.STRIPE_SECRET_KEY ??= 'sk_test_placeholder_for_construction_only';

const { POST } = await import('../src/app/api/stripe/webhook/route');
const { prisma } = await import('../src/db/client');

const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail = ''): void {
  checks.push({ name, pass, detail });
}

/** Stripe's scheme: `t=<unix>,v1=HMAC_SHA256(secret, "<t>.<payload>")`. */
function sign(payload: string, secret = WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${payload}`)
    .digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

function request(body: string, signature: string | null): Request {
  return new Request('http://localhost:3000/api/stripe/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(signature === null ? {} : { 'stripe-signature': signature }),
    },
    body,
  });
}

function eventBody(
  type: string,
  intent: Record<string, unknown>,
  id = `evt_${Date.now()}_${Math.random().toString(36).slice(2)}`,
): string {
  return JSON.stringify({
    id,
    object: 'event',
    type,
    data: {
      object: {
        id: `pi_${Math.random().toString(36).slice(2)}`,
        object: 'payment_intent',
        amount: 1200,
        amount_received: 1200,
        currency: 'cad',
        status: 'succeeded',
        ...intent,
      },
    },
  });
}

let counter = 0;

async function seedOrderWithCapture() {
  counter += 1;
  const creator = await prisma.creator.create({
    data: { displayName: 'Webhook Creator', publicSlug: `webhook-${Date.now()}-${counter}` },
  });

  const order = await prisma.fanOrder.create({
    data: {
      fanId: 'fan_webhook',
      creatorId: creator.id,
      state: 'succeeded' as never,
      fanTotalMinor: 1200,
      markupMinor: 200,
      merchantCapMinor: 1000,
      currency: 'CAD',
    },
  });

  await prisma.paymentEvent.create({
    data: {
      fanOrderId: order.id,
      type: 'captured',
      amountMinor: 1200,
      currency: 'CAD',
      providerRef: 'pi_seeded',
    },
  });

  return { creatorId: creator.id, fanOrderId: order.id };
}

async function reset(creatorId: string): Promise<void> {
  await prisma.outboxEvent.deleteMany({});
  await prisma.fanOrder.deleteMany({ where: { creatorId } });
  await prisma.creator.delete({ where: { id: creatorId } });
}

await prisma.outboxEvent.deleteMany({});
await prisma.idempotencyKey.deleteMany({ where: { scope: 'stripe_webhook' } });

// ---------------------------------------------------------------------------
// 1. The signature boundary
// ---------------------------------------------------------------------------

{
  const body = eventBody('payment_intent.amount_capturable_updated', {});

  const valid = await POST(request(body, sign(body)));
  check('signature: a correctly signed event is accepted', valid.status === 200, `HTTP ${valid.status}`);

  const tampered = await POST(
    request(body.replace('1200', '9999'), sign(body)),
  );
  check(
    'signature: a tampered body is rejected',
    tampered.status === 400,
    `HTTP ${tampered.status}`,
  );

  const wrongSecret = await POST(request(body, sign(body, 'whsec_wrong_secret')));
  check(
    'signature: the wrong secret is rejected',
    wrongSecret.status === 400,
    `HTTP ${wrongSecret.status}`,
  );

  const missing = await POST(request(body, null));
  check('signature: no signature is rejected', missing.status === 400, `HTTP ${missing.status}`);

  const stale = await POST(
    request(body, sign(body, WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 600)),
  );
  check(
    'signature: a replay from outside the tolerance is rejected',
    stale.status === 400,
    `HTTP ${stale.status}`,
  );
}

// ---------------------------------------------------------------------------
// 2. Events we do not handle are acknowledged, not retried
// ---------------------------------------------------------------------------

{
  const body = eventBody('customer.created', {});
  const response = await POST(request(body, sign(body)));

  check(
    'unhandled event: acknowledged so Stripe stops retrying',
    response.status === 200,
    `HTTP ${response.status}`,
  );
}

// ---------------------------------------------------------------------------
// 3. An event with no fanOrderId is not ours
// ---------------------------------------------------------------------------

{
  const body = eventBody('payment_intent.succeeded', {});
  const response = await POST(request(body, sign(body)));

  check('unrelated intent: acknowledged', response.status === 200, `HTTP ${response.status}`);
}

// ---------------------------------------------------------------------------
// 4. A cancellation writes to the ledger
// ---------------------------------------------------------------------------

const seed = await seedOrderWithCapture();

{
  // Start from a hold rather than a capture, so `released` is the honest entry.
  await prisma.paymentEvent.deleteMany({ where: { fanOrderId: seed.fanOrderId } });
  await prisma.paymentEvent.create({
    data: {
      fanOrderId: seed.fanOrderId,
      type: 'authorized',
      amountMinor: 1200,
      currency: 'CAD',
      providerRef: 'pi_seeded',
    },
  });

  const body = eventBody(
    'payment_intent.canceled',
    { metadata: { fanOrderId: seed.fanOrderId }, status: 'canceled' },
  );

  const response = await POST(request(body, sign(body)));

  check('canceled: accepted', response.status === 200, `HTTP ${response.status}`);

  const released = await prisma.paymentEvent.count({
    where: { fanOrderId: seed.fanOrderId, type: 'released' },
  });

  check('canceled: recorded on the fan ledger', released === 1, `${released} released entries`);

  // The state must NOT move. The webhook records; the reconciler decides.
  const order = await prisma.fanOrder.findUniqueOrThrow({
    where: { id: seed.fanOrderId },
    select: { state: true },
  });

  check(
    'canceled: order state was NOT changed by the webhook',
    order.state === 'succeeded',
    order.state,
  );
}

// ---------------------------------------------------------------------------
// 5. Replay of the same event id
// ---------------------------------------------------------------------------

{
  const id = `evt_replay_${Date.now()}`;
  const body = eventBody('payment_intent.payment_failed', { metadata: { fanOrderId: seed.fanOrderId } }, id);

  const first = await POST(request(body, sign(body)));
  const second = await POST(request(body, sign(body)));

  check('replay: first delivery accepted', first.status === 200, `HTTP ${first.status}`);
  check('replay: second delivery accepted', second.status === 200, `HTTP ${second.status}`);

  const secondBody = (await second.json()) as { replayed?: boolean };

  check(
    'replay: recognised as a duplicate rather than reprocessed',
    secondBody.replayed === true,
    JSON.stringify(secondBody),
  );
}

// ---------------------------------------------------------------------------
// 6. A failure arriving after the browser has gone
// ---------------------------------------------------------------------------

{
  const before = await prisma.paymentEvent.count({ where: { fanOrderId: seed.fanOrderId } });

  const body = eventBody(
    'payment_intent.payment_failed',
    {
      metadata: { fanOrderId: seed.fanOrderId },
      status: 'requires_payment_method',
      last_payment_error: { code: 'generic_decline' },
    },
  );

  const response = await POST(request(body, sign(body)));

  check('payment_failed: acknowledged', response.status === 200, `HTTP ${response.status}`);

  const after = await prisma.paymentEvent.count({ where: { fanOrderId: seed.fanOrderId } });

  // Nothing was ever held, so there is no ledger entry that would be truthful.
  check(
    'payment_failed: writes nothing to the ledger',
    after === before,
    `${before} -> ${after}`,
  );

  const order = await prisma.fanOrder.findUniqueOrThrow({
    where: { id: seed.fanOrderId },
    select: { state: true },
  });

  check('payment_failed: order state untouched', order.state === 'succeeded', order.state);
}

await reset(seed.creatorId);

// ---------------------------------------------------------------------------

const width = Math.max(...checks.map((c) => c.name.length));
console.log('');
for (const c of checks) {
  console.log(`${c.name.padEnd(width)}  ${c.pass ? 'ok  ' : 'FAIL'}  ${c.detail}`);
}

const failures = checks.filter((c) => !c.pass);
await prisma.idempotencyKey.deleteMany({ where: { scope: 'stripe_webhook' } });
await prisma.outboxEvent.deleteMany({});
await prisma.$disconnect();

console.log(
  `\n${failures.length === 0 ? `All ${checks.length} checks passed.` : `${failures.length} of ${checks.length} FAILED.`}`,
);
