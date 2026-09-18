# Milestone: The Fan Payment Rail (Stripe)

The second money rail. `AgnicPort` pays the merchant with the platform's vaulted
card; this pays *us* from the fan. FR-3.7 requires them to be modeled as two
separate rails, and until now the fan side was a double that could not be charged.

| Piece | Status | Evidence |
| --- | --- | --- |
| `StripePaymentProvider` | Built, **proven against Stripe** | 13 live test-mode checks |
| Two-phase checkout | Built, **proven** | 15 fake-mode checks |
| Elements card form | Built, rendered in browser | `/checkout/[id]/pay` |
| Signature-verified webhook | Built, unexercised | `/api/stripe/webhook` |
| `smoke-stripe` | **28/28** | `scripts/smoke-stripe.ts` |

---

## 1. The port had a hole the double was hiding

`capture` and `release` received only a `fanOrderId`. That is enough for
`FakePaymentProvider`, which keys everything off the idempotency key — but Stripe
needs the **PaymentIntent id**, created at `authorize` time and, in production, in
a different process minutes earlier.

Resolved by injecting a resolver rather than extending the port or letting a
payment adapter reach into Prisma:

```ts
new StripePaymentProvider({ secretKey, resolveAuthorizationRef })
```

The adapter declares the need; the composition root satisfies it from the ledger,
falling back to the pre-confirmation intent — which is what has to be cancelled
when a fan abandons the card form.

## 2. Card entry is not an FSM state

Elements forces a split: the fan must enter a card *before* anything can be held,
and the card must not touch our server (NFR-2.1). So authorize became
create-then-confirm.

The tempting move was a new `awaiting_payment` state. Rejected, on the FSM's own
stated terms — *"money states have to be unambiguous: 'was this fan charged?'
must have exactly one answer at any instant."* While a fan types digits the answer
is "no", same as `draft`. So the unconfirmed intent is a nullable column and the
`draft → approved → authorized` spine is untouched.

**The ordering guarantee is preserved:** `beginPayment` freezes the request
*before* creating the intent. A hold must never exist against a request we have
not committed to. Proven directly:

```
phase 1: the request is frozen        ok   ApprovedRequest written
phase 1: NO money is held yet         ok   0 ledger entries
phase 1: no dispatch was queued yet   ok   0 outbox rows
```

## 3. Guards that exist because the alternative is a lie

Three of these are the reason to test against a real processor rather than only a
double — the states do not exist in a fake:

- **`capture` checks the intent's own amount and currency.** Capturing a figure
  that was never authorized charges the fan something they did not agree to.
- **`release` refuses when the intent already `succeeded`.** Cancelling is
  impossible there, and reporting success would tell the reconciler a hold was
  dropped when the fan has actually been charged. This is the single most
  dangerous thing the rail could get wrong.
- **`requires_action` is a step-up, not a decline.** R-8 expects it as routine.

And a step-up or in-flight async method no longer fails the order — it stays
`approved` so the fan can retry, because failing something that may still succeed
is its own kind of lie.

## 4. The webhook records; it does not transition

Two writers driving one FSM is how the two rails end up disagreeing about the
same order — the precise failure R-19 exists to prevent. So the webhook verifies
the signature, writes the processor's truth to the ledger via the existing
idempotent `recordPaymentOnce`, and pokes reconciliation. The reconciler remains
the single authority on order state.

Dedupe reuses `IdempotencyKey` rather than adding a table — its `requestHash`
already encodes "same id with a different body is a conflict, not a replay".
The key is written **after** the work, deliberately: writing it first would poison
it on a thrown error, so Stripe's retry would find the key and we would report
success for work that never happened.

---

## Found in the field

**The live sandbox came back with `cvv_refresh_required`.** During the browser
walkthrough the real provider asked for a CVV step-up, and the approval-continuation
work from the previous milestone handled it unaided:

```
live-creator  state=approval_required
  timeline : approved -> authorized -> dispatching -> approval_required
  error    : cvv_refresh_required
  ledger   : authorized
  outbox   : approval.poll  pending
```

Two rails, visibly diverging and both correctly tracked: the fan's hold exists
(`authorized` in the ledger, via the fan rail) while the merchant side waits on a
step-up. The fan-facing page renders "A quick check is needed" with no provider
evidence or live-view URL exposed.

**`cleanup.ts` would have silently stranded in-flight orders.** It wiped the
*entire* outbox table for every debris creator, so running housekeeping while an
order was mid-flight would destroy its pending poll with nothing in the logs to
explain why it stopped. Now scoped to the doomed orders — verified by the live
order's `approval.poll` surviving the run. Also taught it the new smoke slugs
(`cap-`, `stripe-`, `approval-`), which a crashed run leaves behind.

---

## The bug the live test found

The first run against real Stripe failed 4 of 12 checks, and the cause was a
**double hold** — the worst thing this rail could do.

`authorize` created a fresh intent whenever a payment method was named, calling
`prepareAuthorization` with a *different* idempotency key (`authorize:` rather
than `prepare:`). So an order that had already been prepared ended up with **two
holds on one card**, and only the second was ever captured. The first would have
sat on the fan's card until it expired on its own.

Fixed: `authorize` now resolves the order's existing intent first and confirms
*that* one, creating one only when none exists.

**A double could never have found this.** `FakePaymentProvider` keys everything
off the idempotency key and has no notion of a second intent existing — it cannot
represent the failure. That is the entire argument for testing a payment adapter
against the real processor, and it paid for itself on the first run.

The regression guard asserts one order yields exactly one intent, and it reads
Stripe's own list rather than our records, because our records are what missed it:

```
stripe: one order produced exactly one intent   ok   1 intent(s) [succeeded]
```

Two guards I specifically wanted proven against real Stripe both fire correctly:

```
stripe: refuses to release an already-captured intent           ok   already_captured
stripe: refuses to capture an amount that was never authorized  ok   amount_mismatch
```

---

## Honest limits

- A live **webhook** has never been delivered, so signature verification is
  unexercised. `stripe listen --forward-to localhost:3000/api/stripe/webhook`
  is the way to test it.
- Elements has never actually rendered a card form — the browser run used fake
  mode, which correctly renders the no-card branch instead. Needs
  `PAYMENTS_MODE=stripe`.
- Captures are still driven by the reconciler's poll. The webhook pokes it, but
  the poll remains the safety net, so the event-driven path is an optimisation
  rather than a dependency.
- The smoke test refuses a non-`sk_test_` key outright, so it cannot be pointed
  at live mode by accident. Its calls include real captures.

## Verification

| Suite | Result |
| --- | --- |
| `smoke-stripe` | **28/28** (13 live against Stripe test mode) |
| `smoke-approval` | 12/12 |
| `smoke-cap-refusal` | 11/11 |
| `smoke-checkout` | 16/16 |
| `smoke-dto` | 13/13 |
| `smoke-pipeline` | 22/22 |
| `smoke-outbox` / `smoke-binding` / `smoke-scenarios` / `smoke-dispatcher` | all invariants held |
| `npm run typecheck` | clean |
| `npm run build` | clean — all 10 routes |
| Browser: wishlist → delivery → review → pay → status | works end-to-end |

## To finish it

The rail is proven. To see it in the app, one value changes:

```bash
# .env
PAYMENTS_MODE=stripe      # keys are already set and correct
```

For the webhook, which nothing in the payment flow depends on:

```bash
stripe login
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

That prints the `whsec_…` for `STRIPE_WEBHOOK_SECRET`. No dashboard endpoint is
needed for local work — Stripe requires HTTPS there, and the CLI forwards instead.
