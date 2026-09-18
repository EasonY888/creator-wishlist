/**
 * Proves the fan/operator split actually holds.
 *
 * Three things need to be true, and only the first is obvious:
 *
 *   1. A fan view built from a real order contains no address anything.
 *   2. The guard CATCHES a leak when one exists — a detector that never fires is
 *      worse than no detector, because it buys false confidence.
 *   3. The operator view still carries what an operator needs, but only for a
 *      viewer who holds the capability, and it withholds by default.
 */
import type { ProviderOrder } from '../src/domain/provider-status';
import { fanOrderView } from '../src/presentation/fan-view';
import { operatorOrderView } from '../src/presentation/operator-view';
import {
  assertNoSensitiveFields,
  findSensitiveFields,
  SensitiveFieldLeakError,
} from '../src/presentation/sensitive';

const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail = ''): void {
  checks.push({ name, pass, detail });
}

const SECRET = '1 Test Street';

// ---------------------------------------------------------------------------
// 1. The guard must fire on a real leak
// ---------------------------------------------------------------------------

const leaky = {
  orderId: 'ord_1',
  totalMinor: 1200,
  ship_to: { street_address: SECRET, postal_code: 'M5H 1A1' },
  evidence: { charge_state: 'none' },
  live_view_url: 'https://example.invalid/live',
};

let caught: SensitiveFieldLeakError | null = null;
try {
  assertNoSensitiveFields(leaky, 'leaky-fixture');
} catch (error) {
  caught = error as SensitiveFieldLeakError;
}

check(
  'guard catches a leak',
  caught !== null && caught.paths.length === 5,
  caught ? `${caught.paths.length} fields: ${caught.paths.join(', ')}` : 'NOTHING CAUGHT',
);

// ---------------------------------------------------------------------------
// 2. A fan view must pass, and must not contain the address
// ---------------------------------------------------------------------------

const uncertainOrder: ProviderOrder = {
  id: 'ord_uncertain',
  status: 'pending',
  retryable: null,
  retry_action: 'contact_support',
  evidence: { charge_state: 'unknown' },
};

const fan = fanOrderView({
  orderId: 'ord_1',
  creatorDisplayName: 'Smoke Creator',
  fanTotalMinor: 1200,
  currency: 'CAD',
  localState: 'uncertain',
  providerOrder: uncertainOrder,
  placedAt: new Date('2026-09-17T10:00:00Z'),
});

check(
  'fan view passes the guard',
  findSensitiveFields(fan).length === 0,
  findSensitiveFields(fan).join(', ') || 'clean',
);

check(
  'fan view does not contain the street address',
  !JSON.stringify(fan).includes(SECRET),
  'no address text anywhere in the payload',
);

/**
 * The property is that the MERCHANT's figure never reaches the fan.
 *
 * This previously tested for any key matching /charged/i, which was too blunt:
 * it flagged `chargedLessThanApproved`, a boolean derived from our own ledger and
 * entirely appropriate to show. Testing the key name rather than the property
 * meant the guard fired on a change that leaks nothing -- and, worse, would have
 * missed a merchant figure exposed under a differently-named key.
 */
const MERCHANT_CHARGED = 1777;

const withMerchantFigure = fanOrderView({
  orderId: 'ord_2',
  creatorDisplayName: 'Smoke Creator',
  fanTotalMinor: 1200,
  currency: 'CAD',
  localState: 'succeeded',
  providerOrder: {
    ...uncertainOrder,
    status: 'succeeded',
    amount_charged_minor: MERCHANT_CHARGED,
  },
  placedAt: new Date('2026-09-17T10:00:00Z'),
});

check(
  'fan view carries no merchant key',
  !Object.keys(withMerchantFigure).some((k) => /merchant/i.test(k)),
  Object.keys(withMerchantFigure).join(','),
);

check(
  "fan view never exposes the merchant's charged figure",
  !JSON.stringify(withMerchantFigure).includes(String(MERCHANT_CHARGED)),
  `searched the whole payload for ${MERCHANT_CHARGED}`,
);

// The charge we DID make is shown, because "what did I pay?" is the fan's
// question, and the approved ceiling alongside it when they differ.
const chargedView = fanOrderView({
  orderId: 'ord_3',
  creatorDisplayName: 'Smoke Creator',
  fanTotalMinor: 1794,
  chargedMinor: 1599,
  currency: 'CAD',
  localState: 'succeeded',
  providerOrder: { ...uncertainOrder, status: 'succeeded', amount_charged_minor: 1300 },
  placedAt: new Date('2026-09-17T10:00:00Z'),
});

check(
  'fan view shows the real charge, and the ceiling it came in under',
  chargedView.totalMinor === 1599 &&
    chargedView.approvedMinor === 1794 &&
    chargedView.chargedLessThanApproved,
  `charged ${chargedView.totalMinor}, approved ${chargedView.approvedMinor}`,
);

check(
  'fan view does not claim a discount when the ceiling was used',
  fanOrderView({
    orderId: 'ord_4',
    creatorDisplayName: 'Smoke Creator',
    fanTotalMinor: 1794,
    chargedMinor: 1794,
    currency: 'CAD',
    localState: 'succeeded',
    providerOrder: null,
    placedAt: new Date('2026-09-17T10:00:00Z'),
  }).chargedLessThanApproved === false,
  'no false saving',
);

// ---------------------------------------------------------------------------
// 3. Copy must not claim things we cannot prove
// ---------------------------------------------------------------------------

check(
  'uncertain never reads as failure',
  !/fail|declin|error/i.test(fan.status.title + fan.status.explanation) &&
    fan.status.payment === 'unknown' &&
    fan.status.isSettled === false,
  `"${fan.status.title}" / payment=${fan.status.payment} / settled=${fan.status.isSettled}`,
);

const successFan = fanOrderView({
  orderId: 'ord_2',
  creatorDisplayName: 'Smoke Creator',
  fanTotalMinor: 1200,
  currency: 'CAD',
  localState: 'succeeded',
  providerOrder: {
    id: 'ord_2',
    status: 'succeeded',
    retryable: false,
    retry_action: 'none',
    evidence: { charge_state: 'captured' },
  },
  placedAt: new Date(),
});

check(
  'success claims ordered, not delivered',
  successFan.status.title === 'Your gift is ordered',
  `"${successFan.status.title}"`,
);

check(
  'success is settled and captured',
  successFan.status.isSettled === true && successFan.status.payment === 'captured',
  `settled=${successFan.status.isSettled} payment=${successFan.status.payment}`,
);

const failedFan = fanOrderView({
  orderId: 'ord_3',
  creatorDisplayName: 'Smoke Creator',
  fanTotalMinor: 1200,
  currency: 'CAD',
  localState: 'failed',
  placedAt: new Date(),
});

check(
  'failure answers "was I charged?" first',
  /not charged/i.test(failedFan.status.title),
  `"${failedFan.status.title}"`,
);

// ---------------------------------------------------------------------------
// 4. The operator view differs, and withholds by default
// ---------------------------------------------------------------------------

const operatorInput = {
  orderId: 'ord_1',
  fanId: 'fan_1',
  creator: { id: 'c1', displayName: 'Smoke Creator', publicSlug: 'smoke' },
  state: 'uncertain' as const,
  fanTotalMinor: 1200,
  markupMinor: 200,
  merchantCapMinor: 1000,
  currency: 'CAD',
  createdAt: new Date(Date.now() - 600_000),
  providerOrder: uncertainOrder,
  merchantOrder: {
    providerOrderId: 'ord_uncertain',
    statusRaw: 'pending',
    retryable: null,
    retryAction: 'contact_support',
    action: 'reconcile' as const,
    amountApprovedMinor: 1000,
    amountChargedMinor: null,
    pollCount: 3,
    lastPolledAt: new Date(),
    dispatchClaimedAt: new Date(),
    dispatchedAt: new Date(),
    evidence: { charge_state: 'unknown', ship_to: { street_address: SECRET } },
    liveViewUrl: 'https://example.invalid/live',
  },
  approvedRequest: {
    merchantId: 'merchant_1',
    amountMinor: 1000,
    requestDigest: 'abc',
    shipToDigest: 'def',
    fanApprovalText: 'yes please',
    fanApprovedAtIso: new Date(),
  },
  ledger: [{ type: 'authorized', amountMinor: 1200, providerRef: 'pay_1', at: new Date().toISOString() }],
  timeline: [],
};

const authorizedOperator = operatorOrderView({
  ...operatorInput,
  canViewSensitiveData: true,
});

check(
  'operator view exposes evidence when authorized',
  authorizedOperator.evidence !== null && authorizedOperator.liveViewUrl !== null,
  `evidence=${authorizedOperator.evidence !== null} liveView=${authorizedOperator.liveViewUrl !== null}`,
);

check(
  'operator view DOES contain the address (so the guard is not vacuous)',
  findSensitiveFields(authorizedOperator).length > 0,
  `${findSensitiveFields(authorizedOperator).length} sensitive paths present`,
);

const redactedOperator = operatorOrderView({
  ...operatorInput,
  canViewSensitiveData: false,
});

check(
  'operator view redacts when told not to show',
  redactedOperator.evidence === null && redactedOperator.liveViewUrl === null,
  `evidence=${redactedOperator.evidence} liveView=${redactedOperator.liveViewUrl}`,
);

const defaultOperator = operatorOrderView(operatorInput);

check(
  'operator view withholds by default (capability omitted)',
  defaultOperator.evidence === null &&
    defaultOperator.liveViewUrl === null &&
    defaultOperator.sensitiveDataRedacted === true,
  `redacted=${defaultOperator.sensitiveDataRedacted}`,
);

check(
  'operator view surfaces the unknown-outcome warning',
  defaultOperator.attentionReason !== null &&
    /reconcile/i.test(defaultOperator.attentionReason),
  defaultOperator.attentionReason ?? 'none',
);

// ---------------------------------------------------------------------------

const width = Math.max(...checks.map((c) => c.name.length));
console.log('');
for (const c of checks) {
  console.log(`${c.name.padEnd(width)}  ${c.pass ? 'ok  ' : 'FAIL'}  ${c.detail}`);
}

const failures = checks.filter((c) => !c.pass);
console.log(
  `\n${failures.length === 0 ? `All ${checks.length} checks passed.` : `${failures.length} of ${checks.length} FAILED.`}`,
);
