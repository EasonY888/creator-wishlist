# Milestone — Address encryption at rest (NFR-2.2)

**Scope:** NFR-2.2 — the creator's delivery address must not be readable at rest.
**Status:** complete. 148 unit tests, 17 smoke suites, clean typecheck, clean build.

---

## 1. What the requirement asked for, and what was already there

Role gating and an audit table already existed, and the address already lived in its own
table rather than as columns on `Creator`. That isolation was doing real work — if the
address were columns, the boundary would be "which queries remember to select them", and
a boundary enforced by memory is not a boundary.

What was missing was the encryption itself. The blocker was a decision, not code:
*where does the key come from?* That is now decided, so it is built.

---

## 2. The decision

| Question | Answer |
| --- | --- |
| Algorithm | AES-256-GCM — authenticated, so a tampered ciphertext fails to decrypt rather than decrypting to a corrupted address |
| Key source | `ADDRESS_ENCRYPTION_KEY`, 32 bytes hex, from the environment |
| Rotation | `ADDRESS_ENCRYPTION_KEY_PREVIOUS`, tried on read only |
| Missing key | **throws**. No plaintext fallback |
| Storage format | `v1.<keyId>.<iv>.<tag>.<ciphertext>`, base64url |

The version prefix and key id are the part that makes rotation survivable. A row states
which key opens it, so rotation is a data migration run at your own pace rather than a
flag day where everything must be re-encrypted before the next read.

**There is deliberately no plaintext fallback.** A fallback is not a safety net — it is a
configuration bug that stays invisible until the one environment where nobody set the
variable, which is the environment least likely to be checked.

---

## 3. The subtle part: the digest

`CreatorAddress.digest` proves the fan's approved destination is unchanged. It is computed
over the **plaintext** address and is **not encrypted**.

That is not an oversight, and it is the classic mistake to avoid here:

```
digest = hash(plaintext destination)

  fan approves order  ->  digest stored on ApprovedRequest
  ...time passes...
  key rotates         ->  if digest were over ciphertext, it changes
                      ->  every outstanding approval now fails its binding check
                      ->  a key-management chore has silently cancelled orders
```

So encryption and binding are kept independent on purpose. The digest is a commitment to
the *destination*, not to its representation.

---

## 4. Single read path, single write path

Both live in `src/fulfillment/address-store.ts`:

- `writeCreatorAddress` — the only writer. Encrypts every field, computes the digest from
  the plaintext, and enforces the two-letter country rule.
- `loadShipToForFulfillment` — the only reader. Role-gated, audits every access, and
  decrypts **after** writing the audit row, so a read that fails to decrypt is still
  recorded as an attempt.

### A constraint changed owner

`addressCountry` was `@db.Char(2)`. A ciphertext does not fit in two characters, so the
column became plain `String` and the rule moved into the writer, where it throws on
anything that is not a two-letter code.

This is worth stating plainly: **the constraint did not disappear, it changed owner.**
A database constraint that silently stops applying is exactly the kind of thing that looks
like a cleanup and behaves like a regression.

---

## 5. Converting the rows that predate it

`scripts/encrypt-existing-addresses.ts`.

It has to read the columns raw, because the store now refuses to return anything it cannot
decrypt — correct everywhere except here, where the plaintext *is* the thing being
converted. So it is the one place in the repository allowed to look at an unencrypted row,
and it says so in a comment.

It is idempotent (a row already encrypted is skipped, so re-running after a partial failure
is safe) and it re-derives each digest, reporting a mismatch rather than quietly rewriting
history. A mismatch means the row was written without recomputing its digest, which is
worth knowing before it invalidates a live order.

Evidence from the run:

```
2 address row(s) found
  encrypting demo-creator (cmu5uu9d00001ggkpq4nv0vy5)
  encrypting live-creator (cmu5vwkde0001gkkp6rq3oicx)
converted:      2
already done:   0

--- re-run to prove idempotence ---
converted:      0
already done:   2
```

Verified directly in Postgres — the columns are now ciphertext, the digests are not:

```
            full_name             |         postal         |      digest
----------------------------------+------------------------+------------------
 v1.a023d533.AssIbdWZcVCDb31q.KPT | v1.a023d533.loshDUBJn8 | a430b03563d94011
 v1.a023d533.W6QwWkWkuGKOKXca.ZrM | v1.a023d533.9jkucIHamn | 15d07b0dbb20f1b7
```

---

## 6. The gap that hid two real bugs

While wiring this up, a missing import in four scripts went undetected by `npm run
typecheck` — which reported **clean**.

The cause:

```json
"exclude": ["node_modules", "scripts"]
```

`scripts/` was excluded because it is not part of the Next.js build. That is correct for
`next build` and wrong for checking our own work: it meant a script could be wrong in a way
that only appeared at runtime, half-way through a database run, after side effects.

Fixed with a second config (`tsconfig.scripts.json`) that typechecks `src` and `scripts`
together, wired into `npm run typecheck`.

**It found 7 errors immediately.** Two were real bugs, not style:

| Script | Error | Why it mattered |
| --- | --- | --- |
| `smoke-stripe.ts` | `approvedRequest` did not exist on the queried type | The include omitted the relation, so the guard `approvedRequest !== null` was testing `undefined !== null` — always true. The check was passing without checking anything |
| `smoke-checkout.ts` / `smoke-dispatcher.ts` | plaintext address writes | Both simulated a house move with a raw `creatorAddress.update`. Encryption turned that into a runtime failure — which is the encryption working, but it should have been caught by the compiler |
| `smoke-cap-refusal.ts` | `payments` missing from the deps | See below |
| `smoke-curation.ts` | `ConstructorParameters<...>[0]['lookup']` | The constructor argument is optional, so the indexed type was `FakeScript \| undefined` |
| `smoke-scenarios.ts` (×4) | string widening on `provider` / `action` | Meant `presentOrder` could be handed anything |

The `smoke-cap-refusal.ts` one turned into a design improvement. `priceWishlistItem` took
the full `CheckoutDeps`, including `payments` — but pricing never touches the payment rail.
So the type claimed a dependency that did not exist, and callers who only wanted a quote
had to invent a payment provider. It now takes a narrowed `PriceDeps`, which means **an
edit that tries to charge during pricing will not compile.** The invariant was a comment;
it is now a type.

---

## 7. Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` (app) | clean |
| `npm run typecheck:scripts` | clean — was 7 errors |
| `npm test` | 148 passed, 8 files, ~0.8s |
| `npm run build` | clean, 9 routes |
| `scripts/smoke-*` | 17/17 pass |
| Ciphertext in Postgres | confirmed |
| Migration idempotence | confirmed |

The two smoke suites that failed on the first run after encryption — `smoke-checkout` and
`smoke-dispatcher` — failed with `AddressCryptoError: Value is not in the expected
encrypted form`. That is the control working: an unencrypted row was rejected at the read
gate. Both were fixed by routing the simulated address change through `writeCreatorAddress`,
which is the same call a creator's settings form would make.

---

## 8. What is still open

- **No creator-facing address form.** `writeCreatorAddress` is the encrypted write path and
  **nothing in `src/` calls it** — only `seed.ts` and `live-order.ts`. The "creator moves
  house" flow exists in the data model and is enforced at dispatch, but no UI or server
  action triggers it. A UI gap, not a security one.
- **Key management is an environment variable.** Right for this stage, and the seam is that
  `keysFromEnv` takes the environment as an argument, so a KMS or vault source can be
  substituted without touching callers. Worth doing before a real deployment.
- **`.env` now needs `ADDRESS_ENCRYPTION_KEY`.** Without it, address reads and writes throw.
  That is intended, but it means a stale `.env` fails loudly rather than quietly.
