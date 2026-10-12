// Pure helpers for mod-video: watched intervals, the HLS ladder, ffmpeg arguments,
// caption conversion, thumbnail sprites and embed URLs.

export type Interval = [number, number];

/** Merges intervals (seconds), clamped to [0, duration]; drops empty ones. */
export function mergeIntervals(list: Interval[], duration = Number.POSITIVE_INFINITY): Interval[] {
  const clean = list
    .map(([a, b]) => [Math.max(0, Math.min(a, b)), Math.min(duration, Math.max(a, b))] as Interval)
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .sort((x, y) => x[0] - y[0]);
  const out: Interval[] = [];
  for (const [a, b] of clean) {
    const last = out.at(-1);
    // tolerate sub-second gaps from timeupdate granularity
    if (last && a <= last[1] + 0.5) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * Adds reported intervals to what was already watched, but no more new seconds than
 * `budget`: a client cannot claim more watching than the time that has passed.
 */
export function addWatched(
  base: Interval[],
  incoming: Interval[],
  budget: number,
  duration?: number,
): Interval[] {
  let out = mergeIntervals(base, duration);
  let left = Math.max(0, budget);
  for (const [s, e] of mergeIntervals(incoming, duration)) {
    const covered = coveredSeconds(out);
    const gain = (end: number) =>
      coveredSeconds(mergeIntervals([...out, [s, end]], duration)) - covered;
    if (gain(e) <= left) {
      left -= gain(e);
      out = mergeIntervals([...out, [s, e]], duration);
      continue;
    }
    let lo = s;
    let hi = e;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (gain(mid) <= left) lo = mid;
      else hi = mid;
    }
    if (lo > s) out = mergeIntervals([...out, [s, lo]], duration);
    break;
  }
  return out;
}

export function coveredSeconds(list: Interval[]): number {
  return list.reduce((s, [a, b]) => s + (b - a), 0);
}

export function watchPercent(list: Interval[], duration: number): number {
  if (!duration || duration <= 0) return 0;
  return Math.min(100, Math.round((coveredSeconds(list) / duration) * 1000) / 10);
}

export interface Rendition {
  height: number;
  /** Video bitrate, bits per second. */
  bandwidth: number;
}

const LADDER: Rendition[] = [
  { height: 360, bandwidth: 800_000 },
  { height: 720, bandwidth: 2_800_000 },
  { height: 1080, bandwidth: 5_000_000 },
];

/** Ladder capped at the source height (never upscales; tiny sources get one rung). */
export function ladderFor(sourceHeight: number): Rendition[] {
  const fit = LADDER.filter((r) => r.height <= sourceHeight);
  if (fit.length) return fit;
  const h = Math.max(2, sourceHeight - (sourceHeight % 2));
  return [{ height: h, bandwidth: 600_000 }];
}

export const SEGMENT_SECONDS = 6;

/** ffmpeg arguments for an fMP4 HLS ladder with a master playlist. */
export function hlsArgs(opts: {
  input: string;
  outDir: string;
  ladder: Rendition[];
  hasAudio: boolean;
}): string[] {
  const n = opts.ladder.length;
  const split = `[0:v]split=${n}${opts.ladder.map((_, i) => `[s${i}]`).join('')}`;
  const scales = opts.ladder.map((r, i) => `[s${i}]scale=-2:${r.height}[v${i}]`);
  const args = ['-y', '-hide_banner', '-nostats', '-i', opts.input];
  args.push('-filter_complex', [split, ...scales].join(';'));
  opts.ladder.forEach((r, i) => {
    args.push('-map', `[v${i}]`);
    if (opts.hasAudio) args.push('-map', '0:a:0');
    args.push(
      `-c:v:${i}`,
      'libx264',
      `-b:v:${i}`,
      String(r.bandwidth),
      `-maxrate:v:${i}`,
      String(Math.round(r.bandwidth * 1.07)),
      `-bufsize:v:${i}`,
      String(r.bandwidth * 2),
    );
  });
  args.push(
    '-preset',
    'veryfast',
    '-profile:v',
    'high',
    '-pix_fmt',
    'yuv420p',
    '-sc_threshold',
    '0',
    '-force_key_frames',
    `expr:gte(t,n_forced*${SEGMENT_SECONDS})`,
  );
  if (opts.hasAudio) args.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2');
  args.push(
    '-f',
    'hls',
    '-hls_time',
    String(SEGMENT_SECONDS),
    '-hls_playlist_type',
    'vod',
    '-hls_segment_type',
    'fmp4',
    '-hls_flags',
    'independent_segments',
    '-master_pl_name',
    'master.m3u8',
    '-var_stream_map',
    opts.ladder.map((_, i) => (opts.hasAudio ? `v:${i},a:${i}` : `v:${i}`)).join(' '),
    '-hls_fmp4_init_filename',
    'init.mp4',
    '-hls_segment_filename',
    `${opts.outDir}/v%v/seg_%04d.m4s`,
    '-progress',
    'pipe:1',
    `${opts.outDir}/v%v/index.m3u8`,
  );
  return args;
}

/** Parses `out_time_us=` from ffmpeg `-progress` output into seconds. */
export function progressSeconds(chunk: string): number | null {
  const m = [...chunk.matchAll(/out_time_(?:us|ms)=(\d+)/g)].at(-1);
  return m ? Number(m[1]) / 1_000_000 : null;
}

/** Converts SubRip to WebVTT (also accepts VTT unchanged). */
export function srtToVtt(text: string): string {
  const t = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  if (t.startsWith('WEBVTT')) return `${t}\n`;
  const body = t.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${body}\n`;
}

const ts = (sec: number) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
};

export interface SpritePlan {
  interval: number;
  count: number;
  cols: number;
  rows: number;
  width: number;
  height: number;
}

/** At most 100 thumbnails, one every ≥2 s, in a 10-column sprite. */
export function spritePlan(duration: number, width = 160, height = 90): SpritePlan {
  const interval = Math.max(2, Math.ceil(duration / 100));
  const count = Math.max(1, Math.ceil(duration / interval));
  const cols = Math.min(10, count);
  return { interval, count, cols, rows: Math.ceil(count / cols), width, height };
}

/** WebVTT mapping time ranges to sprite tiles (`#xywh=`), for scrubbing previews. */
export function spriteVtt(plan: SpritePlan, duration: number, image: string): string {
  const lines = ['WEBVTT', ''];
  for (let i = 0; i < plan.count; i++) {
    const start = i * plan.interval;
    const end = Math.min(duration, start + plan.interval);
    const x = (i % plan.cols) * plan.width;
    const y = Math.floor(i / plan.cols) * plan.height;
    lines.push(
      `${ts(start)} --> ${ts(end)}`,
      `${image}#xywh=${x},${y},${plan.width},${plan.height}`,
      '',
    );
  }
  return lines.join('\n');
}

export type EmbedProvider = 'youtube' | 'rutube' | 'vk';

/** Recognises YouTube, RuTube and VK Video links and returns an API-enabled embed URL. */
export function parseEmbed(
  raw: string | null | undefined,
): { provider: EmbedProvider; id: string; embedUrl: string } | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\.|^m\./, '');
  if (host === 'youtu.be' || host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const id =
      host === 'youtu.be'
        ? u.pathname.slice(1)
        : (u.searchParams.get('v') ?? u.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]+)/)?.[1]);
    if (id && /^[\w-]{6,20}$/.test(id))
      return {
        provider: 'youtube',
        id,
        embedUrl: `https://www.youtube-nocookie.com/embed/${id}?enablejsapi=1&rel=0`,
      };
    return null;
  }
  if (host === 'rutube.ru') {
    const id = u.pathname.match(/^\/(?:video|play\/embed)\/([\da-f]{20,40})/)?.[1];
    if (id) return { provider: 'rutube', id, embedUrl: `https://rutube.ru/play/embed/${id}` };
    return null;
  }
  if (host === 'vk.com' || host === 'vkvideo.ru' || host === 'vk.ru') {
    let oid = u.searchParams.get('oid');
    let vid = u.searchParams.get('id');
    const m = u.pathname.match(/video(-?\d+)_(\d+)/) ?? u.search.match(/video(-?\d+)_(\d+)/);
    if (m) [, oid, vid] = m as unknown as [string, string, string];
    if (oid && vid && /^-?\d+$/.test(oid) && /^\d+$/.test(vid)) {
      const hash = u.searchParams.get('hash');
      return {
        provider: 'vk',
        id: `${oid}_${vid}`,
        embedUrl: `https://vkvideo.ru/video_ext.php?oid=${oid}&id=${vid}${hash ? `&hash=${hash}` : ''}&js_api=1`,
      };
    }
  }
  return null;
}

export function hlsContentType(file: string): string {
  if (file.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (file.endsWith('.m4s')) return 'video/iso.segment';
  if (file.endsWith('.mp4')) return 'video/mp4';
  if (file.endsWith('.jpg')) return 'image/jpeg';
  if (file.endsWith('.vtt')) return 'text/vtt; charset=utf-8';
  return 'application/octet-stream';
}
