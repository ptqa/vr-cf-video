import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import TOML from 'toml';

export interface Config {
  r2: {
    endpoint: string;
    bucket_name: string;
    access_key_id: string;
    secret_access_key: string;
  };
  worker: {
    url: string;
    shared_password: string;
  };
  thumbnail: {
    seek_seconds: number;
    width: number;
    quality: number;
  };
}

// `homedir()` is cross-platform: `$HOME` on macOS/Linux, `%USERPROFILE%`
// (e.g. `C:\Users\<name>`) on Windows.
const SEARCH_PATHS = [
  () => resolve(process.cwd(), 'vr-cf.toml'),
  () => resolve(process.cwd(), '..', 'vr-cf.toml'),
  () => resolve(homedir(), '.config', 'vr-cf.toml'),
];

const REQUIRED_FIELDS = [
  'r2.endpoint',
  'r2.bucket_name',
  'r2.access_key_id',
  'r2.secret_access_key',
  'worker.url',
  'worker.shared_password',
] as const;

const DEFAULTS: Config['thumbnail'] = {
  seek_seconds: 30,
  width: 640,
  quality: 4,
};

/**
 * Load and validate `vr-cf.toml` from the first matching search path.
 * Throws with a list of attempted paths if no config is found.
 */
export function loadConfig(): Config {
  for (const pathFn of SEARCH_PATHS) {
    const path = pathFn();
    if (!existsSync(path)) continue;

    const raw = readFileSync(path, 'utf-8');
    const parsed = TOML.parse(raw) as Partial<Config>;
    const config = applyDefaults(parsed);
    validate(config, path);
    return config;
  }

  const tried = SEARCH_PATHS.map((fn) => `  - ${fn()}`).join('\n');
  throw new Error(
    `vr-cf.toml not found. Searched:\n${tried}\n\nCopy vr-cf.toml.example to vr-cf.toml and fill it in.`
  );
}

function applyDefaults(parsed: Partial<Config>): Config {
  return {
    r2: {
      endpoint: parsed.r2?.endpoint ?? '',
      bucket_name: parsed.r2?.bucket_name ?? '',
      access_key_id: parsed.r2?.access_key_id ?? '',
      secret_access_key: parsed.r2?.secret_access_key ?? '',
    },
    worker: {
      url: parsed.worker?.url ?? '',
      shared_password: parsed.worker?.shared_password ?? '',
    },
    thumbnail: {
      seek_seconds: parsed.thumbnail?.seek_seconds ?? DEFAULTS.seek_seconds,
      width: parsed.thumbnail?.width ?? DEFAULTS.width,
      quality: parsed.thumbnail?.quality ?? DEFAULTS.quality,
    },
  };
}

function validate(config: Config, path: string): void {
  const missing: string[] = [];
  for (const field of REQUIRED_FIELDS) {
    const [section, key] = field.split('.') as [keyof Config, string];
    const value = (config[section] as Record<string, unknown>)[key];
    if (!value) missing.push(field);
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing required config in ${path}:\n${missing.map((f) => `  - ${f}`).join('\n')}`
    );
  }
}
