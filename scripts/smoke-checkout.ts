/**
 * The whole chain, from an empty database to money captured.
 *
 * price -> draft -> fan approves -> payment held -> dispatch queued -> worker
 * runs -> provider confirms -> captured. Every component is the real
 * implementation; only Agnic and the payment processor are fakes.
 *
 * Also covers the four ways approval must refuse: an expired quote, a creator
 * who moved house mid-flow, a double approval, and an empty confirmation.
 */
import { FakeAgnic } from '../src/agnic/fake';
import { prisma } from '../src/db/client';
import { writeCreatorAddress } from '../src/fulfillment/address-store';
import { approveAndAuthorize, createDraftOrder } from '../src/orders/checkout';
import { drainOnce, type TaskReport } from '../src/orders/worker';
import { FakePaymentProvider } from '../src/payments/port';

const ADDRESS = {
  fullName: 'Creator Example',
  streetAddress: '1 Test Street',
  addressLocality: 'Toronto',
  addressRegion: 'ON',
  postalCode: 'M5H 1A1',
  addressCountry: 'CA',
  phone: null,
};

const MARKUP_PERCENT = 20;

let slugCounter = 0;
const checks: Array<{ name: string; pass: boolean; detail: string }> = [];

function check(name: string, pass: boolean, detail = ''): void {
  checks.push({ name, pass, detail });
}

async function makeAllTasksDue(): Promise<void> {
  await prisma.$executeRaw`update "OutboxEvent" set "availableAt" = now() where status = 'pending'`;
}

async function drainToQuiescence(deps: Parameters<typeof drainOnce>[0]): Promise<TaskReport[]> {
  const reports: TaskReport[] = [];
  for (let round = 0; round < 20; round += 1) {
    await makeAllTasksDue();
    const result = await drainOnce(deps, { limit: 10 });
    reports.push(...result.reports);
    if (result.claimed === 0) break;
  }
  return reports;
}

async function seedCreatorWithItem(): Promise<{
  creatorId: string;
  addressId: string;
  wishlistItemId: string;
}> {
  slugCounter += 1;
  const creator = await prisma.creator.create({
    data: { displayName: 'Checkout Creator', publicSlug: `checkout-${Date.now()}-${slugCounter}` },
  });

  // Written through the store so the address is encrypted at rest (NFR-2.2).
  const address = await writeCreatorAddress(prisma, {
    creatorId: creator.id,
    ...ADDRESS,
    consentPolicyVersion: 'v1',
  });

  const item = await prisma.wishlistItem.create({
    data: {
      creatorId: creator.id,
      merchantId: 'merchant_checkout',
      merchantName: 'Checkout Shop',
      sku: 'sku-checkout',
      title: 'Test Gift',
      currency: 'CAD',
      status: 'active',
    },
  });

  return { creatorId: creator.id, addressId: address.id, wishlistItemId: item.id };
}

async function reset(creatorId: string): Promise<void> {
  await prisma.outboxEvent.deleteMany({});
  await prisma.fanOrder.deleteMany({ where: { creatorId } });
  await prisma.creatorAddress.deleteMany({ where: { creatorId } });
  await prisma.wishlistItem.deleteMany({ where: { creatorId } });
  await prisma.creator.delete({ where: { id: creatorId } });
}

function deps(agnic: FakeAgnic, payments: FakePaymentProvider) {
  return {
    db: prisma,
    agnic,
    payments,
    markupPercent: MARKUP_PERCENT,
    workerId: 'checkout-worker',
  };
}

// ---------------------------------------------------------------------------
// 1. The happy path, end to end
// ---------------------------------------------------------------------------

await prisma.outboxEvent.deleteMany({});

{
  const seed = await seedCreatorWithItem();
  const agnic = new FakeAgnic();
  const payments = new FakePaymentProvider();
  const d = deps(agnic, payments);

  const draft = await createDraftOrder(d, {
    fanId: 'fan_1',
    creatorId: seed.creatorId,
    wishlistItemId: seed.wishlistItemId,
  });

  if (draft.state !== 'created') {
    check('draft created', false, `got ${draft.state}`);
  } else {
    check(
      'draft priced with markup',
      draft.order.fanTotalMinor === 1200 &&
        draft.order.markupMinor === 200 &&
        draft.order.merchantCapMinor === 1000,
      `${draft.order.merchantCapMinor} + ${draft.order.markupMinor} = ${draft.order.fanTotalMinor}`,
    );

    const approved = await approveAndAuthorize(d, {
      fanOrderId: draft.order.fanOrderId,
      fanConfirmationText: 'yes, buy it',
      approvedAt: new Date(),
      paymentMethodRef: 'pm_test',
    });

    check('approved and authorized', approved.state === 'authorized', `got ${approved.state}`);

    const reports = await drainToQuiescence(d);
    void reports;

    const order = await prisma.fanOrder.findUniqueOrThrow({
      where: { id: draft.order.fanOrderId },
      include: {
        paymentEvents: { orderBy: { createdAt: 'asc' } },
        orderEvents: { orderBy: { createdAt: 'asc' } },
        merchantOrder: true,
        approvedRequest: true,
      },
    });

    check('final state succeeded', order.state === 'succeeded', order.state);

    const captured = payments.calls.find((c) => c.op === 'capture');
    check(
      'fan charged our total, not the merchant figure',
      captured?.input.amountMinor === 1200,
      `captured ${captured?.input.amountMinor}`,
    );

    // The two rails must agree: 1000 approved with the merchant, 1200 taken
    // from the fan. Confusing them is the bug this asserts against.
    check(
      'merchant amount bound and unchanged',
      order.approvedRequest?.amountMinor === 1000,
      `bound ${order.approvedRequest?.amountMinor}`,
    );

    const ledger = order.paymentEvents.map((e) => e.type).join(' -> ');
    check('ledger shows held then captured', ledger === 'authorized -> captured', ledger);

    const path = order.orderEvents
      .map((e) => e.toState)
      .filter(Boolean)
      .join(' -> ');
    check(
      'state machine walked the full path',
      path === 'approved -> authorized -> dispatching -> processing -> succeeded',
      path,
    );

    // The address must never have been copied anywhere it could leak.
    check(
      'quote stores only the destination digest',
      !JSON.stringify(order.approvedRequest).includes('1 Test Street'),
      'no street address in the approved request row',
    );
  }

  await reset(seed.creatorId);
}

// ---------------------------------------------------------------------------
// 2. Approval must refuse
// ---------------------------------------------------------------------------

async function refusalCase(
  name: string,
  mutate: (seed: {
    creatorId: string;
    addressId: string;
    wishlistItemId: string;
  }) => Promise<void>,
  input: { text: string } = { text: 'yes' },
): Promise<void> {
  const seed = await seedCreatorWithItem();
  const agnic = new FakeAgnic();
  const payments = new FakePaymentProvider();
  const d = deps(agnic, payments);

  const draft = await createDraftOrder(d, {
    fanId: 'fan_2',
    creatorId: seed.creatorId,
    wishlistItemId: seed.wishlistItemId,
  });

  if (draft.state !== 'created') {
    check(name, false, `draft failed: ${draft.state}`);
    await reset(seed.creatorId);
    return;
  }

  await mutate(seed);

  const result = await approveAndAuthorize(d, {
    fanOrderId: draft.order.fanOrderId,
    fanConfirmationText: input.text,
    approvedAt: new Date(),
    paymentMethodRef: 'pm_test',
  });

  const expected = name.split(':')[1];
  check(name, result.state === expected, `expected ${expected}, got ${result.state}`);

  // Nothing may be held, and nothing may be queued for dispatch.
  check(
    `${name} - no money held`,
    payments.calls.length === 0,
    `${payments.calls.length} payment calls`,
  );

  await reset(seed.creatorId);
}

await refusalCase(
  'expired quote:quote_expired',
  async (seed) => {
    // Filter on the wishlist item id, which is what Quote actually stores.
    await prisma.quote.updateMany({
      where: { wishlistItemId: seed.wishlistItemId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
  },
);

await refusalCase(
  'creator moved house:address_changed',
  async (seed) => {
    // Through the store, not a raw update: this is the same call the creator's
    // settings form makes. A direct write would now store the new postal code in
    // the clear, which is precisely what NFR-2.2 forbids.
    await writeCreatorAddress(prisma, {
      creatorId: seed.creatorId,
      ...ADDRESS,
      postalCode: 'M5H 9Z9',
      consentPolicyVersion: 'v1',
    });
  },
);

await refusalCase('empty confirmation:invalid_confirmation', async () => {}, { text: '   ' });

// Double approval: the second attempt must be refused, not re-authorized.
{
  const seed = await seedCreatorWithItem();
  const agnic = new FakeAgnic();
  const payments = new FakePaymentProvider();
  const d = deps(agnic, payments);

  const draft = await createDraftOrder(d, {
    fanId: 'fan_3',
    creatorId: seed.creatorId,
    wishlistItemId: seed.wishlistItemId,
  });

  if (draft.state === 'created') {
    await approveAndAuthorize(d, {
      fanOrderId: draft.order.fanOrderId,
      fanConfirmationText: 'yes',
      approvedAt: new Date(),
      paymentMethodRef: 'pm_test',
    });

    const second = await approveAndAuthorize(d, {
      fanOrderId: draft.order.fanOrderId,
      fanConfirmationText: 'yes',
      approvedAt: new Date(),
      paymentMethodRef: 'pm_test',
    });

    check(
      'double approval:not_draft',
      second.state === 'not_draft',
      `expected not_draft, got ${second.state}`,
    );
    check(
      'double approval - authorized exactly once',
      payments.countOf('authorize') === 1,
      `${payments.countOf('authorize')} authorize calls`,
    );
  }

  await reset(seed.creatorId);
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
