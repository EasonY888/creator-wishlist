# Judge brief — Creator Wishlist (Track 01, Agentic Checkout)

Everything you need to demo this and to answer questions about it. Read this the night
before, not on stage.

**Demo Day:** Monday 21 September, 10:30–13:30 ET · OneEleven, 325 Front St W, 4th floor
(or present online) · 10 finalist demos.

---

## 1. The ten-second version

> Agnic answers *can an agent complete a checkout*. We answer *what did the fan approve, and
> did they pay exactly that* — because the merchant's final total isn't knowable in advance.

Track 01's own promise is our headline, and it is the thing we protect hardest:

> **The creator's home address never reaches the fan.**

Track 01 asks for four things: discover products, add your markup, automate checkout, protect
delivery addresses. Track 01 also says who does what, and we match it exactly:

| You build | Agnic handles |
| --- | --- |
| Creator accounts, wishlist storage, **fan payments** | Finding products, quoting delivery, executing merchant checkout |

---

## 2. The three-minute demo

Order matters. Do **not** start with the code — start with the promise, then prove it.

### Beat 1 — the wishlist (20s)

Open `/w/demo-creator`.

> "Maya lists what she'd love. Fans pick a gift. And the thing that makes this work at all:
> **her address is never shown to the fan.** Here's the promise on the fan's own page."

Point at: *"Gifts ship to Demo Creator. Their address is never shown to you, and never
appears on anything you can see."*

### Beat 2 — the price the fan approves (30s)

Click through to checkout.

> "We don't know the final total before checkout — the shop adds tax. So the fan approves a
> **ceiling**, and the UI says so. It never presents a ceiling as a total."

### Beat 3 — the card step (30s)

Open the pay page (`scripts/live-card-step.ts` prints a URL).

> "Card data goes straight to Stripe — it never touches our servers, and never touches the
> model. We hold the money here; we don't take it."

### Beat 4 — **the money moment** (60s) ← this is the one that wins

Show `/ops/evidence` and these numbers. Tell it as a bug found and fixed, because that is
what it is:

```
fan approved              1794      <- the ceiling
merchant charged          1300      <- real Agnic settlement
captured AT THE TIME      1794      <- the whole ceiling. THE BUG.
fee kept then / shown     494 / 299 <- a 1.95 overcharge, per order

today's code, same input  1599      <- merchant cost + the fee SHOWN
fee kept now / shown      299 / 299 <- correct
```

> "We captured the authorised total and kept 4.94 while showing 2.99 — a 1.95 overcharge the
> fan would only have found on their statement. Capturing the ceiling and refunding the
> difference is the obvious implementation, and it's wrong twice: two statement lines, a refund
> fee, and a window where the fan's money is gone. So we capture once, for the right number.
>
> We found this against the live sandbox — the merchant charged **less** than the ceiling, and
> no double can produce that, which is why a green test suite didn't catch it."

**Say the provenance before you're asked.** The merchant settlement is real Agnic traffic;
that order's fan rail ran on the in-memory double, which the `pay_…` refs show. The live
Stripe rail was exercised separately — a real `pi_…` intent, authorised, hold confirmed.

### Beat 5 — the controlled refusal (30s)

```
npx tsx scripts/demo-cap-refusal.ts
```

> "A cap the shop's price exceeds is refused **before any card exists**. 409,
> `constraint_total_exceeded`, and the provider has no record of an attempt — so there is
> nothing to unwind and no fan money involved."

### Beat 6 — close on the promise (20s)

```
npx tsx scripts/demo-address-protection.ts
```

Six steps, ending with Maya moving house and the order refusing. Land the one-liner in §5.

---

## 3. Architecture

### Two rails, and they are not symmetrical

```
        CREATOR                     FAN                        MERCHANT
   wishlist, address          card, approval, receipt        the shop
          |                          |                            |
          |                    ┌─────▼─────┐                ┌─────▼──────┐
          └───────────────────►│  FAN RAIL │                │MERCHANT RAIL│
                               │  Stripe   │                │ Agnic HTTP  │
                               │ hold→capture             quote → dispatch → poll
                               └─────┬─────┘                └─────▲──────┘
                                     │                            │
                                 ┌───▼────────────────────────────┴───┐
                                 │        ORDER STATE MACHINE          │
                                 │  ONE writer: the reconciler         │
                                 └────────────────┬────────────────────┘
                                                  │
                                          ┌───────▼────────┐
                                          │ ops queue      │
                                          │ (a human, last)│
                                          └────────────────┘
```

**Why two rails.** The merchant charges *us*; we charge the *fan*. Those are different
systems with different failure modes, and conflating them is how you end up telling a fan
they were refunded because a merchant refund was recorded. So `PaymentEvent` is the **fan
rail's ledger**, and writing `refunded` into it asserts the fan's money came back — which is
why an operator refund reverses the fan's charge through Stripe and *refuses* to mark the
order refunded if that call fails.

**The merchant is merchant of record.** Agnic never holds funds — confirmed against their
docs and their support. There is no refund endpoint to call, so merchant-side refunds are
manual and an operator records the reference as evidence. That is not a shortcut; it is the
only design the rail permits.

### The state machine

```
draft → approved → authorized → dispatching → processing → succeeded
                                  │              │
                                  │              ├→ uncertain ──┐
                                  ├→ approval_required ─────────┤
                                  │                             │
                                  └─────────────────────────────┴→ failed
                                                        succeeded → partially_fulfilled → refunded
```

Two properties worth saying out loud:

- **`approved` means the request is frozen and no money is held yet.** Order matters: a hold
  must never exist against a request we haven't committed to.
- **`uncertain` is a first-class state, not an error.** When the provider returns
  `retryable: null` — "nobody knows and money may have moved" — we stop and escalate. We
  never guess, and we never blindly release.

### The worker — what "the agent" means here

```
outbox → claim (FOR UPDATE SKIP LOCKED) → dispatch once → poll → decide → capture | release
                                                                    │
                                                    can't decide? → human_handoff → ops
```

- **One order, one dispatch.** A dispatch is idempotency-keyed, and the only sanctioned
  retry is the documented approval continuation carrying the `approval_token`.
- **One order, one intent.** `authorize` always resolves the order's *existing* intent before
  doing anything. This was a real double-hold bug that only the live processor exposed —
  a fake cannot represent two PaymentIntents.
- **The webhook records; it does not transition.** Two writers of order state would let the
  rails disagree about the same order, so the reconciler is the single writer.

### The money path

`fanChargeFor({ merchantChargedMinor, markupMinor, authorizedMinor })` is the only place the
fan's charge is computed, and it **blocks rather than guesses**:

| Blocks on | Why |
| --- | --- |
| `merchant_amount_unknown` | We'd be inventing a number |
| `exceeds_authorization` | Never more than the fan approved. Ever. |
| `negative_markup`, `non_positive_charge` | Nonsense in, refused |
| `merchant_amount_invalid` | A figure we can't trust |

When it blocks, the reconciler writes an order event and hands to an operator with **nothing
captured**. The hold stays live, which is the point: waiting is free, guessing is not.

### Address protection — six layers

This is the track's promise, so know it cold.

| Layer | Mechanism |
| --- | --- |
| **Write** | AES-256-GCM inside `writeCreatorAddress` — the only function that can write it. `v1.<keyId>.<iv>.<tag>.<ct>` |
| **No fallback** | A missing key **throws**. A plaintext fallback is a config bug that hides until production |
| **Isolation** | Its own table. If it were columns, the boundary becomes "which queries remember to exclude them" |
| **Read** | One role-gated function, audit row written **before** decryption. The decrypt helper is not exported |
| **Binding** | The approval stores a **digest of the destination, not the destination**. Covers the whole frozen request |
| **Fan surfaces** | Never had the field. The DTO leak guard is **non-vacuous** — prove it on an operator payload and it names the fields |

The digest subtlety is worth one sentence on stage, because it's the sort of thing that
impresses payments people:

> "The digest is over the plaintext on purpose. If it were over the ciphertext, rotating the
> encryption key would change it — and a key-management chore would silently cancel every
> outstanding approval."

---

## 4. Design decisions, and why

Have these ready. Each is a decision *not* to do the obvious thing.

| Decision | Why |
| --- | --- |
| **No LLM in the spend path** | The "agent" is the dispatch worker. The challenge's own fireside chat is about guardrails; an LLM next to a money decision is an unbounded-spend bug, not a feature. An LLM belongs in curation ("a streaming setup under £400"), which is nowhere near money |
| **HTTP only, not MCP** | The build guide targets HTTP and forbids mixing contracts. We also *gained* from it: confirmation tokens are an MCP-layer feature, so over HTTP the binding is ours — which is why the approval digest exists |
| **Manual capture** | Hold now, capture only once the merchant confirms. The fan isn't charged for a purchase that may fail |
| **Partial capture, not capture-and-refund** | Charged the right number once, instead of the maximum and refunded |
| **No webhooks on the merchant rail** | There aren't any — polling is the documented path. We poll at 3s |
| **A released hold is never shown as a charge** | And an unknown outcome is never shown as either |

---

## 5. The sentence to close on

> "Maya's address is encrypted before it's stored, in the only function that can write it. It
> lives in its own table, so no query can leak it by forgetting to exclude it. Reading it
> needs a role and writes an audit row. The approval keeps a digest of the destination rather
> than the destination, so if she moves house the order refuses rather than ships to the wrong
> place. And no fan-facing screen has ever had the field."

---

## 6. Likely questions, with answers

**"Why doesn't the agent use an LLM?"**
It does — it's the dispatch worker, and the challenge defines the agent as the thing that
finishes the purchase. What it doesn't do is let a model choose an amount. Every number in the
spend path is either the fan's approval or the merchant's own report.

**"What if the merchant charges more than the fan approved?"**
It can't reach the fan's card for more — we authorised a ceiling and capture at or below it.
If the merchant's figure somehow exceeds the authorisation, `fanChargeFor` blocks and nothing
is captured.

**"What if you never learn what the merchant charged?"**
We don't capture. The hold stays live and it goes to an operator. Waiting costs nothing;
guessing costs the fan money.

**"What stops a double charge?"**
Three layers: idempotency keys on every rail call, `authorize` resolving the order's existing
intent rather than creating a second one, and dispatch-once with exactly one sanctioned retry.

**"What happens when the agent can't finish?"**
`uncertain` is a real state. It escalates to the ops queue with the provider's own reason, and
a handoff that nobody picks up escalates again after 15 minutes.

**"Who is merchant of record?"**
The merchant. Agnic never holds funds. We refund the *fan* rail; merchant-side refunds are
manual, with an operator-recorded reference.

**"How do you know the fan approved?"**
A frozen request written before any hold exists, the fan's literal words stored verbatim as
dispute evidence, and a digest that makes the request tamper-evident.

**"Where's the business model?"**
A markup on the merchant's figure, shown to the fan as part of a total they approve — and
never presented as the merchant's price.

**"How does it scale?"**
The outbox claims with `FOR UPDATE SKIP LOCKED`, so workers scale horizontally without sharing
a claim. The first real limit is the provider's 200 orders/day cap.

**"What's not done?"**
Answer honestly — it buys credibility (§8).

---

## 7. Numbers to have in your head

| | |
| --- | --- |
| Sandbox shop | `merchant_untitled_fidget_shop`, Shopify rail, CAD |
| Item | Hex Token Fidget, 100 minor CAD |
| Shipping | Standard 1200 / Express 2000 |
| Live order | approved **1794** ceiling · merchant charged **1300** · captured **1794** (the bug) · fee kept then **494** vs shown **299** |
| Same inputs, today's code | captures **1599**, fee kept **299** ✓ |
| Live Stripe rail (separate) | real `pi_…` intent authorised, one order = one intent, hold confirmed |
| Cap refusal | quote 1495 vs cap 500 → **409 `constraint_total_exceeded`**, no order created |
| Address | AES-256-GCM · digest over plaintext · a house move refuses at dispatch |
| Tests | 187 unit, 17 smoke suites, 9 routes |

---

## 8. Honest limitations — say these before you're asked

Judges trust a team that names its own gaps.

- **`/ops` proves *that* someone is an operator, not *which* one.** It's a shared password, so
  a refund is attributed to a constant. Real accounts are next.
- **A creator can't read their own address back.** Deliberate: reading it would mean widening
  the reader allowlist, and *who may see a delivery address* is a product decision.
- **Merchant-side refunds are manual** — because no refund operation exists on the rail.
- **Operator auth is a single shared secret.** Fine here, not fine deployed.

---

## 9. Pre-flight, 10 minutes before

```
npx tsx scripts/preflight.ts        <- 19 checks. NO-GO is final.
npx tsx scripts/live-card-step.ts   <- parks an order, prints the URL
```

`preflight` covers the environment, the database, the app, the provider account and the demo
data, and prints the fix for anything broken. Every failure it looks for has already happened
once during this build — including **Docker Desktop not running**, which is a silent, total
failure.

Then: Tab A on `/w/demo-creator`, Tab B on `/ops/evidence` (sign in once), browser at ~125%,
notifications off.

**Have the fallback recorded.** A live dispatch takes 60–70 seconds; venue wifi does not care
about your demo.
