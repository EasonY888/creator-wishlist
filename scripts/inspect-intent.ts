/**
 * Print the processor's own view of a PaymentIntent, plus whether the two keys
 * in the environment belong to the same Stripe account.
 *
 * Exists because "the card form is blank" has several causes that all look
 * identical from the browser, and guessing between them is how an afternoon
 * disappears. Stripe knows the answer; this asks it.
 *
 *   npx tsx scripts/inspect-intent.ts pi_...
 *   npx tsx scripts/inspect-intent.ts            (lists the 5 most recent)
 */
import 'dotenv/config';

import Stripe from 'stripe';

const secretKey = process.env.STRIPE_SECRET_KEY;
const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;

if (!secretKey) {
  console.error('STRIPE_SECRET_KEY is not set.');
  process.exit(1);
}

const stripe = new Stripe(secretKey);

/**
 * The pk/sk question, answered honestly.
 *
 * A publishable key does not name its account and neither do intent ids
 * (`pi_<random>` has no account segment), so there is no server-side call that
 * proves the two keys match. The only real check is client-side --
 * `Stripe(pk).retrievePaymentIntent(cs)` fails outright on a mismatch -- so this
 * script reports what it can see and does not pretend to more.
 */
function keyShape(): string {
  if (!publishableKey) return 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is not set';
  if (!secretKey?.startsWith('sk_test_') || !publishableKey.startsWith('pk_test_')) {
    return 'WARNING: at least one key is not a test key';
  }
  return 'both keys are test keys';
}

const arg = process.argv[2];

let intents: Stripe.PaymentIntent[];

if (arg) {
  intents = [await stripe.paymentIntents.retrieve(arg)];
} else {
  const list = await stripe.paymentIntents.list({ limit: 5 });
  intents = list.data;
}

const accountSegment = keyShape();

console.log('');
console.log(`publishable key prefix : ${publishableKey?.slice(0, 12) ?? '(not set)'}`);
console.log(`key check              : ${accountSegment}`);
console.log('');

for (const intent of intents) {
  console.log(`${intent.id}`);
  console.log(`  status                 ${intent.status}`);
  console.log(`  amount                 ${intent.amount} ${intent.currency.toUpperCase()}`);
  console.log(`  capture_method         ${intent.capture_method ?? '(default)'}`);
  console.log(`  payment_method_types   ${JSON.stringify(intent.payment_method_types)}`);
  console.log(
    `  automatic_methods      ${JSON.stringify(intent.automatic_payment_methods ?? null)}`,
  );
  console.log(`  amount_received        ${intent.amount_received}`);
  console.log(`  client_secret present  ${intent.client_secret !== null}`);
  if (intent.last_payment_error) {
    console.log(`  last_payment_error     ${JSON.stringify(intent.last_payment_error)}`);
  }
  console.log('');
}
