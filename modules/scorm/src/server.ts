import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Prisma } from '@hubium/db';
import { type ActivityRef, defineAction, defineModule, type ModuleCtx } from '@hubium/module-sdk';
import { bool, optionalNumber } from '@hubium/module-sdk/fields';
import { z } from 'zod';
import {
  contentTypeFor,
  extractZip,
  initialCmi,
  isCompleted,
  type Manifest,
  parseManifest,
  scorePercent,
  trackFromCmi,
} from './package.ts';

export * from './package.ts';

// mod-scorm: SCORM 1.2 / 2004 packages. Files are served from the content origin
// (CONTENT_HOST) together with a scorm-again runtime page that loads each SCO in a
// same-origin iframe; commits go back to the same origin with the signed path token.

export const ScormSettings = z
  .object({
    maxAttempts: z.coerce.number().int().min(0).max(100).default(0),
    gradeMethod: z.enum(['HIGHEST', 'AVERAGE', 'FIRST', 'LAST']).default('HIGHEST'),
    gradeMax: z.coerce.number().min(1).max(10_000).default(100),
    gradePass: optionalNumber(0, 10_000),
    height: z.coerce.number().int().min(300).max(2000).default(640),
    newWindow: bool(false),
  })
  .refine((s) => s.gradePass === undefined || s.gradePass <= s.gradeMax, {
    message: 'Pass grade exceeds maximum',
    path: ['gradePass'],
  });

export type ScormSettingsT = z.output<typeof ScormSettings>;
type Scorm = ActivityRef<ScormSettingsT>;
type Db = Prisma.TransactionClient;

export const SCORM_MAX_BYTES = 1024 * 1024 * 1024;
/**
 * Storage key of a package file. Storage keys are plain ASCII, so names with spaces or
 * other letters (common in exported courses: "Глава 1.html") are stored under a hash.
 */
export const key = (pkgId: string, file: string) =>
  /^[\w./-]+$/.test(file) && !file.includes('..')
    ? `mod/scorm/${pkgId}/${file}`
    : `mod/scorm/${pkgId}/_hashed/${createHash('sha256').update(file).digest('hex')}`;

// ── runtime (scorm-again) ────────────────────────────────────────────────────

const runtimeCache = new Map<string, string>();

/** Locates scorm-again's browser bundles (the package exports hide dist/). */
function runtimeDir(): string {
  const env = process.env.SCORM_AGAIN_DIR;
  if (env && existsSync(env)) return env;
  try {
    const req = createRequire(import.meta.url);
    const p = path.dirname(req.resolve('scorm-again/scorm12/min'));
    const dist = path.basename(p) === 'cjs' ? path.dirname(p) : p;
    if (existsSync(path.join(dist, 'scorm12.min.js'))) return dist;
  } catch {}
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const direct = path.join(dir, 'node_modules', 'scorm-again', 'dist');
    if (existsSync(path.join(direct, 'scorm12.min.js'))) return direct;
    const store = path.join(dir, 'node_modules', '.pnpm');
    if (existsSync(store)) {
      const hit = readdirSync(store).find((d) => d.startsWith('scorm-again@'));
      if (hit) return path.join(store, hit, 'node_modules', 'scorm-again', 'dist');
    }
    dir = path.dirname(dir);
  }
  throw new Error('scorm-again runtime not found; set SCORM_AGAIN_DIR');
}

async function runtimeScript(name: 'scorm12.min.js' | 'scorm2004.min.js'): Promise<string> {
  const hit = runtimeCache.get(name);
  if (hit) return hit;
  // Resolved at runtime; next.config.ts adds these bundles to the /c/** trace explicitly.
  const js = await readFile(
    /*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ runtimeDir(), name),
    'utf8',
  );
  runtimeCache.set(name, js);
  return js;
}

// ── extraction ───────────────────────────────────────────────────────────────

export async function extractPackage(ctx: ModuleCtx, packageId: string): Promise<Manifest> {
  const pkg = await ctx.db.scormPackage.findUniqueOrThrow({ where: { id: packageId } });
  if (!pkg.fileId) throw new Error('No package file');
  const work = await mkdtemp(path.join(tmpdir(), 'hubium-scorm-'));
  try {
    const zipPath = path.join(work, 'package.zip');
    const src = await ctx.files.open(pkg.fileId);
    await pipeline(src.stream, createWriteStream(zipPath));
    let manifestXml = '';
    const old = (pkg.files as string[]) ?? [];
    const { files, totalBytes } = await extractZip(zipPath, async (p, stream) => {
      if (p.toLowerCase() === 'imsmanifest.xml') {
        const chunks: Buffer[] = [];
        for await (const c of stream) chunks.push(c as Buffer);
        const buf = Buffer.concat(chunks);
        manifestXml = buf.toString('utf8');
        await ctx.storage.put(key(packageId, p), buf, 'application/xml');
      } else {
        await ctx.storage.put(key(packageId, p), stream, contentTypeFor(p));
      }
    });
    if (!manifestXml) throw new Error('imsmanifest.xml is missing: this is not a SCORM package');
    const manifest = parseManifest(manifestXml);
    const stale = old.filter((f) => !files.includes(f));
    if (stale.length) await ctx.storage.delete(stale.map((f) => key(packageId, f)));
    // keep SCO ids (and learners' tracks) when a package is replaced
    const keep = new Set(manifest.scos.map((s) => s.identifier));
    await ctx.db.scormSco.deleteMany({ where: { packageId, identifier: { notIn: [...keep] } } });
    for (const [i, s] of manifest.scos.entries()) {
      await ctx.db.scormSco.upsert({
        where: { packageId_identifier: { packageId, identifier: s.identifier } },
        create: { packageId, ...s, sortOrder: i },
        update: { title: s.title, href: s.href, masteryScore: s.masteryScore, sortOrder: i },
      });
    }
    await ctx.db.scormPackage.update({
      where: { id: packageId },
      data: {
        status: 'READY',
        error: null,
        version: manifest.version,
        title: manifest.title,
        files: files as Prisma.InputJsonValue,
        totalBytes: BigInt(totalBytes),
      },
    });
    return manifest;
  } catch (e) {
    await ctx.db.scormPackage.update({
      where: { id: packageId },
      data: { status: 'FAILED', error: e instanceof Error ? e.message.slice(0, 1000) : 'Error' },
    });
    throw e;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// ── attempts, tracking, grades ───────────────────────────────────────────────

export async function currentAttempt(db: Db, activityId: string, userId: string, create = true) {
  const last = await db.scormAttempt.findFirst({
    where: { activityId, userId },
    orderBy: { attemptNumber: 'desc' },
  });
  if (last || !create) return last;
  return db.scormAttempt.create({ data: { activityId, userId, attemptNumber: 1 } });
}

function aggregate(method: ScormSettingsT['gradeMethod'], scores: number[]): number | null {
  if (!scores.length) return null;
  if (method === 'FIRST') return scores[0]!;
  if (method === 'LAST') return scores.at(-1)!;
  if (method === 'AVERAGE') return scores.reduce((a, b) => a + b, 0) / scores.length;
  return Math.max(...scores);
}

/** Recomputes the attempt result and the activity grade after a commit. */
export async function updateResults(ctx: ModuleCtx, a: Scorm, attemptId: string) {
  const attempt = await ctx.db.scormAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    include: { tracks: true },
  });
  const pkg = await ctx.db.scormPackage.findUnique({
    where: { activityId: a.id },
    include: { scos: true },
  });
  const tracks = attempt.tracks;
  const percents = tracks.map((t) => scorePercent(t)).filter((x): x is number => x !== null);
  const score = percents.length ? percents.reduce((s, x) => s + x, 0) / percents.length : null;
  const done =
    !!pkg?.scos.length &&
    pkg.scos.every((s) => {
      const t = tracks.find((x) => x.scoId === s.id);
      return t ? isCompleted(t) : false;
    });
  await ctx.db.scormAttempt.update({
    where: { id: attemptId },
    data: {
      score,
      lastAccessAt: ctx.now,
      finishedAt: done ? (attempt.finishedAt ?? ctx.now) : null,
    },
  });
  const all = await ctx.db.scormAttempt.findMany({
    where: { activityId: a.id, userId: attempt.userId },
    orderBy: { attemptNumber: 'asc' },
  });
  const best = aggregate(
    a.settings.gradeMethod,
    all.map((x) => x.score).filter((x): x is number => x !== null),
  );
  if (best !== null) {
    await ctx.grades.setGrades(a.id, [
      { userId: attempt.userId, rawGrade: (best / 100) * a.settings.gradeMax },
    ]);
  }
  await ctx.completion.recompute(a.id, attempt.userId);
}

/** Applies a commit from the runtime to the learner's track. */
export async function commitTrack(
  ctx: ModuleCtx,
  a: Scorm,
  grant: { userId: string; attemptId: string; scoId: string },
  body: unknown,
) {
  const attempt = await ctx.db.scormAttempt.findUnique({ where: { id: grant.attemptId } });
  if (!attempt || attempt.activityId !== a.id || attempt.userId !== grant.userId) {
    throw new Error('Unknown attempt');
  }
  const pkg = await ctx.db.scormPackage.findUniqueOrThrow({ where: { activityId: a.id } });
  const sco = await ctx.db.scormSco.findUnique({ where: { id: grant.scoId } });
  if (!sco || sco.packageId !== pkg.id) throw new Error('Unknown SCO');
  const f = trackFromCmi(pkg.version, body);
  const prev = await ctx.db.scormTrack.findUnique({
    where: { attemptId_scoId: { attemptId: attempt.id, scoId: sco.id } },
  });
  const base = prev?.sessionBaseSec ?? 0;
  const data = {
    cmi: (body ?? {}) as Prisma.InputJsonValue,
    location: f.location,
    suspendData: f.suspendData.slice(0, 64_000),
    exit: f.exit,
    completionStatus: f.completionStatus,
    successStatus: f.successStatus,
    scoreRaw: f.scoreRaw,
    scoreMin: f.scoreMin,
    scoreMax: f.scoreMax,
    scoreScaled: f.scoreScaled,
    totalTimeSec: Math.round(base + f.sessionTimeSec),
  };
  await ctx.db.scormTrack.upsert({
    where: { attemptId_scoId: { attemptId: attempt.id, scoId: sco.id } },
    create: { attemptId: attempt.id, scoId: sco.id, ...data },
    update: data,
  });
  await updateResults(ctx, a, attempt.id);
}

// ── runtime page ─────────────────────────────────────────────────────────────

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
/** JSON safe to embed in a <script> element. */
const jsonScript = (v: unknown) =>
  JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(/[\u2028\u2029]/g, ' ');

function playerHtml(o: {
  title: string;
  version: Manifest['version'];
  cmi: Record<string, unknown>;
  scoHref: string;
  review: boolean;
}): string {
  const is12 = o.version === 'SCORM_12';
  const script = is12 ? 'runtime/scorm12.min.js' : 'runtime/scorm2004.min.js';
  const cfg = {
    cmi: o.cmi,
    sco: `pkg/${o.scoHref}`,
    commit: o.review ? null : 'commit',
    is12,
  };
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.title)}</title>
<style>html,body{margin:0;height:100%;background:#fff}iframe{border:0;width:100%;height:100%;display:block}</style>
<script src="${script}"></script>
</head><body>
<iframe id="sco" title="${esc(o.title)}" allow="fullscreen; autoplay"></iframe>
<script>
(function(){
  var cfg=${jsonScript(cfg)};
  var settings={autocommit:true,autocommitSeconds:20,logLevel:5,
    lmsCommitUrl:cfg.commit?new URL(cfg.commit,location.href).href:false,
    dataCommitFormat:'json',sendFullCommit:true,
    responseHandler:async function(r){var j={};try{j=await r.json()}catch(e){}return{result:!!j.result,errorCode:j.errorCode||0}},
    xhrResponseHandler:function(x){var j={};try{j=JSON.parse(x.responseText)}catch(e){}return{result:!!j.result,errorCode:j.errorCode||0}}};
  var api=cfg.is12?new Scorm12API(settings):new Scorm2004API(settings);
  api.loadFromJSON(cfg.cmi,'');
  if(cfg.is12){window.API=api}else{window.API_1484_11=api}
  document.getElementById('sco').src=cfg.sco;
  // tell the LMS page when the learner leaves the SCO so it can refresh results
  ['LMSFinish','Terminate'].forEach(function(ev){api.on(ev,function(){try{parent.postMessage({hubium:'scorm-finished'},'*')}catch(e){}})});
})();
</script></body></html>`;
}

function contentHeaders(type: string, appOrigin: string): Record<string, string> {
  return {
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': `frame-ancestors 'self' ${appOrigin}`,
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'private, max-age=600',
  };
}

const ok = (body: object) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

export const scorm = defineModule<ScormSettingsT>({
  key: 'scorm',
  archetype: 'activity',
  icon: 'Package',
  supports: { grading: true, viewCompletion: true, backup: true },
  privacy: {
    async export(ctx, userId) {
      return ctx.db.scormAttempt.findMany({
        where: { userId },
        select: {
          activityId: true,
          attemptNumber: true,
          startedAt: true,
          finishedAt: true,
          score: true,
        },
      });
    },
  },
  backup: {
    // the package is unpacked again from the restored zip
    async import(ctx, a) {
      const [file] = await ctx.files.list(a.id, 'package');
      if (!file) return;
      const pkg = await ctx.db.scormPackage.upsert({
        where: { activityId: a.id },
        create: { activityId: a.id, fileId: file.id },
        update: { fileId: file.id, status: 'PROCESSING' },
      });
      await ctx.jobs.enqueue('scorm.extract', { packageId: pkg.id }, { singletonKey: pkg.id });
    },
  },
  settings: {
    schema: ScormSettings as unknown as z.ZodType<ScormSettingsT>,
    defaults: () => ScormSettings.parse({}),
  },
  grading: {
    items: (a) => [
      { itemNumber: 0, name: '', gradeMax: a.settings.gradeMax, gradePass: a.settings.gradePass },
    ],
  },
  completion: {
    schema: z.object({
      completed: bool(false),
      passed: bool(false),
      minScore: z.coerce.number().min(0).max(100).default(0),
    }),
    async evaluate(ctx, a, userId, rules) {
      const r = rules as { completed: boolean; passed: boolean; minScore: number };
      const attempts = await ctx.db.scormAttempt.findMany({
        where: { activityId: a.id, userId },
        include: { tracks: true },
      });
      if (!attempts.length) return 'incomplete';
      const finished = attempts.some((x) => x.finishedAt);
      const passed = attempts.some(
        (x) =>
          x.tracks.length &&
          x.tracks.every((t) => t.successStatus === 'passed' || t.completionStatus === 'passed'),
      );
      const best = Math.max(...attempts.map((x) => x.score ?? 0));
      if (r.completed && !finished) return 'incomplete';
      if (r.minScore && best < r.minScore) return finished ? 'fail' : 'incomplete';
      if (r.passed) {
        if (passed) return 'pass';
        const failed = attempts.some((x) =>
          x.tracks.some((t) => t.successStatus === 'failed' || t.completionStatus === 'failed'),
        );
        return failed ? 'fail' : 'incomplete';
      }
      return 'complete';
    },
  },
  lifecycle: {
    async onDelete(ctx, a) {
      const pkg = await ctx.db.scormPackage.findUnique({ where: { activityId: a.id } });
      if (pkg) await ctx.storage.delete(((pkg.files as string[]) ?? []).map((f) => key(pkg.id, f)));
    },
  },
  jobs: [
    {
      name: 'scorm.extract',
      async handler(ctx, data: { packageId: string }) {
        const m = await extractPackage(ctx, data.packageId);
        return { scos: m.scos.length, version: m.version };
      },
    },
  ],
  actions: {
    attachUpload: defineAction({
      input: z.object({ uploadId: z.string().uuid() }),
      async handler(ctx, a, input) {
        const access = await ctx.activities.get(a.id);
        if (!access?.canManage) throw new Error('Only course editors can upload packages');
        const file = await ctx.files.storeUpload(a.id, 'package', input.uploadId, {
          maxBytes: SCORM_MAX_BYTES,
          allowedTypes: /^(application\/(zip|x-zip-compressed|octet-stream))$/,
        });
        const prev = await ctx.db.scormPackage.findUnique({ where: { activityId: a.id } });
        if (prev?.fileId && prev.fileId !== file.id)
          await ctx.db.file.deleteMany({ where: { id: prev.fileId } });
        const pkg = await ctx.db.scormPackage.upsert({
          where: { activityId: a.id },
          create: { activityId: a.id, fileId: file.id },
          update: { fileId: file.id, status: 'PROCESSING', error: null },
        });
        await ctx.jobs.enqueue('scorm.extract', { packageId: pkg.id }, { singletonKey: pkg.id });
        return { packageId: pkg.id };
      },
    }),
    newAttempt: defineAction({
      capability: 'mod.scorm:launch',
      input: z.object({}),
      async handler(ctx, ref) {
        const a = ref as Scorm;
        if (ctx.actor.kind !== 'user') throw new Error('Sign in required');
        const userId = ctx.actor.userId;
        const last = await currentAttempt(ctx.db, a.id, userId, false);
        if (!last) return { attempt: (await currentAttempt(ctx.db, a.id, userId))!.attemptNumber };
        if (!last.finishedAt) throw new Error('Finish the current attempt first');
        if (a.settings.maxAttempts && last.attemptNumber >= a.settings.maxAttempts) {
          throw new Error('No attempts left');
        }
        const n = await ctx.db.scormAttempt.create({
          data: { activityId: a.id, userId, attemptNumber: last.attemptNumber + 1 },
        });
        return { attempt: n.attemptNumber };
      },
    }),
  },
  async content(ctx, grant, req, p) {
    const app = ctx.content.appOrigin();
    const act = await ctx.db.activity.findUnique({ where: { id: grant.activityId } });
    if (!act) return new Response('Not found', { status: 404 });
    const a = { ...act, settings: ScormSettings.parse(act.settings ?? {}) } as unknown as Scorm;
    const pkg = await ctx.db.scormPackage.findUnique({ where: { activityId: act.id } });
    if (pkg?.status !== 'READY') return new Response('Package not ready', { status: 404 });
    const [kind, ...rest] = p;

    if (kind === 'runtime') {
      const name = rest[0];
      if (name !== 'scorm12.min.js' && name !== 'scorm2004.min.js')
        return new Response('Not found', { status: 404 });
      return new Response(await runtimeScript(name), {
        headers: {
          ...contentHeaders('text/javascript; charset=utf-8', app),
          'Cache-Control': 'public, max-age=86400',
        },
      });
    }

    if (kind === 'pkg') {
      // Segments may arrive percent-encoded ("Глава%201.html").
      const file = rest
        .map((seg) => {
          try {
            return decodeURIComponent(seg);
          } catch {
            return seg;
          }
        })
        .join('/');
      if (!((pkg.files as string[]) ?? []).includes(file))
        return new Response('Not found', { status: 404 });
      const stream = await ctx.storage.get(key(pkg.id, file));
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          stream.on('data', (d: Buffer) => c.enqueue(new Uint8Array(d)));
          stream.on('end', () => c.close());
          stream.on('error', (e) => c.error(e));
        },
        cancel() {
          stream.destroy();
        },
      });
      return new Response(body, { headers: contentHeaders(contentTypeFor(file), app) });
    }

    const attemptId = String(grant.data.attempt ?? '');
    const scoId = String(grant.data.sco ?? '');

    if (kind === 'commit' && req.method === 'POST') {
      if (grant.data.review) return ok({ result: true, errorCode: 0 });
      let body: unknown;
      try {
        body = JSON.parse(await req.text());
      } catch {
        return ok({ result: false, errorCode: 101 });
      }
      try {
        await commitTrack(ctx, a, { userId: grant.userId, attemptId, scoId }, body);
        return ok({ result: true, errorCode: 0 });
      } catch (e) {
        console.error('[scorm] commit failed', e);
        return ok({ result: false, errorCode: 101 });
      }
    }

    if (kind === 'player') {
      const sco = await ctx.db.scormSco.findUnique({ where: { id: scoId } });
      if (!sco || sco.packageId !== pkg.id) return new Response('Not found', { status: 404 });
      const track = attemptId
        ? await ctx.db.scormTrack.findUnique({ where: { attemptId_scoId: { attemptId, scoId } } })
        : null;
      if (track && !grant.data.review) {
        // the new session's time is added on top of what was recorded so far
        await ctx.db.scormTrack.update({
          where: { id: track.id },
          data: { sessionBaseSec: track.totalTimeSec },
        });
      }
      const user = await ctx.db.user.findUniqueOrThrow({
        where: { id: grant.userId },
        select: { name: true, lastName: true, firstName: true },
      });
      // SCORM 1.2 expects "Last, First"
      const name =
        pkg.version === 'SCORM_12' && user.lastName
          ? `${user.lastName}, ${user.firstName}`
          : user.name;
      const cmi = initialCmi(pkg.version, { id: grant.userId, name }, track, {
        masteryScore: sco.masteryScore,
        review: !!grant.data.review,
      });
      return new Response(
        playerHtml({
          title: sco.title,
          version: pkg.version,
          cmi,
          scoHref: sco.href,
          review: !!grant.data.review,
        }),
        {
          headers: {
            ...contentHeaders('text/html; charset=utf-8', app),
            'Cache-Control': 'no-store',
          },
        },
      );
    }
    return new Response('Not found', { status: 404 });
  },
});

export const scormModules = [scorm];
