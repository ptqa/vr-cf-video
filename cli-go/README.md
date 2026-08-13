# vr-cf-go

Go port of `../cli` — same `vr-cf` commands, no Bun required. Single static binary.

## Install

Requires Go ≥ 1.22 and `ffmpeg` + `ffprobe` on `PATH` (same as Bun CLI).

```bash
cd cli-go
go build -o vr-cf ./cmd/vr-cf
# or install to $GOPATH/bin:
go install ./cmd/vr-cf
./vr-cf --help
```

## Config

Same `vr-cf.toml` as Bun CLI, same search order:

1. `./vr-cf.toml`
2. `../vr-cf.toml`
3. `~/.config/vr-cf.toml` (Windows: `%USERPROFILE%\.config\vr-cf.toml`)

```bash
cp vr-cf.toml.example vr-cf.toml
# edit endpoints / keys / worker url
```

## Commands (parity with `cli/`)

```
vr-cf upload <path>           upload file or directory (recurses)
vr-cf upload <path> --no-thumb     skip thumbnail generation
vr-cf upload <path> --force        re-upload even if R2 has same size

vr-cf list                    list R2 contents with parsed metadata
vr-cf delete <filename>       remove video + sidecar + thumb from R2
vr-cf thumb <localFile>       regenerate thumbnail from local file
vr-cf refresh                 invalidate worker catalog cache
vr-cf stats                   total size, count, by studio
```

All paths except `thumb` accept R2 keys exactly as stored (`videos/<filename>` suffix).
`thumb` takes a local path like the TS `thumb <localFile>`.

## Differences from Bun CLI

- Progress bar is a lightweight `\r` renderer (same `filename | bar | % | speed | step` layout) instead of `cli-progress`.
- No `toml` npm dep — uses `github.com/BurntSushi/toml`.
- S3 client via `aws-sdk-go-v2` with same endpoint/region (`auto`) and multipart settings (50 MB parts × 3 concurrent, 100 MB threshold).

## Layout

```
cli-go/
  cmd/vr-cf/main.go          cobra entry + commands + progress + refresh
  internal/config/config.go  TOML loader + search + validation + defaults
  internal/parser/parser.go  VR filename → metadata (port of shared/src/parser.ts)
  internal/ffprobe/ffprobe.go  ffprobe spawn + JSON parse
  internal/thumbnail/thumbnail.go  ffmpeg single-eye crop
  internal/uploader/uploader.go    R2 S3 + multipart
  internal/scanner/scanner.go      walk + probe + thumb + upload
```
