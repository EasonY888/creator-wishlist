import type { VaultedCard } from './port';

/**
 * Setup verification.
 *
 * Over HTTP the provider does not refuse a dispatch for an incomplete account.
 * There is no `setup_required` blocker as there is in the tool layer — the
 * provider records the missing prerequisite on the order and lets the dispatch
 * proceed, so it surfaces later as a merchant-side `CHECKOUT_INCOMPLETE` that
 * looks like a shop problem.
 *
 * Twice now a live failure has had this shape, so it is worth checking up front
 * rather than debugging a merchant error that is really a configuration error.
 */

const BASE_URL = 'https://api.agnic.ai';

/**
 * Fields the sandbox merchant requires, all of which the checkout engine reads
 * from the **account** profile rather than from `ship_to`.
 *
 * `ship_to` carries only the destination. The buyer's identity and contact
 * details come from the account, because the platform — not the fan — is the
 * party the merchant sees on the card.
 */
export const REQUIRED_PROFILE_FIELDS = [
  'email',
  'given_name',
  'family_name',
  'phone_number',
  'street_address',
  'address_locality',
  'address_region',
  'postal_code',
  'address_country',
] as const;

export interface SetupCheck {
  ready: boolean;
  missingProfileFields: string[];
  cards: VaultedCard[];
  problems: string[];
}

function isSet(value: unknown): boolean {
  return value !== null && value !== undefined && value !== '';
}

export async function checkSetup(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SetupCheck> {
  const problems: string[] = [];
  const headers = { 'X-Agnic-Token': token };

  // --- Profile ---
  let missingProfileFields: string[] = [];
  try {
    const response = await fetchImpl(`${BASE_URL}/api/profile`, { headers });
    if (!response.ok) {
      problems.push(`profile read returned HTTP ${response.status}`);
    } else {
      const body = (await response.json()) as {
        profile?: Record<string, unknown>;
      };
      const profile = body.profile ?? {};
      missingProfileFields = REQUIRED_PROFILE_FIELDS.filter(
        (field) => !isSet(profile[field]),
      );

      if (missingProfileFields.length > 0) {
        problems.push(
          `the account profile is missing ${missingProfileFields.length} field(s) the merchant requires: ${missingProfileFields.join(', ')}`,
        );
      }
    }
  } catch (error) {
    problems.push(`could not read the profile: ${String((error as Error).message ?? error)}`);
  }

  // --- Cards ---
  let cards: VaultedCard[] = [];
  try {
    const response = await fetchImpl(`${BASE_URL}/api/autofill/cards`, { headers });
    if (!response.ok) {
      problems.push(`card read returned HTTP ${response.status}`);
    } else {
      const body = (await response.json()) as {
        cards?: Array<Record<string, unknown>>;
      };
      cards = (body.cards ?? []).map((raw, index) => ({
        id: String(raw.id ?? `card_${index}`),
        brand: typeof raw.brand === 'string' ? raw.brand : null,
        lastFour: typeof raw.last_four === 'string' ? raw.last_four : null,
        expiryMonth: typeof raw.exp_month === 'number' ? raw.exp_month : null,
        expiryYear: typeof raw.exp_year === 'number' ? raw.exp_year : null,
        isDefault: raw.is_default === true || index === 0,
      }));

      if (cards.length === 0) {
        problems.push(
          'no card is vaulted, so a purchase on the card rail cannot succeed',
        );
      }
    }
  } catch (error) {
    problems.push(`could not read cards: ${String((error as Error).message ?? error)}`);
  }

  return {
    ready: problems.length === 0,
    missingProfileFields,
    cards,
    problems,
  };
}

export function describeSetup(check: SetupCheck): string {
  const lines: string[] = [];

  lines.push(
    `cards on file    : ${check.cards.length}${
      check.cards[0]
        ? ` (${check.cards[0].brand ?? 'card'} •••• ${check.cards[0].lastFour ?? '????'})`
        : ''
    }`,
  );

  lines.push(
    check.missingProfileFields.length === 0
      ? 'profile          : complete'
      : `profile          : missing ${check.missingProfileFields.join(', ')}`,
  );

  if (!check.ready) {
    lines.push('');
    for (const problem of check.problems) lines.push(`  ! ${problem}`);
  }

  return lines.join('\n');
}
