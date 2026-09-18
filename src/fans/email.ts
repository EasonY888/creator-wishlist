/**
 * Delivering the fan's login code.
 *
 * The verification was always real; only the channel was missing. This is that
 * channel, and it keeps the property the stub had -- one function to replace --
 * while removing the property it should never have had, which is logging a
 * credential.
 *
 * Two rules, both about failing in the right direction:
 *
 *   1. **If a provider is configured, a failure throws.** A code that quietly
 *      fails to send is worse than an error, because the fan sits waiting for an
 *      email that is never coming and the only visible symptom is "the code
 *      never arrived".
 *   2. **If no provider is configured, logging is allowed in development and
 *      refused in production.** Printing a valid login code to stdout in
 *      production hands an account to anyone who can read a log line. A demo
 *      needs to finish a login; a deployment must not.
 */

export interface LoginCodeMessage {
  email: string;
  code: string;
  expiresAt: Date;
}

export class EmailDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailDeliveryError';
  }
}

/**
 * Resend, chosen because sending a transactional email is one authenticated POST
 * and does not need a dependency. Swapping providers means rewriting the single
 * `fetch` below and nothing else.
 */
const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function minutesUntil(expiresAt: Date, now = Date.now()): number {
  return Math.max(1, Math.round((expiresAt.getTime() - now) / 60_000));
}

export function loginCodeEmail(args: LoginCodeMessage): {
  subject: string;
  text: string;
} {
  const minutes = minutesUntil(args.expiresAt);

  return {
    // No "click here": the code is typed, not followed. A link in a login email
    // is a phishing template that trains the wrong reflex.
    subject: `Your sign-in code: ${args.code}`,
    text: [
      `Your sign-in code is ${args.code}.`,
      '',
      `It expires in ${minutes} minute${minutes === 1 ? '' : 's'} and can be used once.`,
      '',
      `If you did not ask to sign in, you can ignore this message. Nobody can use`,
      `the code without it, and nothing on your account changes if you do nothing.`,
      '',
      'We never ask for this code by phone, chat or email.',
    ].join('\n'),
  };
}

export async function sendLoginCode(args: LoginCodeMessage): Promise<void> {
  if (!emailConfigured()) {
    if (isProduction()) {
      throw new EmailDeliveryError(
        'Refusing to log a login code in production. Set RESEND_API_KEY and EMAIL_FROM.',
      );
    }

    // Development and demo: the code is the whole point of being able to finish
    // the flow without a mailbox.
    const { subject } = loginCodeEmail(args);
    console.log(
      `\n[fan login] ${subject}  ->  ${args.email} (expires ${args.expiresAt.toISOString()})\n` +
        `            ^ printed because no email provider is configured.\n`,
    );
    return;
  }

  const { subject, text } = loginCodeEmail(args);

  let response: Response;
  try {
    response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM,
        to: [args.email],
        subject,
        text,
      }),
    });
  } catch (error) {
    // Network failure. The code is still valid and the fan can ask for another,
    // so this is a retryable inconvenience rather than a broken account.
    throw new EmailDeliveryError(
      `Could not reach the email provider: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }

  if (!response.ok) {
    // The provider's own message can name the address; only the status is
    // surfaced, because an error string has no business carrying a recipient.
    throw new EmailDeliveryError(
      `The email provider refused the message (HTTP ${response.status}).`,
    );
  }
}
