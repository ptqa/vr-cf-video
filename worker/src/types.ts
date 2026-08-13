import type { VrMetadata } from '../../shared/src/parser';

/**
 * Worker bindings. Defined in `wrangler.toml`.
 */
export interface Env {
  /** R2 bucket holding videos/, thumbs/. */
  BUCKET: R2Bucket;
  /** Site title shown in the HTML index. */
  SITE_TITLE: string;
  /** Shared password (Worker secret). */
  SHARED_PASSWORD: string;
}

/**
 * Sidecar JSON written by the CLI alongside each uploaded video, at
 * `videos/<filename>.meta.json`. Allows the worker to surface duration and
 * dimensions without running ffprobe at request time.
 */
export interface VideoSidecarMeta {
  /** Seconds. */
  duration: number | null;
  /** Source pixel width (full SBS frame). */
  width: number | null;
  /** Source pixel height. */
  height: number | null;
  /** Bytes. */
  size: number | null;
  /** Cached parser output so worker can skip re-parsing. */
  parsed?: VrMetadata;
}

/**
 * Catalog entry produced by combining R2 listing + parsed filename + sidecar.
 */
export interface CatalogEntry {
  /** Bare filename, used as URL key. e.g. "Sample_Title_2900p_MKX200.mp4" */
  filename: string;
  /** Bytes from R2 listing. */
  size: number;
  /** R2 etag — useful for cache busting if we need it later. */
  etag: string;
  /** Last modified ISO string. */
  uploaded: string;
  /** Parsed VR metadata. */
  vr: VrMetadata;
  /** Optional sidecar info; null if no .meta.json next to the file. */
  sidecar: VideoSidecarMeta | null;
  /** True if a thumb exists in thumbs/<filename>.jpg (best-effort). */
  hasThumb: boolean;
}
