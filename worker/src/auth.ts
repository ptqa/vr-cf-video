import type { Env } from './types';

/**
 * Shared-password auth.
 *
 * Accepts the password from one of:
 *   1. HTTP Basic auth header  — `Authorization: Basic base64(any:password)`
 *   2. Query string             — `?t=<password>`
 *
 * The username portion of Basic auth is ignored (matches what most clients
 * fill in by default). Constant-time comparison guards against timing leaks.
 *
 * Returns null on success, or a 401 Response (with `WWW-Authenticate`) on
 * failure so browsers prompt for credentials.
 */
export function checkAuth(request: Request, env: Env): Response | null {
  const expected = env.SHARED_PASSWORD;
  if (!expected) {
    // Misconfigured worker — fail closed, but distinguish from bad password.
    return new Response('SHARED_PASSWORD not configured', { status: 500 });
  }

  const url = new URL(request.url);
  const queryToken = url.searchParams.get('t');
  if (queryToken && constantTimeEquals(queryToken, expected)) {
    return null;
  }

  const authHeader = request.headers.get('Authorization') ?? '';
  if (authHeader.startsWith('Basic ')) {
    const decoded = safeAtob(authHeader.slice('Basic '.length));
    if (decoded) {
      const colonIndex = decoded.indexOf(':');
      const password = colonIndex >= 0 ? decoded.slice(colonIndex + 1) : decoded;
      if (constantTimeEquals(password, expected)) {
        return null;
      }
    }
  }

  return new Response('Unauthorized', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="vr", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}

/**
 * Build a query-string token suffix to append to URLs handed back to clients
 * (DeoVR catalog entries, video URLs, etc.) so the headset doesn't have to
 * manage credentials per-request.
 */
export function tokenQuery(env: Env): string {
  return `t=${encodeURIComponent(env.SHARED_PASSWORD)}`;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function safeAtob(input: string): string | null {
  try {
    return atob(input);
  } catch {
    return null;
  }
}
