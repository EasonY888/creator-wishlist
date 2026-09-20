'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { prisma } from '@/db/client';
import {
  normalizeEmail,
  requestLoginCode,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  sessionCookieOptions,
  signSession,
  verifyLoginCode,
} from '@/fans/auth';

function field(form: FormData, name: string): string {
  return String(form.get(name) ?? '').trim();
}

/**
 * Only ever redirect to somewhere on this site.
 *
 * `next` arrives in a form field, so it is attacker-controlled. An unchecked
 * value turns the login page into an open redirect: a fan follows a link to us,
 * logs in, and is handed onward to a copy of our checkout on another domain with
 * their session intact. Requiring a single leading slash rules out absolute URLs
 * and protocol-relative ones alike.
 */
function safeNext(raw: string): string {
  if (!raw.startsWith('/')) return '/';
  if (raw.startsWith('//')) return '/';
  return raw;
}

function loginUrl(args: {
  next: string;
  email?: string;
  sent?: boolean;
  problem?: string;
  demoCode?: string;
}): string {
  const params = new URLSearchParams({ next: safeNext(args.next) });
  if (args.email) params.set('email', args.email);
  if (args.sent) params.set('sent', '1');
  if (args.problem) params.set('problem', args.problem);
  // Only ever present on a demo instance that has opted in. It rides in the URL
  // because that is how the two-step form already carries state, and it is the
  // code the caller just asked to be sent to their own address -- but it is
  // still a credential in a URL bar, which is why the flag that enables it
  // refuses to work alongside a real mail provider.
  if (args.demoCode) params.set('demoCode', args.demoCode);
  return `/fan/login?${params.toString()}`;
}

export async function requestCode(form: FormData): Promise<void> {
  const email = field(form, 'email');
  const next = field(form, 'next');

  const result = await requestLoginCode(prisma, email);

  if (result.state === 'sent') {
    // The address is echoed back so the code form does not make the fan retype it
    // -- the code itself is what proves they own it.
    redirect(
      loginUrl({
        next,
        email: result.email,
        sent: true,
        ...(result.demoCode === undefined ? {} : { demoCode: result.demoCode }),
      }),
    );
  }

  redirect(loginUrl({ next, problem: result.reason }));
}

export async function verifyCode(form: FormData): Promise<void> {
  const email = field(form, 'email');
  const code = field(form, 'code');
  const next = field(form, 'next');

  const result = await verifyLoginCode(prisma, email, code);

  if (result.state === 'verified') {
    const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
    const cookieStore = await cookies();

    cookieStore.set(
      SESSION_COOKIE,
      signSession(result.fanId, expiresAt),
      sessionCookieOptions(expiresAt),
    );

    redirect(safeNext(next));
  }

  // Deliberately vague beyond the reason: whether an address has a pending code
  // is not something a stranger should be able to probe.
  redirect(
    loginUrl({
      next,
      email: normalizeEmail(email),
      sent: true,
      problem:
        result.state === 'wrong_code'
          ? `${result.reason} ${result.attemptsRemaining} attempt(s) left.`
          : result.reason,
    }),
  );
}

/** Clear the session. Nothing depends on it yet, but a session with no way out is a trap. */
export async function signOut(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  redirect('/');
}
