import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import {
  CREATOR_SESSION_COOKIE,
  creatorCookieOptions,
  creatorKeyMatches,
  signCreatorSession,
} from '@/creators/auth';
import { prisma } from '@/db/client';

export const dynamic = 'force-dynamic';

/**
 * Exchange a creator's private link for a session.
 *
 * This is a route handler rather than logic on the page because a server
 * component cannot set a cookie — and without setting one the key would have to
 * stay in the URL and be threaded through every form on the page, which is a
 * credential scattered across a dozen hidden inputs.
 *
 * The creator's field is `accessKey`; this reads `?key=` so the URL they hold is
 * short enough to keep.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  const key = new URL(request.url).searchParams.get('key');

  const creator = await prisma.creator.findUnique({
    where: { publicSlug: slug },
    select: { id: true, accessKey: true },
  });

  // One response for "no such creator" and "wrong key" alike, so this cannot be
  // used to work out which slugs exist. The landing page says only that a
  // private link is required, which is true for both.
  if (!creator || !creatorKeyMatches(key, creator.accessKey)) {
    return NextResponse.redirect(
      new URL(`/creator/${encodeURIComponent(slug)}`, request.url),
    );
  }

  const jar = await cookies();
  jar.set(CREATOR_SESSION_COOKIE, signCreatorSession(creator.id), creatorCookieOptions());

  // Redirect rather than render, so the key leaves the address bar. It is
  // already in their history and possibly their referrer; repeating it on every
  // subsequent page would only widen that.
  return NextResponse.redirect(new URL(`/creator/${encodeURIComponent(slug)}`, request.url));
}
