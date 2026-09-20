# Creator Wishlist

**A creator wishlist where fans send real gifts — and the creator's home address never reaches the fan.**

Built for **Agentic Commerce Pioneers, Edition II** — [Track 01, Agentic Checkout](https://pioneers.agnic.ai/build/agentic-checkout).

A fan picks a gift from a creator's wishlist, approves a maximum, and pays. A background worker then buys that gift from the real merchant, and the creator's address goes to the shop without ever being shown to the fan.

---

## The promise

> **The creator's home address never reaches the fan.**

It is enforced in three places, not stated in one:

- the address is **encrypted at rest**, field by field (`v1.<key id>.<ciphertext>` in the database — readable back only through an audited, role-gated path);
- the fan-facing view is built by a projection that **asserts no sensitive field is present** before returning, so a leak throws rather than rendering;
- the approved request is **digest-bound**, so a changed destination cannot be dispatched.

---

## Who builds what

The track splits the work, and this repo matches that split exactly.

| This build owns | Agnic owns |
| --- | --- |
| Creator accounts, wishlist storage, curation | Product discovery |
| Fan payments (Stripe) | Delivery quotes |
| Pricing, markup, and the capture rule | Executing the merchant checkout |
| Order lifecycle, dispatch, reconciliation | |
| Address protection | |

---

## How it works

```
fan picks a gift
  → Agnic quotes it (item + delivery + estimated tax)
  → the fan approves a CEILING and pays into a hold
  → a worker dispatches the order to the shop
  → the shop settles and reports what it actually charged
  → we capture THAT plus the fee shown, never the ceiling
```

The interesting part is the last two lines. On a tax-added market the final total isn't knowable in advance, so the fan approves a **maximum**. When the shop settles for less — which it usually does — the fan pays the real cost plus the displayed fee, and the difference is released.

### The one rule

```ts
amount = merchant's real charge + the fee the fan was shown

if (amount > what the fan approved)  → block and route to a person
otherwise                            → charge exactly that
```

`src/domain/charge.ts` is the single implementation, called by **both** the worker and the human operator path, so the two can never disagree about what to charge.

---

## Design decisions worth knowing

**No LLM in the spend path.** The "agent" is the dispatch worker. An LLM near a money decision is an unbounded-spend bug rather than a feature; a model belongs in curation (understanding *what* to buy), nowhere near *how much* to move.

**Exactly-once dispatch.** `src/orders/dispatcher.ts` is the only code path that spends money. It verifies the request still matches what was approved, writes a durable claim **before** the network call, calls once, then records the result. If a worker dies mid-call, the claim on disk stops a replacement from calling again.

**Two rails, deliberately asymmetric.** The merchant charges *us* with the platform's vaulted card; we charge the *fan* through Stripe. A `PaymentEvent` is the fan rail's ledger — so writing `refunded` into it asserts the fan's money came back. Merchant refunds are out of band, and the operator records them.

**Money states are a state machine, not nullable columns.** An illegal transition throws rather than being written and repaired later, because by then the owner has been shown something that was not true.

**Every external party has a port and an in-memory double.** `src/agnic/` and `src/payments/` each ship a real client and a fake, so refusal paths can be exercised without a live account or a card. The demo environment is then one environment variable, not a code change.

---

## The proof

A real order, settled end to end:

```
merchant order    af_ord_mu8yhh4hhi7zo6az        succeeded
payment intent    pi_3UHWgsCbMbWV1nTK1Z59KStW    real Stripe intent

fan approved      1794      the ceiling
merchant charged  1300      what the shop actually took
fan charged       1599      1300 + the 299 fee shown
released           195      back to the fan, by Stripe
```

`/ops/evidence` renders this from the same tables the product writes — nothing on that page is typed in. It also shows the counter-example: an earlier order where the code captured the whole ceiling, kept 4.94 having shown 2.99, and has since been fixed.

---

## Running it

**Prerequisites:** Node 20+, Docker, an Agnic sandbox token, Stripe test keys.

```bash
# 1. database
docker run --name creator-wishlist-db \
  -e POSTGRES_USER=wishlist -e POSTGRES_PASSWORD=wishlist -e POSTGRES_DB=wishlist \
  -p 5433:5432 -d postgres:17

# 2. dependencies and schema
npm install
npx prisma db push

# 3. environment (see the table below), then:
npm run dev      # http://localhost:3000
npm run worker   # a SEPARATE process — nothing dispatches without it
```

### Environment

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection |
| `AGNIC_TOKEN` | provider API key — server-side only |
| `AGNIC_MODE` | `live` or `fake` |
| `PAYMENTS_MODE` | `stripe` or `fake` |
| `STRIPE_SECRET_KEY` / `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | fan payment rail |
| `STRIPE_WEBHOOK_SECRET` | webhook verification |
| `SESSION_SECRET` | session signing |
| `ADDRESS_ENCRYPTION_KEY` | address encryption at rest |
| `OPS_PASSWORD` | operator gate |
| `MARKUP_PERCENT` | the platform fee |

### Scripts

```bash
npx tsx scripts/preflight.ts            # readiness gate — exits non-zero on NO-GO
npx tsx scripts/seed.ts                 # rebuild the demo creator and its wishlist
npx tsx scripts/sync-shop-items.ts      # sync a shop's items onto a wishlist, marking sold-out ones
npx tsx scripts/creator-link.ts         # print a creator's private manage link
npx tsx scripts/fan-login-code.ts you@example.com
npx tsx scripts/live-card-step.ts       # park an order at the card step
npx tsx scripts/park-ceiling-order.ts   # park the ceiling beat
npx tsx scripts/demo-cap-refusal.ts     # the controlled spending-cap refusal
npx tsx scripts/pending-approval.ts     # show any step-up the shop is waiting on
```

### Verifying it

```bash
npm run typecheck   # app, then scripts
npm test            # 202 tests
npx tsx scripts/preflight.ts
```

---

## What is real, and what is not

Stated plainly, because it matters more than a green checkmark.

**Real**

- The merchant checkout: a live Shopify shop, driven through Agnic's sandbox. The settlement above is a real `af_ord_…` record.
- The fan payment: real Stripe PaymentIntents, authorised and then captured for a **different, smaller** amount.
- Address encryption, the digest binding, the dispatch claim, the order lifecycle.

**Not real, or limited**

- The card is a Stripe **test** card and the platform's vaulted funding card is a sandbox card. No money moves.
- **Only one sandbox merchant's gateway is in test mode**, so it is the only shop a purchase can complete against. Other shops quote and dispatch, then decline the test card. That is a limitation of the sandbox, not of the agent.
- One exhibit order's *fan* rail ran on the in-memory double — visible as `pay_…` references rather than `pi_…`. It is labelled as such on `/ops/evidence`.

---

## Known limitations

- **The provider exposes no webhooks** for the merchant rail, so order status is polled.
- **The sandbox funding card's security code expires roughly hourly**, producing a step-up. It belongs to the platform's own card, is time-based rather than per-order, and the fan never sees it.
- **Wishlist item status is last-known.** Nothing re-checks a listing in the background, so an item can sell out between being listed and being bought. Checkout refuses correctly at quote time; the display is stale.
- **Merchant rails other than Shopify are out of scope**, though the provider type is an open union to allow them later.

---

## Layout

```
src/agnic/          the provider port, its HTTP client, and a fake
src/payments/       the fan rail, and a fake
src/domain/         the money rule and the order state machine — pure, fully tested
src/orders/         checkout, dispatch, reconciliation, approvals, the worker
src/fulfillment/    address storage, encryption, and request binding
src/presentation/   the fan and operator projections, with leak assertions
src/app/            the Next.js App Router routes
scripts/            setup, seeding, diagnostics, and the demo paths
```
