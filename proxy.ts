import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Vercel Routing Middleware runs before every matching request.
// We use it to inject org_id as a header so tool execute() functions can
// read it without needing it threaded through every function signature.
//
// Today: always returns 'default' org_id (single-tenant demo).
// Multi-tenant upgrade: decode JWT, extract org claim, inject header.
// Zero changes needed to tools, routes, or agent loop.

export function proxy(request: NextRequest) {
  const response = NextResponse.next();

  // TODO: Replace with real JWT decode when adding auth (e.g. Clerk)
  // const token = request.cookies.get('session')?.value;
  // const { orgId } = await verifyJWT(token);
  const orgId = 'default';

  response.headers.set('x-dispatch-org-id', orgId);
  return response;
}

export const config = {
  matcher: ['/api/:path*'],
};
