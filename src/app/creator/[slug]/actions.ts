'use server';

import { redirect } from 'next/navigation';

import { AddressAccessError, writeCreatorAddress } from '@/fulfillment/address-store';
import { services } from '@/services';
import { addWishlistItemByUrl, removeWishlistItem, type AddItemOutcome } from '@/wishlist/curation';

/**
 * Curation actions.
 *
 * There is no creator authentication yet, so the creator id travels in the form.
 * That is a known gap, not a finished access-control story: it means anyone with
 * a creator's id can edit their wishlist. It is recorded here so it is not
 * mistaken for something it isn't.
 */
function field(form: FormData, name: string): string {
  return String(form.get(name) ?? '').trim();
}

/** Turn a curation outcome into something a creator can act on. */
function reasonFor(result: AddItemOutcome): string {
  switch (result.state) {
    case 'added':
      return `Added "${result.title}".`;
    case 'already_listed':
      return `"${result.title}" is already on this wishlist.`;
    case 'creator_not_found':
      return 'That creator no longer exists.';
    case 'not_a_product_url':
      return `That link is not a product page: ${result.detail}`;
    case 'variant_not_found':
      return result.detail;
    case 'needs_onboarding':
      return `That shop is not connected yet, so it cannot be ordered from. Details: ${result.merchantUrl}`;
    case 'transport_error':
      return `We could not reach the provider (${result.code}). Please try again.`;
  }
}

/**
 * The consent wording the creator agreed to.
 *
 * A version string rather than a boolean, because "they consented" is only
 * meaningful next to "to what". Changing the wording must not silently bless
 * everyone who agreed to the previous one.
 */
const CONSENT_POLICY_VERSION = 'v1';

/** Human labels, so a validation message names a field the way the form does. */
const ADDRESS_LABELS: Record<string, string> = {
  fullName: 'full name',
  streetAddress: 'street address',
  addressLocality: 'city',
  postalCode: 'postal code',
  addressCountry: 'country',
};

/**
 * Save the creator's delivery address.
 *
 * This is the only caller of `writeCreatorAddress` in the application, and the
 * reason it exists is that the encrypted store previously had no caller outside
 * the scripts -- so the "creator moves house" path could be demonstrated but not
 * performed.
 *
 * **It deliberately does not read the address back.** The page knows only
 * whether one exists, which needs no decryption and writes no audit row. Reading
 * a real address back would mean adding the creator's own role to
 * `ADDRESS_READER_ROLES`, and *who may see a delivery address* is a product
 * decision rather than a form detail. Replacing an address needs no such
 * decision, so that is what this does.
 */
export async function saveAddress(form: FormData): Promise<void> {
  const creatorId = field(form, 'creatorId');
  const slug = field(form, 'slug');

  const back = (flag: 'note' | 'problem', message: string): never =>
    redirect(`/creator/${encodeURIComponent(slug)}?${flag}=${encodeURIComponent(message)}`);

  if (creatorId.length === 0) back('problem', 'Missing creator id.');

  const values: Record<string, string> = {
    fullName: field(form, 'fullName'),
    streetAddress: field(form, 'streetAddress'),
    addressLocality: field(form, 'addressLocality'),
    postalCode: field(form, 'postalCode'),
    addressCountry: field(form, 'addressCountry'),
  };

  for (const [name, value] of Object.entries(values)) {
    if (value.length === 0) {
      back('problem', `The ${ADDRESS_LABELS[name] ?? name} is empty.`);
    }
  }

  if (!/^[A-Za-z]{2}$/.test(values.addressCountry ?? '')) {
    back('problem', 'The country must be a two-letter code, such as CA or GB.');
  }

  try {
    await writeCreatorAddress(services().db, {
      creatorId,
      fullName: values.fullName ?? '',
      streetAddress: values.streetAddress ?? '',
      addressLocality: values.addressLocality ?? '',
      addressRegion: field(form, 'addressRegion') || null,
      postalCode: values.postalCode ?? '',
      addressCountry: values.addressCountry ?? '',
      phone: field(form, 'phone') || null,
      consentPolicyVersion: CONSENT_POLICY_VERSION,
    });
  } catch (error) {
    // Only our own message is surfaced. An unexpected error could carry a value
    // out of the store, and an error message is not worth an address leak.
    const detail =
      error instanceof AddressAccessError ? error.message : 'the address store rejected it.';
    back('problem', `We could not save that address: ${detail}`);
  }

  return back(
    'note',
    'Address saved, encrypted. Any order already approved against a different address will now be refused at dispatch — that is the check that keeps a fan’s quote honest.',
  );
}

export async function addItem(form: FormData): Promise<void> {
  const creatorId = field(form, 'creatorId');
  const slug = field(form, 'slug');
  const url = field(form, 'url');

  if (url.length === 0) {
    redirect(`/creator/${encodeURIComponent(slug)}?problem=${encodeURIComponent('Paste a product link first.')}`);
  }

  const { db, agnic } = services();
  const result = await addWishlistItemByUrl({ db, agnic }, { creatorId, url });

  const flag = result.state === 'added' ? 'note' : 'problem';
  redirect(
    `/creator/${encodeURIComponent(slug)}?${flag}=${encodeURIComponent(reasonFor(result))}`,
  );
}

export async function removeItem(form: FormData): Promise<void> {
  const creatorId = field(form, 'creatorId');
  const slug = field(form, 'slug');
  const itemId = field(form, 'itemId');

  const { db, agnic } = services();
  const result = await removeWishlistItem({ db, agnic }, { creatorId, itemId });

  const message =
    result.state === 'removed'
      ? 'Removed from the wishlist.'
      : result.state === 'has_orders'
        ? 'That item has been ordered by a fan, so it stays on record.'
        : 'We could not find that item.';

  const flag = result.state === 'removed' ? 'note' : 'problem';
  redirect(`/creator/${encodeURIComponent(slug)}?${flag}=${encodeURIComponent(message)}`);
}
