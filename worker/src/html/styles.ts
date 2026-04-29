/**
 * Inline CSS for the HTML grid + player pages. Single string so the worker
 * can ship a self-contained HTML response with no external asset fetches.
 *
 * Design goals:
 *   - dark, contrasty, immersive (theme matches "VR")
 *   - thumbnails dominate; chrome stays minimal
 *   - works on a phone/laptop/headset browser without media-query gymnastics
 *   - single tasteful accent color, generous whitespace, subtle hover lift
 */
export const STYLES = String.raw`
:root {
  --bg: #0b0d12;
  --bg-card: #14171f;
  --bg-card-hover: #1b1f2a;
  --fg: #e8eaef;
  --fg-muted: #8a8f9a;
  --accent: #7a5cff;
  --border: rgba(255, 255, 255, 0.06);
  --shadow: 0 8px 24px -12px rgba(0, 0, 0, 0.5);
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-size: 15px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

a { color: inherit; text-decoration: none; }

.app {
  max-width: 1600px;
  margin: 0 auto;
  padding: 32px 24px 64px;
}

.app-header {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-bottom: 32px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--border);
}

.app-title {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 0;
}

.app-meta {
  color: var(--fg-muted);
  font-size: 14px;
}

.controls {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.search {
  flex: 1 1 280px;
  min-width: 0;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--fg);
  padding: 10px 14px;
  font: inherit;
  transition: border-color 0.15s;
}
.search:focus {
  outline: none;
  border-color: var(--accent);
}

.studio-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.chip {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 6px 14px;
  font-size: 13px;
  color: var(--fg-muted);
  cursor: pointer;
  transition: all 0.15s;
}
.chip:hover { color: var(--fg); border-color: rgba(255, 255, 255, 0.15); }
.chip.active {
  background: var(--accent);
  color: white;
  border-color: var(--accent);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 20px;
}

.tile {
  background: var(--bg-card);
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--border);
  transition: transform 0.18s, background 0.18s, box-shadow 0.18s;
  display: block;
}
.tile:hover {
  background: var(--bg-card-hover);
  transform: translateY(-2px);
  box-shadow: var(--shadow);
}

.tile-thumb {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  background: #000;
}

.tile-body {
  padding: 14px 16px 16px;
}

.tile-title {
  font-size: 15px;
  font-weight: 600;
  margin: 0 0 8px;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.tile-tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.tag {
  background: rgba(255, 255, 255, 0.05);
  padding: 3px 8px;
  border-radius: 4px;
  white-space: nowrap;
}
.tag.studio { color: var(--accent); }

.empty {
  text-align: center;
  color: var(--fg-muted);
  padding: 80px 20px;
  font-size: 16px;
}

/* Player page */
.player {
  max-width: 1280px;
  margin: 0 auto;
  padding: 24px;
}
.player-back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--fg-muted);
  margin-bottom: 16px;
  font-size: 14px;
}
.player-back:hover { color: var(--fg); }
.player-title {
  font-size: 24px;
  font-weight: 700;
  margin: 0 0 16px;
}
.player video {
  width: 100%;
  background: #000;
  border-radius: 12px;
  margin-bottom: 16px;
}
.player-actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 24px;
}
.btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 18px;
  background: var(--accent);
  color: white;
  border-radius: 8px;
  font-weight: 600;
  font-size: 14px;
  border: none;
  cursor: pointer;
  transition: opacity 0.15s;
}
.btn:hover { opacity: 0.9; }
.btn.secondary {
  background: var(--bg-card);
  color: var(--fg);
  border: 1px solid var(--border);
}
.player-meta {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px 20px;
}
.player-meta dt {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--fg-muted);
  margin-bottom: 4px;
}
.player-meta dd {
  margin: 0;
  font-weight: 500;
}
`;
