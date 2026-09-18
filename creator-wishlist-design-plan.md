# Creator Wishlist — Product Design Plan

**Source:** `creator_wishlist_requirements.md`  
**Prepared:** September 15, 2026  
**Product:** Creator Wishlist — Agentic Checkout Platform

## 1. Product promise

Creators publish real, purchasable gear wishes. Fans choose and pay for a gift. The platform purchases it through the merchant and ships it to the creator without exposing the creator’s address to the fan.

The design must make three things obvious at every step:

1. What the fan is buying and exactly what they will pay.
2. What the creator must do to make an item purchasable.
3. Whether an order is safe, progressing, delayed, failed, or refunded.

The product is a privacy boundary and a money-movement system. “Simple” screens must never hide uncertain quote, payment, or fulfillment states.

## 2. Users and jobs

### Creator

- Set up a public identity and private shipping destination.
- Find products from supported merchants.
- Confirm that an item can actually ship to the stored address.
- Curate a wishlist that fans can understand.
- Update or remove the address without creating unsafe in-flight orders.
- See gifts and order progress without exposing private fulfillment data publicly.

### Fan

- Open a public wishlist without creating an account.
- Understand the item, merchant, final price, and whether it may arrive separately.
- Pay only after seeing a fresh, explicit total.
- Trust that the creator’s address is not being shared.
- Track an order without seeing merchant internals or private delivery information.

### Operator/support staff

- Find every order by platform ID.
- See the complete lifecycle and recommended next action.
- Triage stuck, approval-required, failed, refunded, and partial-fulfillment cases.
- Access creator address data only when role-authorized, with every access audited.

## 3. Design principles

1. **Privacy is visible.** Repeat “ships to the creator; their address is never shown to fans” at the moments where trust matters.
2. **Final price means final.** Never show an estimated number beside a payment action without labeling it provisional.
3. **Uncertainty has a designed state.** Lost dispatch responses, processing orders, and non-final quotes are not errors to hide; they are statuses with a next action.
4. **One order, one source of truth.** The fan sees a platform order ID and friendly status. The operator sees the full merchant lifecycle.
5. **Multi-merchant means multiple deliveries.** Never visually imply that different shops become one shipment.
6. **The agent never surprises the user.** Dispatch happens only after explicit approval of a displayed quote, and approval-required outcomes go to people.
7. **Recovery is part of the happy path.** Stale prices, unavailable products, payment authorization failures, merchant refusal, and timeouts need complete screens.

## 4. Information architecture

```text
Public
├── Creator wishlist page
├── Product detail / item explanation
├── Cart
├── Quote review
├── Payment approval
├── Order confirmation
└── Fan order status / order history

Creator app
├── Dashboard
├── Wishlist
│   ├── Add product
│   ├── Search products
│   ├── Product review
│   ├── Delivery verification
│   └── Item management
├── Orders / gifts
├── Profile
│   ├── Public identity
│   └── Private delivery address
└── Settings / support

Operator console
├── Order queue
├── Order detail and timeline
├── Approval-required queue
├── Stuck/reconciliation queue
├── Creator lookup
├── Merchant health
└── Audit log
```

## 5. Core journeys

### A. Creator onboarding

```text
Create account
  → public profile (name, avatar, raising-for description)
  → private address disclosure
  → country selection / validation
  → address confirmation
  → empty wishlist with Add product CTA
  → publish shareable link
```

Address screen requirements:

- State exactly why the address is needed.
- State who can access it: fulfillment backend and authorized support roles only.
- State that it is never sent to fans or included in fan receipts.
- Require an explicit consent checkbox before saving.
- Show country support: CA, GB, US, AU.
- Warn that changing the address invalidates outstanding quotes and may require re-checking listed products.

### B. Creator adds a wishlist item

```text
Wishlist → Add product
  → search / browse merchant products
  → product detail
  → verify delivery to saved address
  → fresh quote
  → review item + indicative price + last checked
  → publish
```

Do not allow an item to become public until delivery verification succeeds. Persist merchant ID and exact product/variant SKU, not only the browse-time URL or price.

States:

- Deliverable and current
- Quote pending
- Non-final quote / ceiling
- Price changed
- Out of stock
- Undeliverable
- Merchant unsupported
- Address missing or invalid

### C. Fan browsing and checkout

```text
Public wishlist
  → select item(s)
  → cart review
  → fresh quote
  → choose delivery option if required
  → re-quote
  → show final fan total
  → explicit payment approval
  → authorize payment
  → dispatch merchant order
  → confirmation / status tracking
```

Authentication is optional for browsing and required before payment. The checkout must show:

- Creator display name
- Product, variant, quantity, and merchant/shop
- Shipping/tax/markup treatment at the appropriate disclosure level
- Currency
- Quote freshness and expiration
- Delivery option and expectation
- Final fan-facing total
- Privacy statement: “Ships to the creator. Their address is never shown to you.”

### D. Creator address change

```text
Profile → Delivery address → edit
  → explain quote invalidation
  → save with consent
  → invalidate outstanding quotes
  → mark affected wishlist items for re-verification
```

Never silently keep a previously verified quote after the address changes.

### E. Order reconciliation

```text
Approved order
  → durable platform order created
  → payment authorization verified
  → signed spending mandate verified
  → merchant dispatch attempted once
  → merchant order ID saved before response handling
  → status endpoint polling
  → terminal state: succeeded / failed / refunded
```

If dispatch times out, show “Confirming your order,” not “failed,” and read status using the saved merchant order ID. Never issue another dispatch to check the first attempt.

## 6. Screen and component plan

### Public wishlist

Hero:

- Creator avatar, display name, and “what I’m raising for” description
- Privacy reassurance in plain language
- Share link action

Wishlist item card:

- Product image with accessible alt text
- Product name and variant
- Merchant/shop label
- Current indicative price and currency
- “Last checked” timestamp
- Availability/deliverability badge
- Add to gift/cart action

An unavailable item remains understandable but cannot be added. Explain whether it is temporarily unavailable, undeliverable, or removed.

### Product detail

Show the product, variant, merchant, description, and delivery expectation. Do not show creator address, city, region hints, maps, or autofill-derived destination data.

### Cart

The cart must group products by merchant and visibly explain separate fulfillment:

```text
Shop A
  Item 1
Shop B
  Item 2

These gifts may arrive separately.
```

If one shop fails, preserve the successful/failed split in the UI rather than presenting the cart as all-or-nothing.

### Quote review

Use a prominent quote status:

- `Current quote`
- `Needs refresh`
- `Provisional ceiling`
- `Choose delivery option`
- `Expired`

Show the fan total as the primary number. If markup is disclosed, use a concise “Platform service fee” explanation rather than exposing internal margin mechanics.

**Two amount-integrity rules.**

1. **A ceiling is never a total.** When the quote is provisional, the merchant adds tax at checkout and the quoted figure is a limit the charge stays under. Copy it as “subtotal plus tax, never more than $X.XX” — never as a bare total, and never with a payment action beside it while it is unlabeled.
2. **`Choose delivery option` has no total at all.** The provider withholds the amount entirely when a delivery choice is outstanding, because there is no honest figure to show yet. Render the total slot as blank or as a short explanation — **never as `$0.00`, and never by reusing the previous total.** The primary action is “Choose delivery option,” and the payment action is absent rather than disabled, so the fan is never asked to approve a number that does not exist.

**Charged amount.** The fan is charged the platform's approved total and sees that figure, not the merchant's. Where the merchant's checkout reports a lower charge than the approved ceiling, the difference is reconciled internally under the platform's stated policy. Never charge above the approved total, and never show the merchant's figure as the fan's price.

### Payment approval

This is the strongest consent step. The action should read “Approve purchase — $X.XX [currency]” and be disabled until the displayed quote is valid.

Before approval, verify:

- Quote is fresh and final enough to charge
- Delivery option is selected
- Currency matches the spending mandate
- Payment method is authorized
- The fan understands the creator receives the item

Do not use “Place order” if the platform still needs to authorize, dispatch, and reconcile asynchronously. Use copy such as “Approve purchase.”

### Fan order status

Friendly status mapping:

| Internal state | Fan-facing copy |
|---|---|
| Approved | Payment approved; preparing the gift |
| Dispatch pending | Confirming the merchant order |
| Processing | The merchant is preparing it |
| Shipped | On its way |
| Delivered | Delivered to the creator |
| Approval required | A quick review is needed before we continue |
| Failed/refused | The order could not be completed; you were not charged / your payment is being released |
| Refunded | Payment refunded |
| Uncertain | We’re confirming what happened; do not submit again |
| Action needed at the shop | The shop needs a quick confirmation — this is open in review and we'll continue automatically |

Note that “action needed at the shop” is an **operator-facing condition by default.** The provider can surface a human step mid-checkout (a verification challenge, a bank check, a shop sign-in) together with a live URL to resolve it. That URL streams the checkout and retains the receipt and evidence for the buyer — which in this product would include the creator's delivery address. It therefore goes to an authorized operator, never to the fan. The fan sees a reassuring status, not a link.

Display only platform order ID, creator name, fan-approved total, status, and safe next actions.

### Creator dashboard

Show:

- Wishlist health: active, needs re-check, unavailable
- Gifts by status
- Recent order activity
- Address status without displaying the full address in general dashboard views
- Link sharing and profile preview

### Operator order detail

Timeline:

```text
Quote approved
Payment authorized
Merchant dispatch requested
Merchant order ID recorded
Merchant status checked
Payment captured / authorization released
Refund issued
```

Show recommended next action, SLA/age, merchant, payment state, quote snapshot, evidence reference, and audit history. Mask address and payment data by default; reveal address only to an authorized role through an audited action.

## 7. State model and copy contract

The frontend should receive explicit state fields, not infer operational meaning from error strings.

### Wishlist item

```text
active | quote_required | unavailable | undeliverable | removed | merchant_unsupported
```

### Quote

```text
pending | valid_final | valid_provisional | delivery_choice_required | expired | invalidated | changed
```

`valid_final` and `valid_provisional` map directly to the provider's `amount_is_final` flag — do not infer them. `delivery_choice_required` is the state in which the provider has withheld the amount altogether.

### Fan order

```text
draft | approved | authorized | dispatching | uncertain | processing
approval_required | succeeded | failed | refunded | partially_fulfilled
```

### Merchant order

```text
not_created | accepted_pending | processing | shipped | delivered
refused | failed | refunded
```

Every state needs:

- Human-readable title
- Explanation
- Next action
- Whether payment is held, captured, released, or refunded
- Whether retry is safe

**Do not invent the next action.** There are two layers, and conflating them is how a UI ends up recommending something dangerous.

The provider returns one next call per order, computed server-side from the status, the error code and the charge evidence together. Translate that into **one of five application actions**, and make this the only vocabulary any surface branches on:

| Application action | Meaning | Fan sees | Operator sees |
|---|---|---|---|
| `capture_once` | Checkout succeeded. Capture the fan's payment exactly once | “Your gift is ordered” | Confirm capture; reconcile against agreed total |
| `poll_later` | Still running | “Confirming the merchant order” | Age and SLA countdown |
| `human_handoff` | A person is needed at the shop — challenge, bank check, or sign-in | “A quick review is needed; we'll continue automatically” | Live view link and the required step |
| `release_hold_once` | The order was refused before the card was ever used. No purchase exists | “You were not charged” | Confirm evidence, release authorization |
| `reconcile` | The state cannot be determined locally | “We're confirming what happened — please don't submit again” | Evidence bundle, escalate |

**Ordered is not shipped.** An earlier draft of this table mapped `capture_once` to “On its way,” which was wrong: a completed checkout confirms the order was *placed*, never that a parcel was dispatched. The build guide is explicit that a successful checkout is not proof of delivery, so no copy may imply movement until a shipped status actually arrives. “Your gift is ordered” is the honest claim.

`release_hold_once` is gated on evidence that the card was never submitted. An order that shows no evidence at all was refused by the provider itself, which it only ever does *before* the card — a cap breach and a price change both arrive that way, and both must release the fan's hold rather than open a support ticket. If evidence shows a charge, the action is `reconcile`, never a release.

**Retry safety is tri-state — and the naive reading of the third value is wrong.**

The provider reports `retryable` as `true`, `false`, or `null`. The trap is that **`null` is also the value for perfectly healthy in-flight orders**, so it must never be evaluated first. Evaluate in this precedence:

| Step | Condition | Action |
|---|---|---|
| 1 | `retry_action` is `poll` | Keep polling. The order is simply still running |
| 2 | `retry_action` is `handoff` | A human step appeared. Route it, keep polling, never re-place |
| 3 | `retryable` is `null` | Now it is genuinely unknown and money may have moved. Stop automation, escalate to a human |
| 4 | `retryable` is `false` | It failed, or it already succeeded. No retry action |
| 5 | `retryable` is `true` | Safe to offer a retry — evidence proves the card was never submitted |

Two failure modes to avoid. Evaluating `retryable` before `retry_action` would stall **every** healthy order — the fan waits forever on an order that is running normally. And collapsing `null` into `false` renders an unknowable money state as an ordinary failure, which is the most damaging copy bug available in this product.

The fan-facing distinction that matters: steps 1 and 2 must read as *progress*. Only step 3 reads as uncertainty, and it must never read as failure.

**Store raw provider status verbatim.** The operator timeline and the reconciler read provider truth; the fan-facing status is a derived projection that never overwrites it.

## 8. Agent and backend UX contract

The “agent” is a controlled dispatch workflow, not an autonomous browser that can spend freely.

```text
Fan approval
  → platform validates quote/payment/mandate/idempotency
  → durable FanOrder created
  → merchant dispatch called once
  → MerchantOrder ID persisted immediately
  → status endpoint polled
  → payment captured only after confirmed merchant success
```

Hard design constraints:

- Never show a dispatch button to a fan.
- Never let a second click create a second dispatch attempt.
- Never label HTTP 202/accepted as purchased.
- Never expose raw Agnic retry instructions to fans.
- Never log or return the creator address on fan-facing paths.
- Never combine multiple merchant orders into one implied shipment.

## 9. Trust, privacy, and compliance moments

### Address consent

Use direct copy:

> Your address is used only to ship gifts you receive. Fans never see it. It is available only to the fulfillment system and authorized support staff.

Record consent timestamp and policy/version. Updating the address must visibly explain quote invalidation.

### Merchant-visible billing address

Where the provider reports that the merchant will see the delivery address on the payment instrument too, disclose this to the creator before they approve an order — it is a genuine expansion of who sees their address beyond the stated promise of “fulfillment system and authorized support staff.” Keep it short and factual, and do not bury it in a policy page.

This is a **creator-facing** disclosure only. It does not change the fan-facing boundary, and no fan-facing surface may reference it.

### Live order views

The provider supplies URLs that display a running checkout and its evidence afterwards. These are built for the person who paid — in this product, the fan — while the parcel is addressed to the creator. **No fan-facing page, response, error, email, or support macro may carry one of these URLs or any evidence payload**, because together they disclose the delivery address in full. Treat them as operator-only credentials, and give operators an audited way to view them.

### Markup disclosure

Use legal/compliance-approved copy. Candidate treatment:

```text
Item and delivery costs     $X.XX
Platform service fee         $Y.YY
Total                        $Z.ZZ
```

Do not hide a material fee behind a generic total without confirming country-specific requirements.

### Payment failure

Failure screens should first answer the anxiety question: “Was I charged?” Then explain what happens next:

- Not charged: authorization was released.
- Temporary uncertainty: we are checking; do not submit again.
- Charged then downstream failure: refund is in progress and will be tracked.

## 10. Accessibility and localization

- 44px minimum interactive targets.
- Keyboard and screen-reader access for every checkout action.
- Do not communicate availability or order state through color alone.
- Announce quote refresh, status changes, and authorization results to assistive technology.
- Support dynamic type without hiding totals or consent text.
- Format CA, GB, US, and AU currency/date conventions correctly.
- Keep currency explicit whenever multiple merchants or countries are involved.
- Use plain language for financial and fulfillment status.

## 11. Responsive behavior

### Mobile

Prioritize one-column cards, sticky total/approval action, and a compact status timeline. Keep privacy copy adjacent to the payment decision.

### Desktop

Use two-column checkout: product/cart summary left, quote/payment consent right. Creator and operator dashboards can use table-plus-detail layouts, but tables must have a mobile card equivalent.

## 12. Component system

Build these shared components first:

- `CreatorHeader`
- `PrivacyNotice`
- `WishlistItemCard`
- `MerchantBadge`
- `AvailabilityBadge`
- `FreshnessIndicator`
- `QuoteBreakdown`
- `FinalTotal`
- `DeliveryOptionPicker`
- `PaymentConsentButton`
- `OrderStatusTimeline`
- `PaymentStateBanner`
- `MultiMerchantGroup`
- `AddressConsentForm`
- `ApprovalRequiredBanner`
- `OperatorOrderTimeline`
- `AuditAccessDisclosure`

Every component needs loading, empty, unavailable, expired, error, and retry states where relevant.

## 13. Delivery phases

### Phase 1 — Trust boundary and creator setup

- Creator authentication/profile
- Private address consent and role restriction
- Public wishlist link
- Empty, loading, and address-change states
- Audit events for address access

### Phase 2 — Product curation

- Merchant/product search
- Exact SKU persistence
- Delivery verification
- Wishlist publishing
- Availability and quote freshness indicators
- Unsupported-merchant handling

### Phase 3 — Fan checkout

- Public browsing without auth
- Auth before payment
- Fresh quote and delivery options
- Markup disclosure decision
- Payment authorization consent
- Fan-safe order confirmation

### Phase 4 — Agent dispatch and reconciliation

- Idempotent durable order creation
- Spending mandate/currency checks
- Single merchant dispatch attempt
- Merchant order ID persistence before response handling
- Status polling and terminal-state reconciliation
- Authorization release/capture/refund paths

### Phase 5 — Operations and scale

- Operator order queue
- Approval-required queue
- Stuck-order alerts
- Multi-merchant partial fulfillment
- Evidence viewer
- Role-based address access
- Merchant rate-limit and failure visibility

## 14. Acceptance criteria

The design is ready for implementation sign-off when:

- A creator can understand and consent to address storage without ambiguity.
- A wishlist item cannot publish without delivery verification.
- A fan can browse without auth and cannot see creator address data anywhere.
- Payment approval always shows one current, explicit total and currency.
- Stale/non-final quotes visibly block or trigger re-quote before approval.
- Double-submit, timeout, and lost-dispatch cases never create duplicate merchant charges.
- Every order has a visible, durable state and safe next action.
- Failed/refused orders clearly explain authorization release or refund status.
- Multi-merchant carts communicate separate shipments and partial outcomes.
- Operators can reconcile every non-terminal order without reading raw logs.
- Address and payment data are masked by default and every privileged address access is audited.
- Supported-country and markup disclosure behavior has legal/compliance approval.

## 15. Open decisions before build sign-off

1. What is the approved fan-facing markup disclosure for CA, GB, US, and AU?
2. What are the exact payment provider and authorization/capture semantics?
3. What is the quote freshness threshold, and what counts as a material price change?
4. Which operator roles may view creator addresses, and how long should access remain visible in audit logs?
5. Should multi-item checkout submit one platform order with child merchant orders, or separate fan approvals per merchant?
6. What are the service-level thresholds for “stuck” orders and automatic escalation?
7. Which return, refund, and dispute policy is shown before payment?

Until these are answered, use conservative defaults: re-quote at every material checkout step, never capture before confirmed merchant success, keep multi-merchant orders independently reconciled, and mask addresses for every role except explicitly authorized fulfillment/support actions.
