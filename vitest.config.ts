import { defineConfig } from 'vitest/config';

/**
 * Unit tests, kept deliberately narrow.
 *
 * **These cover pure logic only.** Anything that needs Postgres — the outbox, the
 * dispatcher, the reconciler, the worker — lives in `scripts/smoke-*.ts`, which
 * run against a real database on purpose. An order pipeline tested against a
 * mocked database is a test of the mock.
 *
 * What is left here is the logic that is expensive to test end to end and cheap
 * to test directly: the action precedence, the charge arithmetic, the pricing
 * rules, the FSM guards, and the digest that has to survive a `jsonb` round trip.
 *
 * `.test.tsx` is included too, for components whose *wiring* is load-bearing.
 * That gap is not hypothetical: `ResolveForm` shipped with a submit button whose
 * `name` React overrides when `formAction` is a server action, so the decision
 * arrived empty and the action fell through to "release the hold". Every domain
 * test passed, because the domain was never the broken part. The file opts into
 * jsdom with a `@vitest-environment` comment rather than switching the default.
 *
 * A separate `vitest.config.ts` also means `next build` never sees these files.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
  },
});
