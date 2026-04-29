import { parseVrFilename } from '../../shared/src/parser';
import type { CatalogEntry, Env, VideoSidecarMeta } from './types';

const VIDEO_PREFIX = 'videos/';
const THUMB_PREFIX = 'thumbs/';
const META_SUFFIX = '.meta.json';
const CACHE_KEY_URL = 'https://vr-cf-internal/__catalog__';
const CACHE_TTL_SECONDS = 300;

/** Result wrapper so we can surface "from cache" without a side channel. */
interface CatalogResult {
  entries: CatalogEntry[];
  fromCache: boolean;
  generatedAt: number;
}

/**
 * Load the catalog. Cached in `caches.default` for {@link CACHE_TTL_SECONDS}.
 * Use {@link invalidateCatalog} to force regeneration after CLI uploads.
 */
export async function loadCatalog(env: Env, ctx: ExecutionContext): Promise<CatalogResult> {
  const cache = caches.default;
  const cacheReq = new Request(CACHE_KEY_URL);
  const cached = await cache.match(cacheReq);

  if (cached) {
    const body = (await cached.json()) as { entries: CatalogEntry[]; generatedAt: number };
    return { entries: body.entries, fromCache: true, generatedAt: body.generatedAt };
  }

  const entries = await scanBucket(env);
  const generatedAt = Date.now();

  // Cache the catalog so subsequent requests don't re-scan R2.
  const cacheRes = new Response(JSON.stringify({ entries, generatedAt }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
    },
  });
  ctx.waitUntil(cache.put(cacheReq, cacheRes));

  return { entries, fromCache: false, generatedAt };
}

/** Drop the cached catalog. Triggered by `POST /admin/refresh`. */
export async function invalidateCatalog(): Promise<void> {
  await caches.default.delete(new Request(CACHE_KEY_URL));
}

/**
 * List the bucket and assemble catalog entries.
 *
 * Single pass over `videos/` (paginated). For each `.mp4` (or other video
 * extension) we lazily fetch the sidecar `.meta.json` if present. Thumb
 * existence is inferred from a parallel listing of `thumbs/` (cheaper than
 * one HEAD per file).
 */
async function scanBucket(env: Env): Promise<CatalogEntry[]> {
  const [videoObjects, thumbKeys] = await Promise.all([
    listAll(env, VIDEO_PREFIX),
    listAllKeys(env, THUMB_PREFIX),
  ]);

  // Split: real video files vs. their sidecar JSONs.
  const sidecarByFilename = new Map<string, R2Object>();
  const videoObjectsOnly: R2Object[] = [];
  for (const obj of videoObjects) {
    const name = obj.key.slice(VIDEO_PREFIX.length);
    if (name.endsWith(META_SUFFIX)) {
      const videoName = name.slice(0, -META_SUFFIX.length);
      sidecarByFilename.set(videoName, obj);
    } else if (isVideoFilename(name)) {
      videoObjectsOnly.push(obj);
    }
  }

  // Fetch sidecars in parallel (bounded — one HEAD-equivalent per video).
  const sidecars = await Promise.all(
    videoObjectsOnly.map(async (obj) => {
      const name = obj.key.slice(VIDEO_PREFIX.length);
      const sidecar = sidecarByFilename.get(name);
      if (!sidecar) return null;
      return readSidecar(env, sidecar.key);
    })
  );

  return videoObjectsOnly.map((obj, i) => {
    const filename = obj.key.slice(VIDEO_PREFIX.length);
    const sidecar = sidecars[i];
    return {
      filename,
      size: obj.size,
      etag: obj.etag,
      uploaded: obj.uploaded.toISOString(),
      vr: sidecar?.parsed ?? parseVrFilename(filename),
      sidecar,
      hasThumb: thumbKeys.has(`${THUMB_PREFIX}${filename}.jpg`),
    };
  });
}

async function readSidecar(env: Env, key: string): Promise<VideoSidecarMeta | null> {
  const obj = await env.BUCKET.get(key);
  if (!obj) return null;
  try {
    const text = await obj.text();
    return JSON.parse(text) as VideoSidecarMeta;
  } catch {
    return null;
  }
}

/** R2 list paginated until exhausted. */
async function listAll(env: Env, prefix: string): Promise<R2Object[]> {
  const out: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page: R2Objects = await env.BUCKET.list({ prefix, cursor, limit: 1000 });
    out.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

/** Same as {@link listAll} but only returns the keys as a Set. */
async function listAllKeys(env: Env, prefix: string): Promise<Set<string>> {
  const keys = new Set<string>();
  let cursor: string | undefined;
  do {
    const page: R2Objects = await env.BUCKET.list({ prefix, cursor, limit: 1000 });
    for (const o of page.objects) keys.add(o.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.mov', '.webm'];

function isVideoFilename(name: string): boolean {
  const lower = name.toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
