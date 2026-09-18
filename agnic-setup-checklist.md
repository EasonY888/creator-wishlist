# Agnic Sandbox Setup Checklist

**Why this file exists:** the demo rubric scores a *live* dispatch and a *controlled refusal when a spending cap is exceeded*. Both need working credentials. One step below (the mandate currency) fails **permanently** if done wrong, and the form's default makes it easy to get wrong.

Do these in order. Nothing here costs money — the sandbox runs on a real Shopify shop whose gateway is in test mode.

---

## Verified live — 2026-09-18

Checked against the real API, not assumed. Re-run any of this with
`npx tsx scripts/live-readiness.ts`.

| Check | Result |
|---|---|
| `GET /api/autofill/merchants` | ✅ HTTP 200 — **the token works** |
| `GET /api/autofill/merchants?q=untitled-fidget` | ✅ `merchant_untitled_fidget_shop`, `rail: shopify`, `default_currency: CAD` |
| `GET /api/autofill/products/search?country=CA` | ✅ live CAD products returned |
| `GET /api/autofill/cards` | ✅ **1 card — mastercard •••• 4444, default** |
| Account profile (nine required fields) | ✅ **complete** |
| CAD spending mandate | ✅ resolved by evidence — see step 4 |
| Controlled cap refusal, live | ✅ **409 `constraint_total_exceeded`** — see step 6 |

**The two blockers this file used to list are both closed.** The profile was missing eight
fields, which made a live dispatch fail at the shop's checkout as `CHECKOUT_INCOMPLETE`;
and a card was not vaulted. Both are done, and a live dispatch has since reached
`succeeded`. Re-check with `scripts/live-readiness.ts` before judging, because none of this
is visible from the code.

Two things this changes:

1. **The token is scoped for a different product than we assumed.** Its claims read `type: n8n_automation`, `networks: ["base","solana"]` (crypto rails), with `maxPerTransaction: 10`, `dailyLimit: 10`, `monthlyLimit: 100`. It nevertheless authorises the Agentic Commerce routes. Whether those caps apply to a card-funded merchant purchase is unknown — worth knowing before the demo, because a breach would appear as an approval-required or a refusal at dispatch.
2. **Onboarding a shop is the common path, not the edge case.** Live search results return `"merchant_id": null` with an `onboard.merchant_url` for most shops. That means `POST /explore` — up to two minutes — is required before most products can be quoted at all.

---

## 1. Account and token

- [ ] Create an account at `https://app.agnic.ai/dashboard`
- [ ] Create an API token
- [ ] Store it as `AGNIC_TOKEN` in the **server** environment only

**Never** expose it to client code, and never use a client-prefixed variable for it. The token authorizes spending on the platform's vaulted card.

The client base path is `https://api.agnic.ai/api/autofill`, authenticated with the header `X-Agnic-Token`.

---

## 2. Get a card on file — ✅ DONE 2026-09-17

**Vaulted:** Mastercard •••• 4444, expires 09/2028, default. Confirmed via `GET /api/autofill/cards`.

The card response returns `last_four` (not `last4`), plus `brand`, `exp_month`, `exp_year`, `is_default`.

### The callback URL

This app serves a return page at:

```
http://localhost:3000/agnic/card-return
```

It must be registered as a **redirect URI** on the OAuth client and passed as `return_url`. It handles both
signalling paths — `postMessage` on desktop, `?card=success` on mobile — and shows the resulting card list.

### How it was reached

```
https://app.agnic.ai/partner/cards/new?client_id={APP_CLIENT_ID}&return_url={URL_ENCODED}
```

**Still unverified: the spending mandate currency.** The sandbox is a CAD shop and the policy engine refuses
to convert, so a non-CAD mandate fails permanently on every dispatch.

**Now resolved by evidence rather than by a check.** An order in the local database reached
`succeeded` with the provider reporting `succeeded`, which cannot happen under a currency
mismatch — that returns `approval_required` / `currency_mismatch` on every dispatch instead.
So the mandate is CAD and working. The *reason* the rule exists is still worth keeping: it is
not a retryable failure, it is a configuration fault, and the only fix is a new mandate.

---

## 2b. Original notes, kept for reference

**There is no page in the dashboard for this.** It is a deep link your app opens, and it is gated on an approved OAuth client — which is why it cannot be found by browsing `app.agnic.ai`.

### Try this first

- [ ] Signed in, open `https://app.agnic.ai/partner/cards/new` directly

If it loads the card form, vault a test card and you are done. If it says *"This link is invalid"*, the deep link needs a `client_id`, and you need step 2b.

### If it needs a client_id

- [ ] Apply for an OAuth client at `app.agnic.ai/oauth-clients` (needs business details, acceptance of Schedule B, and possibly tax/compliance documents)
- [ ] Wait for approval — **typically 1 business day**
- [ ] Register a redirect URI on that client
- [ ] Open: `https://app.agnic.ai/partner/cards/new?client_id={APP_CLIENT_ID}&return_url={URL_ENCODED}`

`return_url` must match one of the client's registered redirect URIs, or the card form is never shown.

> If you see *"This app isn't approved yet"*, the client is still in review. That is the whole blocker — nothing else is wrong.

### The test card

| Field | Value |
|---|---|
| Number (Visa) | `4242 4242 4242 4242` |
| Number (Mastercard) | `5555 5555 5555 4444` |
| Expiry | any future date |
| Security code | any three digits |
| Name on card | at least two words |

The number goes into VGS-hosted iframes and straight to the vault — neither our servers nor Agnic's JavaScript ever see it. Do not vault a real card; test mode declines it anyway.

**One thing to be aware of:** in this flow the card belongs to the *signed-in Agnic account*, not to an app. That is consistent with our model — the platform's card pays the merchant — as long as we sign in as ourselves when vaulting it.

---

## 3. Complete the contact and billing profile — ✅ DONE 2026-09-18

**Was the blocker; no longer is.** `GET /api/profile` now reports every field the merchant
requires. Verified by `scripts/live-readiness.ts`, which checks exactly these nine.

The detail below is kept because the failure mode is worth knowing — it is silent, and it
looks like a broken shop.

`GET /api/profile` reported **eight fields missing**:

| Field | Status |
|---|---|
| `email` | ✅ set and verified |
| `given_name` | ❌ missing |
| `family_name` | ❌ missing |
| `phone_number` | ❌ missing |
| `street_address` | ❌ missing |
| `address_locality` | ❌ missing |
| `address_region` | ❌ missing |
| `postal_code` | ❌ missing |
| `address_country` | ❌ missing |

**Why this blocks everything.** The merchant's `required_pii` is exactly
`email, given_name, family_name, phone_number, postal_address.*`. The checkout engine has to fill the shop's
form, and it sources those from the account profile — not from `ship_to`, which only carries the destination.
With the profile empty, a live dispatch reaches the provider, creates an order, and then fails at the checkout
step:

```
status        : worker_error
error_code    : CHECKOUT_INCOMPLETE
error_message : We couldn't complete the checkout on the store's site.
charge_state  : attempted
```

**This is the prerequisite the guide warned about.** Its Setup section lists "complete contact/billing
profile" as a requirement, and the tool layer enforces it up front with a `setup_required` blocker. Over HTTP
there is no such preflight — the provider records the fact and lets the dispatch proceed. So the missing
prerequisite surfaces as a runtime checkout failure instead of an upfront refusal.

---

## 3b. Original note, kept for reference

The account's own profile matters even though our product keeps the creator's address separate: the shop's
form needs **the buyer's** name, phone and address. Those come from the Agnic account, because the platform —
not the fan — is the cardholder.

---

## 4. Issue the spending mandate — **in CAD**

- [ ] Issue a spending mandate
- [ ] Set its currency to **CAD**

**This is the step that fails permanently.** The sandbox shop is denominated in CAD, and the policy engine deliberately refuses to convert between currencies — converting at an unseen rate would hide spending behind a stale number. A mandate in any other currency returns an approval-required `currency_mismatch` on **every** dispatch, forever, until the mandate is reissued in CAD.

The mandate form's currency selector defaults to your profile's country. That default is exactly how this goes wrong.

A miss here is not a retryable failure. It is a configuration fault, and the only fix is a new mandate.

---

## 5. Confirm the sandbox shop is reachable

- [ ] `GET /api/autofill/merchants?q=untitled-fidget`

Expect a Shopify-rail merchant. Note that this route returns the ID as `id`, whereas product-search results expose it as `merchant.merchant_id` — two different field names for the same thing, and a reliable source of bugs.

The shop:
- two items at **1.00 CAD** — a hex token fidget and a paw print charm
- ships to Canada, the UK, the US, and most of western Europe
- prices in CAD, GBP and USD

Buy the one-dollar items. A fifty-dollar simulated order teaches nothing a one-dollar one does not.

### Confirmed by live call — use these

| | |
|---|---|
| Merchant id | `merchant_untitled_fidget_shop` |
| Rail | `shopify` |
| Currency | `CAD` |
| Hex Token Fidget | `gid://shopify/ProductVariant/43945235349570` (100 minor) |
| Paw Print Charm | `gid://shopify/ProductVariant/43945255567426` (100 minor) |
| Delivery options | Standard 1200, Express 2000 (both `requires_address`) |

**Note the search trap:** `products/search` returned 50 results for "charm" and **none** from this shop. The sandbox shop is not in the search index. Its SKUs came from a quote's `unknown_sku` suggestions instead. So do not plan the demo around finding it by search — seed the item directly.

---

## 6. Run the chaos tests once, by hand

The guide is explicit that "the failure paths are where an agent product is actually judged." Doing each of these once, on purpose, is worth more than reading about them. Several are also **scored demo paths**.

- [ ] Set `max_shipping_minor` to `1` → expect a constraint refusal at quote time, before any card is touched
- [ ] Change **one character** of the `ship_to` postcode between quote and dispatch → expect a body-mismatch refusal
- [ ] Request a `ship_to` at a merchant that is not on the Shopify rail → expect a refusal
- [ ] Quote an out-of-stock variant → expect `retryable: false` alongside a re-quote action
- [ ] Force a decline using Shopify's published decline test card numbers

The cap-exceeded refusal is a **demo requirement**, not a nicety. Record its exact response shape.

### ✅ Verified live — 2026-09-18

`npx tsx scripts/demo-cap-refusal.ts` runs the scored path end to end against the sandbox, and
the real answer is better than a mock:

```
1. quoting with no cap, to establish the real price
  real merchant total    1495 minor CAD
  final or ceiling?      ceiling

2. re-quoting with a cap of 500 minor
  state                  refused
  http status            409
  code                   constraint_total_exceeded

3. checking the provider recorded nothing
  (a refusal creates no order at all)
```

That is the whole demo in four lines: the shop wanted 1495, the cap was 500, the refusal
arrived **before any card existed**, and the provider has no record of an attempt — so there
is nothing to unwind and no fan money involved.

---

## 7. Know the three routine interruptions

None of these are failures. All three cost people an afternoon before they were written down.

| Interruption | What you see | What to do |
|---|---|---|
| Security code expiry | The vault holds a card's security code for about fifty minutes and never longer. Your next dispatch returns approval-required with a code-refresh reason | Open the approval URL, re-enter any three digits, dispatch the **same saved request** again with the approval token |
| Mandate currency mismatch | Permanent approval-required on every dispatch | Reissue the mandate in the store's currency (see step 4) |
| Polling by re-dispatching | An approval step-up mints a **brand new token on every dispatch** and does not report the pending one as not-ready | **Never poll by re-dispatching.** Poll the approval endpoint until it reports approved, then dispatch once. A re-dispatch loop never terminates |

---

## 8. Operational limits to respect

Rate limits are keyed to the API key, not to your IP — so a shared venue network does not split your quota.

| Category | Limit |
|---|---|
| Reads — merchants, products, orders, evidence | 120 / minute |
| Quotes | 30 / minute |
| Orders and discovery | 10 / minute, **and 200 / day** |

The daily order cap is the one that bites first. Responses carry rate-limit headers; read those rather than counting locally, because they are the authority.

Poll an in-flight order no faster than every three seconds — it takes sixty to seventy seconds to settle, so faster polling buys nothing.

---

## 9. Notes for the build

- **The `test` flag is a trap.** Orders placed in the sandbox report `test: false`, because that field describes whether the *merchant* is a designated test merchant — and this one is an ordinary shop with its gateway in test mode. Do not branch on it.
- **No webhooks exist.** Polling is the documented path, not a workaround.
- **No refund API.** The provider never holds or moves funds; the merchant is merchant of record. Refunds are ours, merchant-side and manual.
- **Fan payments are ours.** The provider's vaulted card pays the merchant. Collecting from the fan is a separate rail (Stripe, authorization hold with delayed capture).

---

## Status

**Setup:** account and token done. **A card is not yet vaulted**, which is the gate on any live dispatch — `GET /api/autofill/cards` currently returns an empty list.

**Implication:** everything except the live dispatch and the live cap-refusal demo can be built and verified against the fake. Both of those are scored demo items, so step 2 below is the one that matters.

| Demo requirement | Blocked by setup? |
|---|---|
| Curated wishlist with markup | No — works against live search today |
| Fan checkout, no address shown | No |
| Successful authorized merchant order | **Yes — needs a vaulted card** |
| Controlled refusal when a cap is exceeded | **Yes — needs a vaulted card** |

### One thing that is not the payment API

`POST https://api.agnic.ai/v1/chat/completions` with a `model` and `messages` array is Agnic's **AI Gateway** for calling LLMs. It has nothing to do with payments. Money moves through `/api/autofill/*` — quote, dispatch, orders. Do not route a purchase through the chat endpoint.
