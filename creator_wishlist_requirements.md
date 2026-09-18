# Business & Technical Requirements Document
## Project: Creator Wishlist — Agentic Checkout Platform

**Prepared for:** Hackathon build track — "Agentic Checkout" (AI Pioneers, Agnic)
**Document type:** Requirements Specification (Functional, Non-Functional, Risk/Exception Register, Design Guidance)
**Status:** Draft v1.0

---

## 1. Purpose & Background

Creators (streamers, YouTubers, podcasters) want fan-funded gear, but have no way to accept help without either exposing their home address or manually managing purchases. This product lets a creator publish a public wishlist of real, purchasable products; a fan selects an item and pays; the platform automatically completes the purchase with the merchant and ships it to the creator — without the fan ever seeing the creator's delivery address, and without the platform holding inventory.

The platform composes two responsibility domains:

| Owned by the platform (this product) | Owned by the commerce provider (Agnic) |
|---|---|
| Creator accounts, profiles, wishlists | Product discovery across merchant catalogs |
| Fan-facing browsing & payment collection | Delivery quoting (cost, tax, options) |
| Markup / margin logic | Merchant checkout execution |
| Privacy boundary (address protection) | Order status & fulfillment truth source |
| Customer support, refund policy, dispute handling | Spending-limit enforcement at the rail level |

This document defines what must be built, the quality bar it must be built to, the failure modes that must be explicitly designed for, and guidance for the design team building the creator- and fan-facing experience.

---

## 2. Scope

**In scope:** creator onboarding, wishlist curation, fan browsing and checkout, quote-and-markup pricing, automated merchant order dispatch, order status tracking and reconciliation, address privacy boundary, and the operational tooling needed to run this safely at more than a handful of orders.

**Out of scope (v1):** creator payouts beyond "delivery of physical goods" (i.e., no cash payouts to creators), merchant rails other than Shopify, in-house courier or delivery, and any support for fan-supplied delivery addresses (all orders ship to the creator only).

---

## 3. Functional Requirements

### 3.1 Creator Management
- **FR-1.1** The system shall allow a creator to create a profile with a public display name, avatar, and a short "what I'm raising for" description.
- **FR-1.2** The system shall allow a creator to enter and store one private delivery address, collected with explicit consent and a clear disclosure of who can access it (see §3.6).
- **FR-1.3** The system shall allow a creator to generate one shareable public wishlist link.
- **FR-1.4** The system shall allow a creator to update or remove their delivery address at any time, with all in-flight quotes invalidated on change.

### 3.2 Product Discovery & Curation
- **FR-2.1** The system shall allow a creator (or platform curator) to search for products by keyword, scoped to the creator's delivery country (CA, GB, US, or AU at launch).
- **FR-2.2** For each search result, the system shall persist the merchant ID and product/variant SKU needed to re-quote that exact item later — never the browse-time price alone.
- **FR-2.3** Before an item is published to a wishlist, the system shall verify the item is deliverable to the creator's stored address via a delivery quote.
- **FR-2.4** The system shall support wishlists containing items from more than one merchant/shop simultaneously.
- **FR-2.5** The system shall support onboarding a new/unknown merchant when a chosen product's merchant is not yet connected.
- **FR-2.6** The system shall periodically (or on-demand) refresh listed items' availability and indicative price, and shall visibly flag or auto-remove items that become undeliverable.

### 3.3 Pricing, Markup & Fan Checkout
- **FR-3.1** Before presenting a total to a fan, the system shall request a fresh delivery quote (product + shipping + tax) rather than reusing a cached or browse-time price.
- **FR-3.2** The system shall apply a configurable markup (percentage or fixed) on top of the merchant-quoted total to compute the fan-facing price.
- **FR-3.3** The system shall display the full current total (merchant cost breakdown optional, final fan price mandatory) to the fan before requesting payment confirmation.
- **FR-3.4** The system shall treat any quote marked as non-final (a ceiling) as provisional and shall re-quote before final confirmation if any material time has elapsed or the delivery option changes.
- **FR-3.5** The system shall support quotes that require the fan/system to choose among multiple delivery options, and shall re-quote after a delivery option is selected.
- **FR-3.5a** When a quote requires a delivery choice, the provider withholds any amount (`expected_amount_minor` is null). The system shall therefore represent this as its own quote state with **no displayed total** and a "Choose delivery option" next action — never rendering the missing amount as zero or as a stale prior figure.
- **FR-3.6** The system shall authorize (not capture) the fan's payment at the moment of approval, and shall only capture the payment after the merchant order is confirmed successful.
- **FR-3.7** Fan payment collection and merchant purchase are **two separate payment rails** and shall be modeled as such: a fan-facing PSP (Stripe, authorization hold with delayed capture) collects from the fan, and the provider's vaulted card pays the merchant. The system shall not assume a single rail reconciles both sides.
- **FR-3.8** The system shall derive quote state directly from the provider's `amount_is_final` flag rather than inferring it: `true` maps to a final, chargeable quote; `false` maps to a provisional quote whose figure is a **ceiling** the real charge stays under. A ceiling shall never be presented as the total without saying so.
- **FR-3.9** The system shall use the provider's `expected_amount_minor` as the amount bound to approval and dispatch, and as the **ceiling the fan authorises**. The fan is shown the platform's own approved total (merchant figure plus markup) — never the provider's raw figure — and shall never be charged more than the total they approved.
- **FR-3.9a (platform policy for an unused ceiling — decided 2026-09-17).** A non-final quote carries headroom the merchant frequently does not use: on the live sandbox the quote estimated 1300 with a cap of 1495, and the merchant charged 1300. Where the merchant's own checkout reports an actual charge below the approved ceiling, the fan shall be charged **that actual charge plus the platform fee they were shown** — the platform retains its stated fee and nothing more. This shall be taken as a **partial capture against the existing authorisation**, never as a full capture followed by a refund, so the fan is charged the correct amount once rather than charged the maximum and refunded the difference.
- **FR-3.9b (disclosure).** The resulting total shall be presented to the fan as the amount they were charged, with the approved ceiling shown alongside it and the difference stated plainly. The merchant's own figure shall never be presented on its own as the fan's price, because that figure excludes the platform fee.
- **FR-3.9c (never guess).** Where the merchant's actual charge cannot be established, the system shall not fall back to the authorised total. Any such order shall be refused for automatic capture and surfaced to an operator with the reason recorded; the authorisation remains live, so nothing is lost by waiting.

*Note for legal/compliance: FR-3.9b sets the disclosure approach, and the markup is itemised at checkout as a separate fee line. Regional requirements (CA, GB, US, AU) still need sign-off — see the open question on markup disclosure.*

### 3.4 Order Dispatch (the "Agent")
- **FR-4.1** The system shall only submit a merchant purchase for an order the fan has explicitly approved at a specific, displayed total.
- **FR-4.2** Before dispatch, the backend shall re-verify: (a) the fan's payment is authorized and held, (b) a valid signed spending mandate covers the amount and currency, and (c) this exact fan order has not already been dispatched (idempotency check).
- **FR-4.3** The system shall record a durable order ID at the moment of dispatch, before any network response is received, so that an interrupted call can be reconciled rather than blindly retried.
- **FR-4.4** The system shall treat an "accepted"/202-style dispatch response as *pending*, not as a completed purchase, and shall poll or otherwise confirm final order status.
- **FR-4.5** The system shall support an `approval_required` outcome by routing the order to a human-in-the-loop approval queue rather than auto-proceeding.
- **FR-4.6** The system shall never issue a second dispatch call for the same fan order in order to *check on* it — status must be read via the order-status endpoint only. The single sanctioned exception is the documented approval retry: a dispatch may be re-issued exactly once, carrying the `approval_token` issued by the preceding `approval_required` response, and only while that token is unexpired. The idempotency layer shall permit that retry and reject every other repeat submission.
- **FR-4.7** The system shall treat an `approval_required` outcome as a **bounded state with an expiry**: it carries an approval URL, an approval token, and a time-to-live. The system shall poll for approval, surface the approval action to the fan or operator as appropriate, and on expiry shall fail the order safely rather than leaving it in a non-terminal state.
- **FR-4.8** The system shall branch on the provider's `retry_action` field rather than pattern-matching error codes, and shall evaluate fields in a fixed precedence, because the naive reading of `retryable` is wrong: **`retryable` is `null` for ordinary in-flight orders too**. The required order of evaluation is:
  1. `retry_action === "poll"` → continue polling. The order is simply still running.
  2. `retry_action === "handoff"` → a human step has appeared mid-checkout; route to a person and keep polling. Never re-place.
  3. `retryable` is `null` (and neither of the above) → the outcome is genuinely unknown and money may have moved. Stop all automation and surface for human handling.
  4. `retryable === false` → it failed the same way it will fail again, or it already succeeded. Do not retry.
  5. `retryable === true` → placing again is safe; evidence proves the card was never submitted.
  A `null` shall never be collapsed into `false`, and shall never be evaluated before `retry_action`, since doing so would stall every healthy in-flight order.
- **FR-4.9** The system shall poll approvals via the provider's approval-status endpoint, keyed by the approval token, until the approval reports as approved — and shall **never** poll by re-issuing dispatch. This is not merely a rate-limit concern: one of the step-up paths mints a brand-new token on every dispatch and does not report the pending one as not-ready, so a dispatch-based polling loop never terminates and fills the approvals record with dead tokens.
- **FR-4.10** The system shall hold a **server-side binding over the approved request** and shall refuse to dispatch if any element of it changed after approval. The provider enforces this binding only in its tool layer; over the HTTP dispatch route nothing stops a caller sending different values. The system must therefore persist the quoted request, digest it, and verify the digest immediately before dispatch as its own equivalent of a body-mismatch refusal. A changed destination, amount, cap, currency, or fulfillment option shall require a fresh quote and renewed fan approval — never a silent dispatch.
- **FR-4.11** The system shall classify the provider's `202 approval-required` responses by their stated reason and treat them as **routine states with distinct handling**, not as failures: a security-code refresh (expected roughly hourly, resolved by re-entering the code at the approval URL and re-dispatching the same saved request with the approval token) and a mandate step-up (resolved by polling the approval). A currency mismatch between the spending mandate and the store is **permanent until the mandate is reissued in the store's currency** and shall be surfaced as a configuration fault requiring operator action, never retried.

### 3.5 Order Status & Reconciliation
- **FR-5.1** The system shall provide a mechanism to read the current status, charged amount, and recommended next action for any dispatched order.
- **FR-5.2** When status indicates "still processing," the system shall schedule a follow-up status check rather than treating the order as failed or successful.
- **FR-5.3** When an order fails or is refused (e.g., spending cap exceeded), the system shall release/void the fan's payment authorization and shall not charge the merchant card.
- **FR-5.4** The system shall reconcile every dispatched order to a terminal state (success, failed, refunded) and surface unresolved/stuck orders to an operator queue.
- **FR-5.5** The system shall capture and store checkout evidence (e.g., merchant order confirmation) associated with each successful order for support and dispute purposes.
- **FR-5.6** The system shall store the provider's raw order status verbatim alongside its own derived fan-facing status, and shall never overwrite or discard the raw status, so that operator views and reconciliation are always driven by provider truth rather than by a lossy local projection.
- **FR-5.7** **Refunds are merchant-side and manual.** The provider neither holds nor moves funds and exposes no refund operation; the merchant is merchant of record and charges through its own processor. The system shall therefore model `refunded` as an **operator-driven terminal state** reached by recording an out-of-band merchant refund, with evidence attached to the order. It shall not present a refund as an automated step, and it shall not silently mark an order refunded without a recorded operator action and reference.
- **FR-5.8** Where an order cannot be reconciled automatically (provider reports `retryable: null`, or a terminal failure occurs after a fan charge), the system shall raise it into an operator queue with the evidence bundle attached and shall not attempt further automated placement.
- **FR-5.9** The system shall poll order status, as the provider exposes no webhooks; polling frequency shall be bounded and shall back off for long-running orders rather than polling indefinitely at a fixed short interval.

### 3.6 Privacy & Address Protection
- **FR-6.1** The system shall never transmit the creator's delivery address to the fan's browser, in any API response, receipt, page, or log reachable by fan-facing code paths.
- **FR-6.2** Fan-facing order views shall be limited to: platform order ID, creator display name, fan-approved total, and order status.
- **FR-6.3** The delivery address shall be resolved only on the backend and attached to quote/dispatch calls server-side.
- **FR-6.4** The system shall verify that a fan requesting order details is the owner of that order before returning any data.
- **FR-6.5** The system shall **never** expose provider-supplied live-order URLs (`order_url`, `live_view_url`) or the provider evidence bundle to any fan-facing code path, response, or page. These artifacts are the provider's buyer-facing surface and are built for the *cardholder*; in this product the cardholder is the fan while the shipped-to party is the creator, so they would disclose the creator's delivery address and can stream the checkout live. They shall be treated as operator-only data.
- **FR-6.6** The system shall use the provider's destination digest (`ship_to_sha256`) as the mechanism for detecting address change: quotes store the digest, never the address, and any quote whose digest does not match the creator's current address digest shall be invalidated rather than reused. This is a cryptographic comparison, not a heuristic or TTL guess.
- **FR-6.7** The system shall disclose to the creator, before they approve an order, that the merchant may receive the delivery address as the billing address where the provider reports this (`billing_uses_ship_to`). This is a creator-facing trust disclosure and is distinct from the fan-facing address boundary.
- **FR-6.8** The system shall treat the provider's failure contract as containing delivery-address data: any provider response carrying a destination echo, digest preimage, or evidence bundle shall be classified as sensitive, and shall be excluded from general-purpose logs and from all fan-facing serializers by construction.

### 3.7 Fan Experience
- **FR-7.1** A fan shall be able to view a creator's public wishlist without authentication, but shall authenticate before paying.
- **FR-7.2** The system shall show order status to the fan post-purchase (e.g., pending, processing, delivered, failed) without exposing fulfillment internals.
- **FR-7.3** The system shall notify the fan if their selected gift becomes unavailable or undeliverable before payment capture, and shall refund/release any authorization automatically.

---

## 4. Non-Functional Requirements

### 4.1 Reliability & Consistency
- **NFR-1.1** No user-facing action shall result in an ambiguous money state; every dispatch attempt must resolve, via reconciliation, to a single terminal status recorded in the system of record.
- **NFR-1.2** Order dispatch must be idempotent under retry at the platform layer (duplicate submissions of the same approved order must not result in duplicate merchant charges).
- **NFR-1.3** The system shall target no data loss on in-flight orders across a backend restart (durable persistence of order state prior to dispatch).

### 4.2 Security & Compliance
- **NFR-2.1** Card/payment credentials (the platform's vaulted business card, fan payment methods) shall never be stored or logged in plaintext, and shall never be exposed to frontend code.
- **NFR-2.2** All personally identifiable information (creator address, fan payment details) shall be encrypted at rest and in transit.
- **NFR-2.3** Access to creator address data shall be restricted by role (backend fulfillment service and authorized support staff only) and fully audit-logged.
- **NFR-2.4** The system shall comply with applicable consumer-protection and payment-processing regulations in each supported country (CA, GB, US, AU) — including clear disclosure of markup where required.

### 4.3 Performance
- **NFR-3.1** Product search results should return within a user-tolerable interactive threshold (target: under ~2 seconds at p95) to keep wishlist curation usable.
- **NFR-3.2** Quote refresh at checkout should complete within a threshold that does not noticeably stall the fan's payment flow (target: under ~3 seconds at p95), with a visible loading state beyond that.

### 4.4 Scalability
- **NFR-4.1** The dispatch pipeline shall handle bursts of concurrent orders (e.g., a creator's viral moment) without serializing on a single merchant or single quote, and without violating per-merchant rate limits.
- **NFR-4.2** The system shall handle each merchant's order independently — a slow or failing merchant must not block orders to other merchants.

### 4.5 Observability & Auditability
- **NFR-5.1** Every state transition of an order (approved → dispatched → pending → succeeded/failed → captured/refunded) shall be logged with timestamps for support and financial reconciliation.
- **NFR-5.2** Operators must be able to see, in near real time, orders stuck in a non-terminal state longer than an expected threshold.

### 4.6 Availability
- **NFR-6.1** Fan-facing wishlist browsing should degrade gracefully (e.g., serve last-known product data) if the live product/quote service is briefly unavailable, rather than showing a hard error.

---

## 5. Exceptions, Edge Cases & Risk Register

These are failure modes the guide explicitly calls out or implies. Each should have an explicit, tested behavior — not a default/unhandled exception.

| # | Scenario | Required behavior |
|---|---|---|
| R-1 | Merchant spending cap is exceeded at dispatch time | Order is refused; fan's payment authorization is released; nothing is charged to the merchant card; fan is notified. |
| R-2 | Dispatch call times out / response is lost | Never re-dispatch blindly. Use the saved order ID to read status and reconcile. Treat as "uncertain," not "failed." |
| R-3 | Order status is `approval_required` | Route to a human approval queue; do not silently proceed or silently fail. |
| R-4 | Quote is marked non-final (a ceiling, not settled) | Never treat the ceiling as the settled price. **Implemented** by reading the merchant's own `amount_charged_minor` at reconciliation and charging that plus the fee (FR-3.9a), rather than by re-quoting: the merchant's settled figure is better evidence than a fresh estimate, and a re-quote cannot see a charge that has already happened. |
| R-5 | Fan takes too long between quote and payment approval | Treat the quote as stale; force a re-quote before allowing payment confirmation. |
| R-6 | Product becomes undeliverable or price changes materially between listing and purchase | Block the purchase, notify the fan, and prompt removal/replacement on the wishlist. |
| R-7 | Currency mismatch between spending mandate and quote | Reject outright before dispatch; do not attempt currency conversion silently. |
| R-8 | Payment method security code (CVV) expires mid-flow | Detect and re-prompt/re-authorize rather than failing silently; expect this as a routine occurrence, not an anomaly. |
| R-9 | A step-up/verification flow issues a new token per dispatch | Never poll for status by re-issuing dispatch; always use the read-status endpoint. |
| R-10 | Duplicate/rapid double-submission of the same fan order (e.g., double-click) | Idempotency check must reject the second attempt before it reaches the merchant. |
| R-11 | Creator changes or removes their address after items are already listed/quoted | Invalidate outstanding quotes for that creator; require re-quote before any further checkout. |
| R-12 | An un-integrated / unsupported merchant is chosen | Fail gracefully at curation time (before it's fan-facing), not at checkout time. |
| R-13 | Partial success (e.g., payment captured but merchant order fails downstream) | Must be detected via reconciliation and raised to an operator queue with the evidence bundle attached. Because refunds are merchant-side and manual (FR-5.7), the operator records the refund and the order moves to a `refunded` terminal state with a reference — it is not an automated step. Never left to be discovered by the fan. |
| R-14 | PII leakage via logs, error messages, or support tooling | Explicit review requirement: address and payment data must be scrubbed from all fan-facing and general-purpose logs. |
| R-15 | Multi-shop cart where one merchant succeeds and another fails | Each merchant order is independent; partial fulfillment must be communicated clearly to the fan (not presented as one atomic order). |
| R-16 | Provider-supplied live order URL or evidence bundle reaches a fan | Hard-blocked by FR-6.5. These artifacts are built for the cardholder and include the delivery address in full. Operator-only; fan-facing serializers must have no field able to carry them. |
| R-17 | Quote requires a delivery choice, so the provider withholds the amount entirely | Must be its own quote state with no displayed total (FR-3.5a). Rendering a null amount as `$0.00`, or reusing a previous total, is a money-misstatement bug. |
| R-18 | Provider reports `retryable: null` | **Evaluate `retry_action` first.** `null` is also the value for healthy in-flight orders, so it is only unknown once `poll` and `handoff` have been excluded. Only then: stop all automation, do not re-place, do not cancel, do not report failure. Surface to an operator with the evidence bundle and tell the fan the order is being confirmed (FR-4.8, FR-5.8). |
| R-19 | Fan's payment must be reconciled against a different rail than the merchant purchase | Two rails, two lifecycles (FR-3.7). A merchant-side failure must not leave a fan authorization held; a merchant-side success must capture the correct fan amount, which is the platform's approved total and never more. |
| R-20 | The approved request is altered between approval and dispatch | Over HTTP the provider does not bind the request body, so the system must enforce its own digest check before dispatch (FR-4.10). A changed postcode, amount, cap, currency or delivery option means a fresh quote and renewed approval. |
| R-21 | Fan demand exceeds the provider's quote or order rate limit | Throttle outbound calls against the provider's own reported rate-limit state, and surface queue position to fans rather than failing checkout. The daily order cap is the limit that bites first. |
| R-22 | Spending mandate is denominated in a different currency than the store | Permanent failure, not transient: every dispatch returns approval-required with a currency-mismatch reason until the mandate is reissued in the store's currency (FR-4.11). Treat as a configuration fault with an operator next action, never as a retry. |

---

## 6. Guidance for the Design Team

### 6.1 Creator-facing surfaces
- Design the address-collection form to clearly disclose *why* it's needed and *who* can see it ("used only to ship your gifts — never shown to fans"). Treat this as a trust moment, not a routine form field.
- Wishlist curation UI should make deliverability and price-freshness visible (e.g., a small "last checked" indicator), since items can silently become unavailable.
- Provide a clear, low-friction way for a creator to update their address, and communicate that doing so may affect items currently listed.

### 6.2 Fan-facing surfaces
- The checkout screen must show one clear, final number the fan is agreeing to pay — avoid ambiguity between "estimated" and "final" totals; if a quote is non-final, say so explicitly rather than showing a bare price.
- Never design a field, screen, or receipt that could surface or imply a delivery address, even indirectly (e.g., avoid city/region auto-fill hints, map previews, or "arriving to [address]" copy tied to the creator).
- Order status should use fan-friendly language (e.g., "Being prepared," "On its way," "Something went wrong — refunding you") rather than exposing raw system states like `retry_action: poll`.
- Design an explicit, non-scary failure state for refused/failed orders that reassures the fan they were not charged (or have been refunded), since payment failures are a normal, expected path here — not a rare edge case.

### 6.3 Multi-merchant / multi-item considerations
- If a wishlist or cart spans multiple shops, the UI must not imply a single combined shipment — set expectations that items may arrive separately, at different times, from different senders.
- Curated items should visually indicate their source shop, since delivery estimates and return/support policies may differ per merchant.

### 6.4 Trust & transparency
- Decide, with legal/compliance input, whether and how the markup is disclosed to fans (e.g., "includes a small service fee to support this platform"). Silent markups are a design and trust risk even where not legally required to disclose.
- Provide the fan a lightweight way to see order history and status without needing to contact support, to reduce "did my payment go through?" anxiety inherent to an asynchronous, agent-driven checkout.

### 6.5 Operator/support tooling (internal, not fan-facing)
- Design an internal dashboard for support staff to look up an order's full lifecycle (approved → dispatched → status) without needing raw API/log access, and with address data visible only to roles that need it, fully audited.
- Surface "stuck" orders (non-terminal beyond expected time) prominently for operator triage — this is a routine operational need, not a rare event, given the guide's own warnings about expiring codes and step-up tokens.

---

## 7. Core Data Entities (for design & engineering alignment)

- **Creator** — id, display name, avatar, description, private address, consent record.
- **WishlistItem** — creator_id, merchant_id, sku, last_checked_at, status (active/undeliverable/removed).
- **Quote** — item reference, merchant cost breakdown, fan total (with markup), currency, is_final flag, expiry.
- **FanOrder** — fan_id, wishlist_item reference, approved quote snapshot, payment authorization reference, status.
- **MerchantOrder** — Agnic/merchant order_id, dispatch timestamp, status, amount_charged, evidence reference.

---

## 8. Requirement-to-API Traceability (corrected)

Verified against the provider's published API reference. Base URL `https://api.agnic.ai`, authenticated via `X-Agnic-Token` (API token) or `Authorization: Bearer` (OAuth).

| Requirement area | Underlying provider endpoint(s) |
|---|---|
| Merchant connectivity (FR-1.x support) | `GET /api/autofill/merchants` (optional `?q=`), `GET /api/autofill/merchants/{id}` |
| Product discovery (FR-2.x) | `GET /api/autofill/products/search?q=&country=` (country = **destination** market, not where the buyer banks), `GET /api/autofill/products/lookup?url=` (Shopify product URLs only) |
| Merchant onboarding (FR-2.5) | `POST /api/autofill/explore` — **this is merchant onboarding, not product search**; required before quoting at a shop carrying `onboard` |
| Pricing & markup (FR-3.x) | `POST /api/autofill/shopify/quote` |
| Dispatch / the "agent" (FR-4.x) | `POST /api/autofill/dispatch` |
| Status & reconciliation (FR-5.x) | `GET /api/autofill/orders/{id}`, `GET /api/autofill/orders` |
| Evidence & disputes (FR-5.5) | `GET /api/autofill/orders/{id}/evidence` — **contains the delivery address in full; operator-only per FR-6.5** |
| Operator merchant health (§6.5) | `GET /api/autofill/reliability` — per-merchant success rate, excludes test-store orders |
| Merchant payment credential (FR-4.2) | `GET /api/autofill/cards` — the platform's vaulted cards. Card numbers never reach application code |
| Fan payment collection (FR-3.6) | **Not provided by this provider.** Separate PSP integration (Stripe, authorization hold with delayed capture) |
| Privacy boundary (FR-6.x) | Backend-only use of `ship_to` in quote/dispatch; destination digest `ship_to_sha256` for change detection; custom fan-safe response mapping |

### 8.1 Protocol decision: HTTP only

**Decision: the system shall integrate over the provider's HTTP API only, and shall not mix in the tool/MCP contract.** The official build guide for this product is written against the HTTP routes, uses explicit dispatch fields, and states that the two contracts must not be combined. `AgnicPort` remains a seam so the transport could be revisited later, but the build targets HTTP.

That decision carries consequences the platform must absorb, because guarantees the MCP layer provides do not exist over HTTP:

| Guarantee | MCP / tool layer | Over HTTP — what the platform must do |
|---|---|---|
| Request binding between approval and dispatch | `preview_order` mints a token bound to a hash of items, amount, currency, destination and caps; `place_order` refuses on any change | **Build it.** Digest the quoted request, persist it, verify before dispatch (FR-4.10) |
| Spending-mandate prerequisite | `preview_order` refuses with `setup_required` until a card, profile and signed mandate exist | **Enforce it.** HTTP will place an order for a caller with no mandate, recording that fact rather than refusing (FR-4.2) |
| Setup completeness | `setup_required` lists every missing prerequisite with a deep link | **Check it ourselves** at onboarding, before a creator can publish |
| Duplicate protection | Tool layer provides idempotency for the caller | **Own it entirely.** No provider idempotency header is available to us (FR-4.2c) |
| Order status | Same read route underneath | Unchanged — `GET /orders/{id}` |

Two HTTP-specific hazards to code against:

- **A `202` is not success.** `approval_required` arrives as a 202 carrying the approval token, the approval URL, its expiry, and a reason. An integration that treats a 202 as success reports an order that was never placed.
- **An error may still carry an `order_id`.** Read it before deciding what to do. A refusal that names an order is pollable, and a price-change refusal requires a fresh quote and renewed fan approval rather than a retry. Over HTTP the equivalent refusals arrive as the `409` family (`ship_to_mismatch`, `shopify_amount_changed`, `constraint_violated`) — all of them before any card is used, so all of them are safe.

HTTP dispatch is also why the fan's approval must be recorded in their own words with a timestamp: that text is dispute evidence and cannot be reconstructed afterwards.

### 8.2 Operational constants to design against

| Constant | Value | Consequence |
|---|---|---|
| Confirmation-token lifetime | ~5 minutes | Sets the concrete staleness window for R-5. Preview is free and idempotent — re-preview rather than nursing a token. |
| Typical place-order duration | ~60-70 seconds | The fan-facing order screen must handle ~1 minute of genuine uncertainty without implying failure. |
| `discover_merchant` duration | up to ~2 minutes | Cannot run inside a fan-facing request. Must be a background job triggered at curation time (FR-2.5, R-12). |
| Webhooks | **None exist** | Polling is the documented path, not a workaround. Drives the scheduler/reconciler architecture (FR-5.9). |
| Approvals | Separate approval-status endpoint keyed by token | Do not poll for approval by re-dispatching (FR-4.9). One step-up mints a new token per dispatch, so that loop never terminates. |
| Rate limits | Reads 120/min · quotes 30/min · orders and discovery 10/min **and 200/day**; keyed to the API key, not the IP | A burst of fans can exceed the quote limit. Requires an outbound throttle that reads the provider's own rate-limit response headers rather than counting locally. |
| Poll cadence | No faster than the work being polled; an order takes ~60-70s | The build guide states a 1s floor; the limits page states ~3s is ample. Use 3s. |
| Sandbox | A real shop in gateway test mode: two items at 1.00 CAD, ships CA/GB/US and much of western Europe, prices in CAD, GBP and USD | Exercises the entire rail with no money and no parcel. **A CAD-denominated shop, so the spending mandate must be in CAD or every dispatch fails permanently.** |
| The `test` flag | Orders from the sandbox report `test: false` | The flag describes whether the *merchant* is a designated test merchant, not whether the order was practice. Do **not** branch on it. |

### 8.3 Corrected status vocabulary

Store the provider's status verbatim (FR-5.6). **Note `dispatched` is a LIVE status, not terminal.**

- **Live:** `pending`, `dispatched`, `approval_required`
- **Terminal:** `succeeded`, `merchant_error`, `worker_error`, `price_changed`, `out_of_stock`, `payment_unconfirmed`, `payment_gate_hit`, `timeout`, `explored`

---

*This document should be treated as a v1 baseline with the corrections above. Still open: confirm whether any refund or void operation exists beyond the documented surface (assumed none — see FR-5.7), and validate FR-3.x markup disclosure and NFR-2.4 regional compliance with legal/compliance before build sign-off.*
