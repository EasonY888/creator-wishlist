# Hand-off message for Claude

> **Start here.** This file is the message. The design spec is `pitch/redesign-brief.md` — read
> **that whole file**, not just the top. The **Per-route warnings are at the very end**, and they
> are the part that bites: every trap found so far was found there.

---

Your first pass is applied and verified. Before you continue: three corrections, and the plan for
the rest.

## Do not redo these — they are done

`globals.css`, `layout.tsx`, `/`, `/w/[slug]`, and **`/checkout/[fanOrderId]`** — verified in a
real browser against live data.

## Three changes I made after your pass

**1. The fonts are now self-hosted.** `src/app/fonts.css` declares all 11 `@font-face` rules
against `.woff2` files in `public/fonts/`, and `layout.tsx` imports it. The `<head>` block with
the three Google Fonts `<link>` tags has been removed — a stylesheet link to
`fonts.googleapis.com` is render-blocking, so first paint depended on the network reaching
Google.

⚠️ **If you emit `layout.tsx` again, keep `import './fonts.css';` and add no `<link>` tags.** Do
not re-add a font CDN, and do not add a fourth family. Keep using `--font-heading`, `--font-body`
and `--font-mono`.

**2. I removed `· final total confirmed at checkout` from `/w/[slug]`.** On tax-added markets the
figure the fan approves at checkout is a **ceiling**, not a final total, so that claim was false.
Read the "Per-route warnings" section of the brief before touching the checkout pages — there is
more of this class of trap, and this is exactly what it looks like.

**3. I rewrote the quote-validity line on `/checkout/[fanOrderId]`.** It used to print
`valid for about 5 minutes` from a constant. It now reports the quote's **actual** remaining life,
read from the row's own expiry:

```tsx
Quoted {relativeTime(order.quote?.createdAt)}
{remainingSeconds === null ? null : remainingSeconds > 0
  ? ` · this price holds for another ${durationWords(remainingSeconds)}`
  : ' · this price is past its window and will need re-quoting'}
```

**Do not revert this to the old wording.** A demo quote is deliberately parked with a longer life
than five minutes, so a constant there would state a figure the row does not carry — on the one
screen whose whole purpose is not doing that. That expression is live data, not decoration. Style
it however you like; leave the expression alone.

## Next: the remaining 9 routes

**One step per reply, full file contents each time.**

**Tier 1 — on the demo path**

1. ~~`/checkout/[fanOrderId]`~~ — **done, do not revisit**
2. `/checkout/[fanOrderId]/pay` ← read its warning first, the Stripe iframe is fragile
3. `/ops/evidence` ← section map is in the brief

**Tier 2**

4. `/ops` and `/ops/login`
5. `/orders/[fanOrderId]`

**Tier 3**

6. `/checkout`, `/creator/[slug]`, `/fan/login`, `/agnic/card-return`

## Rules, restated because they matter

- **Copy is frozen.** Do not change any user-visible sentence. If you think one must change, say
  so in your reply and leave it.
- **Presentation only.** No changes to data fetching, prop shapes, form `action` wiring, hidden
  inputs, or `requireOperator()` calls. Do not open any `actions.ts`, `src/app/api/**`, or
  anything under `src/domain`, `src/orders`, `src/payments`, `src/fulfillment`, `src/agnic`,
  `src/presentation`.
- **No hardcoded data.** Every figure stays bound to live data.
- **No new dependencies.** Plain CSS in `globals.css` only.

I will run the type checker, the 187-test suite, and load each page against the live database
before accepting a step. If something breaks I will send it back with the specific output.

**A page that renders is worth more than a page that looks good.** If you are unsure whether a
change is safe, leave it out and say so.

Start with Tier 1, step 2: `/checkout/[fanOrderId]/pay`.
