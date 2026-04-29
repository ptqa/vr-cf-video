# VR-CF-Video Implementation Plan

Serverless VR video streaming on Cloudflare Workers + R2. Replaces the legacy
nginx + on-disk + DeoVR-bundle.js setup found in `legacy/`.

## Goals

- Stream VR video files (mostly 8K, 30–50GB each) from R2 over HTTPS with
  HTTP range support so headsets can seek.
- Expose a [DeoVR JSON catalog API](https://deovr.com/app/doc) so DeoVR /
  HereSphere / Pigasus headset apps auto-discover the library.
- Provide a **responsive tile-grid HTML index** for browsers with lazy-loaded
  thumbnails (so users on a desktop can browse visually and click through).
- Generate **static JPEG thumbnails** in the CLI at upload time (ffmpeg, single
  -eye left-half crop). Render an SVG placeholder when a thumb is missing.
- Single shared password (env var) gates everything. No per-user accounts.
- No D1 / no metadata DB. Worker lists R2 objects on demand and parses VR
  attributes from filenames. Catalog cached in `caches.default` for 5 min.
- A Bun-based CLI uploads files from disk to R2 (S3 multipart) and generates
  thumbnails with ffmpeg.

Reference project: `../cf-video/` (same author, Jellyfin-on-Cloudflare). Same
patterns for Worker layout, Bun CLI, S3 multipart uploader, wrangler config.

## Non-goals

- No transcoding (Workers can't run ffmpeg).
- No per-user accounts, watch history, resume position. (Headset apps usually
  track this client-side anyway.)
- No D1, no Durable Objects, no KV. R2 is the only state.
- No web admin UI. Catalog management is via CLI.
- No animated hover previews (`videoThumbnail` clips, sprite sheets) in v1 —
  static JPEG only. Easy to add later.
- No on-demand thumbnail generation in the worker. If a video has no thumb in
  R2, browser sees a placeholder SVG; user re-runs CLI to backfill.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    Cloudflare Edge                            │
│  ┌─────────────────┐                  ┌─────────────────────┐ │
│  │  Worker          │─── list ──────> │  R2 Bucket          │ │
│  │  - / (HTML grid) │                 │   videos/*.mp4      │ │
│  │  - /deovr (JSON) │─── get range ─> │   videos/*.meta.json│ │
│  │  - /v/{key}      │─── get ───────> │   thumbs/*.jpg      │ │
│  │  - /t/{key}      │                 │                     │ │
│  └────────^─────────┘                 └─────────────────────┘ │
│           │                                       ^          │
└───────────┼───────────────────────────────────────┼──────────┘
            │                                       │
   ┌────────┴──────────┐                  ┌─────────┴────────────┐
   │  DeoVR/HereSphere │                  │  vr-cf CLI (bun)     │
   │  Pigasus headsets │                  │  scan local dir      │
   │  + browsers       │                  │  parse filenames     │
   │  (tile grid UI)   │                  │  ffprobe + ffmpeg    │
   └───────────────────┘                  │  thumb gen + upload  │
                                          │  multipart S3 upload │
                                          └──────────────────────┘
```

## Project layout

```
vr-cf-video/
├── AGENTS.md            # project guidelines (this repo)
├── PLAN.md              # this file
├── README.md            # setup + usage
├── legacy/              # original nginx+DeoVR static-pages setup (reference)
│   ├── deovr/
│   ├── pages/
│   ├── generate_pages.rb
│   ├── index.html
│   ├── run_docker.sh
│   └── ssl-site.conf
├── shared/              # code shared between worker and cli
│   └── src/
│       └── parser.ts    # VR filename → metadata
├── worker/
│   ├── src/
│   │   ├── index.ts        # router
│   │   ├── auth.ts         # shared-password basic auth + token query
│   │   ├── catalog.ts      # R2 list + cache
│   │   ├── deovr.ts        # DeoVR JSON catalog + per-scene
│   │   ├── stream.ts       # range streaming from R2
│   │   ├── thumbnail.ts    # /t/{key} handler + SVG placeholder fallback
│   │   ├── html/
│   │   │   ├── index.ts    # HTML index page (tile grid)
│   │   │   ├── player.ts   # HTML per-video page
│   │   │   └── styles.ts   # inlined CSS (no asset pipeline needed)
│   │   └── types.ts
│   ├── wrangler.toml.example
│   ├── package.json
│   └── tsconfig.json
└── cli/
    ├── src/
    │   ├── index.ts        # commander entry point
    │   ├── config.ts       # toml config loader
    │   ├── uploader.ts     # S3 multipart (ported from cf-video)
    │   ├── ffprobe.ts      # duration / dimensions probe
    │   ├── thumbnail.ts    # ffmpeg single-eye left-half JPEG extraction
    │   └── scanner.ts      # walk dir, parse, probe, thumb, upload
    ├── vr-cf.toml.example
    ├── package.json
    └── tsconfig.json
```

## Worker endpoints

| Path                    | Method | Auth | Purpose                                      |
|-------------------------|--------|------|----------------------------------------------|
| `/`                     | GET    | yes  | HTML index for browsers                      |
| `/p/{key}`              | GET    | yes  | HTML page for a single video                 |
| `/deovr`                | GET    | yes  | DeoVR catalog JSON (headset entry point)    |
| `/deovr/{key}`          | GET    | yes  | DeoVR per-scene JSON                         |
| `/v/{key}`              | GET    | yes  | Video stream (range-aware)                   |
| `/t/{key}`              | GET    | yes  | Thumbnail JPEG (or SVG placeholder if missing)|
| `/healthz`              | GET    | no   | health check                                 |

`{key}` is the URL-encoded R2 object key without the `videos/` prefix, e.g.
`SLR_AC%20VR_BEST%20BOOBS%20ON%20SLR_2900p_MKX200.mp4`.

## Auth model

- Single shared password via `SHARED_PASSWORD` Worker secret (`wrangler secret put`).
- Accepted in either:
  1. `Authorization: Basic <base64(user:password)>` (user ignored)
  2. `?t=<password>` query param — for clients that can't set headers
- All paths except `/healthz` require auth.
- `WWW-Authenticate: Basic realm="vr"` returned on 401 so browsers prompt.
- Stream URLs handed to headsets include `?t=...` so the headset app doesn't
  need to manage credentials per-request.

Note: this is "shared secret + HTTPS" not real auth. Sufficient for matching
the legacy setup's threat model (URL-only access).

## VR filename parser

Filenames in legacy library encode VR attributes. Parser extracts:

| Attribute     | Detection                                                  |
|---------------|------------------------------------------------------------|
| `studio`      | prefix token (`SLR`, `VRBANGERS`, `wankzvr-`, `nam`, `tspa`, `tdrm`, `naw`, `ptgs`, `Manny_S_`, `NaughtyAmericaVR`, `VirtualRealPorn`) |
| `projection`  | `180x180`/`_180_` → `equirect`+180; `_360_` → `equirect`+360; `MKX200`/`MKX220` → `mkx200`/`mkx220`; `FISHEYE` → `fisheye`; default `equirect` |
| `stereoMode`  | `_LR`/`3dh`/`SBS` → `sbs`; `_TB`/`_OU` → `tb`; `mono` → `off`; default `sbs` |
| `resolution`  | extract `(\d+)p` or `8K`/`6K`/`4K`/`2K` keywords          |
| `fov`         | implied by projection (180 → 180, MKX200 → 200, etc.)     |
| `title`       | filename minus extension, studio prefix, and tag tokens   |
| `id`          | URL-encoded basename (stable since R2 key is filename)    |

Lives in `shared/src/parser.ts` so worker and CLI use identical logic.

## Catalog flow (worker)

1. Request hits `/deovr` (or `/`).
2. Check `caches.default` for cached catalog (key = `vr-catalog-v1`).
3. On miss: `env.BUCKET.list({ prefix: 'videos/' })`, paginate via `cursor`
   until truncated=false (R2 limit is 1000 per page).
4. For each object: parse filename → VR metadata. Build catalog.
5. Render JSON for `/deovr` or HTML for `/`.
6. Cache response 300s.

Cache invalidation: CLI `vr-cf refresh` calls `POST /admin/refresh` (gated by
shared password) which deletes the cache entry.

## DeoVR JSON shape

`/deovr` response:

```json
{
  "scenes": [{
    "name": "Library",
    "list": [
      {
        "title": "BEST BOOBS ON SLR",
        "thumbnailUrl": "https://host/t/SLR_AC%20VR_..._MKX200.mp4?t=...",
        "video_url": "https://host/deovr/SLR_AC%20VR_..._MKX200.mp4?t=..."
      }
    ]
  }]
}
```

`/deovr/{key}` per-scene response:

```json
{
  "encodings": [{
    "name": "h264",
    "videoSources": [{
      "resolution": 2900,
      "url": "https://host/v/SLR_AC%20VR_..._MKX200.mp4?t=..."
    }]
  }],
  "title": "BEST BOOBS ON SLR",
  "id": "SLR_AC...",
  "videoLength": 1740,
  "is3d": true,
  "screenType": "mkx200",
  "stereoMode": "sbs",
  "skipIntro": 0,
  "thumbnailUrl": "https://host/t/...?t=..."
}
```

`videoLength` is unknown without ffprobe metadata — CLI writes it into a
sidecar `videos/<file>.meta.json` at upload time, worker reads it during list.
If absent, omit field (DeoVR tolerates).

## Thumbnails

### Generation (CLI)

For each video, CLI extracts a single JPEG thumbnail at upload time:

```
ffmpeg -ss 30 -i <video> -vframes 1 \
  -vf "crop=in_w/2:in_h:0:0,scale=640:-1" \
  -q:v 4 <key>.jpg
```

- **Seek to 30s** (`-ss 30`) — skip studio intros / black frames. Configurable
  via `--thumb-time` flag; default 30s, fall back to 5s for shorter clips.
- **Single-eye crop** (`crop=in_w/2:in_h:0:0`) — VR source is side-by-side
  stereo. Take left half so a flat 2D viewer sees a normal-looking image.
  Works for `_LR` (most common). For `_TB` files use `crop=in_w:in_h/2:0:0`
  instead — picked from parsed `stereoMode`.
- **Resize** to 640px wide JPEG (q=4, ~50–80KB). Maintains aspect ratio.
- **Output key**: `thumbs/<filename>.jpg` (mirrors `videos/<filename>.mp4`).

CLI command surface:

```
vr-cf thumb <key>             # regenerate thumb for one video
vr-cf thumb --all              # regenerate all (skips existing)
vr-cf thumb --all --force      # regenerate all (overwrites)
vr-cf thumb <key> --time 60    # custom seek time
```

`vr-cf upload` runs `thumb` automatically per file unless `--no-thumb` passed.

### Storage

```
videos/<filename>.mp4
videos/<filename>.mp4.meta.json   # { duration, width, height, parsed }
thumbs/<filename>.mp4.jpg          # 640px wide JPEG
```

Thumb key = video key + `.jpg` so they're trivially derivable both directions.

### Worker `/t/{key}` handler

1. `env.BUCKET.get('thumbs/' + key + '.jpg')`.
2. Hit → return JPEG with `Cache-Control: public, max-age=31536000, immutable`.
3. Miss → return inline SVG placeholder showing studio + title text on a
   gradient background, `Cache-Control: public, max-age=300` (short TTL so
   it auto-fixes once user backfills).
4. Worker thumbnails are read by `<img loading="lazy">` in the HTML grid and
   by `thumbnailUrl` field in DeoVR JSON.

### SVG placeholder

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360">
  <defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
    <stop offset="0" stop-color="#1a1a2e"/><stop offset="1" stop-color="#0f3460"/>
  </linearGradient></defs>
  <rect width="640" height="360" fill="url(#g)"/>
  <text x="320" y="160" fill="#fff" text-anchor="middle"
        font-family="sans-serif" font-size="24" font-weight="700">SLR</text>
  <text x="320" y="200" fill="#aaa" text-anchor="middle"
        font-family="sans-serif" font-size="16">BEST BOOBS ON SLR</text>
</svg>
```

Generated server-side from parsed metadata. No SSR templating needed — string
template literal.

## Browser HTML grid (`/`)

Single self-contained page (HTML + inline CSS + tiny inline JS). No build step.

Layout:
- Header: title, total count, search input, studio filter chips
- Responsive CSS grid: `repeat(auto-fill, minmax(280px, 1fr))`
- Each tile:
  - `<img loading="lazy">` thumbnail (640×360, contains aspect)
  - Title (parsed, no studio prefix)
  - Studio badge + projection badge (e.g. `MKX200`, `180°`, `8K`)
  - Click → `/p/{key}` player page

Search/filter is purely client-side (catalog small enough — hundreds of items
fit in HTML). For libraries >1000, would switch to JSON + virtualized grid.

```
┌──────────────────────────────────────────────────────────┐
│  VR Library                              [search.....]   │
│  154 videos · SLR · VRBangers · Wankz · NA · ...         │
├──────────────────────────────────────────────────────────┤
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐     │
│  │  thumb   │ │  thumb   │ │  thumb   │ │  thumb   │     │
│  │          │ │          │ │          │ │          │     │
│  ├──────────┤ ├──────────┤ ├──────────┤ ├──────────┤     │
│  │ Title... │ │ Title... │ │ Title... │ │ Title... │     │
│  │ SLR·8K   │ │ VRB·4K   │ │ NA·2K    │ │ Wankz·6K │     │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘     │
└──────────────────────────────────────────────────────────┘
```

Player page `/p/{key}` mirrors legacy `pages/*.html`:
- Loads `legacy/deovr/bundle.js`-equivalent from R2 (or CDN) for in-browser VR
  playback. **TBD** — alternative: just embed an `<a href="deovr://...">`
  deeplink to launch headset apps and a fallback `<video>` tag for flat playback.

Native VR-in-browser is hard. v1 plan: simple `<video controls>` with the
DeoVR deeplink button + a "Open in DeoVR" QR code for headset users.

## Streaming (`/v/{key}`)

Same pattern as `cf-video/worker/src/handlers/stream.ts:5`:

- Parse `Range: bytes=N-M` header.
- `env.BUCKET.get(key, { range: { offset, length } })` — R2 native ranged read.
- Return 206 with `Content-Range`, `Content-Length`, `Accept-Ranges: bytes`.
- No range → return full object as 200.
- `Cache-Control: public, max-age=31536000, immutable` (filename is content
  identifier; if file changes, upload as new name).

VR files are 30–50GB. Worker max response size is unbounded for streaming
(passes R2 stream through). Headset apps issue ranged reads, never download
whole file at once. Verified pattern from cf-video.

## CLI commands

```
vr-cf upload <dir>            # scan dir, upload *.mp4 to R2 videos/
vr-cf upload <file>           # upload single file
vr-cf list                    # list R2 contents with parsed metadata
vr-cf delete <key>            # remove video + thumb + meta from R2
vr-cf thumb <key>             # generate thumbnail with ffmpeg, upload to thumbs/
vr-cf refresh                 # invalidate worker catalog cache
vr-cf stats                   # total size, count, by studio
```

`vr-cf upload` workflow per file:

1. Run ffprobe → duration, width, height.
2. Parse filename → metadata.
3. Check R2 `HEAD videos/<name>` → skip if size matches.
4. Multipart upload to `videos/<name>` (50MB parts, 3-way concurrency).
5. Write sidecar `videos/<name>.meta.json` with `{ duration, width, height, parsed }`.
6. If no thumb exists and ffmpeg available: extract frame at 30s,
   upload to `thumbs/<name>.jpg`.

Config in `vr-cf.toml`:

```toml
[cloudflare]
account_id = "..."

[r2]
bucket_name = "vr-cf-video"
endpoint = "https://<account>.r2.cloudflarestorage.com"
access_key_id = "..."
secret_access_key = "..."

[worker]
url = "https://vr.example.com"
shared_password = "..."   # for refresh endpoint
```

## Cost projection

For 30 VR files averaging 35GB each = **~1TB**:

| Service       | Usage              | Monthly       |
|---------------|--------------------|---------------|
| R2 Storage    | 1TB videos + ~5MB thumbs | ~$15    |
| R2 Class A    | ~60 PUT/mo (vid+thumb+meta) | ~$0  |
| R2 Class B    | ~10K GET/mo        | ~$0           |
| R2 egress     | unlimited          | $0            |
| Workers       | <100K req/day      | Free tier     |
| **Total**     |                    | **~$15/mo**   |

Compare legacy: VPS w/ 1TB storage and unmetered bandwidth ~ $20–80/mo.

## Phased delivery

### Phase 1 — Worker MVP
- [ ] Project scaffold (`worker/`, `shared/`, configs)
- [ ] `shared/src/parser.ts` with unit tests against legacy filenames
- [ ] `worker/src/auth.ts` shared-password basic + query-token
- [ ] `worker/src/catalog.ts` R2 list + meta.json sidecar reader + cache
- [ ] `worker/src/stream.ts` range-aware R2 streaming
- [ ] `worker/src/thumbnail.ts` `/t/{key}` + SVG placeholder fallback
- [ ] `worker/src/deovr.ts` catalog + per-scene JSON
- [ ] `worker/src/html/index.ts` tile-grid index
- [ ] `worker/src/html/player.ts` per-video player page
- [ ] `worker/src/html/styles.ts` inlined CSS
- [ ] `worker/src/index.ts` router
- [ ] `wrangler.toml.example`

### Phase 2 — CLI
- [ ] `cli/` scaffold
- [ ] `config.ts` toml loader
- [ ] `uploader.ts` ported from `cf-video/cli/src/uploader.ts`
- [ ] `ffprobe.ts` duration/dimensions probe
- [ ] `thumbnail.ts` ffmpeg single-eye crop JPEG extraction
- [ ] `scanner.ts` directory walk + ffprobe + thumb + upload
- [ ] `index.ts` commander commands incl. `thumb` / `thumb --all`

### Phase 3 — Validation
- [ ] Unit-test parser against all 19 legacy filenames in `legacy/pages/`
- [ ] Unit-test thumbnail crop flag selection (LR vs TB)
- [ ] Local `wrangler dev` + miniflare R2
- [ ] Upload one real VR file, verify thumb extracted + visible in browser grid
- [ ] Browse on a headset (DeoVR / HereSphere) — confirm thumbs load in catalog
- [ ] Verify SVG placeholder for missing-thumb case
- [ ] Verify range seeking on headset
- [ ] Verify lazy loading (network tab) — only visible tiles fetch

### Phase 4 — Deploy
- [ ] Provision R2 bucket
- [ ] `wrangler secret put SHARED_PASSWORD`
- [ ] `wrangler deploy`
- [ ] Wire DNS (point existing `8k.ptqa.xyz` to worker)
- [ ] Migrate first batch of files via CLI

## Open questions

1. **DeoVR scene grouping** — currently single "Library" scene. Future: group
   by studio detected from filename prefix.
2. **Hot file caching** — Cloudflare auto-caches R2 GETs. No extra config
   needed but verify HEAD against zone settings post-deploy.
3. **In-browser VR playback** — legacy `deovr/bundle.js` does WebXR rendering.
   For v1 player page, plan is plain `<video>` + `deovr://` deeplink + QR. If
   browser-VR is a hard requirement, port the bundle (4.5MB) into worker
   assets or serve from R2. Decide post-MVP based on usage.
4. **HereSphere extras** — HereSphere supports tags, scripts (`.funscript`),
   alpha overlays. Out of scope for v1, easy add later (sidecar `.funscript`
   alongside videos/).
5. **Thumbnail timestamp heuristic** — fixed 30s might land on black/transition
   frames. Future enhancement: try 30s, then 60s, then 120s; pick frame with
   highest variance (skip black). Defer until we see misses in practice.

## References

- Legacy setup: `legacy/`
- Reference project (Jellyfin-on-CF): `../cf-video/`
- DeoVR app doc: https://deovr.com/app/doc
- HereSphere JSON spec: https://heresphere.xyz/api
- Cloudflare R2 docs: https://developers.cloudflare.com/r2/
- R2 ranged reads: https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#ranged-reads
