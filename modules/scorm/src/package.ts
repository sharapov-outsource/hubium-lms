import { XMLParser } from 'fast-xml-parser';

// SCORM package handling: manifest parsing, and the mapping between scorm-again's CMI
// JSON and our tracking columns. Unpacking is the SDK's (zip-slip and zip-bomb limits).

export {
  contentTypeFor,
  DEFAULT_LIMITS,
  type ExtractLimits,
  extractZip,
  safeEntryPath,
} from '@hubium/module-sdk/zip';

export interface ManifestSco {
  identifier: string;
  title: string;
  href: string;
  masteryScore: number | null;
}

export interface Manifest {
  version: 'SCORM_12' | 'SCORM_2004';
  title: string;
  scos: ManifestSco[];
}

type Node = Record<string, unknown>;
const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const text = (v: unknown): string =>
  typeof v === 'string' || typeof v === 'number'
    ? String(v).trim()
    : v && typeof v === 'object' && '#text' in v
      ? String((v as Node)['#text']).trim()
      : '';

/** Parses imsmanifest.xml: version, default organization and its launchable items. */
export function parseManifest(xml: string): Manifest {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: true,
  });
  const doc = parser.parse(xml) as Node;
  const manifest = doc.manifest as Node | undefined;
  if (!manifest) throw new Error('imsmanifest.xml has no <manifest>');
  const schemaVersion = text((manifest.metadata as Node | undefined)?.schemaversion);
  const is2004 =
    /2004|CAM 1\.3/i.test(schemaVersion) || /adlcp_v1p3|imscp_v1p1.*2004/i.test(xml.slice(0, 2000));
  const resources = new Map<string, Node>();
  for (const r of arr((manifest.resources as Node | undefined)?.resource as Node | Node[])) {
    resources.set(String(r['@_identifier']), r);
  }
  const orgs = manifest.organizations as Node | undefined;
  const all = arr(orgs?.organization as Node | Node[]);
  const def = String(orgs?.['@_default'] ?? '');
  const org = all.find((o) => o['@_identifier'] === def) ?? all[0];
  const scos: ManifestSco[] = [];
  const walk = (items: Node[]) => {
    for (const item of items) {
      const ref = item['@_identifierref'];
      if (ref && item['@_isvisible'] !== 'false') {
        const res = resources.get(String(ref));
        const href = res?.['@_href'] ? String(res['@_href']) : '';
        if (href) {
          const params = item['@_parameters'] ? String(item['@_parameters']) : '';
          const mastery = text(item.masteryscore);
          scos.push({
            identifier: String(item['@_identifier']),
            title: text(item.title) || String(item['@_identifier']),
            href: params
              ? `${href}${params.startsWith('?') || params.startsWith('#') ? '' : '?'}${params}`
              : href,
            masteryScore: mastery ? Number(mastery) : null,
          });
        }
      }
      walk(arr(item.item as Node | Node[]));
    }
  };
  if (org) walk(arr(org.item as Node | Node[]));
  // packages without organizations: the first SCO resource
  if (!scos.length) {
    const r = [...resources.values()].find((x) => x['@_href']);
    if (r)
      scos.push({
        identifier: String(r['@_identifier']),
        title: 'SCO',
        href: String(r['@_href']),
        masteryScore: null,
      });
  }
  if (!scos.length) throw new Error('The manifest has no launchable items');
  return {
    version: is2004 ? 'SCORM_2004' : 'SCORM_12',
    title: text(org?.title) || scos[0]!.title,
    scos,
  };
}

/** "HHHH:MM:SS.SS" (1.2) or ISO 8601 "PT1H2M3.5S" (2004) → seconds. */
export function durationSeconds(v: unknown): number {
  if (typeof v !== 'string' || !v) return 0;
  const hms = v.match(/^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/);
  if (hms) return Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]);
  const iso = v.match(
    /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/,
  );
  if (!iso) return 0;
  const [, y, mo, d, h, mi, s] = iso.map((x) => Number(x ?? 0));
  return ((((y! * 365 + mo! * 30 + d!) * 24 + h!) * 60 + mi!) * 60 + s!) | 0;
}

const num = (v: unknown) =>
  v === '' || v === undefined || v === null || Number.isNaN(Number(v)) ? null : Number(v);

export interface TrackFields {
  location: string;
  suspendData: string;
  exit: string;
  completionStatus: string;
  successStatus: string;
  scoreRaw: number | null;
  scoreMin: number | null;
  scoreMax: number | null;
  scoreScaled: number | null;
  sessionTimeSec: number;
}

/** Pulls tracking fields from a committed CMI object (`{ cmi: … }` or the cmi itself). */
export function trackFromCmi(version: Manifest['version'], raw: unknown): TrackFields {
  const root = (raw && typeof raw === 'object' && 'cmi' in raw ? (raw as Node).cmi : raw) as Node;
  if (version === 'SCORM_12') {
    const core = (root?.core ?? {}) as Node;
    const score = (core.score ?? {}) as Node;
    const status = String(core.lesson_status ?? 'not attempted');
    return {
      location: String(core.lesson_location ?? ''),
      suspendData: String(root?.suspend_data ?? ''),
      exit: String(core.exit ?? ''),
      completionStatus: status,
      successStatus: status === 'passed' ? 'passed' : status === 'failed' ? 'failed' : 'unknown',
      scoreRaw: num(score.raw),
      scoreMin: num(score.min),
      scoreMax: num(score.max),
      scoreScaled: null,
      sessionTimeSec: durationSeconds(core.session_time),
    };
  }
  const score = (root?.score ?? {}) as Node;
  return {
    location: String(root?.location ?? ''),
    suspendData: String(root?.suspend_data ?? ''),
    exit: String(root?.exit ?? ''),
    completionStatus: String(root?.completion_status ?? 'unknown'),
    successStatus: String(root?.success_status ?? 'unknown'),
    scoreRaw: num(score.raw),
    scoreMin: num(score.min),
    scoreMax: num(score.max),
    scoreScaled: num(score.scaled),
    sessionTimeSec: durationSeconds(root?.session_time),
  };
}

export function isCompleted(t: Pick<TrackFields, 'completionStatus' | 'successStatus'>): boolean {
  return ['completed', 'passed'].includes(t.completionStatus) || t.successStatus === 'passed';
}

/** Score in percent: scaled (2004) first, else raw within min..max (default 0..100). */
export function scorePercent(
  t: Pick<TrackFields, 'scoreRaw' | 'scoreMin' | 'scoreMax' | 'scoreScaled'>,
): number | null {
  if (t.scoreScaled !== null && t.scoreScaled !== undefined)
    return Math.max(0, Math.min(100, t.scoreScaled * 100));
  if (t.scoreRaw === null || t.scoreRaw === undefined) return null;
  const min = t.scoreMin ?? 0;
  const max = t.scoreMax ?? 100;
  if (max <= min) return null;
  return Math.max(0, Math.min(100, ((t.scoreRaw - min) / (max - min)) * 100));
}

const fmt12 = (sec: number) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(4, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

/** Initial CMI for scorm-again's loadFromJSON: learner, resume data, previous results. */
export function initialCmi(
  version: Manifest['version'],
  learner: { id: string; name: string },
  t: (Omit<TrackFields, 'sessionTimeSec'> & { totalTimeSec: number }) | null,
  opts: { masteryScore?: number | null; review?: boolean } = {},
): Record<string, unknown> {
  const resume = !!t && t.exit === 'suspend';
  if (version === 'SCORM_12') {
    return {
      core: {
        student_id: learner.id,
        student_name: learner.name,
        lesson_location: resume ? t.location : '',
        lesson_status: t?.completionStatus ?? 'not attempted',
        entry: resume ? 'resume' : t ? '' : 'ab-initio',
        credit: opts.review ? 'no-credit' : 'credit',
        lesson_mode: opts.review ? 'review' : 'normal',
        total_time: fmt12(t?.totalTimeSec ?? 0),
        score: t?.scoreRaw !== null && t?.scoreRaw !== undefined ? { raw: String(t.scoreRaw) } : {},
      },
      suspend_data: resume ? t.suspendData : '',
      ...(opts.masteryScore !== null && opts.masteryScore !== undefined
        ? { student_data: { mastery_score: String(opts.masteryScore) } }
        : {}),
    };
  }
  return {
    learner_id: learner.id,
    learner_name: learner.name,
    location: resume ? t.location : '',
    suspend_data: resume ? t.suspendData : '',
    completion_status: t?.completionStatus ?? 'unknown',
    success_status: t?.successStatus ?? 'unknown',
    entry: resume ? 'resume' : t ? '' : 'ab-initio',
    credit: opts.review ? 'no-credit' : 'credit',
    mode: opts.review ? 'review' : 'normal',
    total_time: `PT${t?.totalTimeSec ?? 0}S`,
  };
}
