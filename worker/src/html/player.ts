import { tokenQuery } from '../auth';
import { loadCatalog } from '../catalog';
import type { CatalogEntry, Env } from '../types';
import { STYLES } from './styles';

/**
 * Per-video page. Plain HTML5 `<video>` for flat preview + a deep-link
 * button to launch the headset's DeoVR app. WebXR-in-browser is out of
 * scope for v1 — see PLAN.md "Open questions".
 */
export async function renderPlayer(
  filename: string,
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const { entries } = await loadCatalog(env, ctx);
  const entry = entries.find((e) => e.filename === filename);
  if (!entry) {
    return new Response('Not found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const url = new URL(request.url);
  const tq = tokenQuery(env);
  const html = renderHtml(entry, url.origin, tq);

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
    },
  });
}

function renderHtml(entry: CatalogEntry, origin: string, tq: string): string {
  const fn = encodeURIComponent(entry.filename);
  const videoUrl = `/v/${fn}?${tq}`;
  const thumbUrl = `/t/${fn}?${tq}`;
  // DeoVR deeplink: opens the headset's DeoVR app and points it at our scene JSON.
  const sceneUrl = `${origin}/deovr/${fn}?${tq}`;
  const deovrDeeplink = `deovr://${sceneUrl.replace(/^https?:\/\//, '')}`;
  // HereSphere uses heresphere:// with the same convention.
  const hereDeeplink = `heresphere://${sceneUrl.replace(/^https?:\/\//, '')}`;

  const sizeGB = (entry.size / 1024 / 1024 / 1024).toFixed(2);
  const duration = entry.sidecar?.duration ? formatDuration(entry.sidecar.duration) : null;
  const dimensions =
    entry.sidecar?.width && entry.sidecar?.height
      ? `${entry.sidecar.width}×${entry.sidecar.height}`
      : null;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0b0d12">
<title>${escapeHtml(entry.vr.title)}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="player">
  <a class="player-back" href="/?${tq}">← Library</a>
  <h1 class="player-title">${escapeHtml(entry.vr.title)}</h1>

  <video controls preload="metadata" poster="${thumbUrl}">
    <source src="${videoUrl}" type="video/mp4">
  </video>

  <div class="player-actions">
    <a class="btn" href="${deovrDeeplink}">Open in DeoVR</a>
    <a class="btn secondary" href="${hereDeeplink}">Open in HereSphere</a>
    <a class="btn secondary" href="${videoUrl}" download>Download</a>
  </div>

  <dl class="player-meta">
    ${entry.vr.studio ? metaRow('Studio', entry.vr.studio) : ''}
    ${entry.vr.resolutionLabel ? metaRow('Resolution', entry.vr.resolutionLabel) : ''}
    ${dimensions ? metaRow('Pixels', dimensions) : ''}
    ${duration ? metaRow('Length', duration) : ''}
    ${metaRow('Projection', projectionLabel(entry.vr.projection, entry.vr.fov))}
    ${metaRow('Stereo', entry.vr.stereoMode.toUpperCase())}
    ${metaRow('Size', `${sizeGB} GB`)}
  </dl>
</div>
</body>
</html>`;
}

function metaRow(label: string, value: string): string {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function projectionLabel(projection: string, fov: number): string {
  switch (projection) {
    case 'mkx200':
      return 'MKX200';
    case 'mkx220':
      return 'MKX220';
    case 'rf52':
      return 'RF52';
    case 'fisheye':
      return 'Fisheye';
    case 'equirect-360':
      return '360° Equirect';
    case 'flat':
      return 'Flat';
    default:
      return `${fov}° Equirect`;
  }
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
