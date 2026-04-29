import { spawn } from 'node:child_process';

/**
 * Subset of metadata extracted via ffprobe. Used for the sidecar
 * `videos/<filename>.meta.json` and to drive thumbnail generation
 * (we need duration to pick a sensible seek time for short clips).
 */
export interface ProbeResult {
  duration: number | null;
  width: number | null;
  height: number | null;
}

/**
 * Run `ffprobe` against a file and return basic stream/format info.
 * Throws if ffprobe is not on PATH or exits non-zero.
 */
export async function probeVideo(filePath: string): Promise<ProbeResult> {
  return new Promise((resolveResult, reject) => {
    const proc = spawn('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-show_entries',
      'format=duration',
      '-of',
      'json',
      filePath,
    ]);

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));

    proc.on('error', (err) => {
      reject(new Error(`ffprobe spawn failed: ${err.message}. Is ffprobe installed?`));
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        const data = JSON.parse(stdout);
        const stream = data.streams?.[0] ?? {};
        const format = data.format ?? {};
        resolveResult({
          duration: format.duration ? parseFloat(format.duration) : null,
          width: stream.width ?? null,
          height: stream.height ?? null,
        });
      } catch (err) {
        reject(new Error(`failed to parse ffprobe output: ${(err as Error).message}`));
      }
    });
  });
}
