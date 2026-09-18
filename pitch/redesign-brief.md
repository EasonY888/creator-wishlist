# Redesign brief — paste this into Claude

---

I'd like a visual redesign pass across a Next.js 16 App Router + React 19 app (TypeScript, server components, plain CSS — **no Tailwind, no CSS-in-JS, no new dependencies**).

## Scope — the whole app's *appearance*

One visual pass across the app. Restyle freely; change no behaviour and no words.

### In scope for restyling

```
src/app/globals.css                              design tokens + primitives
src/app/layout.tsx                               the shell

Fan journey — what judges see first
  src/app/page.tsx                               home / creator list
  src/app/w/[slug]/page.tsx                      the public wishlist
  src/app/checkout/page.tsx                      pricing + delivery choice
  src/app/checkout/[fanOrderId]/page.tsx         the confirm screen
  src/app/checkout/[fanOrderId]/pay/page.tsx     the card step
  src/app/checkout/[fanOrderId]/pay/PaymentForm.tsx
  src/app/orders/[fanOrderId]/page.tsx           order status
  src/app/fan/login/page.tsx                     email code

Creator
  src/app/creator/[slug]/page.tsx                wishlist + address form

Internal
  src/app/ops/page.tsx                           operator queue
  src/app/ops/login/page.tsx                     operator sign-in
  src/app/ops/evidence/page.tsx                  the stage page
  src/app/ops/RefundForm.tsx
  src/app/ops/ResolveForm.tsx
  src/app/agnic/card-return/page.tsx
```

### Out of scope — do not open these

Every `actions.ts`, `src/app/api/**`, `src/app/orders/[fanOrderId]/AutoRefresh.tsx`, and
everything under `src/domain`, `src/orders`, `src/payments`, `src/fulfillment`, `src/agnic`,
`src/presentation`. The pages above are thin; the behaviour lives behind them.

## Hard constraints — do not violate

### 1. Copy is frozen. This is the rule you must not break.

**Do not change, reword, shorten, reorder or "improve" any user-visible text.** A visual
redesign touches layout, spacing, typography and colour. It does not touch sentences.

The copy on the fan-facing pages is a **contract**, not decoration. It is derived from a
requirements document and each line exists because something specific went wrong without it:

- *"Gifts ship to <creator>. Their address is never shown to you, and never appears on anything
  you can see."* — this is the track's headline promise.
- *"This places a hold for <amount>. You are charged only once the shop confirms the order — and
  never more than this amount."* — a ceiling must never be presented as a final total.
- *"Your gift is ordered"* — never *"on its way"*. A completed checkout is not proof of delivery.
- *"<creator>'s delivery address changed after this order was approved…"* — the refusal reason.
- *"An address is on file… it is stored encrypted: this page cannot read it back either."*
- Anything showing a withheld or unknown amount — it must never render as `$0.00`.

If a layout change makes a sentence wrap awkwardly, **change the layout, not the sentence.**
If you believe a string must change, say so in your reply and leave it as it is.

### 2. Logic is frozen.
No changes to server components' data fetching, prop shapes, `requireOperator()` calls, route
names, or form `action={…}` wiring. Presentation only. Do not add `'use client'` to a server
component, and do not convert any form to a client-side handler.

### 3. No new dependencies.
Plain CSS in `globals.css` only. No Tailwind, no CSS-in-JS, no component library, no icon
package, no fonts to download.

### 4. Legibility beats refinement.
This is projected on a screen and viewed from a few metres. Large numerals, generous spacing,
high contrast, no thin weights, no low-contrast grey-on-grey.

### 5. Two accessibility rules are enforced structurally and must survive.
Interactive targets ≥ 44px tall. State is never communicated by colour alone — every badge
carries a text label, and colour is only a secondary cue.

### 6. The fonts are already self-hosted — do not re-add the Google Fonts links.

`src/app/fonts.css` declares all 11 `@font-face` rules, pointing at `.woff2` files in
`public/fonts/`. `layout.tsx` imports that file.

**If you rewrite `layout.tsx`, keep `import './fonts.css';` and add no `<link>` tags.** The
fonts were previously loaded from `fonts.googleapis.com`, which put a render-blocking
stylesheet in the head of every page and made first paint depend on the network. They are now
vendored, so the app renders identically offline.

Keep using `--font-heading`, `--font-body` and `--font-mono` from `globals.css`. Do not
introduce a fourth family, and do not add a font CDN.


## Design tokens — already defined in `globals.css`

```css
--bg: #0f1115;      --surface: #171a21;   --surface-2: #1f232c;
--border: #2b303b;  --text: #e8eaed;      --muted: #9aa2b1;
--accent: #6ea8fe;  --ok: #79d19a;        --warn: #e6b455;
--bad: #f08a8a;     --radius: 10px;
```

Existing primitives you may reuse or restyle: `.card`, `.row`, `.stack`, `.badge`, `.badge-ok`, `.badge-warn`, `.badge-bad`, `.button`, `button.primary`, `.notice`, `.notice-warn`, `.notice-info`, `.total`, `.money`, `.muted`, `.small`, `.empty`, `.field`.

## Page structure — `/ops/evidence`

This is the page that matters. It is **five numbered sections**, each explaining one claim
about the system. All content is server-rendered; the page is a React server component with
no client state.

It uses two local helper components you should feel free to restyle or restructure:

```tsx
// Wraps a section. Renders <h2> with a muted number prefix.
<Section number="1" title="…">…</Section>

// One large figure: small muted label, big value, optional small muted sub-line.
<Figure label="…" value="…" sub="…" />
```

**Header** — a small back link to `/ops`, an `<h1>` ("What the product does not show you"),
and one muted intro paragraph.

---

### Section 1 — "The capture that was wrong — and what the code does now"

**This is the hero. It holds the single most important comparison in the project.** It is
also the densest section, and the one a judge will be looking at while I talk.

Its content, in order:

1. **A four-up row of large figures** (currently `<Figure>` ×4 in one `.row`):
   - `fan approved` → `$17.94` → sub: *the ceiling the UI showed*
   - `shop actually charged` → `$13.00` → sub: *real Agnic settlement*
   - `captured at the time` → `$17.94` → sub: *the whole ceiling — the bug*
   - `the code decides today` → `$15.99` → sub: *same inputs, after the fix*
2. **A second row of three figures**, the same story told as fees:
   - `fee the fan was shown` → `$2.99`
   - `fee kept — then` → `$4.94` → sub: *on a ceiling-shaped capture*
   - `fee kept — now` → `$2.99` → sub: *exactly what was shown*
3. **A callout** (currently `.notice-warn`) stating the overcharge in a sentence: *"we kept
   $4.94 having shown $2.99 — $1.95 more than the fan agreed to, per order."* This is the
   punchline of the whole demo. It must be the most prominent thing on the page after the
   hero figures. **Note:** this callout is conditional — if the order was captured correctly it
   renders as `.notice-info` instead. Design both states.
4. **A short paragraph** noting this was found against the live sandbox, which is the only
   place it could be found.
5. **A "the ledger, verbatim" block** — a list of raw ledger entries, one per line, in
   monospace: `authorized · $17.94 · pay_authorize_1`. Treat as evidence, not decoration.
6. **A provenance paragraph** — states plainly that the merchant side is real Agnic traffic
   while that order's fan rail used the in-memory double (visible in the `pay_…` refs). Fine
   print is correct here; it must be present and legible but should not compete with the hero.
7. **A "What this does not prove" paragraph** — the honest caveat.

**The one thing to get right:** the reader must instantly see *two numbers that should agree
and don't* (`$17.94` captured vs `$15.99` correct), and then the fee consequence. If it reads
as four equal figures with no emphasis, the section fails.

---

### Section 2 — "The creator's address, as the database holds it"

1. **A card** with an intro line ("Read with a raw `select` against Postgres — not an API, not
   a view. This is what a leaked dump would contain."), then **five labelled monospace values**:
   `fullName`, `streetAddress`, `postalCode`, `addressCountry`, and `digest — deliberately NOT
   encrypted`. Each value is a long base64url ciphertext string like
   `v1.a023d533.AssIbdWZcVCDb31q.KPTgaGWiFPXuXObyO_J54A.soAg1qfNG1h8u9Zy`.
   **These are the hardest thing on the page to read** — they're long, unbroken and wrap badly.
   Give them a treatment that stays legible: break at the `.` separators, allow wrapping, use a
   size that survives a projector, and don't let them overflow their container.
2. **A callout** explaining AES-256-GCM and why the digest is deliberately over the plaintext.
3. A closing paragraph on why the address lives in its own table.

The visual idea: **ciphertext should look like ciphertext.** This is the moment that proves
the promise, so the strings deserve to be framed as the exhibit they are.

---

### Section 3 — "The leak guard, and proof it is not vacuous"

1. **A card containing a two-column comparison:**
   - left: `a fan-facing payload` → the word **clean**
   - right: `the same payload, operator-shaped` → a comma-separated list of leaked paths
     (`$.evidence, $.evidence.ship_to, $.evidence.ship_to.street_address, $.order_url, …`)
   The right-hand value is long and will wrap. It is the proof, so it should be readable.
2. **A paragraph** explaining that a guard which finds nothing proves nothing, and naming the
   operator-only keys.

The contrast between **clean** and **a list of violations** is the whole point — make it a
visible juxtaposition, not two blocks of text.

---

### Section 4 — "Paths this system has actually handled"

1. **A vertical stack of small cards**, one per recorded outcome. Each card has:
   - a bold provider status (`dispatched`, `succeeded`, `(no provider status)`) and, when
     present, a muted `· error_code`
   - a muted sub-line: `fan order <state> · retryable <true|false|null — nobody knows> · next: <action>`
   - a **badge** on the right: `settled` (ok) or `handled` (warn/bad by retryability)
2. **A closing paragraph** noting that a quote-time refusal creates no order at all, so the
   409 cap refusal is deliberately not in this list.

This is a log. It should read as a list of things survived — scannable, uniform, calm.

---

### Section 5 — "The invariants"

1. **A stack of six cards**, each a bold one-line claim plus one muted sentence of reasoning.
   Titles are things like *"One order, one intent"*, *"One writer of order state"*,
   *"Never more than the fan approved"*.
2. **A footer paragraph** with the counts: *187 unit tests · 17 smoke suites · a real Stripe
   intent, a real signed webhook, and a real purchase at a real shop.*

Deliberately the quietest section — it's the closing note, not the argument.

---

## Page structure — the fan journey

**Read each file before restyling it.** The notes below are orientation so you understand each
screen's job, not a spec — the source is the source of truth. What matters is that you know
*what each screen is for* before you change how it looks.

| Route | What it is | What's on it |
| --- | --- | --- |
| `/` | Home — the pitch, in one screen | An `<h1>`, one muted sentence stating the promise, then a list of creators linking to their wishlist. Has an empty state. |
| `/w/[slug]` | The public wishlist — **the track's hero screen** | Creator's name, their items with an **indicative** price (labelled as indicative — it is not a price we honour), and the trust notice about the address. Each item starts a checkout. |
| `/checkout?item=…` | Pricing and delivery choice | The quoted price, and delivery options the fan picks between. Some quotes withhold the amount until a delivery option is chosen. |
| `/checkout/[fanOrderId]` | The confirm screen — **where the fan agrees to a number** | The total, the merchant's ceiling, and the fan's approval. This is the screen the "ceiling is never a total" rule protects, so its amount presentation matters most. |
| `/checkout/[fanOrderId]/pay` | The card step | "Pay for your gift", a card showing creator + amount, two trust notices (card data, address), then the Stripe Elements card form. **Three other states exist:** a "finishing" state after a bank redirect, a no-card fallback when the payment rail is the in-memory double, and an "unavailable" state when Stripe is not configured. All four need to look deliberate. |
| `/orders/[fanOrderId]` | Order status | Whether the fan was charged, the current state in plain language, and a timeline. Has an auto-refresh. **This screen must never imply the parcel is moving** — ordered is not shipped. |
| `/fan/login` | Email code | Two steps in one page: request a code, then enter it. The `sent=1` state shows the code form instead of the email field. |

### Two things to get right on the fan pages

1. **Money has three states, and they must look different:** a final total, a ceiling (a maximum
   the fan may be charged), and an amount that is *not yet known*. Conflating them — or styling
   them identically — is the single most damaging thing a redesign could do here.
2. **The card step has four states.** Design them as a set, not just the happy path.

---

## Page structure — `/ops` (the operator queue)

Secondary. **Do not restructure it**, it has too much behaviour attached. Light touch only
(spacing, card treatment, table legibility):

- Header row: `<h1>Order queue</h1>` and a sign-out `<form>` button
- A link through to `/ops/evidence`
- A muted count line: *"7 orders · 3 needing attention"*
- Conditional `.notice-warn` (problem) and `.notice-info` (note) banners carrying a result message
- `<h2>Needs attention</h2>` — a stack of order cards with status, a derived "attention reason",
  provider/retry details, a redacted-digest line, and inline refund/resolve forms
- `<h2>Recent</h2>` — a `<table>` of all orders with a per-row refund control

The inline forms (`RefundForm`, `ResolveForm`) contain real submit buttons with confirmation
dialogs. Restyle but do not rewire them.

---

## What looks wrong today

- `main` is capped at **880px**, so a four-up row of large figures wraps awkwardly. Wide figure rows need to break out of that cap, or the layout needs to be designed to stack deliberately rather than by accident.
- Sections all look identical: `<h2>` + card + card + paragraph. There's no visual hierarchy between "the headline number" and "supporting note", so nothing guides the eye.
- The page is long and reads as a document. On stage I need to talk to it in four places, so the **five sections should be visually distinct and scannable** rather than uniform.
- Large figures use `.total` at the same weight as everything else in the card; they don't dominate.
- Dense monospace strings (ciphertext, digests, ledger refs) wrap mid-value and are hard to read at a distance. They need to be chunked, or given their own treatment with wrapping at sensible boundaries.

## What good looks like

- **A hero moment.** Section 1 holds the single most important comparison in the whole project — four money figures where one is wrong and one is right. That should be unmissable, and the contrast between "then" and "now" should be readable at a glance without narration.
- **Hierarchy.** A clear ladder: hero figures → section framing → supporting prose → provenance fine print. Right now everything is the same size.
- **Restraint with colour.** Use `--ok` / `--warn` / `--bad` to mark the one thing that was wrong and the one thing that's now right. Do not colour everything; that removes the signal.
- **Prose that isn't a wall.** Several sections are explanatory paragraphs. Keep them readable without letting them dominate the page.

## Per-route warnings — read the one for each page before you restyle it

These are the specific ways a *visual* change on these routes becomes a *correctness* change.
They are not style preferences. One of them was already broken on the first pass (the wishlist
claimed a "final total" that does not exist on tax-added markets).

### `/checkout/[fanOrderId]` — the confirm screen. Highest risk.

- **The amount may be a CEILING, not a total.** It is the maximum the fan may be charged, and
  the design plan forbids presenting it as the final figure. Do not add the word "total", do not
  style it as final, and do not change the surrounding wording that establishes it as a maximum.
- **There is a state where the amount is withheld entirely** (when the merchant offers a delivery
  choice and none has been made). It must render as *no number at all* — **never `$0.00`, and
  never a reused figure from a previous quote.** Design that state deliberately.
- Every figure comes from `formatMoney(...)`. Never hardcode or re-derive one.

### `/checkout/[fanOrderId]/pay` — the card step. Second highest risk.

- **It has four states, not one.** Design all four: the card form, the "finishing" state after a
  bank redirect, the no-card fallback when the payment rail is the in-memory double, and the
  "unavailable" state when Stripe is not configured.
- ⚠️ **The card fields are a cross-origin iframe. You cannot style them.** You can only size and
  position the container. Specifically:
  - Do **not** put `overflow: hidden`, `height: 0`, or `max-height` on the element that wraps
    `<PaymentElement />` or any of its ancestors.
  - Do **not** apply `transform`, `zoom`, or `scale` to an ancestor — it breaks Stripe's own
    iframe measurement and the card fields collapse to a few pixels.
  - Give the container room to grow. Stripe sizes its own frame from its content.
  - This already cost hours to diagnose once. If the card frame is tiny, the cause is a
    container, not Stripe.
- **Do not touch the form submission.** There is a real submit handler with a confirmation and a
  server action. Restyle the button; do not rewire it.

### `/orders/[fanOrderId]` — order status

- **Never imply the parcel is moving.** A completed checkout confirms the order was *placed*, not
  dispatched. Do not add icons, progress bars, or copy suggesting shipping.
- It must answer **"was I charged?"** before anything else.
- **An unknown outcome is not a failure**, and a withheld amount is not `$0.00`. Both have
  designed representations already — keep their distinct treatments.

### `/ops` — operator queue

- The refund and resolve forms **move money and have confirmation dialogs**. Restyle them; do not
  change their `action` wiring, their hidden inputs, or the fields they submit.
- Address-bearing fields stay redacted. Do not "improve" them by showing more.
- The approve-charge/release pair must stay visually neutral — neither is the safe default.

### `/ops/evidence` — the stage page

The detailed section map is above. Two rules on top of it:

- **Every figure must stay bound to live data.** The hero four numbers come from `fanChargeFor`
  and the ledger. If you hardcode any number to make the layout look right, the page becomes a
  lie and it is worse than the unstyled version.
- Single author, single page. It carries the most information per screen; do not simplify it by
  dropping a section.

### Lower risk — `/checkout`, `/creator/[slug]`, `/fan/login`, `/ops/login`, `/agnic/card-return`

Chrome, layout and typography only. The same copy freeze applies, plus: on
`/creator/[slug]` the address form **must not display the stored address** — it writes without
reading, deliberately. Do not add a field that shows it back.

## Suggested order

**Already done in the first pass** — `globals.css`, `layout.tsx`, `/` and `/w/[slug]`. Do not
redo them.

Ten routes remain. Do them in this order, and make each step independently shippable — a
half-redesigned app is worse than a plain one.

**Tier 1 — on the demo path. These are what a judge actually looks at.**
1. `/checkout/[fanOrderId]` — the confirm screen
2. `/checkout/[fanOrderId]/pay` — the card step *(read its warning first; the Stripe iframe is
   fragile)*
3. `/ops/evidence` — the stage page, section map above

**Tier 2 — reached during the demo**
4. `/ops` and `/ops/login`
5. `/orders/[fanOrderId]`

**Tier 3 — supporting screens**
6. `/checkout`, `/creator/[slug]`, `/fan/login`, `/agnic/card-return`

Send each step as a **separate reply** so I can apply and verify them one at a time, rather than
one large diff. I will check each against the live database and the test suite before moving on,
so a batch that breaks something costs a round trip.

**A page that renders is worth more than a page that looks good.** If you are unsure whether a
change is safe, leave it out and say so.

## Deliverable

Give me the complete updated file contents for each file you change — **full files, not diffs**,
one step at a time as described above. Keep the existing data-fetching blocks, form `action`
attributes, and the `Section` / `Figure` helper components intact: they can be restyled or
reorganised, but the data they render must not change and no number may be hardcoded.

If you find something in the existing markup that you think is a genuine bug rather than a
styling problem, **describe it in your reply and leave the code alone.** I will decide.
