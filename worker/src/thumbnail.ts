import { parseVrFilename } from '../../shared/src/parser';
import type { Env } from './types';

/**
 * Serve a thumbnail JPEG from R2 (`thumbs/<filename>.jpg`).
 *
 * On miss, return a generated SVG placeholder showing the studio + title so
 * the browser grid never has broken images. Placeholder TTL is short
 * (5 min) so it self-heals once the CLI backfills.
 */
export async function serveThumbnail(filename: string, env: Env): Promise<Response> {
  const key = `thumbs/${filename}.jpg`;
  const object = await env.BUCKET.get(key);

  if (object) {
    return new Response(object.body, {
      status: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'Content-Length': String(object.size),
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  }

  // Placeholder: SVG with studio + title from filename.
  const meta = parseVrFilename(filename);
  const svg = renderPlaceholderSvg(meta.studio ?? 'VR', truncate(meta.title, 60));

  return new Response(svg, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

function renderPlaceholderSvg(studio: string, title: string): string {
  // Hash studio name to a hue so each studio gets a stable color.
  const hue = hashString(studio) % 360;

  // Wrap title text into 2 lines of ~30 chars each.
  const lines = wrapText(title, 30, 2);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" width="640" height="360">
  <defs>
    <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="hsl(${hue}, 35%, 18%)"/>
      <stop offset="1" stop-color="hsl(${(hue + 40) % 360}, 60%, 12%)"/>
    </linearGradient>
  </defs>
  <rect width="640" height="360" fill="url(#g)"/>
  <text x="32" y="60" fill="#fff" font-family="system-ui, sans-serif" font-size="20" font-weight="700" letter-spacing="2">${escapeXml(studio.toUpperCase())}</text>
  ${lines
    .map(
      (line, i) =>
        `<text x="32" y="${190 + i * 28}" fill="#e8e8e8" font-family="system-ui, sans-serif" font-size="22" font-weight="500">${escapeXml(line)}</text>`
    )
    .join('\n  ')}
  <text x="608" y="332" fill="#888" font-family="system-ui, sans-serif" font-size="14" text-anchor="end">no thumb</text>
</svg>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function wrapText(text: string, lineLen: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (!cur) {
      cur = w;
    } else if (cur.length + 1 + w.length <= lineLen) {
      cur += ` ${w}`;
    } else {
      lines.push(cur);
      cur = w;
      if (lines.length === maxLines - 1) break;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === maxLines) {
    const last = lines[lines.length - 1];
    if (last.length > lineLen) lines[lines.length - 1] = `${last.slice(0, lineLen - 1)}…`;
  }
  return lines;
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}
