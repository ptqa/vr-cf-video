# vr-cf-video Agent Guidelines

## Project overview

Serverless VR video streaming on Cloudflare Workers + R2. Implements the
DeoVR JSON catalog API so headset apps (DeoVR, HereSphere, Pigasus) auto-
discover the library, plus a responsive HTML tile-grid index for browsers.

See `PLAN.md` for full architecture and `README.md` for setup.

Reference project (same author, similar stack): `../cf-video/` —
Jellyfin-on-Cloudflare. Reuse patterns: worker layout, S3 multipart uploader,
wrangler config, Bun CLI w/ commander.

## Layout

- `legacy/` — original nginx + DeoVR-bundle.js static-pages setup. Reference
  only. Don't modify.
- `shared/src/` — code shared between worker and CLI (filename parser).
- `worker/` — Cloudflare Worker (TypeScript, wrangler).
- `cli/` — Bun CLI for upload + thumb generation.

## Conventions

- TypeScript everywhere, `"type": "module"`.
- Idiomatic, full explanatory variable names. Smaller files over larger.
- No D1, no KV, no DO. R2 is the only state. Filename is the source of truth.
- Catalog cached in `caches.default` for 5 min; CLI invalidates via
  `POST /admin/refresh`.
- All Worker paths except `/healthz` require shared-password auth (HTTP Basic
  or `?t=<password>` query).
- R2 layout:
  ```
  videos/<filename>.mp4
  videos/<filename>.mp4.meta.json   # { duration, width, height, parsed }
  thumbs/<filename>.mp4.jpg
  ```
- Object key passed to URLs is the bare filename (URL-encoded), e.g.
  `/v/Sample_Title_2900p_MKX200.mp4`.

## Tooling

- ASDF for runtime versions where applicable.
- `bun` for CLI install/run/build (per cf-video pattern).
- `wrangler` for worker dev/deploy.
- `ffmpeg` + `ffprobe` required on the host running the CLI.

## Don't

- Don't put secrets in code or git. `wrangler secret put` for worker secrets,
  `vr-cf.toml` (gitignored) for CLI.
- Don't add a database. If we need indexed search at scale, switch to KV or
  embedded JSON manifest before D1.
- Don't transcode in worker. Workers can't run ffmpeg.
- Don't break the legacy `8k.ptqa.xyz` URL scheme until migration is verified
  on a headset.
