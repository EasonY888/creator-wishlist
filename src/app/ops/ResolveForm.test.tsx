// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ResolveForm from './ResolveForm';

/**
 * The operator's terminal-outcome form.
 *
 * This file exists because of a specific bug. The two buttons carried the
 * decision as `<button name="decision" value="succeeded">`, which does not work
 * when `formAction` is a server action: React overrides the `name` for its own
 * action encoding, so the field never arrived, and `resolveStuckOrder` fell
 * through to its default of `failed`. Clicking **"It completed — charge"**
 * therefore RELEASED the fan's hold.
 *
 * No domain test could have caught it. `resolveOrder` was correct and stays
 * correct; the value simply never reached it. So the assertion here is about
 * wiring, which is exactly the layer that was untested.
 */

// The action is a server action: importing the real one drags in `next/navigation`
// and the Prisma client. Nothing in these tests should execute it -- the guard
// prevents submission -- but it still has to be importable.
vi.mock('./actions', () => ({ resolveStuckOrder: vi.fn() }));

afterEach(cleanup);

function decisionValue(): string {
  const field = document.querySelector('input[name="decision"]') as HTMLInputElement | null;
  return field?.value ?? '(missing)';
}

function renderForm() {
  render(<ResolveForm fanOrderId="order_1" approvedLabel="$17.94" />);
  // A reference shorter than the 4-character minimum makes `guard` prevent
  // submission, so no action is invoked and no confirmation dialog is needed --
  // while still proving the decision was recorded before that early return.
  fireEvent.change(screen.getByPlaceholderText('Evidence reference'), {
    target: { value: 'x' },
  });
}

describe('ResolveForm', () => {
  it('records "succeeded" when the charge button is pressed', () => {
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: /charge/ }));
    expect(decisionValue()).toBe('succeeded');
  });

  it('records "failed" when the release button is pressed', () => {
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: /release/ }));
    expect(decisionValue()).toBe('failed');
  });

  it('never carries the decision on a submit button, which React would override', () => {
    renderForm();
    const buttons = screen.getAllByRole('button');
    for (const button of buttons) {
      expect(button.getAttribute('name')).not.toBe('decision');
    }
  });

  it('sends the order id', () => {
    renderForm();
    const hidden = document.querySelector('input[name="fanOrderId"]') as HTMLInputElement;
    expect(hidden.value).toBe('order_1');
  });

  it('reads the evidence reference from the form, not from the button', () => {
    // `new FormData(event.currentTarget)` where currentTarget is a button throws,
    // which is how the confirmation dialog silently never ran.
    renderForm();
    expect(() =>
      fireEvent.click(screen.getByRole('button', { name: /charge/ })),
    ).not.toThrow();
    const form = document.querySelector('form') as HTMLFormElement;
    expect(new FormData(form).get('reference')).toBe('x');
  });

  it('asks for a confirmation before a success, and submits nothing if refused', () => {
    const confirm = vi.fn((_message: string) => false);
    vi.stubGlobal('confirm', confirm);

    render(<ResolveForm fanOrderId="order_2" approvedLabel="$17.94" />);
    fireEvent.change(screen.getByPlaceholderText('Evidence reference'), {
      target: { value: 'shopify-4471' },
    });
    fireEvent.change(screen.getByPlaceholderText('Charged (dollars)'), {
      target: { value: '15.99' },
    });
    fireEvent.click(screen.getByRole('button', { name: /charge/ }));

    expect(confirm).toHaveBeenCalledTimes(1);
    // Names the amount and the consequence, because this moves money.
    expect(String(confirm.mock.calls[0]?.[0])).toContain('15.99');
    expect(String(confirm.mock.calls[0]?.[0])).toContain('CHARGED');

    vi.unstubAllGlobals();
  });

  it('warns that a release against a real charge leaves the fan paid up for nothing', () => {
    const confirm = vi.fn((_message: string) => false);
    vi.stubGlobal('confirm', confirm);

    render(<ResolveForm fanOrderId="order_3" approvedLabel="$17.94" />);
    fireEvent.change(screen.getByPlaceholderText('Evidence reference'), {
      target: { value: 'shopify-4472' },
    });
    fireEvent.click(screen.getByRole('button', { name: /release/ }));

    expect(String(confirm.mock.calls[0]?.[0])).toContain('RELEASED');

    vi.unstubAllGlobals();
  });
});
