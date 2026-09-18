'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Refresh a server-rendered page while an order is still moving.
 *
 * Three seconds matches the provider's own guidance for polling an in-flight
 * order: it takes sixty to seventy seconds to settle, so asking more often buys
 * nothing but rate limit.
 *
 * Rendering is entirely server-side; this only asks for a fresh render, so no
 * order data is ever computed in the browser.
 */
export function AutoRefresh({
  enabled,
  intervalMs = 3000,
}: {
  enabled: boolean;
  intervalMs?: number;
}) {
  const router = useRouter();

  useEffect(() => {
    if (!enabled) return;

    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs, router]);

  return null;
}
