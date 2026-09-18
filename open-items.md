# Open Items

Running log of decisions we deliberately deferred, gaps not yet built, and questions that need an answer from outside the codebase.

**Purpose:** so nothing gets re-litigated from memory, and nothing quietly disappears. Each deferred item records *why* it was deferred and *when* to pick it up again.

Last updated: 2026-09-17

---

## 0. What has shipped since the last revision

Recorded so the lists below can be trusted. Everything here was previously in
"not yet built".

- Dispatcher — claim, verify binding, dispatch once, record outcome
- Approval continuation — `POLL_APPROVAL` has a handler; CVV, currency and expiry are all acted on
- Reconciler — poll, decide, capture or release
- Fan checkout — price → approve → hold → dispatch
- Address resolution — role-gated, audited, feeding `ship_to`
- Fan/operator DTO split, with a leak guard that is proven non-vacuous
- UI — wishlist, delivery choice, checkout, card step, order status, operator queue, creator curation
- **Stripe fan rail** — real PaymentIntents, hold then capture, plus a signature-verified webhook
- **Operator refunds** — FR-5.7 and R-13 are now reachable; `/ops` can act, not just observe
- **Creator curation** — paste a product link, verified against the provider before it is stored
- **Rate-limit throttle** — the worker holds off when the provider reports no quota
- **PII log guard** — error messages name fields, never values, and that is now pinned by a test
- **Address encryption at rest** — NFR-2.2 is now met, not deferred. AES-256-GCM before the row is written; the digest is still taken over plaintext so it does not move when the key rotates. No plaintext fallback: a missing key throws rather than storing an address in the clear
- **Scripts are typechecked** — `scripts/` was excluded from `tsconfig.json`, so a script that did not compile only failed at runtime, mid-database-run. A second config now checks them, and turning it on immediately found 7 latent errors
- **Operator authentication** — `/ops` needs a password now. Missing password means closed, not open
- **Creator address form** — the encrypted address store had no caller outside the scripts, so the encrypted write path was unreachable from the app. It has one now
- **Real email delivery for login codes** — Resend behind the existing `send` seam, and the log fallback refuses to run in production
- **A money bug in the operator resolve form** — see section 2; it is the reason components are now tested
- [x] **Both Stripe rails are now verified by real deliveries.** See "External setup".
- External setup — Agnic account, vaulted card, CAD mandate

---

## 1. Deferred decisions

Decided, but only for now. Each has a trigger for revisiting.

### Primary key format — cuid v1 (leave as-is)

Prisma's `@default(cuid())` generates cuid **v1**: timestamp + a global counter + machine fingerprint + 8 random base36 characters.

**Deferred on purpose.** An earlier concern that ids were enumerable was **wrong** and has been withdrawn. The counter does not reduce the search space for guessing a neighbour — the 8 random characters (~41 bits, ~2.8 trillion) are independent of it and still have to be guessed, against an authenticated and rate-limited endpoint.

What it *does* leak, which is minor:
- creation time (timestamp prefix)
- approximate platform order volume (the counter increments globally)
- the deployment's machine fingerprint (constant)

The real argument for changing it is **collision safety, not secrecy**: the counter starts at `0000` rather than at a randomised offset, so two instances running identical container images could generate colliding ids. Today we run one process.

- **Revisit when:** we scale beyond a single instance, or the schema is next touched for another reason.
- **Fix if taken:** `@default(cuid(2))` across all models. Do it while the database is empty.
- **Evidence:** `scripts/check-id-defaults.ts`

### Refunds are manual on the merchant side, real on the fan side

The provider holds no funds and exposes no refund operation; the merchant is merchant of record. So the **merchant** refund happens out-of-band and an operator records the reference as evidence.

The **fan** side is not the same thing, and this was glossed over the first time. `PaymentEvent` is the fan rail's ledger, so writing `refunded` into it asserts the fan's money came back. Recording a merchant refund alone would therefore be a lie. Operator refunds consequently reverse the fan's charge through the payment rail, and refuse to mark the order refunded if that call fails.

- **Revisit when:** the provider ships a refund/void endpoint, or volume makes manual handling untenable.
- **Consequence today:** R-13 (partial success) is a triage queue item that an operator can now actually close.
- **Evidence:** `scripts/smoke-operator.ts` (26 checks)

### Merchant choice is pinned at curation

Agnic takes `merchant_id` as a required input — it does not shop around. So all fans pay the same price for the same wishlist item, varying only by time drift.

- **Revisit when:** we want "find a cheaper shop for this item". Note that would re-price the item for *every* fan, not give one fan a better deal.

### No LLM in the checkout path

The track's guide defines the "agent" as the backend dispatch worker. Nothing in the build path needs a model, and an LLM near a spend decision is an unbounded-spend bug rather than a feature.

- **Revisit when:** adding curation assistance ("here's a streaming setup under £400 that ships to you"). That is genuinely agentic and nowhere near money.

### Local Docker database

- **Revisit when:** we deploy. The swap is `DATABASE_URL` plus `datasource.url` in `prisma.config.ts`. Note Prisma 7 removed the separate `directUrl`, so it is less work than v6.

### HTTP only, no MCP

The guide requires it and forbids mixing the two contracts. Consequence: token binding and mandate preflight are ours to implement.

---

## 2. Known gaps — not yet built

### Blocking the MVP

*Nothing. Both items that were here have shipped:*

- [x] **Operator ability to declare a terminal outcome for a stuck order.** An operator
  who has checked the merchant can now confirm the purchase completed (charging the
  fan the merchant's observed figure plus the fee) or confirm it never completed
  (releasing the hold). Both require an evidence reference, both refuse to contradict
  the ledger, and neither touches the order if the rail refuses. `src/orders/operator.ts`,
  covered by `scripts/smoke-operator.ts` (52 checks).
- [x] **Fan authentication — FR-7.1.** A fan confirms their email with a single-use
  six-digit code before paying, and a signed httpOnly session carries them after.
  Browsing remains open, as the requirement says it should. Order status pages are
  now owned: `notFound()` rather than a 403, so a guessed id does not confirm the
  order exists. `src/fans/auth.ts` + `src/fans/current.ts`; 16 unit tests on the
  signing and 22 checks on the code lifecycle.

  **One stub, deliberate and documented:** the code is *logged*, not emailed, because
  sending mail needs a provider and a key. `deliver()` in `src/fans/auth.ts` is the
  single function to replace; the verification itself is real.

### Not blocking the MVP

- [x] **Regression test suite.** Was: "vitest is configured and `npm test` runs nothing." It was worse than that — there was no vitest config and no test files, so `npm test` **exited 1**. Now 148 unit tests across 8 files in under a second, covering the pure logic that is expensive to test end to end: action precedence, the charge arithmetic, pricing, FSM guards, digest canonicalisation, the operator queue's judgement, crypto round-trips and session signing. Order-pipeline behaviour stays in `scripts/smoke-*`, which run against a real database on purpose.
- [x] **Address encryption at rest — NFR-2.2.** Was deferred pending a key-management
  decision. Decided: a 32-byte key from the environment, `ADDRESS_ENCRYPTION_KEY`, with
  an optional `ADDRESS_ENCRYPTION_KEY_PREVIOUS` for rotation.

  What is encrypted: name, street, locality, region, postal code, country and phone, as
  AES-256-GCM, stored as `v1.<keyId>.<iv>.<tag>.<ciphertext>`. The key id is inside the
  ciphertext, so a row always says which key opens it — which is what makes rotation a
  data migration rather than a flag day.

  Three things are worth stating because they are the parts that are easy to get wrong:
  - **The digest is taken over the plaintext and does not change.** It proves the fan's
    approved destination is unchanged, so if it moved when the key did, every outstanding
    approval would be silently invalidated by a key rotation.
  - **There is no plaintext fallback.** A missing key throws. A fallback would mean the
    control is only on in the environments where somebody remembered the variable —
    which is to say, the ones that least need it.
  - **The two-letter country rule moved.** `addressCountry` was `@db.Char(2)`, and a
    ciphertext no longer fits that, so the column is now plain text and the rule is
    enforced in the writer. The constraint did not disappear; it changed owner.

  One module may read an address (`loadShipToForFulfillment`) and one may write it
  (`writeCreatorAddress`), and both are the same file. The audit row is written *before*
  decryption, so a read that fails to decrypt is still recorded as an attempt.

  Existing rows were converted by `scripts/encrypt-existing-addresses.ts`, which is
  idempotent and refuses to touch a row that is already encrypted. It also re-derives
  each digest and reports a mismatch rather than silently rewriting history.

  - **Evidence:** `src/fulfillment/address-crypto.test.ts` (25 tests),
    `scripts/encrypt-existing-addresses.ts` (2 rows converted, verified ciphertext in
    the database, re-run reported 0 converted / 2 already done)
- [x] **A creator cannot edit their address from the app.** Closed — see the item under
  "Not blocking the MVP".
- [ ] **Operator *identity*, not just operator access.** `/ops` now proves *that* someone
  is an operator. It cannot say *which* operator, because it is a shared password — so
  the actor recorded on a refund or a resolution is still the constant `'operator'`.
  Attributing money movements to a person needs real accounts.
- [x] **A creator can now edit their address from the app.** The encrypted write path
  had no caller outside `scripts/`; the creator page now has a form behind it. Save a new
  address and any approval already given against the old one is refused at dispatch.

  **The form deliberately does not read the address back.** The page knows only whether
  one exists — `currentAddressIdFor` needs no decryption and writes no audit row. Reading
  a real address back would mean adding the creator's own role to `ADDRESS_READER_ROLES`,
  and *who may see a delivery address* is a product decision, not a form detail.
  Replacing one needs no such decision. If read-back is wanted, that is the trade to make
  explicitly.
- [x] **Operator authentication.** `/ops` and both of its money-moving actions now require
  a session. See section 2 for why the check is in the actions and not in middleware.
- [x] **Email delivery for login codes.** `src/fans/email.ts`, behind the `send` seam that
  was already there. Falls back to logging in development only; refuses in production,
  because a login code in a log file is an account for whoever reads the log.
- [x] **Staleness alert for `human_handoff`.** A handoff now escalates once it has been waiting 15 minutes. A handoff polls indefinitely and correctly, so nothing ever *looks* wrong — age is the only available signal that nobody has picked it up.
- [x] **Operator terminal-outcome action.** Built after all — `resolveOrder` in
  `src/orders/operator.ts`, reachable from `/ops` via `ResolveForm.tsx`. An operator who has
  checked the merchant can declare `succeeded` (charge the merchant's observed figure plus
  the fee) or `failed` (release the hold). Both require an evidence reference and refuse to
  contradict the ledger. (This entry sat stale in the "not blocking" list for a while after
  the same item was ticked under "blocking the MVP" — two copies of one item is how that
  happens.)
- [ ] **Operator authentication.** Done — see "Not blocking the MVP" for the design, and
  note that the redaction of address-bearing fields was deliberately left ON.
- [ ] **`SESSION_SECRET` is absent from `.env`.** Not a design gap — an environment one with
  a sharp edge, because it is missing rather than wrong, so nothing complains at boot.
  `secret()` in `src/fans/auth.ts` throws without it, and the two callers fail differently:
  - **`requestLoginCode` throws** (`secret()` peppers the code hash), so submitting the
    `/fan/login` form is a 500.
  - **`readSession` fails closed** — it catches and returns `null`, deliberately. So
    protected pages render "not signed in" rather than crashing. Browsing and the creator
    pages are unaffected, which is exactly what makes this easy to miss.

  Generate one:
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

### Fixed while building the test suite

- **A waiting step-up was reported as "outcome unknown".** The real provider returns
  `retryable: null` with no `retry_action` for `approval_required` (verified against
  the sandbox), which `nextOrderAction` correctly reads as `reconcile`. `attentionFor`
  then checked the derived action *before* the order's own state, so a healthy order
  waiting on a CVV confirmation was shown as "Outcome unknown — reconcile before
  acting". That sent an operator to investigate a working order and invited them to
  act on it. The order's state is now read first, because a state is specific
  evidence and a null field is not. Covered by `src/presentation/operator-view.test.ts`.
- **`MerchantOrder.amountApprovedMinor` was never written.** Dispatch created the row
  with only a `fanOrderId`, so reconciliation later held the actual charge with no
  ceiling to compare it against, and the unused headroom was only discoverable from
  the quote rather than from the order. Now recorded at dispatch and never
  overwritten afterwards.
- **The operator resolve form would have released a hold when asked to charge.** Found
  in the browser, from a React warning, during the pass that finally rendered the
  operator UI with sign-in in front of it.

  Three faults, stacked so that each hid the next:

  1. The buttons carried the decision as `<button name="decision" value="succeeded">`.
     That does not work when `formAction` is a server action — React overrides `name`
     for its own action encoding — so the field never arrived. `resolveStuckOrder`
     then fell through to its default, `failed`, which is the *release* path. Clicking
     **"It completed — charge"** would have released the fan's hold.
  2. The confirmation guard read `new FormData(event.currentTarget)`, where
     `currentTarget` is the button, not the form. `new FormData(button)` throws, so the
     dialog that exists to make an operator stop and read the consequence never ran.
  3. The action *defaulted* a money decision instead of refusing one. That is the real
     defect: the first two are how a missing field happened, and this is what made a
     missing field mean something.

  Fixed as: the decision travels in a hidden input the click handler sets; the guard
  reads from the form; and an unrecognised decision now refuses the whole operation.
  A money decision is never a safe default.

  **Why nothing caught it.** `resolveOrder` was correct and stayed correct — the value
  simply never reached it, and `scripts/smoke-operator.ts` exercises the domain, not
  the form. No amount of domain testing could have found it. So `vitest` now includes
  `*.test.tsx`, and `src/app/ops/ResolveForm.test.tsx` asserts the wiring directly.

### External setup

- [x] Agnic account + API token
- [x] Vaulted test card
- [x] Spending mandate issued in CAD
- [x] Run the chaos tests against the live sandbox — the cap refusal and the CVV step-up have both now fired for real
- [x] **A real Stripe event has now been delivered and accepted.** `stripe listen` forwarded
  `payment_intent.succeeded` and the route answered **200**. Signature verification is no
  longer only tested against payloads we signed ourselves.

  Done without `stripe login`, which is interactive: the CLI takes `--api-key`, and
  `listen --print-secret` returns the signing secret without opening a browser. The CLI is
  unpacked at `.tools/stripe/` (downloaded, not installed — no elevation, and `.tools/` is
  gitignored). To repeat:

  ```
  .tools/stripe/stripe.exe listen --events payment_intent.amount_capturable_updated,payment_intent.succeeded,payment_intent.canceled,payment_intent.payment_failed --forward-to localhost:3000/api/stripe/webhook
  .tools/stripe/stripe.exe trigger payment_intent.succeeded
  ```

  **The signing secret in `.env` is a real credential** for the test account. It is only
  ever valid for a listener on this machine, but it should still be regenerated with
  `--print-secret` if this repository is shared.
- [x] **The Elements card form renders, and has taken a payment.** It was never a bug: the
  VS Code integrated browser lays Stripe's frame out at 2px, and a hand-mounted
  `PaymentElement` outside the app behaved identically. Real headless Chrome measures the
  frame at **126px**.

  Better than rendering — a full payment went through it. Test card, real Stripe.js, real
  browser: the order reached `authorized`, the ledger shows one `authorized` entry, and
  dispatch was queued. The `providerRef` is **the same intent that was prepared**, so the
  one-order-one-intent guard holds under a real browser and not just under the fake.

  Repeat with `scripts/verify-card-form.ts <pay-url> [--pay]`. It drives the Chrome already
  installed rather than downloading one, via `playwright-core`.

---

## 3. Open questions needing an answer

### A. Ceiling reconciliation — **DECIDED (2026-09-17), pending one confirmation**

When `amount_is_final` is false, the merchant adds tax at checkout and the quoted figure is a ceiling the real charge stays under. The actual charge can come in **below** what the fan approved.

**What the live sandbox actually did**, which turned this from theoretical into concrete:

```
charge_estimate_minor  1300   <- what it expected to cost
charge_cap_minor       1495   <- estimate + 15% headroom
amount_is_final        false

merchant charged       1300   <- exactly the estimate; the headroom was unused
we held                1794   <- cap 1495 + fee 299
we captured            1794   <- so the fee we KEPT was 494, having shown 299
```

**Decision: keep only the platform fee.** The fan is charged the merchant's real
figure plus the fee they were shown. Implemented as a **partial capture** rather
than capture-then-refund: we authorised the ceiling precisely so we could capture
any amount up to it, so the fan is charged the right number once instead of being
charged the maximum and refunded the difference (two statement lines, a refund
fee, and a window where their money is gone).

- **Implemented in:** `src/domain/charge.ts`, used by `src/orders/reconciler.ts`
- **Evidence:** `scripts/smoke-charge.ts` (17 checks)
- **Refuses rather than guesses:** an order whose merchant charge is unreported is
  handed to an operator, not captured at the authorised total. The hold is still
  live, so waiting costs nothing.

**✅ FR-3.9 reconciled (2026-09-17).** The requirement originally said the fan is
"shown and charged the platform's own approved total", which the decision above
contradicts. That clause ended with the difference being "reconciled internally
under the platform's stated policy" — a placeholder for a decision that had not
been made. It now does state it: FR-3.9 keeps the binding and never-more clauses,
and FR-3.9a–c record the policy, the disclosure and the never-guess rule.

Two clauses of the original are deliberately superseded:

| FR-3.9 clause | Now |
| --- | --- |
| "never be charged more than the total they approved" | retained, unchanged |
| "reconciled internally under the platform's stated policy" | now stated (FR-3.9a) |
| "shown and charged the platform's own approved total" | superseded: charged the real cost plus the shown fee |
| "not presented to the fan as their price" | retained in intent (FR-3.9b): the merchant's figure is still never shown alone as the fan's price |

**✅ R-4 resolved.** It said a non-final quote shall "re-quote immediately before
capture". We do not re-quote; we read the merchant's settled `amount_charged_minor`.
That is better evidence than a fresh estimate, because it observes a charge that
has already happened rather than predicting one. R-4's intent — never treat the
ceiling as the settled price — is what the implementation enforces.

**Still open for legal:** the disclosure wording in FR-3.9b, per market.

**✅ Confirmed against the published API, 2026-09-18.** The two amount semantics are
not our interpretation, they are the documented contract:

> When `amount_is_final` is true the total is tax-inclusive and `expected_amount_minor`
> IS the charge. When it is false the merchant adds tax at checkout, and
> `expected_amount_minor` is a CEILING the real charge stays under.

And on `amount_charged_minor`, the field the partial capture reads:

> What the merchant's own page said. **Report THIS to the user**; it can be below the
> approved figure.

The docs even prescribe the wording we arrived at independently — "subtotal plus tax,
never more than X". So the question "can a quote return the final tax-inclusive total
before dispatch?" is answered: it can when `amount_is_final` is true, and on the markets
where it is false there is no earlier figure to get, because the merchant itself has not
computed it yet. Partial capture is therefore not a workaround. It is the only way to
charge the right number.

### F. Reversed: what the published API confirmed about the build

Recorded because a verification pass that only ever adds work is not a verification
pass. Every item below was checked against `docs.agnic.ai` and the code already did it:

| Documented behaviour | Where we already handle it |
|---|---|
| A `202` with `approval_required` is not a failure; retry with the `approval_token` | `src/orders/dispatcher.ts` sends it; FR-4.6 sanctions exactly one retry |
| Terminal statuses include `payment_unconfirmed`, `payment_gate_hit`, `price_changed`, `explored` | `src/domain/provider-status.ts` |
| `retryable: null` means "nobody knows and money may have moved" | `nextOrderAction`, and the operator view reads state before derived action |
| **There are no webhooks yet — polling is the documented path** | We poll. The Stripe webhook we added is for the *fan* rail, a different system |
| `shopify_amount_changed` and `constraint_violated` are `409`s before any charge | `src/orders/dispatcher.ts`, covered by `scripts/smoke-cap-refusal.ts` |
| A province is required for CA, US and AU | `toShipTo` |

**One real limitation, now documented rather than assumed away.** Confirmation tokens are
a tool-layer feature: "Over HTTP that binding does not exist — the second check still
happens, and a breach is still a 409 before any charge, but nothing stops the caller
sending different caps the second time."

Since we *are* the HTTP-only caller, that binding is ours to provide, and we already
have: the `ApprovedRequest` stores a digest of the destination taken at approval, and
dispatch refuses if the creator's address no longer matches. `constraints` are not bound
the same way — the provider re-checks them against a fresh cart, so a breach is caught
before any charge, but a caller could in principle send different caps on the retry. We
never do, because we replay the frozen request rather than rebuilding it. Worth knowing
that the guarantee comes from our code, not from the provider's. The
policy is decided; how it must be *stated* in CA/GB/US/AU is not.

### B. Does a refund/void operation exist at all? — **ANSWERED: NO**

**Confirmed by Agnic directly, 2026-09-18.** Asked and answered: the operation does not
exist. That matters more than it sounds, because documentation is evidence about what is
documented — support knows about the endpoints that were never written down. This is now
settled rather than inferred.

Read from the published Checkout API reference at the same time, which agrees. The complete
surface is twelve routes, and none of them reverses a charge:

```
GET  /api/autofill/merchants                  GET  /api/autofill/orders
GET  /api/autofill/merchants/{id}             GET  /api/autofill/orders/{id}
POST /api/autofill/shopify/quote              GET  /api/autofill/orders/{id}/evidence
GET  /api/autofill/cards                      GET  /api/autofill/reliability
GET  /api/autofill/products/search            POST /api/autofill/explore
GET  /api/autofill/products/lookup            POST /api/autofill/dispatch
```

No refund, no void, no cancel. The docs also state the position directly: **"The
merchant. Every order is charged by the merchant through its own payment
processor. Agnic never holds or moves funds."** A party that never holds the money
cannot give it back, so R-13 stays a triage queue with a human in it, and the
manual merchant-side refund is not a stopgap — it is the only possible design.

**This closes the question for good.** It is no longer "assumed none, worth confirming"
and it is not waiting on an email. If a refund endpoint ever ships, R-13 becomes
automatable and this is the line to revisit; until then, building one is not a backlog item,
it is a wish.

The *fan* rail's refund (`PaymentPort.refund`) remains a different thing and stays
real.

### C. Markup disclosure policy per country

We compute a markup and it is ours to set. Whether it must be itemised, and how, varies by market (CA, GB, US, AU). Needs legal input; the design plan already carries candidate copy.

### D. Does the sandbox accept `ship_to`? — **answered: yes**

Live orders have shipped to the creator's address with `ship_to` supplied on the dispatch. The provider's note about the third-party delivery path being broken referred to a period before 13 September 2026.

### E. Fan authentication mechanism — **DECIDED (2026-09-17)**

Chosen: **email plus a one-time code**, sessions in a signed httpOnly cookie. No new
infrastructure, no dependency, no bill — and the address is *verified* rather than
merely asserted, which is what makes it authentication rather than a shared secret.

Email delivery is the one stubbed piece. That is a deployment decision (which
provider, which key), not a code one, so it is left as a single function.

**Consequence worth knowing:** orders created before this change carry `fanId: 'guest'`
and are now visible to nobody but the operator queue. They are demo rows;
`scripts/cleanup.ts` removes them.

---

## 4. Deliberate design calls worth not re-litigating

- **Two rails, two refund paths.** `PaymentEvent` is the fan rail's ledger, so `refunded` in it asserts the fan's money came back. A merchant-side refund alone would be a lie, so operator refunds reverse the fan's charge through the payment rail and refuse to mark the order refunded if that fails.
- **The webhook records; it does not transition.** The reconciler is the single writer of order state, because the decision depends on the merchant rail as well. Two writers would let the rails disagree about the same order.
- **Card entry is not an FSM state.** While a fan types digits, "was I charged?" is still no — the same answer as `draft`.
- **The request is frozen before any hold exists.** A hold must never exist against a request we have not committed to.
- **`release` refuses on a captured intent, and `capture` checks its own amount.** Both guards exist because the alternative is telling a caller something untrue about money.
- **Curation verifies before it stores.** An item on a wishlist is a promise that a fan can buy it, so an unverifiable link is refused at the point a creator pastes it rather than discovered by a fan at checkout.
- **The address is encrypted; its digest is not, and should not be.** The digest is taken over the plaintext destination, so rotating the encryption key cannot change it. Encrypting it would make every rotation invalidate every outstanding approval — a key-management chore silently converted into cancelled orders.
- **A missing encryption key throws rather than falling back to plaintext.** A fallback is not a safety net; it is a configuration bug that only appears in the environment where nobody checked.

---

## 5. Accepted risks

Consciously accepted, with the reasoning recorded so they are not rediscovered as surprises.

| Risk | Why accepted |
|---|---|
| `Math.random()` in cuid v1 is not a CSPRNG | ~41 bits behind auth and an ownership check. Recovering PRNG state would require observing raw outputs and modelling cuid's exact usage. Not a realistic path. |
| The merchant may see the delivery address as the billing address | Provider reports this via `billing_uses_ship_to`. Disclosed to the creator; does not breach the fan-facing boundary. |
| A successful checkout is not proof of delivery | No copy may imply movement until a shipped status arrives. "Your gift is ordered" is the strongest honest claim. |
| No webhooks — polling only | Added latency on status changes. Bounded by polling at ~3s. |
| 200 orders/day cap | The limit that bites first under a viral moment. Needs the outbound throttle before launch. |
| Polling reads the delivery address in the evidence bundle | Raw responses are never forwarded to a fan; the operator view is role-gated. |

---

## 6. Invariants that must survive into the UI

A checklist for whoever builds the screens. Each of these is a way to break the product while looking fine.

1. **`order_url`, `live_view_url` and the evidence bundle never reach a fan.** They stream the checkout and retain the address in full.
2. **A ceiling is never presented as a total.** Label it, or do not offer payment.
3. **A withheld amount is never rendered as `$0.00`** and never reuses a previous total. Show no number at all.
4. **A `null` retry state is never rendered as failure.** Evaluate `retry_action` first.
5. **"Ordered" is not "on its way."** Success confirms checkout, not delivery.
6. **A released hold is never shown as a charge**, and an unknown outcome is never shown as either.

---

## 7. How we got here

A short index so this document does not have to be read in isolation.

| Document | Covers |
|---|---|
| `creator_wishlist_requirements.md` | Requirements, corrected against the provider's real API and the official build guide |
| `creator-wishlist-design-plan.md` | Screens, states, and the copy contract |
| `agnic-setup-checklist.md` | Sandbox setup, in order, with the permanent-failure traps called out |
| This file | What is deferred, missing, or unanswered |

Four smoke scripts currently prove specific claims against a real database rather than asserting them:

| Script | Proves |
|---|---|
| `scripts/smoke-db.ts` | The client connects, and `FOR UPDATE SKIP LOCKED` executes |
| `scripts/smoke-scenarios.ts` | Every chaos case routes to the right action and copy; dispatch-once holds |
| `scripts/smoke-binding.ts` | `jsonb` reorders keys, so digests must be canonical; address and amount changes are caught |
| `scripts/smoke-outbox.ts` | Concurrent workers never share a claim; a stalled dispatch is never requeued |
