#!/usr/bin/env bun
/**
 * vr-cf — local-disk → Cloudflare R2 uploader for the VR video library.
 *
 * Commands:
 *   vr-cf upload <path>           upload a file or directory to R2
 *   vr-cf list                    list R2 contents with parsed VR metadata
 *   vr-cf delete <filename>       delete video + sidecar + thumbnail
 *   vr-cf thumb <filename>        regenerate a thumbnail for an existing video
 *   vr-cf refresh                 invalidate the worker's catalog cache
 *   vr-cf stats                   print library size + counts
 *
 * Cross-platform: tested on macOS/Linux. On Windows you need:
 *   - Bun ≥ 1.1
 *   - ffmpeg + ffprobe on PATH (`winget install Gyan.FFmpeg`)
 */
import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import cliProgress from 'cli-progress';
import { Command } from 'commander';
import { loadConfig } from './config';
import { generateAndUploadThumbnail, uploadDirectory, uploadFile } from './scanner';
import { R2Uploader } from './uploader';
import { ListObjectsV2Command, S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { parseVrFilename } from '../../shared/src/parser';

const program = new Command();

program
  .name('vr-cf')
  .description('Upload + manage VR videos for vr-cf-video on Cloudflare')
  .version('0.1.0');

program
  .command('upload <path>')
  .description('Upload a single file or every video in a directory')
  .option('--no-thumb', 'Skip thumbnail generation')
  .option('--force', 'Re-upload even if R2 already has the same-size file')
  .action(async (path: string, opts: { thumb: boolean; force: boolean }) => {
    const config = loadConfig();
    const uploader = new R2Uploader(config);
    const target = resolve(path);

    if (!existsSync(target)) {
      console.error(`path not found: ${target}`);
      process.exit(1);
    }

    const stat = statSync(target);
    const isDir = stat.isDirectory();

    const bar = new cliProgress.SingleBar(
      {
        format: '  {filename} | {bar} {percentage}% | {speed} | {step}',
        barCompleteChar: '█',
        barIncompleteChar: '░',
        hideCursor: true,
      },
      cliProgress.Presets.shades_classic
    );

    if (isDir) {
      console.log(`Scanning ${target}…`);
      const result = await uploadDirectory(uploader, config, target, {
        noThumb: !opts.thumb,
        force: opts.force ?? false,
        onStep: (filename, step) => {
          bar.update({ filename: short(filename), step });
        },
        onProgress: (filename, p) => {
          if (!bar.isActive) {
            bar.start(100, p.percent, {
              filename: short(filename),
              speed: formatSpeed(p.bytesPerSecond),
              step: 'upload',
            });
          } else {
            bar.update(p.percent, {
              filename: short(filename),
              speed: formatSpeed(p.bytesPerSecond),
              step: 'upload',
            });
          }
          if (p.percent >= 100) bar.stop();
        },
      });

      console.log('\n--- Done ---');
      console.log(`  Total:    ${result.total}`);
      console.log(`  Uploaded: ${result.uploaded}`);
      console.log(`  Skipped:  ${result.skipped}`);
      console.log(`  Failed:   ${result.failed}`);
      if (result.errors.length > 0) {
        console.log('\nErrors:');
        for (const e of result.errors) console.log(`  ${e.filename}: ${e.error}`);
      }
      await refreshWorkerCatalog(config);
    } else {
      console.log(`Uploading ${target}…`);
      const filename = basename(target);
      bar.start(100, 0, {
        filename: short(filename),
        speed: '—',
        step: 'starting',
      });
      const wasUploaded = await uploadFile(uploader, config, target, {
        noThumb: !opts.thumb,
        force: opts.force ?? false,
        onStep: (_, step) => {
          bar.update({ filename: short(filename), step });
        },
        onProgress: (_, p) => {
          bar.update(p.percent, {
            filename: short(filename),
            speed: formatSpeed(p.bytesPerSecond),
            step: 'upload',
          });
        },
      });
      bar.stop();
      console.log(wasUploaded ? '✓ uploaded' : '✓ already on R2 (skipped)');
      await refreshWorkerCatalog(config);
    }
  });

program
  .command('list')
  .description('List videos in R2 with parsed metadata')
  .action(async () => {
    const config = loadConfig();
    const client = makeS3Client(config);
    const objects = await listAllVideos(client, config.r2.bucket_name);

    if (objects.length === 0) {
      console.log('(empty)');
      return;
    }

    console.log(`${objects.length} videos:\n`);
    for (const obj of objects) {
      const filename = obj.Key!.slice('videos/'.length);
      const m = parseVrFilename(filename);
      const sizeGB = ((obj.Size ?? 0) / 1024 / 1024 / 1024).toFixed(2);
      const tags = [m.studio, m.resolutionLabel, `${m.fov}°`].filter(Boolean).join(' · ');
      console.log(`  ${filename}`);
      console.log(`    ${m.title}  [${tags}]  ${sizeGB} GB`);
    }
  });

program
  .command('delete <filename>')
  .description('Delete a video + its sidecar + thumbnail from R2')
  .action(async (filename: string) => {
    const config = loadConfig();
    const client = makeS3Client(config);
    const keys = [`videos/${filename}`, `videos/${filename}.meta.json`, `thumbs/${filename}.jpg`];
    for (const key of keys) {
      try {
        await client.send(
          new DeleteObjectCommand({ Bucket: config.r2.bucket_name, Key: key })
        );
        console.log(`  deleted: ${key}`);
      } catch (err) {
        console.warn(`  not found: ${key} (${(err as Error).message})`);
      }
    }
    await refreshWorkerCatalog(config);
  });

program
  .command('thumb <localFile>')
  .description('Regenerate a thumbnail from a local video file (uploads to thumbs/)')
  .action(async (localFile: string) => {
    const config = loadConfig();
    const uploader = new R2Uploader(config);
    const target = resolve(localFile);
    if (!existsSync(target)) {
      console.error(`file not found: ${target}`);
      process.exit(1);
    }
    console.log(`Generating thumbnail for ${basename(target)}…`);
    await generateAndUploadThumbnail(uploader, config, target);
    console.log('✓ uploaded thumbnail');
    await refreshWorkerCatalog(config);
  });

program
  .command('refresh')
  .description('Invalidate the worker catalog cache')
  .action(async () => {
    const config = loadConfig();
    await refreshWorkerCatalog(config);
  });

program
  .command('stats')
  .description('Print library statistics')
  .action(async () => {
    const config = loadConfig();
    const client = makeS3Client(config);
    const objects = await listAllVideos(client, config.r2.bucket_name);
    const totalBytes = objects.reduce((sum, o) => sum + (o.Size ?? 0), 0);
    const byStudio = new Map<string, number>();
    for (const obj of objects) {
      const filename = obj.Key!.slice('videos/'.length);
      const studio = parseVrFilename(filename).studio ?? 'Unknown';
      byStudio.set(studio, (byStudio.get(studio) ?? 0) + 1);
    }
    console.log(`Videos: ${objects.length}`);
    console.log(`Total:  ${(totalBytes / 1024 / 1024 / 1024).toFixed(2)} GB`);
    console.log('\nBy studio:');
    for (const [studio, count] of [...byStudio.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${studio.padEnd(24)} ${count}`);
    }
  });

program.parseAsync().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

// ─── helpers ─────────────────────────────────────────────────────────

function makeS3Client(config: ReturnType<typeof loadConfig>): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: config.r2.endpoint,
    credentials: {
      accessKeyId: config.r2.access_key_id,
      secretAccessKey: config.r2.secret_access_key,
    },
  });
}

async function listAllVideos(
  client: S3Client,
  bucket: string
): Promise<{ Key?: string; Size?: number }[]> {
  const out: { Key?: string; Size?: number }[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: 'videos/',
        ContinuationToken: token,
        MaxKeys: 1000,
      })
    );
    for (const obj of page.Contents ?? []) {
      const key = obj.Key ?? '';
      if (!key.endsWith('.meta.json') && key !== 'videos/') {
        out.push(obj);
      }
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return out;
}

async function refreshWorkerCatalog(config: ReturnType<typeof loadConfig>): Promise<void> {
  try {
    const url = new URL('/admin/refresh', config.worker.url);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`vr-cf:${config.worker.shared_password}`)}`,
      },
    });
    if (!res.ok) {
      console.warn(`worker refresh failed: ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    console.warn(`worker refresh failed: ${(err as Error).message}`);
  }
}

function short(filename: string): string {
  return filename.length > 40 ? `${filename.slice(0, 37)}…` : filename.padEnd(40);
}

function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond <= 0) return '—';
  const mb = bytesPerSecond / 1024 / 1024;
  return `${mb.toFixed(1)} MB/s`;
}
