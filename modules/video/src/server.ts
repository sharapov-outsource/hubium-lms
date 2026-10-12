import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Prisma } from '@hubium/db';
import { type ActivityRef, defineAction, defineModule, type ModuleCtx } from '@hubium/module-sdk';
import { bool } from '@hubium/module-sdk/fields';
import { z } from 'zod';
import {
  hlsArgs,
  hlsContentType,
  type Interval,
  ladderFor,
  mergeIntervals,
  parseEmbed,
  progressSeconds,
  type Rendition,
  spritePlan,
  spriteVtt,
  srtToVtt,
  watchPercent,
} from './media.ts';

export * from './media.ts';

// mod-video: an uploaded file transcoded to HLS by the worker-media container, or an
// embedded YouTube / RuTube / VK video. Watch progress is kept as merged intervals.

export const VideoSettings = z
  .object({
    source: z.enum(['upload', 'embed']).default('upload'),
    embedUrl: z
      .string()
      .trim()
      .max(2000)
      .default('')
      .refine((v) => !v || parseEmbed(v) !== null, 'Unsupported video link'),
    noSeekAhead: bool(false),
    deleteSource: bool(false),
  })
  .refine((s) => s.source !== 'embed' || s.embedUrl, {
    message: 'Paste a YouTube, RuTube or VK Video link',
    path: ['embedUrl'],
  });

export type VideoSettingsT = z.output<typeof VideoSettings>;
type Video = ActivityRef<VideoSettingsT>;

export interface VideoOutputs {
  master?: string;
  renditions?: Rendition[];
  poster?: string;
  sprite?: string;
  files?: string[];
}

export const VIDEO_MAX_BYTES = 4 * 1024 * 1024 * 1024;
const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe';

const storageKey = (assetId: string, file: string) => `mod/video/${assetId}/${file}`;

function uid(ctx: ModuleCtx): string {
  if (ctx.actor.kind !== 'user') throw new Error('Sign in required');
  return ctx.actor.userId;
}

async function requireManager(ctx: ModuleCtx, a: { id: string }) {
  const r = await ctx.activities.get(a.id);
  if (!r?.canManage) throw new Error('Only course editors can manage the video');
}

async function removeOutputs(ctx: ModuleCtx, assetId: string, outputs: VideoOutputs) {
  await ctx.storage.delete((outputs.files ?? []).map((f) => storageKey(assetId, f)));
}

// ── transcoding (worker-media) ───────────────────────────────────────────────

function run(
  cmd: string,
  args: string[],
  onStdout?: (chunk: string) => void,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d: Buffer) => {
      const s = d.toString();
      stdout += s.length < 100_000 ? s : '';
      onStdout?.(s);
    });
    p.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-8000);
    });
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0
        ? resolve({ stdout, stderr })
        : reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-1500)}`)),
    );
  });
}

export async function probe(file: string) {
  const { stdout } = await run(FFPROBE, [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_streams',
    '-show_format',
    file,
  ]);
  const info = JSON.parse(stdout) as {
    streams: { codec_type: string; width?: number; height?: number; tags?: { rotate?: string } }[];
    format: { duration?: string };
  };
  const v = info.streams.find((s) => s.codec_type === 'video');
  if (!v?.width || !v.height) throw new Error('No video stream');
  const rotated = Math.abs(Number(v.tags?.rotate ?? 0)) % 180 === 90;
  return {
    duration: Number(info.format.duration ?? 0),
    width: rotated ? v.height : v.width,
    height: rotated ? v.width : v.height,
    hasAudio: info.streams.some((s) => s.codec_type === 'audio'),
  };
}

async function listFilesRec(dir: string, base = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFilesRec(path.join(dir, e.name), rel)));
    else out.push(rel);
  }
  return out;
}

/** Downloads the source, probes it, builds the HLS ladder, poster and sprite, uploads all. */
export async function transcodeAsset(ctx: ModuleCtx, assetId: string): Promise<VideoOutputs> {
  const asset = await ctx.db.videoAsset.findUnique({ where: { id: assetId } });
  if (!asset?.sourceFileId) throw new Error('Nothing to transcode');
  const source = await ctx.db.file.findUnique({ where: { id: asset.sourceFileId } });
  const owner = source?.uploadedById ? [source.uploadedById] : [];
  const status = async (data: Prisma.VideoAssetUpdateInput) => {
    const a = await ctx.db.videoAsset.update({ where: { id: assetId }, data });
    await ctx.realtime.publish(owner, 'video.status', {
      activityId: a.activityId,
      status: a.status,
      progress: a.progress,
    });
  };
  const work = await mkdtemp(path.join(tmpdir(), 'hubium-video-'));
  try {
    await status({ status: 'PROCESSING', progress: 0, error: null });
    const input = path.join(work, 'source');
    const src = await ctx.files.open(asset.sourceFileId);
    await pipeline(src.stream, createWriteStream(input));
    const info = await probe(input);
    const ladder = ladderFor(info.height);
    const out = path.join(work, 'out');
    for (let i = 0; i < ladder.length; i++)
      await mkdir(path.join(out, `v${i}`), { recursive: true });
    let lastReport = 0;
    await run(FFMPEG, hlsArgs({ input, outDir: out, ladder, hasAudio: info.hasAudio }), (chunk) => {
      const t = progressSeconds(chunk);
      if (t === null || !info.duration) return;
      const pct = Math.min(95, Math.round((t / info.duration) * 95));
      if (Date.now() - lastReport > 2000) {
        lastReport = Date.now();
        void status({ progress: pct }).catch(() => {});
      }
    });
    // poster at 10% and a scrubbing sprite
    await run(FFMPEG, [
      '-y',
      '-v',
      'error',
      '-ss',
      String(Math.max(0, info.duration * 0.1)),
      '-i',
      input,
      '-frames:v',
      '1',
      '-vf',
      'scale=-2:720',
      path.join(out, 'poster.jpg'),
    ]);
    const plan = spritePlan(info.duration || 1);
    await run(FFMPEG, [
      '-y',
      '-v',
      'error',
      '-i',
      input,
      '-vf',
      `fps=1/${plan.interval},scale=${plan.width}:${plan.height}:force_original_aspect_ratio=decrease,pad=${plan.width}:${plan.height}:(ow-iw)/2:(oh-ih)/2,tile=${plan.cols}x${plan.rows}`,
      '-frames:v',
      '1',
      path.join(out, 'sprite.jpg'),
    ]);
    await writeFile(path.join(out, 'sprite.vtt'), spriteVtt(plan, info.duration, 'sprite.jpg'));
    const files = await listFilesRec(out);
    for (const f of files) {
      await ctx.storage.put(
        storageKey(assetId, f),
        createReadStream(path.join(out, f)),
        hlsContentType(f),
      );
    }
    const prev = asset.outputs as VideoOutputs;
    const outputs: VideoOutputs = {
      master: 'master.m3u8',
      renditions: ladder,
      poster: 'poster.jpg',
      sprite: 'sprite.vtt',
      files,
    };
    // old renditions that the new ladder did not overwrite
    const stale = (prev.files ?? []).filter((f) => !files.includes(f));
    if (stale.length) await removeOutputs(ctx, assetId, { files: stale });
    await status({
      status: 'READY',
      progress: 100,
      durationSec: info.duration,
      width: info.width,
      height: info.height,
      outputs: outputs as Prisma.InputJsonValue,
    });
    const act = await ctx.db.activity.findUnique({ where: { id: asset.activityId } });
    const settings = VideoSettings.safeParse(act?.settings ?? {});
    if (settings.success && settings.data.deleteSource && source) {
      await ctx.db.file.delete({ where: { id: source.id } });
      await ctx.db.videoAsset.update({ where: { id: assetId }, data: { sourceFileId: null } });
    }
    return outputs;
  } catch (e) {
    await status({
      status: 'FAILED',
      error: e instanceof Error ? e.message.slice(0, 2000) : 'Error',
    });
    throw e;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// ── progress ─────────────────────────────────────────────────────────────────

export async function recordProgress(
  db: Prisma.TransactionClient,
  activityId: string,
  userId: string,
  input: { intervals: Interval[]; duration: number; position: number },
) {
  const prev = await db.videoProgress.findUnique({
    where: { activityId_userId: { activityId, userId } },
  });
  const duration = input.duration > 0 ? input.duration : (prev?.durationSec ?? 0);
  const merged = mergeIntervals(
    [...((prev?.intervals as Interval[] | undefined) ?? []), ...input.intervals],
    duration || undefined,
  );
  const percent = watchPercent(merged, duration);
  const data = {
    intervals: merged as unknown as Prisma.InputJsonValue,
    watchedSec: merged.reduce((s, [a, b]) => s + b - a, 0),
    durationSec: duration,
    percent,
    position: Math.max(0, input.position),
  };
  await db.videoProgress.upsert({
    where: { activityId_userId: { activityId, userId } },
    create: { activityId, userId, ...data },
    update: data,
  });
  return { percent, previous: prev?.percent ?? 0 };
}

const IntervalInput = z.tuple([z.number().min(0), z.number().min(0)]);

const FileInput = z.object({
  name: z.string().min(1).max(255),
  mimeType: z.string().default('application/octet-stream'),
  data: z.instanceof(Buffer),
});

export const video = defineModule<VideoSettingsT>({
  key: 'video',
  archetype: 'activity',
  icon: 'PlaySquare',
  supports: { viewCompletion: true, backup: true },
  settings: {
    schema: VideoSettings as unknown as z.ZodType<VideoSettingsT>,
    defaults: () => VideoSettings.parse({}),
  },
  completion: {
    schema: z.object({ minPercent: z.coerce.number().int().min(0).max(100).default(0) }),
    async evaluate(ctx, a, userId, rules) {
      const min = (rules as { minPercent: number }).minPercent;
      if (!min) return 'complete';
      const p = await ctx.db.videoProgress.findUnique({
        where: { activityId_userId: { activityId: a.id, userId } },
      });
      return (p?.percent ?? 0) >= min ? 'complete' : 'incomplete';
    },
  },
  files: {
    // captions follow the activity; sources are for editors only
    captions: { canRead: async () => true },
  },
  lifecycle: {
    async onDelete(ctx, a) {
      const asset = await ctx.db.videoAsset.findUnique({ where: { activityId: a.id } });
      if (asset) await removeOutputs(ctx, asset.id, asset.outputs as VideoOutputs);
    },
  },
  jobs: [
    {
      name: 'video.transcode',
      queue: 'media',
      async handler(ctx, data: { assetId: string }) {
        return transcodeAsset(ctx, data.assetId);
      },
    },
  ],
  actions: {
    attachUpload: defineAction({
      input: z.object({ uploadId: z.string().uuid() }),
      async handler(ctx, a, input) {
        await requireManager(ctx, a);
        const file = await ctx.files.storeUpload(a.id, 'source', input.uploadId, {
          maxBytes: VIDEO_MAX_BYTES,
          allowedTypes: /^(video\/|application\/octet-stream$)/,
          replace: false,
        });
        const prev = await ctx.db.videoAsset.findUnique({ where: { activityId: a.id } });
        if (prev?.sourceFileId && prev.sourceFileId !== file.id) {
          await ctx.db.file.deleteMany({ where: { id: prev.sourceFileId } });
        }
        const asset = await ctx.db.videoAsset.upsert({
          where: { activityId: a.id },
          create: { activityId: a.id, sourceFileId: file.id },
          update: { sourceFileId: file.id, status: 'UPLOADED', progress: 0, error: null },
        });
        await ctx.jobs.enqueue(
          'video.transcode',
          { assetId: asset.id },
          { singletonKey: asset.id },
        );
        await ctx.log('video.uploaded', { activityId: a.id, size: file.size.toString() });
        return { assetId: asset.id };
      },
    }),
    retranscode: defineAction({
      input: z.object({}),
      async handler(ctx, a) {
        await requireManager(ctx, a);
        const asset = await ctx.db.videoAsset.findUnique({ where: { activityId: a.id } });
        if (!asset?.sourceFileId) throw new Error('The source file was deleted; upload it again');
        await ctx.db.videoAsset.update({
          where: { id: asset.id },
          data: { status: 'UPLOADED', progress: 0, error: null },
        });
        await ctx.jobs.enqueue(
          'video.transcode',
          { assetId: asset.id },
          { singletonKey: asset.id },
        );
        return { ok: true };
      },
    }),
    addCaption: defineAction({
      input: z.object({
        lang: z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/),
        label: z.string().trim().min(1).max(60),
        files: z.array(FileInput).length(1),
      }),
      async handler(ctx, a, input) {
        await requireManager(ctx, a);
        const asset =
          (await ctx.db.videoAsset.findUnique({ where: { activityId: a.id } })) ??
          (await ctx.db.videoAsset.create({ data: { activityId: a.id } }));
        const f = input.files[0]!;
        if (f.data.length > 2 * 1024 * 1024) throw new Error('Caption file is too large');
        const vtt = srtToVtt(f.data.toString('utf8'));
        const stored = await ctx.files.store(
          a.id,
          'captions',
          {
            name: `${input.lang}.vtt`,
            mimeType: 'text/vtt',
            data: Buffer.from(vtt),
            itemId: input.lang,
          },
          { replace: true },
        );
        await ctx.db.videoCaption.upsert({
          where: { assetId_lang: { assetId: asset.id, lang: input.lang } },
          create: { assetId: asset.id, lang: input.lang, label: input.label, fileId: stored.id },
          update: { label: input.label, fileId: stored.id },
        });
        return { ok: true };
      },
    }),
    removeCaption: defineAction({
      input: z.object({ lang: z.string().max(10) }),
      async handler(ctx, a, input) {
        await requireManager(ctx, a);
        const asset = await ctx.db.videoAsset.findUnique({ where: { activityId: a.id } });
        if (!asset) return { ok: true };
        const c = await ctx.db.videoCaption.findUnique({
          where: { assetId_lang: { assetId: asset.id, lang: input.lang } },
        });
        if (c) {
          await ctx.db.videoCaption.delete({ where: { id: c.id } });
          await ctx.db.file.deleteMany({ where: { id: c.fileId } });
        }
        return { ok: true };
      },
    }),
    progress: defineAction({
      input: z.object({
        intervals: z.array(IntervalInput).max(500),
        duration: z
          .number()
          .min(0)
          .max(24 * 3600),
        position: z.number().min(0).default(0),
      }),
      async handler(ctx, ref, input) {
        const a = ref as Video;
        const me = uid(ctx);
        // For uploads the server knows the real duration; don't trust the client.
        const asset =
          a.settings.source === 'upload'
            ? await ctx.db.videoAsset.findUnique({ where: { activityId: a.id } })
            : null;
        const duration = asset?.durationSec ?? input.duration;
        const r = await recordProgress(ctx.db, a.id, me, {
          intervals: input.intervals as Interval[],
          duration,
          position: input.position,
        });
        const min = Number(
          (a.completionRules as { module?: { minPercent?: number } }).module?.minPercent ?? 0,
        );
        if (a.completionMode === 'AUTO' && r.previous < min && r.percent >= min) {
          await ctx.completion.recompute(a.id, me);
        }
        return { percent: r.percent };
      },
    }),
  },
  async http(ctx, req, p) {
    // GET /api/mod/video/<activityId>/hls/<file...>
    const [activityId, kind, ...rest] = p;
    if (req.method !== 'GET' || kind !== 'hls' || !activityId || !rest.length) {
      return new Response('Not found', { status: 404 });
    }
    const file = rest.join('/');
    if (!/^[\w./-]+$/.test(file) || file.includes('..'))
      return new Response('Bad path', { status: 400 });
    const access = await ctx.activities.get(activityId);
    if (!access?.canOpen) return new Response('Forbidden', { status: 403 });
    const asset = await ctx.db.videoAsset.findUnique({ where: { activityId } });
    const outputs = (asset?.outputs ?? {}) as VideoOutputs;
    if (!asset || !outputs.files?.includes(file)) return new Response('Not found', { status: 404 });
    const key = storageKey(asset.id, file);
    const head = await ctx.storage.head(key);
    if (!head) return new Response('Not found', { status: 404 });
    const stream = await ctx.storage.get(key);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        stream.on('data', (c: Buffer) => controller.enqueue(new Uint8Array(c)));
        stream.on('end', () => controller.close());
        stream.on('error', (e) => controller.error(e));
      },
      cancel() {
        stream.destroy();
      },
    });
    return new Response(body, {
      headers: {
        'Content-Type': hlsContentType(file),
        'Content-Length': String(head.size),
        // segments never change; playlists can be replaced by a re-transcode
        'Cache-Control':
          file.endsWith('.m3u8') || file.endsWith('.vtt')
            ? 'private, no-cache'
            : 'private, max-age=86400, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  },
});

/** Watch report rows for a teacher (participants with progress). */
export async function watchReport(ctx: ModuleCtx, a: { id: string }) {
  const [viewers, staff] = await Promise.all([
    ctx.perm.usersWithCap('activity:view', a.id),
    ctx.perm.usersWithCap('mod.video:viewprogress', a.id),
  ]);
  const userIds = viewers.filter((u) => !staff.includes(u));
  const [users, rows] = await Promise.all([
    ctx.db.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    }),
    ctx.db.videoProgress.findMany({ where: { activityId: a.id } }),
  ]);
  const by = new Map(rows.map((r) => [r.userId, r]));
  return users.map((u) => ({
    id: u.id,
    name: u.name,
    percent: by.get(u.id)?.percent ?? 0,
    watchedSec: by.get(u.id)?.watchedSec ?? 0,
    updatedAt: by.get(u.id)?.updatedAt ?? null,
  }));
}

export const videoModules = [video];
