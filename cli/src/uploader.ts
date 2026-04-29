import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import type { Config } from './config';

/**
 * R2 upload client built on the S3-compatible API.
 *
 * - Files <100MB go via single-part `PutObject`.
 * - Larger files use multipart upload with concurrent part uploads.
 * - Parts are streamed from disk (no full-file buffering) — important for
 *   30–50GB VR videos.
 */
export interface UploadProgress {
  loaded: number;
  total: number;
  percent: number;
  bytesPerSecond: number;
}

const PART_SIZE_BYTES = 50 * 1024 * 1024; // 50MB
const PART_CONCURRENCY = 3;
const MULTIPART_THRESHOLD_BYTES = 100 * 1024 * 1024;

export class R2Uploader {
  private readonly client: S3Client;
  private readonly bucketName: string;

  constructor(config: Config) {
    this.bucketName = config.r2.bucket_name;
    this.client = new S3Client({
      region: 'auto',
      endpoint: config.r2.endpoint,
      credentials: {
        accessKeyId: config.r2.access_key_id,
        secretAccessKey: config.r2.secret_access_key,
      },
    });
  }

  /** True if an object with the exact byte size already exists. */
  async exists(key: string, expectedSize?: number): Promise<boolean> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucketName, Key: key })
      );
      if (expectedSize === undefined) return true;
      return result.ContentLength === expectedSize;
    } catch {
      return false;
    }
  }

  /**
   * Upload a file from disk, with progress callbacks. Returns false if the
   * object already exists with the same size (no-op skip).
   */
  async uploadFile(
    key: string,
    filePath: string,
    contentType: string,
    onProgress?: (p: UploadProgress) => void
  ): Promise<boolean> {
    const fileInfo = await stat(filePath);
    const fileSize = fileInfo.size;

    if (await this.exists(key, fileSize)) return false;

    if (fileSize < MULTIPART_THRESHOLD_BYTES) {
      await this.uploadSinglePart(key, filePath, fileSize, contentType, onProgress);
    } else {
      await this.uploadMultipart(key, filePath, fileSize, contentType, onProgress);
    }
    return true;
  }

  /** Upload an in-memory buffer (used for thumbnails, sidecar JSON). */
  async uploadBytes(key: string, body: Buffer | Uint8Array, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.byteLength,
      })
    );
  }

  /** Delete a single key. */
  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: key }));
  }

  // ─── private helpers ──────────────────────────────────────────────

  private async uploadSinglePart(
    key: string,
    filePath: string,
    fileSize: number,
    contentType: string,
    onProgress?: (p: UploadProgress) => void
  ): Promise<void> {
    const startMs = Date.now();
    onProgress?.({ loaded: 0, total: fileSize, percent: 0, bytesPerSecond: 0 });

    const body = await readRange(filePath, 0, fileSize);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: fileSize,
      })
    );

    const elapsedSec = (Date.now() - startMs) / 1000;
    onProgress?.({
      loaded: fileSize,
      total: fileSize,
      percent: 100,
      bytesPerSecond: elapsedSec > 0 ? fileSize / elapsedSec : 0,
    });
  }

  private async uploadMultipart(
    key: string,
    filePath: string,
    fileSize: number,
    contentType: string,
    onProgress?: (p: UploadProgress) => void
  ): Promise<void> {
    const create = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucketName,
        Key: key,
        ContentType: contentType,
      })
    );
    const uploadId = create.UploadId;
    if (!uploadId) throw new Error('no upload id returned by R2');

    const parts: { ETag: string; PartNumber: number }[] = [];
    let uploadedBytes = 0;
    let lastReportedBytes = 0;
    let lastReportMs = Date.now();

    const reportProgress = () => {
      if (!onProgress) return;
      const now = Date.now();
      const dt = (now - lastReportMs) / 1000;
      let bps = 0;
      if (dt > 0.1) {
        bps = (uploadedBytes - lastReportedBytes) / dt;
        lastReportedBytes = uploadedBytes;
        lastReportMs = now;
      }
      onProgress({
        loaded: uploadedBytes,
        total: fileSize,
        percent: Math.round((uploadedBytes / fileSize) * 100),
        bytesPerSecond: bps,
      });
    };

    const partCount = Math.ceil(fileSize / PART_SIZE_BYTES);
    const partDefs = Array.from({ length: partCount }, (_, i) => ({
      partNumber: i + 1,
      offset: i * PART_SIZE_BYTES,
      length: Math.min(PART_SIZE_BYTES, fileSize - i * PART_SIZE_BYTES),
    }));

    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < partDefs.length) {
        const idx = cursor++;
        const def = partDefs[idx];
        const buffer = await readRange(filePath, def.offset, def.length);

        const result = await this.client.send(
          new UploadPartCommand({
            Bucket: this.bucketName,
            Key: key,
            UploadId: uploadId,
            PartNumber: def.partNumber,
            Body: buffer,
            ContentLength: def.length,
          })
        );

        if (!result.ETag) throw new Error(`no ETag for part ${def.partNumber}`);
        parts.push({ ETag: result.ETag, PartNumber: def.partNumber });
        uploadedBytes += def.length;
        reportProgress();
      }
    };

    try {
      await Promise.all(
        Array.from({ length: Math.min(PART_CONCURRENCY, partCount) }, () => worker())
      );

      parts.sort((a, b) => a.PartNumber - b.PartNumber);

      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucketName,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts },
        })
      );
      onProgress?.({ loaded: fileSize, total: fileSize, percent: 100, bytesPerSecond: 0 });
    } catch (err) {
      try {
        await this.client.send(
          new AbortMultipartUploadCommand({
            Bucket: this.bucketName,
            Key: key,
            UploadId: uploadId,
          })
        );
      } catch {
        // ignore — original error is more useful
      }
      throw err;
    }
  }
}

/** Read [offset, offset+length) from disk as a Buffer. */
function readRange(filePath: string, offset: number, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(filePath, { start: offset, end: offset + length - 1 });
    stream.on('data', (chunk: string | Buffer) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
