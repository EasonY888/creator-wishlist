import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EmailDeliveryError,
  emailConfigured,
  loginCodeEmail,
  loginCodeShownOnScreen,
  sendLoginCode,
} from './email';

/**
 * Login-code delivery.
 *
 * The behaviour worth pinning is the failure direction, not the happy path. A
 * code that is silently not sent leaves the fan waiting with no signal, and a
 * code printed to a production log is a credential. Both are asserted here.
 */

const ORIGINAL = { ...process.env };
const MESSAGE = {
  email: 'fan@example.test',
  code: '123456',
  expiresAt: new Date(Date.now() + 10 * 60 * 1000),
};

/**
 * `process.env` types `NODE_ENV` as read-only, which is right, and inconvenient
 * here: the only way to test the production guard is to be in production.
 */
function setEnv(key: string, value: string | undefined): void {
  const env = process.env as Record<string, string | undefined>;
  if (value === undefined) delete env[key];
  else env[key] = value;
}

beforeEach(() => {
  setEnv('RESEND_API_KEY', undefined);
  setEnv('EMAIL_FROM', undefined);
  setEnv('NODE_ENV', undefined);
  setEnv('DEMO_LOGIN_CODES', undefined);
  vi.unstubAllGlobals();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('configuration', () => {
  it('is unconfigured with neither variable', () => {
    expect(emailConfigured()).toBe(false);
  });

  it('is unconfigured with only one of the two', () => {
    process.env.RESEND_API_KEY = 're_test';
    expect(emailConfigured()).toBe(false);
    process.env.EMAIL_FROM = 'gifts@example.test';
    expect(emailConfigured()).toBe(true);
  });
});

describe('the message', () => {
  it('carries the code in the subject so it is readable without opening', () => {
    expect(loginCodeEmail(MESSAGE).subject).toContain('123456');
  });

  it('states the expiry in minutes', () => {
    expect(loginCodeEmail(MESSAGE).text).toContain('10 minutes');
  });

  it('never contains a link', () => {
    // A link in a login email trains the reflex that phishing depends on.
    const { text, subject } = loginCodeEmail(MESSAGE);
    expect(`${subject}\n${text}`).not.toMatch(/https?:\/\//);
  });

  it('says we never ask for the code, so a caller who is asked knows it is a scam', () => {
    expect(loginCodeEmail(MESSAGE).text).toContain('never ask for this code');
  });
});

describe('with no provider configured', () => {
  it('logs the code in development rather than throwing, so the flow can be finished', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(sendLoginCode(MESSAGE)).resolves.toBe('log');
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain('123456');
  });

  it('refuses to log a login code in production', async () => {
    setEnv('NODE_ENV', 'production');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(sendLoginCode(MESSAGE)).rejects.toBeInstanceOf(EmailDeliveryError);
    // The important half: it refused AND it did not leak the code on the way out.
    expect(log).not.toHaveBeenCalled();
  });
});

describe('demo mode', () => {
  it('is off unless the deployment opts in', () => {
    expect(loginCodeShownOnScreen()).toBe(false);
  });

  it('does not switch itself on for an unset or unexpected value', () => {
    setEnv('DEMO_LOGIN_CODES', 'true');
    expect(loginCodeShownOnScreen()).toBe(false);
  });

  it('hands the code back in production when the deployment opts in', async () => {
    setEnv('NODE_ENV', 'production');
    setEnv('DEMO_LOGIN_CODES', 'show');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(sendLoginCode(MESSAGE)).resolves.toBe('screen');
    expect(loginCodeShownOnScreen()).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('is refused the moment a provider is configured, however the flag is set', () => {
    // The half that matters. A deployment with a working mailbox must never have
    // its codes painted onto a page, so the flag cannot override a real channel.
    setEnv('DEMO_LOGIN_CODES', 'show');
    process.env.RESEND_API_KEY = 're_test';
    process.env.EMAIL_FROM = 'gifts@example.test';

    expect(loginCodeShownOnScreen()).toBe(false);
  });
});

describe('with a provider configured', () => {
  beforeEach(() => {
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.EMAIL_FROM = 'gifts@example.test';
  });

  it('posts the message to the provider', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response('{"id":"x"}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await sendLoginCode(MESSAGE);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    const [url, init] = call as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');

    const body = JSON.parse(String(init.body)) as { to: string[]; text: string };
    expect(body.to).toEqual(['fan@example.test']);
    expect(body.text).toContain('123456');
  });

  it('throws when the provider refuses, rather than pretending it sent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 422 })),
    );

    await expect(sendLoginCode(MESSAGE)).rejects.toBeInstanceOf(EmailDeliveryError);
  });

  it('does not put the recipient in the error message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('no such recipient', { status: 422 })),
    );

    const error = await sendLoginCode(MESSAGE).catch((e: Error) => e);
    expect(error).toBeInstanceOf(EmailDeliveryError);
    expect(String((error as Error).message)).not.toContain('fan@example.test');
    expect(String((error as Error).message)).toContain('422');
  });

  it('throws on a network failure so the caller can retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('socket hang up');
      }),
    );

    await expect(sendLoginCode(MESSAGE)).rejects.toBeInstanceOf(EmailDeliveryError);
  });
});
