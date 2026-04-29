import { readdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { parseVrFilename } from '../../shared/src/parser';
import { probeVideo } from './ffprobe';
import { generateThumbnail } from './thumbnail';
import type { R2Uploader, UploadProgress } from './uploader';
import type { Config } from './config';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.webm']);

export interface UploadOptions {
  /** Skip thumbnail generation. */
  noThumb: boolean;
  /** Re-upload even if R2 already has the file at the same size. */
  force: boolean;
  /** Per-file progress callback. */
  onProgress?: (filename: string, progress: UploadProgress) => void;
  /** Per-file step messages (probe/thumb/upload). */
  onStep?: (filename: string, step: string) => void;
}

export interface UploadResult {
  total: number;
  uploaded: number;
  skipped: number;
  failed: number;
  errors: { filename: string; error: string }[];
}

/**
 * Scan a directory recursively and upload every video file found.
 * Per file: probe → thumbnail → upload video → upload sidecar.
 *
 * Files are processed with `config.upload.file_concurrency` workers. For huge
 * VR files a single worker usually saturates the upstream link; raise this if
 * you have surplus bandwidth and small-ish files.
 */
export async function uploadDirectory(
  uploader: R2Uploader,
  config: Config,
  directory: string,
  options: UploadOptions
): Promise<UploadResult> {
  const files = collectVideos(directory);
  const result: UploadResult = {
    total: files.length,
    uploaded: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  let cursor = 0;
  const fileWorkerCount = Math.max(1, Math.min(config.upload.file_concurrency, files.length));

  const worker = async (): Promise<void> => {
    while (cursor < files.length) {
      const idx = cursor++;
      const filePath = files[idx];
      const filename = basename(filePath);
      try {
        const wasUploaded = await uploadOne(uploader, config, filePath, filename, options);
        if (wasUploaded) result.uploaded++;
        else result.skipped++;
      } catch (err) {
        result.failed++;
        result.errors.push({ filename, error: (err as Error).message });
      }
    }
  };

  await Promise.all(Array.from({ length: fileWorkerCount }, () => worker()));

  return result;
}

/**
 * Upload a single file (any path). Returns true if a video upload happened,
 * false if skipped. Sidecar + thumb are always (re)written if applicable.
 */
export async function uploadFile(
  uploader: R2Uploader,
  config: Config,
  filePath: string,
  options: UploadOptions
): Promise<boolean> {
  const filename = basename(filePath);
  return uploadOne(uploader, config, filePath, filename, options);
}

/**
 * Generate (or regenerate) a thumbnail for an already-uploaded video and
 * push it to R2. Used by `vr-cf thumb` subcommand.
 */
export async function generateAndUploadThumbnail(
  uploader: R2Uploader,
  config: Config,
  filePath: string
): Promise<void> {
  const filename = basename(filePath);
  const meta = parseVrFilename(filename);
  const probe = await probeVideo(filePath).catch(() => ({
    duration: null,
    width: null,
    height: null,
  }));
  const jpeg = await generateThumbnail(filePath, {
    seekSeconds: config.thumbnail.seek_seconds,
    width: config.thumbnail.width,
    quality: config.thumbnail.quality,
    stereoMode: meta.stereoMode,
    duration: probe.duration,
  });
  await uploader.uploadBytes(`thumbs/${filename}.jpg`, jpeg, 'image/jpeg');
}

// ─── internals ────────────────────────────────────────────────────────

async function uploadOne(
  uploader: R2Uploader,
  config: Config,
  filePath: string,
  filename: string,
  options: UploadOptions
): Promise<boolean> {
  const videoKey = `videos/${filename}`;
  const metaKey = `videos/${filename}.meta.json`;
  const thumbKey = `thumbs/${filename}.jpg`;

  options.onStep?.(filename, 'probe');
  const probe = await probeVideo(filePath);
  const parsed = parseVrFilename(filename);

  if (!options.noThumb) {
    options.onStep?.(filename, 'thumb');
    try {
      const jpeg = await generateThumbnail(filePath, {
        seekSeconds: config.thumbnail.seek_seconds,
        width: config.thumbnail.width,
        quality: config.thumbnail.quality,
        stereoMode: parsed.stereoMode,
        duration: probe.duration,
      });
      await uploader.uploadBytes(thumbKey, jpeg, 'image/jpeg');
    } catch (err) {
      // Thumbnail failure shouldn't block the video upload — log and continue.
      options.onStep?.(filename, `thumb skipped: ${(err as Error).message}`);
    }
  }

  options.onStep?.(filename, 'upload');
  const stat = statSync(filePath);
  const sizeBytes = stat.size;

  if (!options.force) {
    const exists = await uploader.exists(videoKey, sizeBytes);
    if (exists) {
      options.onStep?.(filename, 'already on R2 (skipped)');
      // Still refresh sidecar in case parser logic changed.
      await writeSidecar(uploader, metaKey, probe, parsed, sizeBytes);
      return false;
    }
  }

  const wasUploaded = await uploader.uploadFile(
    videoKey,
    filePath,
    contentTypeFor(filename),
    options.onProgress ? (p) => options.onProgress!(filename, p) : undefined
  );

  await writeSidecar(uploader, metaKey, probe, parsed, sizeBytes);
  return wasUploaded;
}

async function writeSidecar(
  uploader: R2Uploader,
  metaKey: string,
  probe: { duration: number | null; width: number | null; height: number | null },
  parsed: ReturnType<typeof parseVrFilename>,
  sizeBytes: number
): Promise<void> {
  const sidecar = {
    duration: probe.duration,
    width: probe.width,
    height: probe.height,
    size: sizeBytes,
    parsed,
  };
  const body = Buffer.from(JSON.stringify(sidecar, null, 2), 'utf-8');
  await uploader.uploadBytes(metaKey, body, 'application/json');
}

/** Walk a directory recursively and collect every supported video file. */
function collectVideos(directory: string): string[] {
  const out: string[] = [];
  const stack: string[] = [directory];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      throw new Error(`failed to read ${dir}: ${(err as Error).message}`);
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile() && VIDEO_EXTENSIONS.has(extname(ent.name).toLowerCase())) {
        out.push(full);
      }
    }
  }

  return out.sort();
}

function contentTypeFor(filename: string): string {
  switch (extname(filename).toLowerCase()) {
    case '.mp4':
      return 'video/mp4';
    case '.mkv':
      return 'video/x-matroska';
    case '.mov':
      return 'video/quicktime';
    case '.webm':
      return 'video/webm';
    default:
      return 'application/octet-stream';
  }
}
