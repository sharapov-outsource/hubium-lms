import { ModuleError, msg } from '@hubium/module-sdk';

// H5P packages without the database: what a package's h5p.json says and whether the
// package carries the libraries it needs, and the result an xAPI statement reports.
// Pure, so the server and the tests share them.

export interface H5pInfo {
  title: string;
  mainLibrary: string;
  /** Library folders the content needs ("H5P.MultiChoice-1.16"). */
  libraries: string[];
}

// The file types H5P itself accepts in content and libraries (H5P core's default
// whitelist); anything else in a package is left out.
const ALLOWED = new Set(
  'json png jpg jpeg gif bmp tif tiff svg eot ttf woff woff2 otf webm mp4 ogg mp3 m4a wav txt pdf rtf doc docx xls xlsx ppt pptx odt ods odp xml csv diff patch swf md textile vtt webvtt gltf glb js css'.split(
    ' ',
  ),
);

/** Whether a packaged file is kept: a known type, not hidden, not archive litter. */
export function allowedFile(path: string): boolean {
  const parts = path.split('/');
  if (parts.some((p) => p.startsWith('.') || p === '__MACOSX')) return false;
  const name = parts.at(-1)!;
  const dot = name.lastIndexOf('.');
  return dot > 0 && ALLOWED.has(name.slice(dot + 1).toLowerCase());
}

const folder = (d: { machineName?: unknown; majorVersion?: unknown; minorVersion?: unknown }) =>
  `${String(d.machineName)}-${String(d.majorVersion)}.${String(d.minorVersion)}`;

/**
 * Reads h5p.json and checks the package: its content and the library folder of each
 * preloaded dependency (and of their own dependencies) must be there. Throws what is
 * wrong, in words a teacher can act on.
 */
export function checkPackage(
  files: string[],
  h5pJson: string,
  libraryJson: (dir: string) => string | null,
): H5pInfo {
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(h5pJson) as Record<string, unknown>;
  } catch {
    throw new ModuleError('BAD_REQUEST', msg('mod.h5p.errors.badH5pJson'));
  }
  const mainLibrary = typeof meta.mainLibrary === 'string' ? meta.mainLibrary : '';
  if (!mainLibrary) throw new ModuleError('BAD_REQUEST', msg('mod.h5p.errors.noMainLibrary'));
  if (!files.includes('content/content.json'))
    throw new ModuleError('BAD_REQUEST', msg('mod.h5p.errors.noContentJson'));
  const need = new Set<string>();
  const queue = Array.isArray(meta.preloadedDependencies) ? [...meta.preloadedDependencies] : [];
  while (queue.length) {
    const dep = queue.shift() as Record<string, unknown>;
    if (!dep?.machineName) continue;
    const dir = folder(dep);
    if (need.has(dir)) continue;
    need.add(dir);
    const lib = libraryJson(dir);
    if (lib === null)
      throw new ModuleError('BAD_REQUEST', msg('mod.h5p.errors.missingLibrary', { dir }));
    try {
      const l = JSON.parse(lib) as { preloadedDependencies?: unknown[] };
      queue.push(...(l.preloadedDependencies ?? []));
    } catch {
      throw new ModuleError('BAD_REQUEST', msg('mod.h5p.errors.badLibraryJson', { dir }));
    }
  }
  if (![...need].some((d) => d.startsWith(`${mainLibrary}-`)))
    throw new ModuleError(
      'BAD_REQUEST',
      msg('mod.h5p.errors.mainNotInDependencies', { mainLibrary }),
    );
  return {
    title: typeof meta.title === 'string' ? meta.title.slice(0, 255) : '',
    mainLibrary,
    libraries: [...need],
  };
}

/** Seconds of an ISO 8601 duration ("PT1M2.5S"); null when it is not one. */
export function durationSeconds(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m =
    /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      v,
    );
  if (!m || v === 'P' || v === 'PT') return null;
  const [d, h, min, s] = m.slice(1).map((x) => (x ? Number(x) : 0)) as [
    number,
    number,
    number,
    number,
  ];
  return Math.round(d * 86_400 + h * 3600 + min * 60 + s);
}

export interface Result {
  rawScore: number | null;
  maxScore: number | null;
  /** 0..1 */
  scaled: number | null;
  completion: boolean;
  success: boolean | null;
  durationSec: number | null;
}

/**
 * The result of the whole content from an xAPI statement, as Moodle's H5P activity
 * records it: "completed" or "answered" with a result, and no parent (questions inside a
 * set report on their own; only the set counts). Null for any other statement.
 */
export function resultOf(statement: unknown): Result | null {
  if (!statement || typeof statement !== 'object') return null;
  const s = statement as {
    verb?: { id?: unknown };
    result?: {
      score?: { raw?: unknown; max?: unknown; scaled?: unknown };
      completion?: unknown;
      success?: unknown;
      duration?: unknown;
    };
    context?: { contextActivities?: { parent?: unknown } };
  };
  const verb = typeof s.verb?.id === 'string' ? s.verb.id : '';
  if (!/\/(completed|answered)$/.test(verb) || !s.result) return null;
  const parent = s.context?.contextActivities?.parent;
  if (Array.isArray(parent) ? parent.length : parent) return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const raw = num(s.result.score?.raw);
  const max = num(s.result.score?.max);
  const scaled =
    num(s.result.score?.scaled) ?? (raw !== null && max !== null && max > 0 ? raw / max : null);
  return {
    rawScore: raw,
    maxScore: max,
    scaled: scaled === null ? null : Math.max(0, Math.min(1, scaled)),
    completion: s.result.completion === true || verb.endsWith('/completed'),
    success: typeof s.result.success === 'boolean' ? s.result.success : null,
    durationSec: durationSeconds(s.result.duration),
  };
}

/** The grade (0..1) from a learner's attempts by the grading method. */
export function gradeOf(
  method: 'HIGHEST' | 'AVERAGE' | 'FIRST' | 'LAST',
  scaled: (number | null)[],
) {
  const xs = scaled.filter((x): x is number => x !== null);
  if (!xs.length) return null;
  if (method === 'FIRST') return xs[0]!;
  if (method === 'LAST') return xs[xs.length - 1]!;
  if (method === 'AVERAGE') return xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.max(...xs);
}
