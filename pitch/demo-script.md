# Demo script — the performance plan

Three minutes on stage. This is the operational version: what's on screen, what you click,
what you say, and what happens when it breaks.

**Read the diagnosis first, because it drives everything else.**

---

## 0. What can and cannot be *shown* today

| Point you must land | Visible today? | Where |
| --- | --- | --- |
| The promise — her address never reaches the fan | ✅ | Fan wishlist, checkout, card step |
| A real purchase completed at a real shop | ✅ | `/ops` queue (but 60–70s live) |
| **The fan paid the right number, not the ceiling** | ❌ | only in the database |
| **Failure paths are handled, not hoped for** | ❌ | only in scripts |
| **The depth** (digests, audit, one-intent, guards) | ❌ | only in code and tests |

Three of five are invisible. That is the whole problem, and it is why the first build in
this plan is not a feature — it is a **surface**.

---

## 1. Build: one evidence page

**`/ops/evidence`** — a single stage page, behind the operator login you already have.

Why a page and not a terminal:

- **Legible at projector resolution.** Fixed layout, big numbers, no scroll-hunting.
- **Cannot be derailed.** No stray keystroke, no shell history, no prompt in the wrong place.
- **Pulls live data.** Every number on it is read from the same tables the product uses, so
  it is not a slide — and you can say so.
- **It stays behind auth**, which is a bonus: logging in demonstrates the gate you built.

What it renders, in this order:

1. **The money moment.** Take the real settled order and lay the four numbers out:
   `approved 1794` / `merchant charged 1300` / `captured 1599` / `not captured 1794` — plus the
   fee that was *shown* (299) and the fee a capture-the-ceiling implementation would have kept
   (494). That gap is the entire argument in one line.
2. **The address row, raw.** The actual ciphertext from `CreatorAddress`, next to the digest
   that is deliberately *not* encrypted, with the one-sentence reason why.
3. **Fan vs operator, side by side.** The fan payload, and the operator payload with the
   leak-guard refusing to let it through. Proves the guard is non-vacuous.
4. **The failure log.** The real outcomes this system has actually handled: the 409 cap
   refusal, the step-up, the out-of-stock, the decline, the address change.
5. **The invariants.** Six one-liners — the things that are true and would be bugs if they
   weren't.

That page lets you *show* all five points instead of asserting three of them.

---

## 2. The three-minute script

Have exactly two browser tabs open: **Tab A** = the fan journey, **Tab B** = `/ops/evidence`.
Nothing else. No terminal.

### 0:00–0:20 · The promise — Tab A, `/w/demo-creator`

> "Maya lists what she'd love. Fans pick a gift, pay, and we ship it to her. Which raises the
> question this whole track is about: how does the money work when the fan never sees where
> it's going — and doesn't know the final price?"

Point at: *"Gifts ship to Demo Creator. Their address is never shown to you…"*

### 0:20–0:45 · The price she actually approves — Tab A, checkout

> "The shop adds tax at checkout, so the final total **isn't knowable in advance**. Agnic's own
> docs say so. So the fan approves a **ceiling**, and we say that plainly — we never present a
> ceiling as a total."

### 0:45–1:15 · The card step — Tab A, pay page

> "Card data goes straight to Stripe. It never touches our servers. We **hold** the money here —
> we don't take it."

*(Do not complete a live payment on stage. The hold is already real from a rehearsal run, and
Tab B proves it. Save the clock.)*

### 1:15–2:15 · The money moment — Tab B, `/ops/evidence`

**This is the beat that wins it.** Point at the four numbers, and tell it as what it is — a
bug you found and fixed, not a feature you designed.

> "This is a real order from before the fix. The shop charged **13.00**, and we captured the
> whole ceiling — **17.94**. So we kept **4.94** having shown the fan **2.99**. A 1.95
> overcharge on every order, and the fan only finds it on their statement.
>
> Here's the same merchant figure through today's code: it decides **15.99**. Fee kept,
> **2.99** — exactly what was shown.
>
> We found this against the live sandbox. The merchant charged *less* than the ceiling, and no
> test double can produce that — that's why it survived a green test suite.
>
> And the obvious implementation captures the ceiling and refunds the difference: two
> statement lines, a refund fee, and a window where the fan's money is gone. We authorised the
> ceiling precisely so we could capture anything up to it, so the fan is charged the right
> number **once**. The refusal to capture more than was shown is now a function, not a
> convention."

Then point at the provenance line and say it before anyone asks: the merchant settlement is
real Agnic traffic; this order's *fan* rail ran on the in-memory double, which is visible in
the `pay_…` refs. Naming that yourself is worth more than being caught by it — and it lets you
say the live Stripe rail was exercised separately, where a real `pi_…` intent was authorised
and the hold confirmed.

### 2:15–2:45 · The promise, proven — Tab B, lower half

> "Now the address. This is the raw row from Postgres — not an API, the shell. Ciphertext.
>
> The digest next to it is **not** encrypted, on purpose: it's over the plaintext, so rotating
> the encryption key can't change it. If it moved with the key, a key rotation would silently
> cancel every outstanding approval.
>
> Fan columns — no address, ever. Operator columns — the leak guard names the fields and
> refuses. And when Maya moves house:"

Point at the refusal.

> "Dispatch refuses. The price the fan agreed to was computed for a destination."

### 2:45–3:00 · Close

> "Agnic answers *can an agent complete the checkout*. We answer *what did the human approve,
> and did they pay exactly that*. Six hundred lines of tests say we're serious about the second
> one."

**If you have ten seconds left, use the sentence in §6 of the judge brief.** Do not ad-lib a
new close.

---

## 3. If you have a longer slot

Add, in this order — each is ~40s:

1. **The cap refusal, live** — `demo-cap-refusal.ts` is real and fast, but run it *before* the
   money moment, or record it. 409, `constraint_total_exceeded`, no order created.
2. **The live dispatch** — only if the network is yours. Otherwise play the recording and say
   you're playing the recording. Judges respect that more than a spinner.
3. **The ops queue** — a human is the last resort, not the first, and a handoff escalates
   after 15 minutes.

---

## 4. Fallbacks, in order of likelihood

| What breaks | What you do |
| --- | --- |
| Live dispatch is slow / fails | Play the recording. Say: "this is a recording of the live run." |
| Network to Agnic is down | Everything on Tab B is local and still works. Skip the dispatch, keep the money moment. |
| Docker isn't running | Nothing works. §5 is not optional. |
| Dev server dies | You have a `npm run build` + `npm start` fallback. Rehearse it once. |
| A judge interrupts early | Go straight to Tab B. The money moment is the answer to almost every question. |

---

## 4b. The fallback recording — make it today, not on the day

The live dispatch takes 60–70 seconds and depends on the network between here and Agnic. It is
the one part of the demo you cannot control, so it gets a recording. Record it **now**, while
you are still assembling demo data — not the morning of.

```
npx tsx scripts/live-order.ts --slug=rehearsal-creator --reset
```

**Use `--slug=`.** Run as `live-creator` this deletes the real settled order that `/ops/evidence`
reads — and that order *is* the money moment. The script now refuses to do that unless you pass
`--reset`, but a scratch creator is the cleaner path. `cleanup.ts` sweeps `rehearsal-` afterwards.

Capture, in one continuous take of about 90 seconds:

1. The command's own output — the live quote, `amount_is_final`, the dispatch, and the
   `--- result ---` block with the provider order id, the provider status and the ledger.
2. The `/ops` queue in a second window: the row appearing, going `processing → succeeded`.
3. Nothing else. No window switching, no hunting for a cursor.

Save it as `pitch/fallback-dispatch.mp4`. While it plays, say this — it matters:

> "This is a recording of a real run against the live sandbox, made a few days ago. I'd rather
> show you the recording than gamble on someone else's network in front of you."

Saying it is worth more than being caught by it. Then return to Tab B, which is entirely local
and does not care whether the network exists.

Then sweep the scratch creator:

```
npx tsx scripts/cleanup.ts --dry-run     <- rehearsal-creator should be the only addition
npx tsx scripts/cleanup.ts
```

---

## 5. Pre-flight — 10 minutes before

One command checks the environment, the database, the app, the provider account and the demo
data, and prints the exact fix for anything broken:

```
npx tsx scripts/preflight.ts
```

It exits non-zero on a failure, so **a NO-GO is final** — fix it or change the plan. It covers
everything that has already gone wrong once during this build: a stopped Docker daemon, a
missing `SESSION_SECRET`, an empty `STRIPE_WEBHOOK_SECRET`, a missing `ADDRESS_ENCRYPTION_KEY`,
`PAYMENTS_MODE` still on the fake, an empty operator queue, and a parked ceiling order that has
gone missing.

Then park the two orders the script actually uses. They are **different screens**, and the
ceiling beat has no other source:

```
npx tsx scripts/seed.ts                   <- only if you need to rebuild the demo creator
npx tsx scripts/park-ceiling-order.ts     <- approval screen, showing a CEILING (0:20-0:45)
npx tsx scripts/live-card-step.ts         <- the card step (0:45-1:15)
```

**Seed before you park.** `seed.ts` rebuilds `demo-creator` from scratch and drops its orders,
so parking first loses the parked order with no error at all. `preflight.ts` checks for it
afterwards — that is where you find out.

`park-ceiling-order.ts` re-quotes live and parks at `draft` against a non-final quote, so the
"maximum, not an exact total" notice *and* the approval field are both on screen — that is the
approval act from §2. It never deletes the creator and never touches the settled order.

**The parked order is owned by the fan who last signed in.** `startPayment` refuses an order
whose `fanId` is not the session's, so an order parked under a different fan can be *shown* but
never *approved*. Park it after step 1 above, or pass `--fan=you@example.com` to say who owns it.
It prints `owned by …` either way — check that line matches who you will be signed in as.

`live-card-step.ts` seeds a **final** amount, so it renders a plain total. Correct for the card
beat, useless for the ceiling beat.

Pre-flight prints the parked order's URL in its closing list, so you do not have to go looking.

Then:

1. **Sign in as a fan, in Tab A, before anything else.** No email provider is configured, so the
   code is never emailed — get one with `npx tsx scripts/fan-login-code.ts <email>` and enter it
   at `/fan/login`. The session lasts 30 days.

   **This is not optional.** Clicking "Send this gift" on `/w/demo-creator` redirects an
   anonymous visitor to `/fan/login?next=/checkout?...`, so without a session §2 stalls on a login
   screen — and the code to get past it is only readable in a terminal, which §2 forbids you from
   having open. Sign in during rehearsal and the whole journey runs clean.
2. Open Tab A on `/w/demo-creator`
3. Open Tab B on `/ops/evidence` and sign in **once**, then leave it
4. Zoom the browser to ~125%
5. Close Slack, email, notifications

Run both sign-ins **twice** — the morning of, and ten minutes out. The fan session survives; the
operator session is the one that can expire.

---

## 6. Rehearsal

Rehearse **three times**, out loud, with a timer:

- Run 1: text in hand, find the rough edges.
- Run 2: no notes. Note where you hesitate — that's the bit to cut, not to practise.
- Run 3: hostile. Have someone interrupt with "why didn't you just use an LLM?"

Then stop. Change nothing after the third run.
