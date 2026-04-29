import { tokenQuery } from '../auth';
import { loadCatalog } from '../catalog';
import type { CatalogEntry, Env } from '../types';
import { STYLES } from './styles';

/**
 * Browser-facing HTML index. Tile grid of thumbnails with client-side
 * search + studio filtering. Self-contained: inline CSS, inline JS, no
 * external assets so the page stays fast even on a phone or headset
 * browser.
 */
export async function renderIndex(
  _request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const { entries } = await loadCatalog(env, ctx);
  const tq = tokenQuery(env);

  // Sort newest-first by upload date.
  const sorted = [...entries].sort((a, b) => b.uploaded.localeCompare(a.uploaded));

  const studios = uniqueStudios(sorted);

  const html = renderHtml({
    siteTitle: env.SITE_TITLE,
    entries: sorted,
    studios,
    tokenQuery: tq,
  });

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
    },
  });
}

interface RenderArgs {
  siteTitle: string;
  entries: CatalogEntry[];
  studios: string[];
  tokenQuery: string;
}

function renderHtml({ siteTitle, entries, studios, tokenQuery: tq }: RenderArgs): string {
  const count = entries.length;
  const tiles = entries.map((e) => renderTile(e, tq)).join('\n');

  const studioChips = [
    `<button class="chip active" data-studio="">All</button>`,
    ...studios.map(
      (s) => `<button class="chip" data-studio="${escapeAttr(s)}">${escapeHtml(s)}</button>`
    ),
  ].join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0b0d12">
<title>${escapeHtml(siteTitle)}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="app">
  <header class="app-header">
    <h1 class="app-title">${escapeHtml(siteTitle)}</h1>
    <div class="app-meta" id="counter">${count} videos · <a href="/deovr?${tq}" style="color:var(--accent)">DeoVR catalog</a></div>
    <div class="controls">
      <input class="search" id="search" type="search" placeholder="Search title or studio…" autocomplete="off">
      <div class="studio-filters" id="studios">${studioChips}</div>
    </div>
  </header>
  <main>
    ${count === 0
      ? `<div class="empty">No videos yet. Upload some via the CLI.</div>`
      : `<div class="grid" id="grid">${tiles}</div>`
    }
  </main>
</div>
<script>${BROWSER_JS}</script>
</body>
</html>`;
}

function renderTile(entry: CatalogEntry, tq: string): string {
  const fn = encodeURIComponent(entry.filename);
  const href = `/p/${fn}?${tq}`;
  const thumb = `/t/${fn}?${tq}`;
  const studio = entry.vr.studio ?? 'Unknown';
  const tags: string[] = [];
  if (entry.vr.resolutionLabel) tags.push(entry.vr.resolutionLabel);
  if (entry.vr.projection !== 'flat') tags.push(`${entry.vr.fov}°`);
  if (entry.vr.projection === 'mkx200') tags.push('MKX200');
  if (entry.vr.projection === 'mkx220') tags.push('MKX220');
  if (entry.vr.projection === 'fisheye') tags.push('FISHEYE');

  const dataStudio = escapeAttr(studio);
  const searchBlob = escapeAttr(`${entry.vr.title} ${studio} ${entry.filename}`.toLowerCase());

  return `<a class="tile" href="${href}" data-studio="${dataStudio}" data-search="${searchBlob}">
  <img class="tile-thumb" src="${thumb}" alt="" loading="lazy" decoding="async">
  <div class="tile-body">
    <h2 class="tile-title">${escapeHtml(entry.vr.title)}</h2>
    <div class="tile-tags">
      <span class="tag studio">${escapeHtml(studio)}</span>
      ${tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
    </div>
  </div>
</a>`;
}

function uniqueStudios(entries: CatalogEntry[]): string[] {
  const set = new Set<string>();
  for (const e of entries) {
    if (e.vr.studio) set.add(e.vr.studio);
  }
  return [...set].sort();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

/**
 * Tiny client-side script for filter + search. Vanilla, no framework.
 * Reads `data-studio` and `data-search` from each `.tile`. No re-render —
 * just hides/shows DOM nodes.
 */
const BROWSER_JS = String.raw`
(function() {
  const grid = document.getElementById('grid');
  if (!grid) return;
  const tiles = Array.from(grid.querySelectorAll('.tile'));
  const counter = document.getElementById('counter');
  const counterText = counter ? counter.firstChild : null;
  const search = document.getElementById('search');
  const studioBox = document.getElementById('studios');
  let activeStudio = '';
  let query = '';

  function applyFilter() {
    let visible = 0;
    for (const tile of tiles) {
      const studio = tile.dataset.studio || '';
      const blob = tile.dataset.search || '';
      const matchesStudio = !activeStudio || studio === activeStudio;
      const matchesQuery = !query || blob.includes(query);
      const show = matchesStudio && matchesQuery;
      tile.style.display = show ? '' : 'none';
      if (show) visible++;
    }
    if (counterText) {
      counterText.nodeValue = visible + ' of ' + tiles.length + ' videos · ';
    }
  }

  search.addEventListener('input', () => {
    query = search.value.trim().toLowerCase();
    applyFilter();
  });

  studioBox.addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    studioBox.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    activeStudio = btn.dataset.studio || '';
    applyFilter();
  });
})();
`;
