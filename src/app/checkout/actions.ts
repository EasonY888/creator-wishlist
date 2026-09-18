'use server';

import { redirect } from 'next/navigation';
import {
  approveAndAuthorize,
  beginPayment,
  createDraftOrder,
} from '@/orders/checkout';
import { prisma } from '@/db/client';
import { currentFan, loginPathFor } from '@/fans/current';
import { checkoutDeps } from '@/services';

/**
 * Server actions for the fan's checkout.
 *
 * Deliberately thin: they read a form, call one service function, and redirect.
 * All the decisions — pricing, quote validity, whether the address still
 * matches, whether the payment holds — live in the checkout service, so the same
 * logic is exercised by the UI and by the smoke tests rather than being
 * duplicated in a route handler.
 */

function field(form: FormData, name: string): string {
  return String(form.get(name) ?? '').trim();
}

/** Send the fan to the wishlist with a readable reason. */
function backToWishlist(slug: string, code: string): never {
  redirect(`/w/${encodeURIComponent(slug)}?note=${encodeURIComponent(code)}`);
}

/**
 * Start a checkout for one wishlist item.
 *
 * Prices the item against the creator's current address. If the merchant needs a
 * delivery choice first, the provider withholds the amount entirely — so there
 * is no total to show, and the fan is sent to pick one rather than being shown a
 * number we invented.
 */
export async function startCheckout(form: FormData): Promise<void> {
  const wishlistItemId = field(form, 'wishlistItemId');
  const creatorId = field(form, 'creatorId');
  const slug = field(form, 'slug');

  // Browsing is open (FR-7.1); paying is not. The fan is asked to confirm their
  // address before an order exists at all, so nothing is created that nobody can
  // later prove they own.
  const fan = await currentFan();
  if (!fan) {
    redirect(
      loginPathFor(
        `/checkout?item=${encodeURIComponent(wishlistItemId)}&creator=${encodeURIComponent(creatorId)}&slug=${encodeURIComponent(slug)}`,
      ),
    );
  }

  const result = await createDraftOrder(checkoutDeps(), {
    fanId: fan.fanId,
    creatorId,
    wishlistItemId,
  });

  switch (result.state) {
    case 'created':
      redirect(`/checkout/${result.order.fanOrderId}`);

    case 'choose_delivery':
      redirect(
        `/checkout?item=${encodeURIComponent(wishlistItemId)}&creator=${encodeURIComponent(creatorId)}&slug=${encodeURIComponent(slug)}`,
      );

    case 'unknown_sku':
      // Recoverable: the provider handed us real alternatives.
      redirect(
        `/checkout?item=${encodeURIComponent(wishlistItemId)}&creator=${encodeURIComponent(creatorId)}&slug=${encodeURIComponent(slug)}&unknown=1`,
      );

    case 'unfulfillable':
      backToWishlist(slug, 'This shop cannot deliver to the creator right now.');

    case 'missing_address':
      backToWishlist(slug, 'The creator has not saved a delivery address yet.');

    case 'item_not_found':
      backToWishlist(slug, 'That item is no longer on the wishlist.');

    case 'refused':
      backToWishlist(slug, `The shop declined to quote this item (${result.code}).`);

    case 'transport_error':
      backToWishlist(slug, 'We could not reach the shop just now. Please try again.');
  }
}

/** Re-quote with a delivery option chosen, then continue to the total. */
export async function chooseDelivery(form: FormData): Promise<void> {
  const wishlistItemId = field(form, 'wishlistItemId');
  const creatorId = field(form, 'creatorId');
  const deliveryOptionId = field(form, 'deliveryOptionId');
  const slug = field(form, 'slug');

  // The same gate as `startCheckout`, repeated rather than assumed. A server
  // action is addressable by id, so "the other action already checked" is not a
  // property this one can rely on.
  //
  // This is also where the order gets its owner. It used to write `'guest'`
  // unconditionally, which was a live bug: the sandbox shop always asks for a
  // delivery choice, so every signed-in fan came through here, and
  // `startPayment` then refused their own order -- the draft said `guest` while
  // the session said their email address.
  const fan = await currentFan();
  if (!fan) {
    redirect(
      loginPathFor(
        `/checkout?item=${encodeURIComponent(wishlistItemId)}&creator=${encodeURIComponent(creatorId)}&slug=${encodeURIComponent(slug)}`,
      ),
    );
  }

  const result = await createDraftOrder(checkoutDeps(), {
    fanId: fan.fanId,
    creatorId,
    wishlistItemId,
    deliveryOptionId,
  });

  if (result.state === 'created') {
    redirect(`/checkout/${result.order.fanOrderId}`);
  }

  backToWishlist(slug, `We could not price that delivery option (${result.state}).`);
}

function reasonFor(result: Awaited<ReturnType<typeof beginPayment>>): string {
  switch (result.state) {
    case 'quote_expired':
      return 'That price is out of date. Please start again so we can show you a current total.';
    case 'address_changed':
      return 'The creator updated their delivery address, so this price no longer applies. Please start again.';
    case 'invalid_confirmation':
      return `We could not record your approval: ${result.reason}`;
    case 'payment_failed':
      return `We could not open the payment step (${result.code}). You have not been charged.`;
    case 'not_draft':
      return `This order is already ${result.currentState}.`;
    case 'order_not_found':
      return 'We could not find that order.';
    default:
      return 'Something went wrong. You have not been charged.';
  }
}

/**
 * Freeze the fan's approval and open the card step.
 *
 * Split from the hold itself because the fan has to enter a card before anything
 * can be held, and the card goes to the processor rather than to us. Nothing is
 * held at the point this redirects -- the order sits in `approved` with an
 * unconfirmed intent, which is inert.
 */
export async function startPayment(form: FormData): Promise<void> {
  const fanOrderId = field(form, 'fanOrderId');
  const confirmation = field(form, 'confirmation');

  const fan = await currentFan();
  if (!fan) {
    redirect(loginPathFor(`/checkout/${fanOrderId}`));
  }

  // A session is not enough -- it has to be the session that placed this order.
  // Otherwise a fan could approve somebody else's by guessing an id.
  const owner = await prisma.fanOrder.findUnique({
    where: { id: fanOrderId },
    select: { fanId: true, creator: { select: { publicSlug: true } } },
  });

  if (!owner || owner.fanId !== fan.fanId) {
    // The slug rides along so the note lands on a page that can explain itself.
    // Passing '' sent the fan to `/w` with a message about an order -- an error
    // page that tells them nothing about what went wrong.
    backToWishlist(owner?.creator.publicSlug ?? '', 'That order is not yours.');
  }

  const result = await beginPayment(checkoutDeps(), {
    fanOrderId,
    fanConfirmationText: confirmation || 'I approve this purchase',
    approvedAt: new Date(),
    description: 'Creator wishlist gift',
  });

  if (result.state === 'ready') {
    redirect(`/checkout/${fanOrderId}/pay`);
  }

  redirect(`/checkout/${fanOrderId}?note=${encodeURIComponent(reasonFor(result))}`);
}

/**
 * What the browser is told after the card step.
 *
 * Returns a value rather than redirecting, because the caller is already a
 * client component deciding where to go next -- and because a redirect would
 * throw away the error the fan needs to see.
 */
export type VerifyResult =
  | { state: 'authorized' }
  /** No money moved. The fan can try a different card. */
  | { state: 'retry'; message: string }
  /** The order is dead, and provably never charged. */
  | { state: 'failed'; message: string };

/**
 * Verify the hold the browser just placed, then queue the purchase.
 *
 * This deliberately does NOT trust that the browser returned successfully. It
 * asks the processor what state the intent is actually in, because a browser can
 * claim success for a 3DS flow that was then abandoned, and the return_url is
 * reachable by anyone who types it.
 */
export async function verifyPayment(fanOrderId: string): Promise<VerifyResult> {
  const result = await approveAndAuthorize(checkoutDeps(), {
    fanOrderId,
    approvedAt: new Date(),
  });

  switch (result.state) {
    case 'authorized':
      return { state: 'authorized' };

    case 'payment_failed':
      // A step-up is not a dead order, so it must not be reported as one.
      return result.retryable === true
        ? { state: 'retry', message: 'Your bank needs another step. Please try again.' }
        : {
            state: 'failed',
            message: `Your payment was not authorized (${result.code}). You have not been charged.`,
          };

    case 'not_draft':
      // Reached by reloading the finish page after the order already moved on.
      return result.currentState === 'authorized'
        ? { state: 'authorized' }
        : { state: 'retry', message: `This order is already ${result.currentState}.` };

    case 'quote_expired':
      return { state: 'retry', message: 'That price expired while you were paying. Nothing was charged.' };

    case 'address_changed':
      return { state: 'retry', message: 'The creator changed their address, so this price no longer applies.' };

    case 'invalid_confirmation':
      return { state: 'retry', message: `We could not confirm it: ${result.reason}` };

    case 'order_not_found':
      return { state: 'failed', message: 'We could not find that order.' };
  }
}
