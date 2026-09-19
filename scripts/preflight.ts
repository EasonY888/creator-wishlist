/**
 * Pre-flight. Run this before you present, and treat a NO-GO as final.
 *
 * Every failure it checks for has already happened once during this build — a
 * stopped Docker daemon, a missing `SESSION_SECRET`, an empty `STRIPE_WEBHOOK_SECRET`,
 * a missing `ADDRESS_ENCRYPTION_KEY`. Each of them is invisible until the moment it
 * matters, and each of them turns a demo into a blank screen in front of judges.
 *
 * So this answers one question: **is this machine ready to demo right now?** It
 * checks the environment, the database, the app, the provider account, and the
 * demo data, and it prints the exact command to fix anything that fails.
 *
 *   npx tsx scripts/preflight.ts
 *
 * Exits 0 on GO and 1 on NO-GO, so it can gate a deploy or a rehearsal.
 */
import 'dotenv/config';

import { checkSetup } from '../src/agnic/setup-check';

const DEV_SERVER = process.env.APP_URL ?? 'http://localhost:3000';

interface Result {
  ok: boolean;
  label: string;
  detail: string;
  fix?: string;
}

const results: Result[] = [];

function record(result: Result): void {
  results.push(result);
}

function pass(label: string, detail: string): void {
  record({ ok: true, label, detail });
}

function fail(label: string, detail: string, fix: string): void {
  record({ ok: false, label, detail, fix });
}

function group(title: string): void {
  console.log('');
  console.log(title);
  console.log('-'.repeat(72));
}

// ---------------------------------------------------------------------------
// 1. Environment
// ---------------------------------------------------------------------------

group('1. Environment');

/**
 * Each of these has been missing at least once. `AGNIC_MODE` and `PAYMENTS_MODE`
 * are the ones that silently change behaviour rather than failing, which is worse.
 */
const REQUIRED_ENV: Array<{ name: string; why: string; min?: number }> = [
  { name: 'DATABASE_URL', why: 'nothing works without the database' },
  { name: 'AGNIC_TOKEN', why: 'the merchant rail', min: 16 },
  { name: 'STRIPE_SECRET_KEY', why: 'the fan rail' },
  { name: 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', why: 'the card form cannot render without it' },
  { name: 'SESSION_SECRET', why: 'fan login and operator sessions throw', min: 16 },
  { name: 'ADDRESS_ENCRYPTION_KEY', why: 'address reads and writes throw', min: 64 },
  { name: 'OPS_PASSWORD', why: 'the operator queue is CLOSED without it', min: 16 },
  { name: 'STRIPE_WEBHOOK_SECRET', why: 'the webhook route returns 500' },
];

for (const { name, why, min } of REQUIRED_ENV) {
  const value = process.env[name];
  if (!value) {
    fail(name, `missing — ${why}`, `Add ${name} to .env`);
  } else if (min !== undefined && value.length < min) {
    fail(name, `only ${value.length} chars, needs at least ${min}`, `Regenerate ${name}`);
  } else {
    pass(name, `set (${value.length} chars)`);
  }
}

// Modes decide which rail you are actually on. Getting these wrong does not throw,
// it just quietly demos the wrong thing.
const agnicMode = process.env.AGNIC_MODE ?? 'live';
const paymentsMode = process.env.PAYMENTS_MODE ?? 'fake';

if (agnicMode === 'live') pass('AGNIC_MODE', 'live — real merchant rail');
else fail('AGNIC_MODE', `"${agnicMode}" — the demo will not touch a real shop`, 'Set AGNIC_MODE=live');

if (paymentsMode === 'stripe') pass('PAYMENTS_MODE', 'stripe — the card form renders');
else
  fail(
    'PAYMENTS_MODE',
    `"${paymentsMode}" — the card step shows the no-card fallback`,
    'Set PAYMENTS_MODE=stripe',
  );

const key = process.env.STRIPE_SECRET_KEY ?? '';
if (key.startsWith('sk_test_')) pass('Stripe key mode', 'test key — no real money moves');
else if (key.startsWith('sk_live_'))
  fail('Stripe key mode', 'LIVE KEY — a demo payment would take real money', 'Use a sk_test_ key');
else if (key) fail('Stripe key mode', 'not recognisable as a test key', 'Check STRIPE_SECRET_KEY');

// ---------------------------------------------------------------------------
// 2. Database
// ---------------------------------------------------------------------------

group('2. Database');

let dbOk = false;
let orderCount = 0;

try {
  const { prisma } = await import('../src/db/client');
  orderCount = await prisma.fanOrder.count();
  dbOk = true;
  pass('connection', `reachable · ${orderCount} order(s) on file`);
} catch (error) {
  const message = String((error as Error).message ?? error).split('\n')[0] ?? 'unknown';
  if (message.includes('ECONNREFUSED')) {
    fail(
      'connection',
      'Postgres refused the connection',
      'Start Docker Desktop, then: docker start creator-wishlist-db',
    );
  } else {
    fail('connection', message.slice(0, 90), 'Check DATABASE_URL and that the container is up');
  }
}

// ---------------------------------------------------------------------------
// 3. The app
// ---------------------------------------------------------------------------

group('3. The app');

try {
  const response = await fetch(DEV_SERVER, { signal: AbortSignal.timeout(5000) });
  pass('dev server', `${DEV_SERVER} responded HTTP ${response.status}`);
} catch {
  fail('dev server', `nothing answering on ${DEV_SERVER}`, 'Run: npm run dev');
}

// ---------------------------------------------------------------------------
// 4. The provider account
// ---------------------------------------------------------------------------

group('4. The provider account');

const token = process.env.AGNIC_TOKEN;

if (!token) {
  fail('account', 'cannot check without AGNIC_TOKEN', 'Set AGNIC_TOKEN in .env');
} else {
  const setup = await checkSetup(token);

  const profileOk = setup.missingProfileFields.length === 0;
  if (profileOk) pass('account profile', 'complete');
  else
    fail(
      'account profile',
      `missing: ${setup.missingProfileFields.join(', ')}`,
      'Complete the profile in the Agnic dashboard — a live dispatch will fail at checkout as CHECKOUT_INCOMPLETE',
    );

  if (setup.cards.length > 0) {
    pass(
      'vaulted card',
      setup.cards
        .map((c) => `${c.brand ?? '?'} ****${c.lastFour ?? '????'}${c.isDefault ? ' (default)' : ''}`)
        .join(', '),
    );
  } else {
    fail('vaulted card', 'no card on file', 'Vault a card — a live dispatch cannot be funded');
  }

  try {
    const response = await fetch(
      'https://api.agnic.ai/api/autofill/merchants?q=untitled-fidget',
      { headers: { 'X-Agnic-Token': token }, signal: AbortSignal.timeout(10_000) },
    );
    const body = (await response.json()) as { merchants?: unknown[] };
    const count = body.merchants?.length ?? 0;
    if (count > 0) pass('sandbox shop', `${count} merchant(s) matched`);
    else fail('sandbox shop', 'no match for untitled-fidget', 'Check the merchant id before seeding');
  } catch {
    fail('sandbox shop', 'the provider did not answer', 'Check network access to api.agnic.ai');
  }
}

// ---------------------------------------------------------------------------
// 5. Demo data — what the evidence page needs to render
// ---------------------------------------------------------------------------

group('5. Demo data');

/**
 * Kept for the closing "open these" list. The approval beat has exactly one
 * source -- a draft order against a live, non-final quote -- so if this is
 * missing there is nothing to open and 0:20-0:45 silently disappears.
 */
let parkedOrderId: string | null = null;

if (dbOk) {
  const { prisma } = await import('../src/db/client');

  /**
   * Section 1 of `/ops/evidence` is about an order whose capture **exceeded what
   * the fan was shown**. Select for that property, not for recency.
   *
   * This check had the same bug the page had: "newest settled order with a
   * merchant figure" picks a correctly-captured order the moment one exists, so
   * it reported GO while the page had no specimen to show.
   */
  const settledOrders = await prisma.fanOrder.findMany({
    where: { state: 'succeeded' },
    orderBy: { createdAt: 'desc' },
    take: 25,
    include: {
      merchantOrder: true,
      paymentEvents: { select: { type: true, amountMinor: true } },
    },
  });

  const specimen = settledOrders.find((order) => {
    const charged = order.merchantOrder?.amountChargedMinor ?? null;
    if (charged === null) return false;

    const captured = order.paymentEvents
      .filter((event) => event.type === 'captured')
      .reduce((sum, event) => sum + event.amountMinor, 0);

    return captured > charged + order.markupMinor;
  });

  if (specimen) {
    const captured = specimen.paymentEvents
      .filter((event) => event.type === 'captured')
      .reduce((sum, event) => sum + event.amountMinor, 0);

    pass(
      'money moment',
      `order ${specimen.id} · captured ${captured} though the shop charged ${specimen.merchantOrder?.amountChargedMinor}`,
    );
  } else {
    fail(
      'money moment',
      'no settled order captured more than the fan was shown',
      '/ops/evidence section 1 will render its empty state — it needs the order that shows the bug',
    );
  }

  const addresses = await prisma.creatorAddress.count();
  if (addresses > 0) pass('address row', `${addresses} on file — section 2 renders`);
  else
    fail('address row', 'no creator address on file', 'Save one via /creator/<slug>, or run the seed');

  const creators = await prisma.creator.count();
  if (creators > 0) pass('wishlist', `${creators} creator(s) — the fan journey has a subject`);
  else fail('wishlist', 'no creators', 'Run: npx tsx scripts/seed.ts');

  /**
   * The "maximum, not a total" beat needs an order sitting in `draft` against a
   * quote that is neither final nor expired. Two ways to lose it without being
   * told: `seed.ts` rebuilds `demo-creator` and drops its orders, and the
   * approval screen refuses an expired quote -- correctly, and confusingly, in
   * front of an audience.
   */
  const parked = await prisma.fanOrder.findFirst({
    where: {
      state: 'draft',
      quote: { is: { amountIsFinal: false, expiresAt: { gt: new Date() } } },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (parked) {
    parkedOrderId = parked.id;
    pass('ceiling order', `${parked.id} — approves up to ${parked.fanTotalMinor}`);
  } else {
    fail(
      'ceiling order',
      'no draft order against a live non-final quote',
      'Run: npx tsx scripts/park-ceiling-order.ts',
    );
  }
}

// ---------------------------------------------------------------------------
// 6. Self-hosted assets
// ---------------------------------------------------------------------------

group('6. Self-hosted assets');

// The fonts are vendored so the page does not depend on fonts.googleapis.com.
// If they go missing the app still renders, but the typography silently degrades
// to Georgia — which is exactly the kind of thing nobody notices until it is on a
// projector.
try {
  const { readdir } = await import('node:fs/promises');
  const files = await readdir('public/fonts');
  const woff2 = files.filter((f) => f.endsWith('.woff2'));

  if (woff2.length >= 11) pass('self-hosted fonts', `${woff2.length} woff2 files in public/fonts`);
  else
    fail(
      'self-hosted fonts',
      `only ${woff2.length} of 11 woff2 files present`,
      'Re-vendor them: npx tsx scripts/fetch-fonts.ts',
    );
} catch {
  fail(
    'self-hosted fonts',
    'public/fonts is missing — typography fell back to Georgia',
    'Re-vendor them: npx tsx scripts/fetch-fonts.ts',
  );
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.ok);

console.log('');
console.log('='.repeat(72));
for (const result of results) {
  const mark = result.ok ? 'ok  ' : 'FAIL';
  console.log(`${mark}  ${result.label.padEnd(28)} ${result.detail}`);
  if (!result.ok && result.fix) console.log(`      -> ${result.fix}`);
}
console.log('='.repeat(72));
console.log('');

if (failed.length === 0) {
  console.log('GO. Open these in this order:');
  console.log('');
  console.log(`  Tab A   ${DEV_SERVER}/w/demo-creator        the promise`);
  console.log(`  Tab A   ${DEV_SERVER}/ops                   the queue (sign in)`);
  console.log(`  Tab B   ${DEV_SERVER}/ops/evidence          the money moment`);
  if (parkedOrderId) {
    console.log('');
    console.log('  Fallback if the live quote misbehaves — already parked and waiting:');
    console.log(`  Tab A   ${DEV_SERVER}/checkout/${parkedOrderId}`);
  }
  console.log('');
  console.log('Then zoom the browser to ~125%, and close Slack.');
} else {
  console.log(`NO-GO — ${failed.length} check(s) failing. Fix these before you present:`);
  for (const result of failed) console.log(`  - ${result.label}: ${result.fix ?? result.detail}`);
}

console.log('');

await new Promise((resolve) => setTimeout(resolve, 50));
process.exit(failed.length === 0 ? 0 : 1);
