import { screenTypeForDeovr } from '../../shared/src/parser';
import { tokenQuery } from './auth';
import { loadCatalog } from './catalog';
import type { CatalogEntry, Env } from './types';

/**
 * DeoVR JSON catalog API.
 *
 * Spec: https://deovr.com/app/doc
 *
 * - GET /deovr           → root catalog (list of scenes)
 * - GET /deovr/{key}     → per-scene metadata (encodings + screenType etc.)
 *
 * Headset apps (DeoVR / HereSphere / Pigasus) point at `/deovr` and walk the
 * `list[].video_url` links to fetch per-scene JSON, then play the URL listed
 * under `encodings[0].videoSources[0].url`.
 */
export async function deovrIndex(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const { entries } = await loadCatalog(env, ctx);
  const origin = new URL(request.url).origin;
  const tq = tokenQuery(env);

  const list = entries.map((e) => ({
    title: e.vr.title,
    thumbnailUrl: thumbUrl(origin, e.filename, tq),
    video_url: sceneUrl(origin, e.filename, tq),
  }));

  return jsonResponse({
    scenes: [
      {
        name: env.SITE_TITLE,
        list,
      },
    ],
  });
}

export async function deovrScene(
  filename: string,
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const { entries } = await loadCatalog(env, ctx);
  const entry = entries.find((e) => e.filename === filename);
  if (!entry) {
    return new Response('Not found', { status: 404 });
  }

  const origin = new URL(request.url).origin;
  const tq = tokenQuery(env);
  return jsonResponse(buildScenePayload(entry, origin, tq));
}

function buildScenePayload(entry: CatalogEntry, origin: string, tq: string): Record<string, unknown> {
  const { vr, sidecar } = entry;
  const resolution = vr.resolution ?? sidecar?.height ?? 1080;

  const payload: Record<string, unknown> = {
    title: vr.title,
    id: hashId(entry.filename),
    description: buildDescription(entry),
    thumbnailUrl: thumbUrl(origin, entry.filename, tq),
    is3d: vr.is3d,
    screenType: screenTypeForDeovr[vr.projection],
    stereoMode: vr.stereoMode,
    encodings: [
      {
        name: 'h264',
        videoSources: [
          {
            resolution,
            url: videoUrl(origin, entry.filename, tq),
          },
        ],
      },
    ],
  };

  if (sidecar?.duration) {
    payload.videoLength = Math.round(sidecar.duration);
  }
  return payload;
}

function buildDescription(entry: CatalogEntry): string {
  const parts: string[] = [];
  if (entry.vr.studio) parts.push(entry.vr.studio);
  if (entry.vr.resolutionLabel) parts.push(entry.vr.resolutionLabel);
  if (entry.vr.projection !== 'flat') parts.push(`${entry.vr.fov}°`);
  return parts.join(' · ');
}

function thumbUrl(origin: string, filename: string, tq: string): string {
  return `${origin}/t/${encodeURIComponent(filename)}?${tq}`;
}

function videoUrl(origin: string, filename: string, tq: string): string {
  return `${origin}/v/${encodeURIComponent(filename)}?${tq}`;
}

function sceneUrl(origin: string, filename: string, tq: string): string {
  return `${origin}/deovr/${encodeURIComponent(filename)}?${tq}`;
}

/** Stable numeric-ish id for DeoVR (it expects a unique id field per scene). */
function hashId(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
