import { checkAuth } from './auth';
import { invalidateCatalog } from './catalog';
import { deovrIndex, deovrScene } from './deovr';
import { renderIndex } from './html/index';
import { renderPlayer } from './html/player';
import { streamVideo } from './stream';
import { serveThumbnail } from './thumbnail';
import type { Env } from './types';

/**
 * Worker entry point. Routing is intentionally tiny — we have ~7 endpoints.
 *
 * Public:
 *   GET /healthz
 *
 * Auth-gated (Basic or `?t=`):
 *   GET  /                  HTML grid
 *   GET  /p/{filename}      HTML player page
 *   GET  /deovr             DeoVR catalog JSON
 *   GET  /deovr/{filename}  DeoVR per-scene JSON
 *   GET  /v/{filename}      Video stream (range-aware)
 *   GET  /t/{filename}      Thumbnail JPEG (or SVG placeholder)
 *   POST /admin/refresh     Drop catalog cache
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/healthz') {
      return new Response('ok', { headers: { 'Content-Type': 'text/plain' } });
    }

    const authFailure = checkAuth(request, env);
    if (authFailure) return authFailure;

    try {
      const response = await route(path, request, env, ctx);
      if (response) return response;
      return new Response('Not found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    } catch (err) {
      console.error(`[error] ${request.method} ${path}:`, err);
      return new Response('Internal error', { status: 500 });
    }
  },
};

async function route(
  path: string,
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response | null> {
  // /
  if (path === '/' || path === '') {
    return renderIndex(request, env, ctx);
  }

  // /admin/refresh
  if (path === '/admin/refresh') {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }
    await invalidateCatalog();
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // /deovr  (root catalog JSON)
  if (path === '/deovr') {
    return deovrIndex(request, env, ctx);
  }

  // /deovr/{filename}  (per-scene JSON)
  if (path.startsWith('/deovr/')) {
    const filename = decodeURIComponent(path.slice('/deovr/'.length));
    return deovrScene(filename, request, env, ctx);
  }

  // /p/{filename}  (HTML player)
  if (path.startsWith('/p/')) {
    const filename = decodeURIComponent(path.slice('/p/'.length));
    return renderPlayer(filename, request, env, ctx);
  }

  // /v/{filename}  (video stream)
  if (path.startsWith('/v/')) {
    const filename = decodeURIComponent(path.slice('/v/'.length));
    return streamVideo(filename, request, env);
  }

  // /t/{filename}  (thumbnail)
  if (path.startsWith('/t/')) {
    const filename = decodeURIComponent(path.slice('/t/'.length));
    return serveThumbnail(filename, env);
  }

  return null;
}
