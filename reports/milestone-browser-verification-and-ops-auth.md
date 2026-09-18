# Milestone — Browser verification, operator access, and two real bugs

**Scope:** close the remaining gaps and verify the parts that had never run against
reality.
**Status:** complete. 187 unit tests, 17 smoke suites, clean typecheck, clean build.

---

## 1. What was asked, and what happened

The remaining list was four items: config that was broken, three features that were gaps,
and two questions waiting on the provider. All four are closed, and **two real bugs were
found on the way — one of them in the money path.**

| Item | Outcome |
| --- | --- |
| `SESSION_SECRET` missing | Fixed. `/fan/login` was a 500 |
| Stripe Elements form never rendered | Rendered. **Not an app bug** — see §3 |
| Real Stripe webhook delivery | Not closed — needs an interactive `stripe login`. See §7 |
| `/ops` authentication | Built, with fail-closed config |
| Creator address form | Built |
| Email delivery for login codes | Built, behind the existing seam |
| Agnic refund/void + final total | **Answered from the published API.** See §6 |

---

## 2. Two bugs found by looking at the running app

Neither was reachable from the test suite, and both were found by opening the UI.

### 2.1 A money bug in the operator resolve form

`ResolveForm` carried the operator's decision on the button:

```tsx
<button type="submit" formAction={resolveStuckOrder} name="decision" value="succeeded">
```

**That does not work when `formAction` is a server action.** React needs the `name` for its
own action encoding and overrides it, so `decision` never arrived. `resolveStuckOrder` then
fell through to its default:

```ts
const decision = field(form, 'decision') === 'succeeded' ? 'succeeded' : 'failed';
```

`failed` is the **release** path. So an operator clicking **"It completed — charge"** would
have released the fan's hold instead of charging — leaving the merchant paid and the fan
refunded, with the order marked as never having completed.

Two more faults were stacked on top, each hiding the next:

- The confirmation guard read `new FormData(event.currentTarget)`, where `currentTarget`
  is the button. `new FormData(button)` throws, so the dialog that exists to make an
  operator read the consequence **never ran**.
- The action defaulted a money decision instead of refusing one. This is the real defect:
  the other two are how a missing field happened; this is what made it mean something.

Fixed: the decision travels in a hidden input the click handler sets, the guard reads from
the form, and an unrecognised decision now **refuses the whole operation**. A money
decision is never a safe default.

**Why nothing caught it.** `resolveOrder` was correct and stayed correct. The value simply
never reached it, and `scripts/smoke-operator.ts` exercises the domain, not the form. No
amount of domain testing could have found this. So `vitest` now includes `*.test.tsx`, and
`src/app/ops/ResolveForm.test.tsx` asserts the wiring directly — 7 tests, one of which
asserts the decision is *not* on a submit button, so this cannot come back.

### 2.2 Two crypto tests that were flaky at a 25% rate

`address-crypto.test.ts` tampered with a value by rewriting its last base64 character:

```js
const flipped = `${tag.slice(0, -1)}${tag.slice(-1) === 'A' ? 'B' : 'A'}`;
```

In a base64 group encoding a single trailing byte, the last character's **low four bits are
padding**. So 2⁴ = **16 of the 64 characters decode to byte-identical output**. Verified:

```
encoded 16 bytes : QUFBQUFBQUFBQUFBQUFBQQ
last character   : Q
chars decoding to the SAME bytes: Q R S T U V W X Y Z a b c d e f
```

Replacing the last character with `A` is therefore a no-op whenever the original is one of
those 16 — nothing is tampered with, decryption correctly succeeds, and the test fails.
**One run in four was passing without testing anything**, which is worse than a test that
fails, because it looks like coverage.

Fixed by decoding, flipping a real bit, and re-encoding. Confirmed with 12 consecutive runs.

---

## 3. The Stripe card form: a negative result, properly established

The Elements form "did not render" on first look. It does render. Establishing that took
five steps, and the useful part is *how* it was established rather than the conclusion:

| Step | Finding |
| --- | --- |
| Screenshot | No card fields visible |
| Accessibility tree | An iframe **is** present |
| `getBoundingClientRect` | The "Secure payment input frame" is **2px tall** |
| MutationObserver | 5 frames, mounted once — **no re-render loop** |
| Intent inspection | Healthy: `requires_payment_method`, 1200 CAD, manual capture, `card` enabled |
| Client-side check | Both keys reach the browser; Stripe.js loads; `api.stripe.com` reachable |
| **Hand-mounted a `PaymentElement` with raw Stripe.js, outside the app** | **Also 2px** |

That last row is the one that matters. A minimal, textbook mount — no app code involved —
behaves identically, so the app is not the cause. It is the VS Code integrated browser
(an Electron webview) failing to lay out Stripe's frame.

**What this does and does not establish.** The server side is proven: a real
`pi_...` intent was created, the order was frozen before the hold, and the page computed a
client secret. The *visual* card form is still unverified, and now it is unverified for a
stated reason rather than an unknown one. **Open it in a real browser to close it.**

`scripts/live-card-step.ts` exists for that: it parks an order at the card step against the
real rail and prints a URL. `scripts/inspect-intent.ts` prints what Stripe thinks of an
intent, which is the difference between diagnosing this in five steps and guessing for an
afternoon.

---

## 4. Operator access

`/ops` can refund a fan, charge a merchant and close an order. It now requires a password.

**The property that matters: unconfigured means closed, not open.** With no `OPS_PASSWORD`,
`/ops` refuses everyone and says so. An access control whose absence silently means "allow
everyone" is worse than none, because it looks like a control in the code and behaves like
a doorman who went home.

**The guard is in the actions, not in middleware.** Two reasons, both real:

1. **A server action is addressable by its own id**, so a crafted POST can invoke one
   without ever rendering the page that guards it. Middleware protects a render; the money
   is in the actions. Both are guarded, and the action guard is the one that counts.
2. Middleware runs on the Edge runtime, where `node:crypto` HMAC is not dependable.

The session is signed with a key **derived from `SESSION_SECRET` with a domain separator**,
so an ops cookie can never validate as a fan cookie even though both are HMACs over a
similar payload. Sharing a key without a prefix is how one system's token becomes another's
credential.

**Also fixed:** the address-bearing fields stay redacted on `/ops` even now that sign-in
exists. A shared password proves *that* someone is an operator, never *that this person*
should see a fan's address — so the redaction stays on, and turning it off should wait for
per-person accounts.

20 unit tests, weighted towards the fail-closed branches.

---

## 5. Creator address form, and email delivery

**The creator address form** closes a gap that made the encryption work partly decorative:
`writeCreatorAddress` was the only encrypted write path and **nothing in `src/` called it** —
only the seed scripts. Now `/creator/[slug]` has a form, and saving a new address
demonstrably invalidates approvals given against the old one.

**It deliberately does not read the address back.** The page knows only whether one exists
(`currentAddressIdFor`, which needs no decryption and writes no audit row). Reading a real
address back would mean adding the creator's own role to `ADDRESS_READER_ROLES`, and *who
may see a delivery address* is a product decision rather than a form detail. Replacing one
needs no such decision. If read-back is wanted, that is the trade to make explicitly.

**Email delivery** replaces the stub behind the `send` seam that already existed. Two rules,
both about failing in the right direction:

- With a provider configured, a failure **throws**. A code that quietly fails to send is
  worse than an error, because the fan waits for an email that is never coming.
- With no provider, logging is allowed in development and **refused in production**. A
  valid login code in a log file is an account for anyone who can read the log.

12 unit tests, mostly on the failure paths.

---

## 6. The provider questions, answered from the published API

Both were on the "email Agnic" list. The docs answered them, and one answer **confirms the
partial-capture decision rather than challenging it.**

**Does a refund or void exist? No.** The entire Checkout surface is twelve routes and none
reverses a charge. The docs state the position directly:

> The merchant. Every order is charged by the merchant through its own payment processor.
> Agnic never holds or moves funds.

A party that never holds the money cannot give it back. So the manual merchant-side refund
is not a stopgap — it is the only possible design, and R-13 stays a triage queue with a
human in it.

**Can a quote return the final tax-inclusive total? Only when the merchant has computed
it.** The two amount semantics are the documented contract, not our reading of it:

> When `amount_is_final` is true the total is tax-inclusive and `expected_amount_minor` IS
> the charge. When it is false the merchant adds tax at checkout, and
> `expected_amount_minor` is a CEILING the real charge stays under.

And on `amount_charged_minor`, the field our partial capture reads:

> What the merchant's own page said. **Report THIS to the user**; it can be below the
> approved figure.

The docs even prescribe the wording we arrived at independently — "subtotal plus tax, never
more than X". On tax-added markets there is no earlier figure to obtain, because the
merchant has not computed it yet. Partial capture is the only way to charge the right
number.

### Verified, not just read

Every documented behaviour was checked against the code, and it already handled all of it:
the `202`/`approval_token` retry, the terminal statuses including `payment_unconfirmed` and
`payment_gate_hit`, `retryable: null` meaning "nobody knows", `shopify_amount_changed`,
and the absence of webhooks.

**One limitation, now documented rather than assumed away.** Confirmation tokens are an
MCP-layer feature; over HTTP, "nothing stops the caller sending different caps the second
time". We are the HTTP-only caller, so that binding is ours — and we have it: the
`ApprovedRequest` stores a digest of the destination taken at approval, and dispatch
refuses if the address has moved. Worth knowing the guarantee comes from our code, not the
provider's.

---

## 7. What is still open

- **The card form has never been seen rendering.** Now for a known reason (the preview
  browser), and `scripts/live-card-step.ts` makes it a two-minute check in a real browser.
- **No real Stripe-delivered webhook.** Closing this needs `stripe login`, which is
  interactive, so it is a human step. Signature verification is already covered against the
  route with locally signed payloads.
- **Operator identity.** `/ops` proves *that* someone is an operator, not *which* one, so
  the actor on a refund or a resolution is still the constant `'operator'`.
- **Address read-back for creators** — a product decision, deliberately not taken.
- **Legal:** the FR-3.9b disclosure wording per market.

---

## 8. Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` (app + scripts) | clean |
| `npm test` | **187 passed**, 11 files |
| `npm run build` | clean, 9 routes |
| `scripts/smoke-*` | **17/17 pass** |
| Address ciphertext in Postgres | confirmed |
| Tamper tests, 12 consecutive runs | 0 failures |
| `/ops` unauthenticated | redirects to `/ops/login` |
| `/ops` sign-in | reaches the queue, address data still redacted |
| Creator address save | "Address saved, encrypted", new ciphertext verified in Postgres |

Test count moved 148 → 187 (+20 operator auth, +12 email, +7 resolve form).

---

## 9. Addendum — both remaining verification gaps closed

§7 listed two things as still open. Both are now closed, and neither needed a decision.

### 9.1 The card form renders, and has taken a payment

The 2px measurement was the VS Code integrated browser, and the app was already clear. Real
headless Chrome — driven by `playwright-core` against the Chrome already installed, so no
150MB download — measures the payment frame at **126px**, with the pay button enabled and
Stripe's own "Powered by Stripe" widget present.

Better than rendering, it took a payment. `scripts/verify-card-form.ts <url> --pay` fills
the Stripe test card and confirms, and the result is not a screenshot but a database state:

```
FanOrder  cmu6jiksz000408kp7teaa9a1   authorized   1200   pi_3UGuhMCbMbWV1nTK0dqQl5Ki
ledger    authorized  pi_3UGuhMCbMbWV1nTK0dqQl5Ki  1200
outbox    dispatch.merchant_order  pending
```

Two things in that output matter more than the others:

- **`providerRef` equals the intent reference that was prepared.** One order, one intent —
  the guard that exists because the fake cannot represent two intents. It now holds under a
  real browser and real Stripe.js, not only under the fake.
- The four checks of the card path are all real: real browser, real Stripe.js, real iframe,
  real authorization.

**A 404 that is not a bug.** After confirming, the page redirects to `/orders/...` and the
headless browser (having no session) gets `notFound()`. That is the intended design — a
guessed order id must not confirm the order exists — so the 404 is the ownership check
working, not a broken redirect. Worth stating because it looks alarming in a log.

### 9.2 A real Stripe event has been delivered

Previously unclosed because `stripe login` is interactive. It is avoidable: the CLI accepts
`--api-key`, and `listen --print-secret` returns the signing secret without a browser. The
CLI was downloaded to `.tools/stripe/` — unpacked, not installed, no elevation, gitignored.

```
--> payment_intent.succeeded [evt_3UGuk4CbMbWV1nTK0gf9lmvP]
<--  [200] POST http://localhost:3000/api/stripe/webhook
```

and on the app side:

```
POST /api/stripe/webhook 200 in 635ms
```

So signature verification is no longer only tested against payloads we signed ourselves. The
event was one Stripe actually sent, over the wire, and the route accepted it.

**One security note.** The `whsec_...` in `.env` is a real credential for the test account.
It is only valid for a listener on this machine, but it should be regenerated with
`--print-secret` if this repository is shared — and it appeared in a terminal transcript
during this work, which is the reason to say so.

### 9.3 Fixed on the way

`scripts/live-card-step.ts` had a `--keep` flag that was worse than useless: skipping the
cleanup meant the next `creator.create` hit the unique slug and the script died with a Prisma
error, so it only ever worked on a fresh database. Removed — the script is now always
re-runnable, and the doc comment says why the flag is gone rather than silently not existing.

### 9.4 Final state

| Check | Result |
| --- | --- |
| `npm run typecheck` (app + scripts) | clean |
| `npm test` | **187 passed**, 11 files |
| `npm run build` | clean |
| `scripts/smoke-*` | **17/17 pass** |
| Card frame in real Chrome | 126px, rendered |
| Full card payment | `authorized`, one intent, dispatch queued |
| Real Stripe webhook | delivered, signature verified, 200 |

What is left is no longer verification. It is **operator identity** (a shared password
proves *that* someone is an operator, not *which* one), **address read-back** (a product
decision, deliberately not taken), the **legal markup wording**, and deployment items that
were deferred on purpose.
