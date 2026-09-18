/**
 * Issue a fan login code and print it.
 *
 * With no `RESEND_API_KEY` / `EMAIL_FROM`, the app does not email the code — it
 * logs it to the dev server's stdout (`src/fans/email.ts`). That is deliberate,
 * and it is useless when you cannot see that terminal: the server was started
 * before you sat down, the log has scrolled past it, or it is printing into a
 * window you are not looking at.
 *
 * This goes through the real `requestLoginCode` path and its `send` seam, so the
 * code it prints is the same code the app would have emailed — same hash, same
 * expiry, same "exactly one live code" rule, same single-use consumption. The
 * only thing replaced is the transport. Nothing is bypassed.
 *
 *   npx tsx scripts/fan-login-code.ts someone@example.com
 *
 * Worth knowing: `fanId` IS the email address (`verifyLoginCode` returns the
 * normalised email). A fan session lasts 30 days, so signing in once before a
 * demo means the whole fan journey runs without ever showing the login screen —
 * which is what makes "no terminal on stage" true rather than aspirational.
 */
import 'dotenv/config';

import { prisma } from '../src/db/client';
import { requestLoginCode } from '../src/fans/auth';

const email = process.argv[2];
const APP_URL = process.env.APP_URL ?? 'http://localhost:3000';

if (!email) {
  console.error('Usage: npx tsx scripts/fan-login-code.ts <email>');
  process.exit(1);
}

const result = await requestLoginCode(prisma, email, {
  send: async ({ code, expiresAt }) => {
    const minutes = Math.max(1, Math.round((expiresAt.getTime() - Date.now()) / 60_000));

    console.log('');
    console.log('  fan login code');
    console.log(`    email     ${email}`);
    console.log(`    code      ${code}`);
    console.log(`    valid     ${minutes} minutes, single use`);
    console.log('');
    console.log(`    sign in   ${APP_URL}/fan/login`);
    console.log('');
    console.log('  Any earlier code for this address is now dead — issuing one');
    console.log('  retires the previous, so there is only ever one way in.');
    console.log('');
  },
});

if (result.state !== 'sent') {
  console.error(`Could not issue a code: ${result.reason}`);
  await prisma.$disconnect();
  process.exit(1);
}

await prisma.$disconnect();
