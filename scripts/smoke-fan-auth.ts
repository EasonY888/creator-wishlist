/**
 * The fan login flow, end to end against a real database.
 *
 * The signing is unit-tested in `src/fans/auth.test.ts`. What can only be checked
 * here is the part that involves the code's lifetime: that it is stored hashed,
 * that it is consumed exactly once, that guessing is bounded, and that asking for
 * a new one retires the old one.
 *
 * Each of those is a real attack path rather than a nicety. A code that can be
 * replayed is a session for whoever reads the inbox later; a code with unlimited
 * attempts is a six-digit password; a code left live after a re-request is a
 * second key nobody is tracking.
 */
import 'dotenv/config';

import { prisma } from '../src/db/client';
import { requestLoginCode, verifyLoginCode } from '../src/fans/auth';

// The flow needs a secret. Where the environment has none, this uses an obviously
// temporary one for the run and says so, rather than failing with a message that
// reads like a bug in the code under test.
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 16) {
  process.env.SESSION_SECRET = 'ephemeral-smoke-secret-not-for-production';
  console.log('\n(note: SESSION_SECRET is not set in .env; using an ephemeral one for this run)\n');
}

const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail = ''): void {
  checks.push({ name, pass, detail });
}

/** Captures the generated code instead of logging it. */
function capture() {
  let code = '';
  return {
    get value() {
      return code;
    },
    send: async (args: { code: string }) => {
      code = args.code;
    },
  };
}

async function clear(email: string): Promise<void> {
  await prisma.fanLoginCode.deleteMany({ where: { email } });
}

const EMAIL = `fan-${Date.now()}@example.com`;

await clear(EMAIL);

// ---------------------------------------------------------------------------
// 1. A code is issued, and stored hashed
// ---------------------------------------------------------------------------

{
  const box = capture();
  const result = await requestLoginCode(prisma, EMAIL, { send: box.send });

  check('issue: reports sent', result.state === 'sent', result.state);
  check('issue: the code is six digits', /^\d{6}$/.test(box.value), box.value);

  const stored = await prisma.fanLoginCode.findFirst({
    where: { email: EMAIL },
    orderBy: { createdAt: 'desc' },
  });

  check(
    'issue: the code is NOT stored in plaintext',
    stored !== null && !stored.codeHash.includes(box.value),
    stored === null ? 'no row' : 'hash does not contain the code',
  );

  check(
    'issue: the hash is long enough to be a real digest',
    (stored?.codeHash.length ?? 0) === 64,
    `${stored?.codeHash.length ?? 0} hex chars`,
  );
}

// ---------------------------------------------------------------------------
// 2. A wrong code fails, and the attempt is counted
// ---------------------------------------------------------------------------

{
  const wrong = '000000';
  const result = await verifyLoginCode(prisma, EMAIL, wrong);

  // Guard against the (unlikely) case the real code IS 000000.
  if (result.state === 'verified') {
    check('wrong code: skipped, the generated code happened to be 000000', true, 'retry');
  } else {
    check('wrong code: refused', result.state === 'wrong_code', result.state);

    const stored = await prisma.fanLoginCode.findFirst({
      where: { email: EMAIL },
      orderBy: { createdAt: 'desc' },
    });

    check('wrong code: the attempt was recorded', stored?.attempts === 1, String(stored?.attempts));
  }
}

// ---------------------------------------------------------------------------
// 3. The right code works, and only once
// ---------------------------------------------------------------------------

{
  const box = capture();
  await clear(EMAIL);
  await requestLoginCode(prisma, EMAIL, { send: box.send });

  const verified = await verifyLoginCode(prisma, EMAIL, box.value);

  check('correct code: verified', verified.state === 'verified', verified.state);
  check(
    'correct code: returns the normalised address as the identity',
    verified.state === 'verified' && verified.fanId === EMAIL,
    verified.state === 'verified' ? verified.fanId : verified.state,
  );

  // The replay. Whoever reads the inbox afterwards must not get a session.
  const replay = await verifyLoginCode(prisma, EMAIL, box.value);

  check('replay: refused', replay.state === 'no_code', replay.state);
}

// ---------------------------------------------------------------------------
// 4. Case and whitespace do not create a second identity
// ---------------------------------------------------------------------------

{
  const box = capture();
  await clear(EMAIL);
  await requestLoginCode(prisma, EMAIL, { send: box.send });

  const shouty = await verifyLoginCode(prisma, EMAIL.toUpperCase(), `  ${box.value}  `);

  check(
    'normalisation: a differently-cased login reaches the same code',
    shouty.state === 'verified',
    shouty.state,
  );
}

// ---------------------------------------------------------------------------
// 5. Guessing is bounded
// ---------------------------------------------------------------------------

{
  const box = capture();
  await clear(EMAIL);
  await requestLoginCode(prisma, EMAIL, { send: box.send });

  const notTheCode = box.value === '111111' ? '222222' : '111111';

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await verifyLoginCode(prisma, EMAIL, notTheCode);
  }

  const afterCeiling = await verifyLoginCode(prisma, EMAIL, notTheCode);

  check(
    'too many attempts: the code is dead',
    afterCeiling.state === 'too_many_attempts',
    afterCeiling.state,
  );

  // And the real code must no longer work either -- the code is dead, not merely
  // rate-limited.
  const realCodeAfterCeiling = await verifyLoginCode(prisma, EMAIL, box.value);

  check(
    'too many attempts: even the correct code is refused',
    realCodeAfterCeiling.state === 'too_many_attempts',
    realCodeAfterCeiling.state,
  );
}

// ---------------------------------------------------------------------------
// 6. An expired code is refused
// ---------------------------------------------------------------------------

{
  const box = capture();
  await clear(EMAIL);
  await requestLoginCode(prisma, EMAIL, { send: box.send });

  await prisma.fanLoginCode.updateMany({
    where: { email: EMAIL, consumedAt: null },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });

  const result = await verifyLoginCode(prisma, EMAIL, box.value);

  check('expired: refused', result.state === 'expired', result.state);

  check(
    'expired: not consumed, so it can be cleaned up rather than logged out',
    (await prisma.fanLoginCode.count({ where: { email: EMAIL, consumedAt: null } })) === 1,
    'still unconsumed',
  );
}

// ---------------------------------------------------------------------------
// 7. Asking again retires the previous code
// ---------------------------------------------------------------------------

{
  const first = capture();
  const second = capture();

  await clear(EMAIL);
  await requestLoginCode(prisma, EMAIL, { send: first.send });
  await requestLoginCode(prisma, EMAIL, { send: second.send });

  const outstanding = await prisma.fanLoginCode.count({
    where: { email: EMAIL, consumedAt: null },
  });

  check('re-request: exactly one code is live', outstanding === 1, `${outstanding} live`);

  const stale = await verifyLoginCode(prisma, EMAIL, first.value);

  check(
    're-request: the superseded code no longer works',
    stale.state !== 'verified',
    stale.state,
  );

  const current = await verifyLoginCode(prisma, EMAIL, second.value);

  check('re-request: the new code works', current.state === 'verified', current.state);
}

// ---------------------------------------------------------------------------
// 8. Unusable addresses are refused before a row is written
// ---------------------------------------------------------------------------

{
  for (const bad of ['', 'not-an-email', 'a@b', '@example.com']) {
    const result = await requestLoginCode(prisma, bad, { send: async () => undefined });

    check(`invalid address "${bad}": refused`, result.state === 'invalid_email', result.state);
  }

  const rows = await prisma.fanLoginCode.count({ where: { email: '' } });

  check('invalid address: no row written', rows === 0, `${rows} rows`);
}

await clear(EMAIL);

// ---------------------------------------------------------------------------

const width = Math.max(...checks.map((c) => c.name.length));
console.log('');
for (const c of checks) {
  console.log(`${c.name.padEnd(width)}  ${c.pass ? 'ok  ' : 'FAIL'}  ${c.detail}`);
}

const failures = checks.filter((c) => !c.pass);
await prisma.$disconnect();

console.log(
  `\n${failures.length === 0 ? `All ${checks.length} checks passed.` : `${failures.length} of ${checks.length} FAILED.`}`,
);
