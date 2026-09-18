/**
 * Prove the card step in a REAL browser.
 *
 * The VS Code integrated browser renders Stripe's payment frame at 2px, and a
 * hand-mounted `PaymentElement` outside the app does the same — so the app was
 * cleared but the card form was left visually unverified. This closes that with
 * the Chrome already installed on the machine.
 *
 * `playwright-core` on purpose: it drives an existing browser rather than
 * downloading its own, so this adds a small dependency and no 150MB of Chromium.
 *
 *   npx tsx scripts/verify-card-form.ts <url>            measure the frame
 *   npx tsx scripts/verify-card-form.ts <url> --pay      ...and actually pay
 *
 * `--pay` fills the Stripe test card and confirms, which is the only way to test
 * the one thing the fake rail cannot represent: that a real browser, a real
 * Stripe.js and our server agree on the same intent.
 */
import 'dotenv/config';

import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const url = process.argv[2];
const shouldPay = process.argv.includes('--pay');

if (!url) {
  console.error('usage: npx tsx scripts/verify-card-form.ts <pay-page-url> [--pay]');
  process.exit(1);
}

const CHANNELS = ['chrome', 'msedge'] as const;

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
let channelUsed = '';

for (const channel of CHANNELS) {
  try {
    browser = await chromium.launch({ channel, headless: true });
    channelUsed = channel;
    break;
  } catch {
    // Not installed. Try the next one.
  }
}

if (!browser) {
  console.error(
    'Neither Chrome nor Edge could be launched. Install one, or run `npx playwright install chromium`.',
  );
  process.exit(1);
}

const page = await browser.newPage({ viewport: { width: 1000, height: 1200 } });

const consoleErrors: string[] = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 200));
});

await page.goto(url, { waitUntil: 'domcontentloaded' });
// Stripe's frames load and then resize; anything less than this measures a
// half-built form and reports a false negative.
await page.waitForTimeout(8000);

/** The frame that actually holds the card fields. */
async function paymentFrameHeight(): Promise<number> {
  return page.evaluate(() => {
    const frame = document.querySelector('iframe[title="Secure payment input frame"]');
    return frame ? Math.round(frame.getBoundingClientRect().height) : -1;
  });
}

const height = await paymentFrameHeight();

const seen = await page.evaluate(() => ({
  headings: Array.from(document.querySelectorAll('h1')).map((h) => h.textContent?.trim() ?? ''),
  iframes: Array.from(document.querySelectorAll('iframe')).map((f) =>
    Math.round(f.getBoundingClientRect().height),
  ),
  submitDisabled: document.querySelector('button[type=submit]')?.hasAttribute('disabled') ?? null,
}));

mkdirSync('reports/screenshots', { recursive: true });
const shot = `reports/screenshots/card-form-${Date.now()}.png`;
await page.screenshot({ path: shot, fullPage: true });

console.log('');
console.log(`browser            ${channelUsed} (headless)`);
console.log(`page               ${seen.headings.join(' / ') || '(no heading)'}`);
console.log(`iframe heights     ${seen.iframes.join('px, ')}px`);
console.log(`payment frame      ${height}px   ${height > 50 ? '<- RENDERED' : '<- COLLAPSED'}`);
console.log(`pay button         ${seen.submitDisabled ? 'disabled' : 'enabled'}`);
console.log(`screenshot         ${shot}`);
if (consoleErrors.length > 0) {
  console.log(`console errors     ${consoleErrors.length}`);
  for (const error of consoleErrors.slice(0, 5)) console.log(`  ${error}`);
}
console.log('');

if (height <= 50) {
  console.log('The payment frame did not render here either. That would mean the app, not the');
  console.log('preview browser -- and this script just became a real bug report.');
  await browser.close();
  process.exit(1);
}

console.log('The card form renders in a real browser. The 2px measurement was the preview');
console.log('browser, and the app is clear.');
console.log('');

if (!shouldPay) {
  console.log('Re-run with --pay to fill the Stripe test card and confirm the intent for real.');
  await browser.close();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Optional: actually confirm the intent
// ---------------------------------------------------------------------------

const frame = page.frameLocator('iframe[title="Secure payment input frame"]');

/**
 * With dynamic payment methods the element renders as an accordion and the card
 * fields do not exist until the Card option is chosen. Filling first fails on a
 * selector that is simply not there yet, which looks like a bug and is not one.
 */
async function selectCardTab(): Promise<boolean> {
  const option = frame.getByText('Card', { exact: true });
  if ((await option.count()) === 0) return false;
  await option.first().click({ timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(1200);
  return true;
}

async function fillFirst(candidates: string[], value: string): Promise<boolean> {
  for (const selector of candidates) {
    const field = frame.locator(selector);
    if ((await field.count()) > 0) {
      await field.first().fill(value);
      return true;
    }
  }
  return false;
}

console.log('filling the Stripe test card...');
console.log(`  selected the Card tab: ${await selectCardTab()}`);

const filledNumber = await fillFirst(
  ['input[name="number"]', 'input[placeholder*="Card number" i]', 'input[autocomplete="cc-number"]'],
  '4242 4242 4242 4242',
);
const filledExpiry = await fillFirst(
  ['input[name="expiry"]', 'input[placeholder*="MM" i]', 'input[autocomplete="cc-exp"]'],
  '12 / 34',
);
const filledCvc = await fillFirst(
  ['input[name="cvc"]', 'input[placeholder*="CVC" i]', 'input[autocomplete="cc-csc"]'],
  '123',
);
const filledPostal = await fillFirst(
  ['input[name="postalCode"]', 'input[placeholder*="ZIP" i]', 'input[placeholder*="postal" i]'],
  'M5H 1A1',
);

console.log(
  `  number=${filledNumber} expiry=${filledExpiry} cvc=${filledCvc} postal=${filledPostal}`,
);

await page.waitForTimeout(1500);
await page.locator('button[type=submit]').first().click({ timeout: 15000 }).catch(() => undefined);
await page.waitForTimeout(12000);

const after = await page.evaluate(() => ({
  url: window.location.href,
  text: (document.body.innerText || '').slice(0, 700),
}));

console.log('');
console.log(`landed on          ${after.url}`);
console.log('--- what the fan sees ---');
console.log(after.text);
console.log('');

await browser.close();
