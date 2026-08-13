# vr-cf-video

Serverless VR video streaming on Cloudflare Workers + R2.

- **Headsets** (DeoVR, HereSphere, Pigasus) auto-discover the library via the
  DeoVR JSON catalog API.
- **Browsers** get a responsive tile-grid index with lazy-loaded thumbnails
  and a built-in flat `<video>` player.
- **Single shared password** gates every endpoint (HTTP Basic or `?t=` query).
- **No database** — R2 is the only state. Filenames carry the metadata; the
  worker parses them on demand.
- **CLI** uploads from local disk to R2 (S3 multipart) and generates
  single-eye JPEG thumbnails with ffmpeg.

See `PLAN.md` for full architecture.

## Layout

```
vr-cf-video/
├── legacy/           # original nginx + DeoVR-bundle.js setup (reference)
├── shared/src/       # filename parser shared by worker + cli
├── worker/           # Cloudflare Worker (TypeScript, wrangler)
└── cli/              # Bun CLI for upload + thumb generation
```

## Prerequisites

- A Cloudflare account with R2 enabled
- Node-compatible runtime for the CLI: **Bun ≥ 1.1**
- **ffmpeg** + **ffprobe** on your PATH (CLI host only — the worker doesn't
  use them)
- `wrangler` (installed as a dev dependency in `worker/`)

### ffmpeg install cheatsheet

| OS      | Command                                              |
|---------|------------------------------------------------------|
| macOS   | `brew install ffmpeg`                                |
| Linux   | `apt install ffmpeg` / `dnf install ffmpeg`          |
| Windows | `winget install Gyan.FFmpeg` or `scoop install ffmpeg` |

### Bun install

| OS              | Command                                              |
|-----------------|------------------------------------------------------|
| macOS / Linux   | `curl -fsSL https://bun.sh/install \| bash`         |
| Windows         | `powershell -c "irm bun.sh/install.ps1 \| iex"`     |

## Setup

### 1. Provision R2

In the Cloudflare dashboard:

1. **R2 → Create bucket** named `vr-cf-video` (or whatever you prefer).
2. **R2 → Manage R2 API tokens → Create API token** with read/write to that
   bucket. Copy the access key id + secret.

### 2. Configure + deploy the worker

```bash
cd worker
cp wrangler.toml.example wrangler.toml
# edit wrangler.toml and set bucket_name if you used a different name
bun install
bunx wrangler secret put SHARED_PASSWORD
# enter your password when prompted
bunx wrangler deploy
```

The deploy output shows your `*.workers.dev` URL. Add a custom domain in the
Cloudflare dashboard if you want one (recommended — DeoVR plays nicer with a
clean hostname).

### 3. Configure the CLI

```bash
cd cli
cp vr-cf.toml.example vr-cf.toml
# edit vr-cf.toml: R2 endpoint/keys + worker URL + shared_password
bun install
```

The CLI looks for `vr-cf.toml` in the current directory, then `..`, then
`~/.config/vr-cf.toml` (Windows: `%USERPROFILE%\.config\vr-cf.toml`).

### 4. Upload a video

```bash
cd cli
bun run src/index.ts upload /path/to/your-vr-video.mp4
# or upload an entire directory:
bun run src/index.ts upload /path/to/vr-library/
```

Per file the CLI:
1. Probes with `ffprobe` (duration + dimensions).
2. Generates a single-eye JPEG thumbnail with `ffmpeg`.
3. Uploads `videos/<filename>.mp4` (multipart, 50MB parts × 3 concurrent).
4. Uploads `thumbs/<filename>.jpg`.
5. Uploads sidecar `videos/<filename>.mp4.meta.json`.
6. POSTs `/admin/refresh` to the worker so the new entry is visible immediately.

### 5. Browse

| Audience    | URL                                            |
|-------------|------------------------------------------------|
| Headset     | `https://your-worker.example.com/deovr` (in DeoVR/HereSphere/Pigasus) |
| Browser     | `https://your-worker.example.com/`             |

The browser is prompted for HTTP Basic creds (any username, your shared
password). The headset URL accepts `?t=<password>` so the catalog/stream
URLs handed back already include auth.

## CLI commands

```
vr-cf upload <path>           upload file or directory (recurses)
vr-cf upload <path> --no-thumb     skip thumbnail generation
vr-cf upload <path> --force        re-upload even if R2 has the same size

vr-cf list                    list R2 contents with parsed metadata
vr-cf delete <filename>       remove video + sidecar + thumb from R2
vr-cf thumb <localFile>       regenerate a thumbnail from a local file
vr-cf refresh                 invalidate the worker's catalog cache
vr-cf stats                   total size, count, by studio
```

## Filename conventions

The parser extracts metadata from filename tokens (studio prefix, resolution,
projection, stereo). Tag tokens recognised: `MKX200`, `MKX220`, `RF52`,
`FISHEYE`, `180x180`, `360x180`, `LR`, `TB`, `OU`, `3dh`, `mono`, `8K`,
`6K`, `4K`, `vrdesktophd`, plus any `\d+p` resolution like `4096p`.

Unknown filenames still work — they get stored as-is and rendered with a
sensible default (`equirect-180`, `sbs`, fallback title = filename).

## Cost

Roughly **$15/month** for a 1TB library (~30 × 35GB 8K files):

| Service     | Usage           | Cost     |
|-------------|-----------------|----------|
| R2 storage  | 1TB             | ~$15     |
| R2 egress   | unlimited       | $0       |
| R2 ops      | <100 PUTs, ~10K GETs | free tier |
| Workers     | <100K req/day   | free tier |

## Development

```bash
# worker locally (uses miniflare R2)
cd worker && bun run dev

# typecheck everything
cd shared && bun run typecheck
cd worker && bun run typecheck
cd cli    && bun run typecheck
```

## License

MIT.
