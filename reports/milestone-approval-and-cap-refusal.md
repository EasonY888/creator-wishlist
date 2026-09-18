# Milestone: Approval Continuation & Controlled Refusal

Two remaining scored demo paths, both now implemented and proven.

| Path | Status | Evidence |
| --- | --- | --- |
| Step-up approval continuation (CVV refresh) | Done, proven | `scripts/smoke-approval.ts` — 12/12 |
| Spending-cap refusal | Done, proven live | `scripts/demo-cap-refusal.ts` + `scripts/smoke-cap-refusal.ts` — 11/11 |

---

## 1. Approval continuation

A `202` with `approval_required` is not a failure. It means the shop wants the
fan to re-authorise, and the purchase is parked until they do. The trap is that
the order is *indistinguishable* from a stuck one unless the reason is read.

Implemented in `src/orders/approval.ts`:

- **Currency mismatch is checked before expiry.** It is a permanent
  configuration fault — waiting cannot fix a mandate issued in the wrong
  currency. Polling it would dress a setup problem up as a stuck order.
- **Expiry releases the hold.** A `202` means nothing was ever placed, so a
  lapsed approval is the one case where unwinding is unambiguous.
- **Approval → resume.** `resumeDispatch` CAS-consumes the approval window
  (`consumedAt: null AND expiresAt > now`), transitions
  `approval_required → dispatching`, and dispatches with the token.

Verified:

```
cvv refresh: order succeeds                     ok   approval_required -> still_pending -> resumed -> still_processing -> captured
cvv refresh: dispatched a second time           ok   2 dispatch calls
cvv refresh: approval window consumed once      ok   consumedAt set on exactly one window
cvv refresh: charged our total, not merchant    ok   captured 1200
currency mismatch: order stays awaiting         ok   approval_required
currency mismatch: NO approval poll queued      ok   none queued
currency mismatch: dispatched exactly once      ok   1 dispatch calls
currency mismatch: no money moved               ok   0 payment calls
expired approval: order fails                   ok   failed
expired approval: hold released                 ok   released
expired approval: never dispatched twice        ok   1 dispatch calls
expired approval: never captured                ok   0 capture calls
```

**The dispatch-once invariant survives.** A second dispatch happens, but only
ever behind a granted approval — the window is consumed exactly once and the
CAS is what enforces it. This is the single sanctioned exception, and it is
narrow enough to state precisely rather than hand-wave.

---

## 2. Controlled refusal when a cap is exceeded

### Live, against the sandbox

```
real merchant total    1495 minor CAD
final or ceiling?      ceiling
subtotal               100 minor

cap 500, re-quoted:
  state                 refused
  http status           409
  code                  constraint_total_exceeded
```

The refusal arrives **before any card exists**: nothing to unwind, no hold to
release, no fan money involved. A refusal creates no provider order at all.

### Order-level handling

The same breach can land *after* approval, when we are already holding the
fan's money. That is the dangerous case, because a post-approval refusal looks
exactly like a pre-approval one unless the evidence is read correctly.

```
pricing: cap breach surfaces as a refusal       ok   refused
pricing: refusal carries the provider code      ok   constraint_violated
pricing: no order was created                   ok   zero orders
dispatch: order ends failed, not stuck          ok   failed (dispatched -> released)
dispatch: the hold was released                 ok   released
dispatch: released exactly once                 ok   1 release calls
dispatch: never captured                        ok   0 capture calls
dispatch: never retried against the same cap    ok   1 dispatch calls
dispatch: the refusal reason was recorded       ok   shopify_amount_changed
unreadable money state: nothing was released    ok   0 release calls
unreadable money state: nothing was captured    ok   0 capture calls
```

The last two are the asymmetry that makes the rest safe. Releasing a hold on an
order that actually charged is far worse than reconciling one that did not, so
an unreadable money state releases nothing. `refusedBeforeCard` only returns
true on positive evidence (`charge_state: 'none'`) or on *no evidence at all*
paired with a re-quote — never on absence of information alone.

---

## Findings

**1. `constraint_total_exceeded` was missing from `REFUSAL_CODES`.** The enum
documents itself as the set of pre-charge refusals, and the live code for a cap
breach was not in it. No behavioural bug — nothing branches on the code, and
`refusedBeforeCard` keys off evidence plus the retry action — but the enum was
making a claim it could not support. Added, with the observed evidence.

**2. The bind guard caught a bad test seed, not a bad system.** The first run of
the cap smoke failed with `binding_failed:request_changed` and **zero** dispatch
calls. The seed computed the request digest without `constraints` while
`rebuildBoundRequest` reads them back out of the row, so the digests could never
match. The guard refused the order before spending a card — correct behaviour,
wrong test. Worth remembering: `BoundRequest.constraints` must be present on the
object the digest is computed from.

---

## Honest limits

- The cap refusal is demonstrated **live** at *pricing* time (real 409, real
  figures). The *dispatch-time* breach is proven with the fake
  (`priceChanged`), because a live price change cannot be forced on the sandbox.
  The mechanism is the same code path; only the trigger differs.
- Both paths are proven by smoke scripts, not by a regression suite. There are
  still no unit tests in the repo (`npm test` has nothing to run).
- `charge_state: unknown` correctly does nothing today, which means an order in
  that state waits for a human. There is no staleness alert if nobody looks.

---

## Verification summary

| Suite | Result |
| --- | --- |
| `smoke-approval` | 12/12 |
| `smoke-cap-refusal` | 11/11 |
| `smoke-checkout` | 16/16 |
| `smoke-dto` | 13/13 |
| `smoke-pipeline` | 22/22 |
| `smoke-outbox` | all invariants held |
| `smoke-binding` | all cases caught |
| `smoke-scenarios` | dispatch-once held for all |
| `smoke-db` | 13 tables / 6 enums / SKIP LOCKED ok |
| `npm run typecheck` | clean |
