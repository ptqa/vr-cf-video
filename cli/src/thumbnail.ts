import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StereoMode } from '../../shared/src/parser';

/**
 * Extract a single-frame JPEG thumbnail from a video using ffmpeg.
 *
 * Strategy:
 * - Seek to {@link seekSeconds} (defaults to 30s; falls back to 5s for
 *   shorter clips so we don't end up past EOF).
 * - Crop to the appropriate "single eye" half based on the parsed stereo
 *   mode (LR → left half, TB → top half, mono → no crop).
 * - Scale to a fixed pixel width preserving aspect ratio.
 * - Re-encode as JPEG at the requested quality.
 *
 * We use a temp file rather than ffmpeg's stdout pipe because ffmpeg's mjpeg
 * muxer is finicky about pipe output and JPEG framing.
 */
export interface ThumbnailOptions {
  seekSeconds: number;
  width: number;
  /** ffmpeg `-q:v` value: 1 = best, 31 = worst. */
  quality: number;
  /** Stereo layout from the filename parser. */
  stereoMode: StereoMode;
  /** Optional video duration (seconds) so we can clamp seek time. */
  duration?: number | null;
}

export async function generateThumbnail(
  videoPath: string,
  options: ThumbnailOptions
): Promise<Buffer> {
  const seek = clampSeek(options.seekSeconds, options.duration);
  const tempDir = mkdtempSync(join(tmpdir(), 'vr-cf-thumb-'));
  const outPath = join(tempDir, 'thumb.jpg');

  try {
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      String(seek),
      '-i',
      videoPath,
      '-vframes',
      '1',
      '-vf',
      buildFilter(options),
      '-q:v',
      String(options.quality),
      '-y',
      outPath,
    ];

    await runFfmpeg(args);
    return readFileSync(outPath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Build the ffmpeg `-vf` filter chain.
 *
 * For SBS (`sbs`) stereo we crop the left half (`crop=in_w/2:in_h:0:0`).
 * For top-bottom (`tb`) we crop the top half (`crop=in_w:in_h/2:0:0`).
 * For `off` (mono) we keep the full frame.
 *
 * Then scale to `width` keeping aspect ratio (`-1` preserves aspect, the `-2`
 * variant ensures even height which JPEG/h264 muxers prefer).
 */
function buildFilter(options: ThumbnailOptions): string {
  const filters: string[] = [];
  switch (options.stereoMode) {
    case 'sbs':
      filters.push('crop=in_w/2:in_h:0:0');
      break;
    case 'tb':
      filters.push('crop=in_w:in_h/2:0:0');
      break;
    case 'off':
      // no-op
      break;
  }
  filters.push(`scale=${options.width}:-2`);
  return filters.join(',');
}

function clampSeek(requestedSeek: number, duration?: number | null): number {
  if (duration && duration > 0 && requestedSeek > duration - 2) {
    return Math.max(1, Math.floor(duration / 4));
  }
  return Math.max(0, requestedSeek);
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));

    proc.on('error', (err) => {
      reject(new Error(`ffmpeg spawn failed: ${err.message}. Is ffmpeg installed?`));
    });

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim() || 'unknown error'}`));
    });
  });
}
