import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { finished, pipeline } from 'node:stream/promises';
import type { Prisma } from '@hubium/db';
import { log } from '@hubium/log';
import {
  type ActivityRef,
  defineAction,
  defineModule,
  type ModuleCtx,
  parseSettings,
} from '@hubium/module-sdk';
import { bool, optionalNumber } from '@hubium/module-sdk/fields';
import {
  contentTypeFor,
  extractZip,
  permanent,
  StorageFailure,
  stored,
} from '@hubium/module-sdk/zip';
import { z } from 'zod';
import { allowedFile, checkPackage, gradeOf, resultOf } from './package.ts';

const logger = log('h5p');

export * from './package.ts';

// mod-h5p: H5P content uploaded as .h5p packages (there is no editor). Files are served
// from the content origin (CONTENT_HOST) with the h5p-standalone player; the player
// page reports the content's top-level xAPI results back to the same origin with the
// signed path token, and each one becomes an attempt.

export const H5pSettings = z
  .object({
    tracking: bool(true),
    gradeMethod: z.enum(['HIGHEST', 'AVERAGE', 'FIRST', 'LAST']).default('HIGHEST'),
    gradeMax: z.coerce.number().min(1).max(10_000).default(100),
    gradePass: optionalNumber(0, 10_000),
    /** H5P's action bar under the content. */
    showFrame: bool(true),
    showCopyright: bool(true),
  })
  .refine((s) => s.gradePass === undefined || s.gradePass <= s.gradeMax, {
    message: 'Pass grade exceeds maximum',
    path: ['gradePass'],
  });

export type H5pSettingsT = z.output<typeof H5pSettings>;
type H5p = ActivityRef<H5pSettingsT>;

export const H5P_MAX_BYTES = 512 * 1024 * 1024;
/** Largest xAPI statement accepted from the player. */
const MAX_STATEMENT = 64 * 1024;

/** Storage key of a package file (names outside plain ASCII are stored under a hash). */
export const key = (pkgId: string, file: string) =>
  /^[\w./-]+$/.test(file) && !file.includes('..')
    ? `mod/h5p/${pkgId}/${file}`
    : `mod/h5p/${pkgId}/_hashed/${createHash('sha256').update(file).digest('hex')}`;

// ── player (h5p-standalone) ──────────────────────────────────────────────────

/** Locates h5p-standalone's browser bundles. */
function playerDir(): string {
  const env = process.env.H5P_STANDALONE_DIR;
  if (env && existsSync(env)) return env;
  try {
    const dist = path.dirname(createRequire(import.meta.url).resolve('h5p-standalone'));
    if (existsSync(path.join(dist, 'frame.bundle.js'))) return dist;
  } catch {}
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const store = path.join(dir, 'node_modules', '.pnpm');
    if (existsSync(store)) {
      const hit = readdirSync(store).find((d) => d.startsWith('h5p-standalone@'));
      if (hit) return path.join(store, hit, 'node_modules', 'h5p-standalone', 'dist');
    }
    dir = path.dirname(dir);
  }
  throw new Error('h5p-standalone not found; set H5P_STANDALONE_DIR');
}

let playerFiles: Set<string> | undefined;
const playerCache = new Map<string, Buffer>();

/** A file of the player (scripts, styles, fonts, images); null for anything else. */
async function playerFile(file: string): Promise<Buffer | null> {
  const dir = playerDir();
  playerFiles ??= new Set(
    readdirSync(/*turbopackIgnore: true*/ dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && /\.(js|css|woff2?|svg|gif)$/.test(e.name))
      .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/')),
  );
  if (!playerFiles.has(file)) return null;
  const hit = playerCache.get(file);
  if (hit) return hit;
  // Resolved at runtime; next.config.ts adds the bundles to the /c/** trace explicitly.
  const buf = await readFile(/*turbopackIgnore: true*/ path.join(dir, file));
  playerCache.set(file, buf);
  return buf;
}

// ── extraction ───────────────────────────────────────────────────────────────

export async function extractPackage(ctx: ModuleCtx, packageId: string) {
  const pkg = await ctx.db.h5pPackage.findUniqueOrThrow({ where: { id: packageId } });
  if (!pkg.fileId) throw new Error('No package file');
  const work = await mkdtemp(path.join(tmpdir(), 'hubium-h5p-'));
  const kept: string[] = [];
  try {
    const zipPath = path.join(work, 'package.h5p');
    const src = await ctx.files.open(pkg.fileId);
    await pipeline(src.stream, createWriteStream(zipPath));
    const old = (pkg.files as string[]) ?? [];
    // h5p.json and each library's library.json, read while the files are stored
    const meta = new Map<string, string>();
    let totalBytes = 0;
    let info: ReturnType<typeof checkPackage>;
    // What the package is goes wrong the same way at every try; what storage does may not.
    try {
      await extractZip(zipPath, async (p, stream, size) => {
        if (!allowedFile(p)) return void (await finished(stream.resume()));
        kept.push(p);
        if (p === 'h5p.json' || /^[^/]+\/library\.json$/.test(p)) {
          const chunks: Buffer[] = [];
          for await (const c of stream) chunks.push(c as Buffer);
          const buf = Buffer.concat(chunks);
          meta.set(p, buf.toString('utf8'));
          await stored(ctx.storage.put(key(packageId, p), buf, 'application/json'));
        } else {
          await stored(ctx.storage.put(key(packageId, p), stream, contentTypeFor(p)));
        }
        totalBytes += size;
      });
      const h5pJson = meta.get('h5p.json');
      if (h5pJson === undefined) throw new Error('h5p.json is missing: this is not an H5P package');
      info = checkPackage(kept, h5pJson, (dir) => meta.get(`${dir}/library.json`) ?? null);
    } catch (e) {
      throw e instanceof StorageFailure ? e.cause : permanent(e);
    }
    const stale = old.filter((f) => !kept.includes(f));
    if (stale.length) await ctx.storage.delete(stale.map((f) => key(packageId, f)));
    await ctx.db.h5pPackage.update({
      where: { id: packageId },
      data: {
        status: 'READY',
        error: null,
        title: info.title,
        mainLibrary: info.mainLibrary,
        files: kept as Prisma.InputJsonValue,
        totalBytes: BigInt(totalBytes),
      },
    });
    return info;
  } catch (e) {
    // what this run stored and the package did not have before goes again
    const junk = kept.filter((f) => !((pkg.files as string[]) ?? []).includes(f));
    if (junk.length) await ctx.storage.delete(junk.map((f) => key(packageId, f))).catch(() => {});
    await ctx.db.h5pPackage.update({
      where: { id: packageId },
      data: { status: 'FAILED', error: e instanceof Error ? e.message.slice(0, 1000) : 'Error' },
    });
    throw e;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// ── attempts and grades ──────────────────────────────────────────────────────

/** Puts the learner's grade by the grading method into the gradebook. */
export async function updateGrade(ctx: ModuleCtx, a: H5p, userId: string) {
  if (!a.settings.tracking) return;
  const attempts = await ctx.db.h5pAttempt.findMany({
    where: { activityId: a.id, userId },
    orderBy: { attemptNumber: 'asc' },
    select: { scaled: true },
  });
  const g = gradeOf(
    a.settings.gradeMethod,
    attempts.map((x) => x.scaled),
  );
  await ctx.grades.setGrades(a.id, [
    { userId, rawGrade: g === null ? null : g * a.settings.gradeMax },
  ]);
}

/**
 * Records an xAPI statement from the player as a new attempt when it reports the result
 * of the whole content; other statements are ignored.
 */
export async function recordStatement(ctx: ModuleCtx, a: H5p, userId: string, statement: unknown) {
  const r = resultOf(statement);
  if (!r) return null;
  const create = async () => {
    const last = await ctx.db.h5pAttempt.findFirst({
      where: { activityId: a.id, userId },
      orderBy: { attemptNumber: 'desc' },
      select: { attemptNumber: true },
    });
    return ctx.db.h5pAttempt.create({
      data: {
        activityId: a.id,
        userId,
        attemptNumber: (last?.attemptNumber ?? 0) + 1,
        ...r,
        createdAt: ctx.now,
      },
    });
  };
  let attempt: Awaited<ReturnType<typeof create>> | undefined;
  for (let tries = 0; !attempt; tries++) {
    try {
      attempt = await create();
    } catch (e) {
      // two statements at once took the same number: count again
      if (tries >= 3 || (e as { code?: string }).code !== 'P2002') throw e;
    }
  }
  await updateGrade(ctx, a, userId);
  await ctx.completion.recompute(a.id, userId);
  return attempt;
}

// ── player page ──────────────────────────────────────────────────────────────

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

/**
 * The player's own words (its action bar and dialogs). The LMS page passes them in the
 * frame URL's fragment, which never reaches the server, in the learner's language.
 */
export const PLAYER_STRINGS = [
  'fullscreen',
  'disableFullscreen',
  'copyrights',
  'copyrightInformation',
  'close',
  'title',
  'author',
  'year',
  'source',
  'license',
  'noCopyrights',
  'by',
  'showMore',
  'showLess',
  'confirmDialogHeader',
  'confirmDialogBody',
  'cancelLabel',
  'confirmLabel',
  'contentChanged',
  'startingOver',
] as const;

function playerHtml(o: {
  lang: string;
  title: string;
  contentId: string;
  iri: string;
  app: string;
  frame: boolean;
  copyright: boolean;
  track: boolean;
}): string {
  const cfg = {
    id: o.contentId,
    title: o.title,
    iri: o.iri,
    app: o.app,
    frame: o.frame,
    copyright: o.copyright,
    track: o.track,
  };
  return `<!doctype html>
<html lang="${esc(o.lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.title)}</title>
<style>html,body{margin:0;background:#fff}#h5p{min-height:120px}</style>
<script>
(function(){
  var keys=${jsonScript(PLAYER_STRINGS)},words={},given={};
  try{given=JSON.parse(decodeURIComponent(location.hash.slice(1)))||{}}catch(e){}
  keys.forEach(function(k){if(typeof given[k]==='string')words[k]=given[k].slice(0,300)});
  window.H5PIntegration={l10n:{H5P:words}};
})();
</script>
<script src="runtime/main.bundle.js"></script>
</head><body>
<div id="h5p"></div>
<script>
(function(){
  var cfg=${jsonScript(cfg)};
  var base=new URL('./',location.href).href;
  var tell=function(m){try{parent.postMessage(Object.assign({hubium:'h5p'},m),cfg.app)}catch(e){}};
  new H5PStandalone.H5P(document.getElementById('h5p'),{
    id:cfg.id,h5pJsonPath:base+'pkg',frameJs:base+'runtime/frame.bundle.js',frameCss:base+'runtime/styles/h5p.css',
    frame:cfg.frame,copyright:cfg.copyright,export:false,embed:false,icon:false,fullScreen:true,xAPIObjectIRI:cfg.iri
  }).then(function(){
    var frame=document.querySelector('iframe.h5p-iframe');
    if(frame)frame.setAttribute('title',cfg.title);
    H5P.externalDispatcher.on('xAPI',function(e){
      var s=e&&e.data&&e.data.statement;
      if(!cfg.track||!s||!s.verb||!/\\/(completed|answered)$/.test(s.verb.id||''))return;
      var p=s.context&&s.context.contextActivities&&s.context.contextActivities.parent;
      if(p&&p.length)return;
      fetch(base+'xapi',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(s)})
        .then(function(r){return r.json()}).then(function(j){if(j.recorded)tell({result:true})}).catch(function(){});
    });
  }).catch(function(err){
    document.getElementById('h5p').textContent=String(err&&err.message||err);
  });
  // the LMS page sizes its frame to the content
  var last=0;
  new ResizeObserver(function(){
    var h=Math.ceil(document.documentElement.scrollHeight);
    if(h!==last){last=h;tell({height:h})}
  }).observe(document.body);
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

const json = (body: object, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export const h5p = defineModule<H5pSettingsT>({
  key: 'h5p',
  archetype: 'activity',
  icon: 'Puzzle',
  supports: { grading: true, viewCompletion: true, backup: true },
  reset: {
    async userData(ctx, a) {
      await ctx.db.h5pAttempt.deleteMany({ where: { activityId: a.id } });
    },
  },
  privacy: {
    async export(ctx, userId) {
      return ctx.db.h5pAttempt.findMany({
        where: { userId },
        select: {
          activityId: true,
          attemptNumber: true,
          rawScore: true,
          maxScore: true,
          success: true,
          durationSec: true,
          createdAt: true,
        },
      });
    },
  },
  backup: {
    // the package is unpacked again from the restored file
    async import(ctx, a) {
      const [file] = await ctx.files.list(a.id, 'package');
      if (!file) return;
      const pkg = await ctx.db.h5pPackage.upsert({
        where: { activityId: a.id },
        create: { activityId: a.id, fileId: file.id },
        update: { fileId: file.id, status: 'PROCESSING' },
      });
      await ctx.jobs.enqueue('h5p.extract', { packageId: pkg.id }, { singletonKey: pkg.id });
    },
  },
  settings: {
    schema: H5pSettings as unknown as z.ZodType<H5pSettingsT>,
    defaults: () => H5pSettings.parse({}),
  },
  grading: {
    items: (a) =>
      a.settings.tracking
        ? [
            {
              itemNumber: 0,
              name: '',
              gradeMax: a.settings.gradeMax,
              gradePass: a.settings.gradePass,
            },
          ]
        : [],
  },
  completion: {
    schema: z.object({
      completed: bool(false),
      passed: bool(false),
      minScore: z.coerce.number().min(0).max(100).default(0),
    }),
    async evaluate(ctx, a, userId, rules) {
      const r = rules as { completed: boolean; passed: boolean; minScore: number };
      const attempts = await ctx.db.h5pAttempt.findMany({
        where: { activityId: a.id, userId },
        select: { completion: true, success: true, scaled: true },
      });
      if (!attempts.length) return 'incomplete';
      const best = Math.max(...attempts.map((x) => (x.scaled ?? 0) * 100));
      if (r.completed && !attempts.some((x) => x.completion)) return 'incomplete';
      if (r.minScore && best < r.minScore) return 'fail';
      if (r.passed) {
        if (attempts.some((x) => x.success === true)) return 'pass';
        return attempts.some((x) => x.success === false) ? 'fail' : 'incomplete';
      }
      return 'complete';
    },
  },
  lifecycle: {
    async onDelete(ctx, a) {
      const pkg = await ctx.db.h5pPackage.findUnique({ where: { activityId: a.id } });
      if (pkg) await ctx.storage.delete(((pkg.files as string[]) ?? []).map((f) => key(pkg.id, f)));
    },
  },
  jobs: [
    {
      name: 'h5p.extract',
      async handler(ctx, data: { packageId: string }) {
        // The activity (or its course) may be deleted before the job runs.
        if (!(await ctx.db.h5pPackage.findUnique({ where: { id: data.packageId } })))
          return { skipped: 'package deleted' };
        const info = await extractPackage(ctx, data.packageId);
        return { mainLibrary: info.mainLibrary, libraries: info.libraries.length };
      },
    },
  ],
  actions: {
    attachUpload: defineAction({
      summary: 'Use a finished upload (POST /uploads) as the .h5p package and unpack it',
      input: z.object({ uploadId: z.string().uuid() }),
      async handler(ctx, a, input) {
        const access = await ctx.activities.get(a.id);
        if (!access?.canManage) throw new Error('Only course editors can upload packages');
        const file = await ctx.files.storeUpload(a.id, 'package', input.uploadId, {
          maxBytes: H5P_MAX_BYTES,
          allowedTypes: /^(application\/(zip|x-zip-compressed|octet-stream|x-h5p))$/,
          // a package uploaded again under the same name takes the old one's place
          replace: true,
        });
        const prev = await ctx.db.h5pPackage.findUnique({ where: { activityId: a.id } });
        if (prev?.fileId && prev.fileId !== file.id)
          await ctx.db.file.deleteMany({ where: { id: prev.fileId } });
        const pkg = await ctx.db.h5pPackage.upsert({
          where: { activityId: a.id },
          create: { activityId: a.id, fileId: file.id },
          update: { fileId: file.id, status: 'PROCESSING', error: null },
        });
        await ctx.jobs.enqueue('h5p.extract', { packageId: pkg.id }, { singletonKey: pkg.id });
        return { packageId: pkg.id };
      },
    }),
  },
  async content(ctx, grant, req, p) {
    const app = ctx.content.appOrigin();
    const act = await ctx.db.activity.findUnique({ where: { id: grant.activityId } });
    if (!act) return new Response('Not found', { status: 404 });
    const a = { ...act, settings: parseSettings(h5p, act.settings) } as unknown as H5p;
    const pkg = await ctx.db.h5pPackage.findUnique({ where: { activityId: act.id } });
    if (pkg?.status !== 'READY') return new Response('Package not ready', { status: 404 });
    const [kind, ...rest] = p;

    if (kind === 'runtime') {
      const file = rest.join('/');
      const buf = await playerFile(file);
      if (!buf) return new Response('Not found', { status: 404 });
      return new Response(new Uint8Array(buf), {
        headers: {
          ...contentHeaders(contentTypeFor(file), app),
          'Cache-Control': 'public, max-age=86400',
        },
      });
    }

    if (kind === 'pkg') {
      // Segments may arrive percent-encoded.
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

    const track = a.settings.tracking && grant.data.track === 1;

    if (kind === 'xapi' && req.method === 'POST') {
      if (!track) return json({ recorded: false });
      const text = await req.text();
      if (text.length > MAX_STATEMENT) return json({ recorded: false }, 413);
      let statement: unknown;
      try {
        statement = JSON.parse(text);
      } catch {
        return json({ recorded: false }, 400);
      }
      try {
        const attempt = await recordStatement(ctx, a, grant.userId, statement);
        return json({ recorded: !!attempt });
      } catch (e) {
        logger.error({ err: e, activityId: a.id }, 'H5P result not recorded');
        return json({ recorded: false }, 500);
      }
    }

    if (kind === 'player') {
      const user = await ctx.db.user.findUniqueOrThrow({
        where: { id: grant.userId },
        select: { locale: true },
      });
      return new Response(
        playerHtml({
          lang: user.locale || ctx.locale,
          title: pkg.title || act.name,
          contentId: act.id,
          iri: `${app}/course/${act.courseId}/a/${act.id}`,
          app,
          frame: a.settings.showFrame,
          copyright: a.settings.showCopyright,
          track,
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

export const h5pModules = [h5p];
