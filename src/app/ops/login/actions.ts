'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import {
  OPS_SESSION_COOKIE,
  checkPassword,
  opsConfigured,
  opsCookieOptions,
  signOpsSession,
} from '@/ops/auth';

function complain(message: string): never {
  redirect(`/ops/login?problem=${encodeURIComponent(message)}`);
}

/**
 * Exchange the operator password for a signed session cookie.
 *
 * The same message is returned for a wrong password and for a password of the
 * wrong length, so the form is not an oracle for guessing.
 */
export async function signIn(form: FormData): Promise<void> {
  if (!opsConfigured()) {
    complain(
      'Operator access is not configured on this deployment. Set OPS_PASSWORD (at least 16 characters) and restart.',
    );
  }

  const password = String(form.get('password') ?? '');

  if (!checkPassword(password)) {
    complain('That password was not accepted.');
  }

  const jar = await cookies();
  jar.set(OPS_SESSION_COOKIE, signOpsSession(), opsCookieOptions());

  redirect('/ops');
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  jar.delete(OPS_SESSION_COOKIE);
  redirect('/ops/login');
}
