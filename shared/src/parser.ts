/**
 * Parse VR-video filenames into structured metadata.
 *
 * Filename conventions encode:
 * - Studio prefix (e.g. "STUDIO_A_", "STUDIO-B-")
 * - Resolution (e.g. "2900p", "4096p", "8K", "vrdesktophd")
 * - Projection (e.g. "MKX200", "180x180", "fisheye")
 * - Stereo mode (e.g. "_LR", "_TB", "3dh")
 *
 * Output is best-effort: missing fields are returned null. Title falls back to
 * the cleaned filename minus extension if no studio is detected.
 *
 * Used by both worker (catalog rendering) and CLI (R2 key + thumb generation).
 */
export type StereoMode = 'sbs' | 'tb' | 'off';

export type Projection =
  | 'equirect-180'
  | 'equirect-360'
  | 'mkx200'
  | 'mkx220'
  | 'rf52'
  | 'fisheye'
  | 'flat';

/** Maps to DeoVR's `screenType` field. */
export const screenTypeForDeovr: Record<Projection, string> = {
  'equirect-180': 'dome',
  'equirect-360': 'sphere',
  mkx200: 'mkx200',
  mkx220: 'mkx220',
  rf52: 'rf52',
  fisheye: 'fisheye',
  flat: 'flat',
};

export interface VrMetadata {
  /** Original filename including extension. R2 object key suffix. */
  filename: string;
  /** Best-effort human-friendly title. */
  title: string;
  /** Detected studio (canonical short name) or null. */
  studio: string | null;
  /** Vertical resolution in pixels, e.g. 2900, 4096, 4320. Null if unknown. */
  resolution: number | null;
  /** Display label like "8K", "2900p", "1080p". */
  resolutionLabel: string | null;
  /** Projection geometry. Defaults to equirect-180 (most common in VR). */
  projection: Projection;
  /** Field of view in degrees, derived from projection. */
  fov: number;
  /** Stereo mode. Defaults to sbs (most VR files are SBS). */
  stereoMode: StereoMode;
  /** True if not flat/mono. */
  is3d: boolean;
}

interface StudioMatcher {
  /** Canonical short label. */
  studio: string;
  /** Detection regex; must match start of filename. */
  pattern: RegExp;
}

/**
 * Studio detection. Order matters — more specific patterns first.
 * Short prefix codes handled last so longer matches win.
 */
const STUDIO_MATCHERS: StudioMatcher[] = [
  { studio: 'NaughtyAmericaVR', pattern: /^NaughtyAmericaVR\b/i },
  { studio: 'VirtualRealPorn', pattern: /^VirtualRealPorn[_-]/i },
  { studio: 'VRBangers', pattern: /^VRBANGERS[_-]/i },
  { studio: 'WankzVR', pattern: /^wankzvr[_-]/i },
  { studio: 'SLR', pattern: /^SLR[_-]/i },
  { studio: 'Manny S (SLR)', pattern: /^Manny_S[_-]/i },
  // NaughtyAmerica internal short codes — keep last so longer matches win.
  // Lookahead so we don't consume the first letter of the title fragment.
  { studio: 'NaughtyAmerica', pattern: /^(?:nam|naw|tdrm|tspa|ptgs)(?=[a-z])/i },
];

/** Tag tokens that are NOT part of the title — used to trim noise. */
const TAG_TOKENS = [
  // Resolution
  /^\d{3,4}p$/i,
  /^[2468]K$/i,
  /^4096p$/,
  // Projection
  /^MKX200$/i,
  /^MKX220$/i,
  /^RF52$/i,
  /^FISHEYE$/i,
  /^180x180$/i,
  /^360x180$/i,
  /^180$/,
  /^360$/,
  // Stereo
  /^LR$/i,
  /^TB$/i,
  /^OU$/i,
  /^SBS$/i,
  /^3dh$/i,
  /^3dv$/i,
  /^mono$/i,
  // Codecs / containers / generic
  /^vr265$/i,
  /^vrdesktophd$/i,
  /^8kvr265$/i,
  /^6kvr265$/i,
  /^4kvr265$/i,
  // numeric scene IDs (e.g. 31956)
  /^\d{4,6}$/,
];

function isTagToken(token: string): boolean {
  return TAG_TOKENS.some((re) => re.test(token));
}

/** Extract resolution number + label from filename. */
function detectResolution(filename: string): { resolution: number | null; label: string | null } {
  // Numeric "{num}p" wins over keyword "8K" since it's more specific.
  const px = filename.match(/(\d{3,4})p/i);
  if (px) {
    const n = parseInt(px[1], 10);
    return { resolution: n, label: `${n}p` };
  }

  // VR keyword shortcuts. Approximate vertical pixels.
  if (/8kvr265|_8K(_|\b)|8K_/i.test(filename)) return { resolution: 4320, label: '8K' };
  if (/6kvr265|_6K(_|\b)|6K_/i.test(filename)) return { resolution: 3160, label: '6K' };
  if (/_4K(_|\b)|4K_|4kvr265/i.test(filename)) return { resolution: 2160, label: '4K' };
  if (/_2K(_|\b)|2K_/i.test(filename)) return { resolution: 1440, label: '2K' };
  if (/vrdesktophd/i.test(filename)) return { resolution: 1080, label: 'HD' };

  return { resolution: null, label: null };
}

/** Detect projection geometry from filename keywords. */
function detectProjection(filename: string): { projection: Projection; fov: number } {
  if (/MKX200/i.test(filename)) return { projection: 'mkx200', fov: 200 };
  if (/MKX220/i.test(filename)) return { projection: 'mkx220', fov: 220 };
  if (/RF52/i.test(filename)) return { projection: 'rf52', fov: 190 };
  if (/FISHEYE/i.test(filename)) return { projection: 'fisheye', fov: 180 };
  if (/(?:^|[_\-])360(?:[_\-.]|$)|360x180/i.test(filename)) {
    return { projection: 'equirect-360', fov: 360 };
  }
  // Default for VR content: equirect-180.
  return { projection: 'equirect-180', fov: 180 };
}

/** Detect stereo layout from filename hints. */
function detectStereoMode(filename: string): StereoMode {
  if (/(?:^|[_\-])mono(?:[_\-.]|$)|(?:^|[_\-])2D(?:[_\-.]|$)/i.test(filename)) return 'off';
  if (/(?:^|[_\-])(?:TB|OU|3dv)(?:[_\-.]|$)/i.test(filename)) return 'tb';
  // sbs is the safe default for VR content; LR/3dh confirms it.
  return 'sbs';
}

/** Detect studio prefix; return matcher and the trimmed remainder. */
function detectStudio(stem: string): { studio: string | null; remainder: string } {
  for (const m of STUDIO_MATCHERS) {
    const match = stem.match(m.pattern);
    if (match) {
      const remainder = stem.slice(match[0].length).replace(/^[_\-\s]+/, '');
      return { studio: m.studio, remainder };
    }
  }
  return { studio: null, remainder: stem };
}

/**
 * Extract a human-readable title from the filename remainder (post-studio).
 *
 * Strategy: split on `_` and `-`, drop tag tokens (resolution, projection,
 * stereo), join the rest with spaces. If everything looks like tags or short
 * codes, return the original cleaned stem so we always have something.
 */
function extractTitle(remainder: string, fullStem: string): string {
  if (!remainder) return fullStem;

  // Split on underscores or runs of dashes/spaces, but preserve internal spaces.
  const tokens = remainder.split(/[_]+|\s*-\s*/).filter(Boolean);
  const titleTokens = tokens.filter((t) => !isTagToken(t));

  if (titleTokens.length === 0) {
    // Everything was a tag — fall back to the un-trimmed remainder.
    return remainder.replace(/[_]+/g, ' ').trim() || fullStem;
  }

  return titleTokens.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Parse a VR video filename into structured metadata.
 *
 * @param filename Object key suffix, e.g. "Sample_Title_2900p_MKX200.mp4"
 */
export function parseVrFilename(filename: string): VrMetadata {
  // Strip extension for analysis but keep the original for the `filename` field.
  const stem = filename.replace(/\.[a-z0-9]+$/i, '');

  const { studio, remainder } = detectStudio(stem);
  const { resolution, label } = detectResolution(filename);
  const { projection, fov } = detectProjection(filename);
  const stereoMode = detectStereoMode(filename);
  const title = extractTitle(remainder, stem);

  return {
    filename,
    title,
    studio,
    resolution,
    resolutionLabel: label,
    projection,
    fov,
    stereoMode,
    is3d: stereoMode !== 'off',
  };
}
