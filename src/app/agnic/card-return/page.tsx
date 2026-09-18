import Link from 'next/link';
import { headers } from 'next/headers';
import { CardReturnHandler } from './CardReturnHandler';
import type { VaultedCard } from '@/agnic/port';
import { services } from '@/services';

function cap(value: string | null): string {
  if (!value) return 'Card';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export const dynamic = 'force-dynamic';

/**
 * Where Agnic sends the browser after the card form.
 *
 * This URL must be registered as a redirect URI on the OAuth client, and passed
 * as `return_url` on the deep link — the host renders an error page instead of
 * the card form if they do not match, so a typo here looks like the whole feature
 * being broken.
 *
 * The page also reports card status, because "did it actually save?" is the
 * question you have immediately after closing the popup.
 */
export default async function CardReturnPage() {
  const { agnic, mode } = services();

  let cards: VaultedCard[] = [];
  let readError: string | null = null;

  try {
    cards = await agnic.listCards();
  } catch (error) {
    readError = String((error as Error).message ?? error);
  }

  const headerList = await headers();
  const host = headerList.get('host') ?? 'localhost:3000';
  const thisUrl = `http://${host}/agnic/card-return`;

  return (
    <main>
      <p className="small">
        <Link href="/">&larr; Home</Link>
      </p>

      <div className="hero">
        <h1>Card setup</h1>
      </div>

      <CardReturnHandler />

      <div className="card">
        <div className="row">
          <strong>Cards on file</strong>
          <span className={`badge ${cards.length > 0 ? 'badge-ok' : 'badge-warn'}`}>
            {cards.length > 0 ? `${cards.length} card${cards.length === 1 ? '' : 's'}` : 'none'}
          </span>
        </div>

        {readError ? (
          <div className="notice notice-warn" style={{ marginTop: '0.85rem' }}>
            Could not read the card list: {readError}
          </div>
        ) : cards.length === 0 ? (
          <p className="muted small" style={{ marginTop: '0.85rem' }}>
            No card is vaulted, so a merchant purchase on the card rail cannot
            succeed yet. Dispatch will reach the provider and fail at the card
            step — which is what happened on the last live run.
          </p>
        ) : (
          <table style={{ marginTop: '0.85rem' }}>
            <tbody>
              {cards.map((card) => (
                <tr key={card.id}>
                  <td>
                    {cap(card.brand)} •••• {card.lastFour ?? '????'}
                  </td>
                  <td className="muted small">
                    {card.expiryMonth && card.expiryYear
                      ? `expires ${String(card.expiryMonth).padStart(2, '0')}/${card.expiryYear}`
                      : ''}
                  </td>
                  <td className="muted small">{card.isDefault ? 'default' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2>Register this URL</h2>

      <div className="notice notice-warn">
        <p style={{ marginTop: 0 }}>
          Add this as a <strong>redirect URI</strong> on your OAuth client, and
          pass it as <code>return_url</code> when opening the card form:
        </p>
        <p>
          <code>{thisUrl}</code>
        </p>
        <p className="small" style={{ marginBottom: 0 }}>
          They must match exactly, or the card form refuses to render.
        </p>
      </div>

      <h2>Open the card form</h2>
      <pre className="code-block">
        {`https://app.agnic.ai/partner/cards/new
  ?client_id={YOUR_CLIENT_ID}
  &return_url=${encodeURIComponent(thisUrl)}`}
      </pre>

      <p className="muted small">
        Running against <code>{mode}</code>. Card data lives in Agnic&apos;s vault,
        not here — this page never receives a number.
      </p>
    </main>
  );
}
