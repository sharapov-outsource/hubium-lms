import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Prisma } from '@hubium/db';
import { defineModule, type ModuleCtx } from '@hubium/module-sdk';
import { bool, optionalNumber } from '@hubium/module-sdk/fields';
import { checkUrlShape } from '@hubium/module-sdk/net';
import { decodeJwt } from 'jose';
import { z } from 'zod';
import {
  appUrl,
  autoPostForm,
  claimNonce,
  endpoint,
  issuer,
  jwks,
  LTI,
  parseCustom,
  readHint,
  signHint,
  signPlatformJwt,
  verifyToolJwt,
} from './protocol.ts';

const textToHtml = (t: string) =>
  t.trim()
    ? `<p>${t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>`
    : '';
const htmlToText = (h: string) =>
  h
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();

export * from './protocol.ts';

// mod-lti: LTI 1.3 platform. Tools are registered by administrators; activities launch
// them through OIDC third-party login, receive grades over AGS, read rosters via NRPS and
// pick content with Deep Linking.

const LineItem = z.object({
  n: z.number().int().min(1),
  label: z.string().max(255),
  scoreMaximum: z.number().positive().max(10_000),
  resourceId: z.string().max(255).default(''),
  tag: z.string().max(255).default(''),
});

export const LtiSettings = z.object({
  toolId: z.string().uuid({ message: 'Choose a tool' }),
  customParams: z.string().max(5000).default(''),
  container: z.enum(['iframe', 'window']).default('iframe'),
  height: z.coerce.number().int().min(300).max(3000).default(700),
  sendGrades: bool(true),
  gradeMax: z.coerce.number().min(1).max(10_000).default(100),
  gradePass: optionalNumber(0, 10_000),
  /** Set by Deep Linking: the launch URL of the chosen content. */
  contentUrl: z.string().max(2000).default(''),
  contentTitle: z.string().max(255).default(''),
  /** Columns the tool added over AGS (the default one is the activity's own). */
  lineItems: z.array(LineItem).max(100).default([]),
});

export type LtiSettingsT = z.output<typeof LtiSettings>;
type Db = Prisma.TransactionClient;

// ── tool registry (admin) ────────────────────────────────────────────────────

export const ToolInput = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(255),
  oidcLoginUrl: z.string().url(),
  targetLinkUri: z.string().url(),
  redirectUris: z
    .string()
    .transform((s) => s.split(/\s+/).filter(Boolean))
    .pipe(z.array(z.string().url()).min(1, 'Add at least one redirect URI')),
  jwksUrl: z
    .string()
    .trim()
    .transform((v) => v || null)
    .pipe(z.string().url().nullable()),
  publicKeyPem: z
    .string()
    .trim()
    .transform((v) => v || null)
    .refine((v) => v === null || v.includes('BEGIN PUBLIC KEY'), 'Paste a PEM public key'),
  deepLinkingUrl: z
    .string()
    .trim()
    .transform((v) => v || null)
    .pipe(z.string().url().nullable()),
  customParams: z.string().max(5000).default(''),
  sendName: bool(true),
  sendEmail: bool(false),
  enabled: bool(true),
});

export async function saveTool(db: Db, raw: unknown) {
  const input = ToolInput.parse(raw);
  if (!input.jwksUrl && !input.publicKeyPem) throw new Error('Provide a JWKS URL or a public key');
  if (input.jwksUrl) checkUrlShape(input.jwksUrl);
  const data = {
    name: input.name,
    oidcLoginUrl: input.oidcLoginUrl,
    targetLinkUri: input.targetLinkUri,
    redirectUris: input.redirectUris,
    jwksUrl: input.jwksUrl,
    publicKeyPem: input.publicKeyPem,
    deepLinkingUrl: input.deepLinkingUrl,
    customParams: parseCustom(input.customParams) as Prisma.InputJsonValue,
    sendName: input.sendName,
    sendEmail: input.sendEmail,
    enabled: input.enabled,
  };
  if (input.id) return db.ltiTool.update({ where: { id: input.id }, data });
  return db.ltiTool.create({
    data: { ...data, clientId: randomBytes(12).toString('hex'), deploymentId: randomUUID() },
  });
}

/** What an administrator copies into the tool's configuration. */
export function platformInfo(tool?: { clientId: string; deploymentId: string }) {
  return {
    issuer: issuer(),
    clientId: tool?.clientId,
    deploymentId: tool?.deploymentId,
    authUrl: endpoint('auth'),
    tokenUrl: endpoint('token'),
    jwksUrl: endpoint('jwks'),
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

const html = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
const json = (body: unknown, status = 200, type = 'application/json') =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': type, 'Cache-Control': 'no-store' },
  });
const fail = (status: number, message: string) => json({ error: message }, status);

async function params(req: Request): Promise<URLSearchParams> {
  const url = new URL(req.url);
  if (req.method !== 'POST') return url.searchParams;
  const body = await req.text();
  return new URLSearchParams(body);
}

async function loadLti(db: Db, activityId: string) {
  const act = await db.activity.findUnique({ where: { id: activityId } });
  if (act?.moduleKey !== 'lti' || act.deletedAt) return null;
  const s = LtiSettings.safeParse(act.settings);
  if (!s.success) return null;
  const tool = await db.ltiTool.findUnique({ where: { id: s.data.toolId } });
  return tool ? { act, settings: s.data, tool } : null;
}

/**
 * LIS roles of people in the activity: Instructor for those who grade there (grade:edit),
 * whatever their role is called, Learner for the rest; Administrator added for site
 * administrators. Worked out for everyone at once.
 */
async function lisRolesOf(
  ctx: ModuleCtx,
  activityId: string,
  userIds: string[],
): Promise<Map<string, string[]>> {
  const [graders, admins] = await Promise.all([
    ctx.perm.usersWithCap('grade:edit', activityId),
    ctx.db.user.findMany({
      where: { id: { in: userIds }, isSiteAdmin: true },
      select: { id: true },
    }),
  ]);
  const teaching = new Set(graders);
  const admin = new Set(admins.map((u) => u.id));
  return new Map(
    userIds.map((id) => [
      id,
      [
        teaching.has(id) ? LTI.roles.instructor : LTI.roles.learner,
        ...(admin.has(id) ? [LTI.roles.admin] : []),
      ],
    ]),
  );
}

const lineItemsUrl = (activityId: string) => endpoint(`ags/${activityId}/lineitems`);
const lineItemUrl = (activityId: string, n: number) => `${lineItemsUrl(activityId)}/${n}`;

function lineItemsOf(act: { id: string; name: string }, s: LtiSettingsT) {
  const base = s.sendGrades
    ? [{ n: 0, label: act.name, scoreMaximum: s.gradeMax, resourceId: '', tag: '' }]
    : [];
  return [...base, ...s.lineItems];
}

/** AGS score values (activityProgress, gradingProgress) the specification defines. */
const ACTIVITY_PROGRESS = new Set([
  'Initialized',
  'Started',
  'InProgress',
  'Submitted',
  'Completed',
]);
const GRADING_PROGRESS = new Set(['FullyGraded', 'Pending', 'PendingManual', 'Failed', 'NotReady']);

const lineItemJson = (
  act: { id: string },
  li:
    | z.output<typeof LineItem>
    | { n: number; label: string; scoreMaximum: number; resourceId: string; tag: string },
) => ({
  id: lineItemUrl(act.id, li.n),
  label: li.label,
  scoreMaximum: li.scoreMaximum,
  resourceLinkId: act.id,
  ...(li.resourceId ? { resourceId: li.resourceId } : {}),
  ...(li.tag ? { tag: li.tag } : {}),
});

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Resolves a bearer token to its tool if it carries one of the scopes. */
async function bearer(db: Db, req: Request, scopes: string[]) {
  const m = (req.headers.get('authorization') ?? '').match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const t = await db.ltiAccessToken.findUnique({
    where: { tokenHash: sha(m[1]!) },
    include: { tool: true },
  });
  if (!t || t.expiresAt < new Date() || !t.tool.enabled) return null;
  return t.scopes.some((s) => scopes.includes(s)) ? t.tool : null;
}

// ── launch messages ──────────────────────────────────────────────────────────

async function idTokenClaims(ctx: ModuleCtx, hint: NonNullable<ReturnType<typeof readHint>>) {
  const found = await loadLti(ctx.db, hint.a);
  if (!found) throw new Error('Unknown activity');
  const { act, settings: s, tool } = found;
  const [course, user, roles, siteName] = await Promise.all([
    ctx.db.course.findUniqueOrThrow({
      where: { id: act.courseId },
      select: { id: true, shortName: true, fullName: true },
    }),
    ctx.db.user.findUniqueOrThrow({
      where: { id: hint.u },
      select: {
        id: true,
        name: true,
        firstName: true,
        lastName: true,
        email: true,
        emailPlaceholder: true,
        locale: true,
      },
    }),
    lisRolesOf(ctx, act.id, [hint.u]).then((m) => m.get(hint.u)!),
    // Tools show the platform name to users: the site's, not the engine's.
    ctx.db.siteSetting
      .findUnique({ where: { key: 'site.name' } })
      .then((r) => (typeof r?.value === 'string' && r.value.trim() ? r.value : 'Hubium LMS')),
  ]);
  const returnUrl = `${appUrl()}/course/${course.id}/a/${act.id}`;
  const custom = {
    ...(tool.customParams as Record<string, string>),
    ...parseCustom(s.customParams),
  };
  const claims: Record<string, unknown> = {
    sub: user.id,
    [LTI.claim('message_type')]: hint.m,
    [LTI.claim('version')]: LTI.version,
    [LTI.claim('deployment_id')]: tool.deploymentId,
    [LTI.claim('roles')]: roles,
    [LTI.claim('context')]: {
      id: course.id,
      label: course.shortName,
      title: course.fullName,
      type: ['http://purl.imsglobal.org/vocab/lis/v2/course#CourseOffering'],
    },
    [LTI.claim('tool_platform')]: {
      guid: sha(appUrl()).slice(0, 32),
      name: siteName,
      product_family_code: 'hubium',
      url: appUrl(),
    },
    [LTI.claim('launch_presentation')]: {
      document_target: s.container,
      return_url: returnUrl,
      locale: user.locale || ctx.locale,
    },
    ...(Object.keys(custom).length ? { [LTI.claim('custom')]: custom } : {}),
    ...(tool.sendName
      ? { name: user.name, given_name: user.firstName, family_name: user.lastName }
      : {}),
    ...(tool.sendEmail && !user.emailPlaceholder ? { email: user.email } : {}),
  };
  if (hint.m === 'LtiResourceLinkRequest') {
    claims[LTI.claim('target_link_uri')] = s.contentUrl || tool.targetLinkUri;
    claims[LTI.claim('resource_link')] = { id: act.id, title: act.name };
    claims[LTI.ags] = {
      scope: [LTI.scopes.lineitem, LTI.scopes.lineitemRead, LTI.scopes.result, LTI.scopes.score],
      lineitems: lineItemsUrl(act.id),
      ...(s.sendGrades ? { lineitem: lineItemUrl(act.id, 0) } : {}),
    };
    claims[LTI.nrps] = {
      context_memberships_url: endpoint(`nrps/${act.id}/memberships`),
      service_versions: ['2.0'],
    };
  } else {
    claims[LTI.claim('target_link_uri')] = tool.deepLinkingUrl ?? tool.targetLinkUri;
    claims[LTI.dl('deep_linking_settings')] = {
      deep_link_return_url: endpoint(`deeplink/${act.id}`),
      accept_types: ['ltiResourceLink'],
      accept_presentation_document_targets: ['iframe', 'window'],
      accept_multiple: false,
      auto_create: true,
      title: act.name,
      data: signHint({ a: act.id, u: user.id, t: tool.id, m: 'LtiDeepLinkingRequest' }, 3600),
    };
  }
  return { claims, tool };
}

async function handleLaunch(ctx: ModuleCtx, activityId: string, deepLink: boolean) {
  if (ctx.actor.kind !== 'user') return fail(401, 'Sign in');
  const access = await ctx.activities.get(activityId);
  const found = await loadLti(ctx.db, activityId);
  if (!access?.canOpen || !found) return fail(404, 'Not found');
  if (!found.tool.enabled) return fail(409, 'This tool is disabled');
  if (deepLink) {
    if (!(await ctx.perm.can('mod.lti:manage', found.act.courseId))) return fail(403, 'Forbidden');
    if (!found.tool.deepLinkingUrl) return fail(409, 'The tool does not support content selection');
  } else if (!(await ctx.perm.can('mod.lti:launch', activityId))) {
    return fail(403, 'Forbidden');
  }
  const hint = signHint({
    a: activityId,
    u: ctx.actor.userId,
    t: found.tool.id,
    m: deepLink ? 'LtiDeepLinkingRequest' : 'LtiResourceLinkRequest',
  });
  const login = new URL(found.tool.oidcLoginUrl);
  login.searchParams.set('iss', issuer());
  login.searchParams.set('login_hint', ctx.actor.userId);
  login.searchParams.set(
    'target_link_uri',
    deepLink
      ? (found.tool.deepLinkingUrl ?? found.tool.targetLinkUri)
      : found.settings.contentUrl || found.tool.targetLinkUri,
  );
  login.searchParams.set('lti_message_hint', hint);
  login.searchParams.set('client_id', found.tool.clientId);
  login.searchParams.set('lti_deployment_id', found.tool.deploymentId);
  await ctx.log('lti.launch', { activityId, deepLink });
  return new Response(null, {
    status: 302,
    headers: { Location: login.toString(), 'Cache-Control': 'no-store' },
  });
}

async function handleAuth(ctx: ModuleCtx, req: Request) {
  const p = await params(req);
  const clientId = p.get('client_id') ?? '';
  const redirectUri = p.get('redirect_uri') ?? '';
  const tool = clientId ? await ctx.db.ltiTool.findUnique({ where: { clientId } }) : null;
  if (!tool?.enabled) return fail(400, 'Unknown client_id');
  // Errors may only be sent back to a registered redirect URI.
  if (!tool.redirectUris.includes(redirectUri)) return fail(400, 'redirect_uri is not registered');
  const state = p.get('state') ?? '';
  const back = (error: string, description: string) =>
    html(autoPostForm(redirectUri, { error, error_description: description, state }));
  if (p.get('response_type') !== 'id_token')
    return back('unsupported_response_type', 'id_token only');
  if (!(p.get('scope') ?? '').split(' ').includes('openid'))
    return back('invalid_scope', 'openid required');
  const nonce = p.get('nonce');
  if (!nonce) return back('invalid_request', 'nonce required');
  const hint = readHint(p.get('lti_message_hint'));
  if (!hint || hint.t !== tool.id || hint.u !== p.get('login_hint')) {
    return back('invalid_request', 'Invalid or expired launch');
  }
  // When a session is present it must belong to the launching user.
  if (ctx.actor.kind === 'user' && ctx.actor.userId !== hint.u)
    return back('login_required', 'User mismatch');
  if (!(await claimNonce(ctx.db, `auth:${nonce}`))) return back('invalid_request', 'nonce reused');
  // the hint is the only proof of who launches (the frame has no session cookie): it works
  // once, or anyone who saw it (it is in the tool's logs) could take more id_tokens with it
  const hintKey = createHash('sha256').update(p.get('lti_message_hint')!).digest('base64url');
  if (!(await claimNonce(ctx.db, `hint:${hintKey}`)))
    return back('invalid_request', 'Invalid or expired launch');
  const { claims } = await idTokenClaims(ctx, hint);
  const idToken = await signPlatformJwt(
    ctx.db,
    { ...claims, nonce, azp: tool.clientId },
    tool.clientId,
  );
  return html(autoPostForm(redirectUri, { id_token: idToken, state }));
}

const ALL_SCOPES = Object.values(LTI.scopes) as string[];

async function handleToken(ctx: ModuleCtx, req: Request) {
  const p = await params(req);
  if (p.get('grant_type') !== 'client_credentials')
    return json({ error: 'unsupported_grant_type' }, 400);
  if (p.get('client_assertion_type') !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer') {
    return json({ error: 'invalid_client' }, 401);
  }
  const assertion = p.get('client_assertion') ?? '';
  let clientId = '';
  try {
    clientId = String(decodeJwt(assertion).sub ?? '');
  } catch {
    return json({ error: 'invalid_client' }, 401);
  }
  const tool = clientId ? await ctx.db.ltiTool.findUnique({ where: { clientId } }) : null;
  if (!tool?.enabled) return json({ error: 'invalid_client' }, 401);
  try {
    const { payload } = await verifyToolJwt(tool, assertion, {
      audience: endpoint('token'),
      issuer: clientId,
      subject: clientId,
    });
    if (!payload.jti || !(await claimNonce(ctx.db, `jti:${payload.jti}`, 3600))) {
      return json({ error: 'invalid_client', error_description: 'jti reused' }, 401);
    }
  } catch (e) {
    return json(
      { error: 'invalid_client', error_description: e instanceof Error ? e.message : '' },
      401,
    );
  }
  const scopes = (p.get('scope') ?? '').split(' ').filter((s) => ALL_SCOPES.includes(s));
  if (!scopes.length) return json({ error: 'invalid_scope' }, 400);
  const token = randomBytes(32).toString('base64url');
  await ctx.db.ltiAccessToken.create({
    data: {
      toolId: tool.id,
      tokenHash: sha(token),
      scopes,
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  return json({
    access_token: token,
    token_type: 'Bearer',
    expires_in: 3600,
    scope: scopes.join(' '),
  });
}

async function handleAgs(ctx: ModuleCtx, req: Request, activityId: string, rest: string[]) {
  const found = await loadLti(ctx.db, activityId);
  if (!found) return fail(404, 'Not found');
  const { act, settings: s } = found;
  const needs =
    rest[1] === 'scores'
      ? [LTI.scopes.score]
      : rest[1] === 'results'
        ? [LTI.scopes.result]
        : req.method === 'GET'
          ? [LTI.scopes.lineitem, LTI.scopes.lineitemRead]
          : [LTI.scopes.lineitem];
  const tool = await bearer(ctx.db, req, needs);
  if (!tool || tool.id !== found.tool.id) return fail(401, 'Invalid token');
  const items = lineItemsOf(act, s);
  // What the tool writes is held to the settings' schema, as a teacher's form is: settings
  // that do not parse would stop the activity launching for everyone. The tool is told why.
  const saveSettings = async (next: LtiSettingsT): Promise<Response | null> => {
    const parsed = LtiSettings.safeParse(next);
    if (!parsed.success)
      return fail(
        400,
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    await ctx.db.activity.update({
      where: { id: act.id },
      data: { settings: parsed.data as unknown as Prisma.InputJsonValue },
    });
    await ctx.grades.syncItems(act.id);
    return null;
  };

  if (!rest.length) {
    if (req.method === 'GET') {
      const resourceId = new URL(req.url).searchParams.get('resource_id');
      const tag = new URL(req.url).searchParams.get('tag');
      const list = items.filter(
        (i) => (!resourceId || i.resourceId === resourceId) && (!tag || i.tag === tag),
      );
      return json(
        list.map((i) => lineItemJson(act, i)),
        200,
        'application/vnd.ims.lis.v2.lineitemcontainer+json',
      );
    }
    if (req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const scoreMaximum = Number(body.scoreMaximum);
      if (!(scoreMaximum > 0) || typeof body.label !== 'string')
        return fail(400, 'label and scoreMaximum are required');
      const n = Math.max(0, ...s.lineItems.map((i) => i.n)) + 1;
      const li = {
        n,
        label: body.label.slice(0, 255),
        scoreMaximum,
        resourceId: String(body.resourceId ?? ''),
        tag: String(body.tag ?? ''),
      };
      const refused = await saveSettings({ ...s, lineItems: [...s.lineItems, li] });
      if (refused) return refused;
      return json(lineItemJson(act, li), 201, 'application/vnd.ims.lis.v2.lineitem+json');
    }
    return fail(405, 'Method not allowed');
  }

  const n = Number(rest[0]);
  const li = items.find((i) => i.n === n);
  if (!li) return fail(404, 'No such line item');

  if (rest.length === 1) {
    if (req.method === 'GET')
      return json(lineItemJson(act, li), 200, 'application/vnd.ims.lis.v2.lineitem+json');
    if (req.method === 'PUT') {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      let refused: Response | null;
      if (n === 0) {
        const max = Number(body.scoreMaximum);
        refused = await saveSettings({ ...s, gradeMax: max > 0 ? max : s.gradeMax });
      } else {
        refused = await saveSettings({
          ...s,
          lineItems: s.lineItems.map((x) =>
            x.n === n
              ? {
                  ...x,
                  label: typeof body.label === 'string' ? body.label.slice(0, 255) : x.label,
                  scoreMaximum:
                    Number(body.scoreMaximum) > 0 ? Number(body.scoreMaximum) : x.scoreMaximum,
                }
              : x,
          ),
        });
      }
      if (refused) return refused;
      const fresh = lineItemsOf(act, (await loadLti(ctx.db, act.id))!.settings).find(
        (x) => x.n === n,
      )!;
      return json(lineItemJson(act, fresh), 200, 'application/vnd.ims.lis.v2.lineitem+json');
    }
    if (req.method === 'DELETE') {
      if (n === 0) return fail(400, 'The default line item cannot be deleted');
      const refused = await saveSettings({
        ...s,
        lineItems: s.lineItems.filter((x) => x.n !== n),
      });
      if (refused) return refused;
      // a line item made later may take the number again, and starts with no scores
      await ctx.db.ltiScore.deleteMany({ where: { activityId: act.id, itemNumber: n } });
      return new Response(null, { status: 204 });
    }
    return fail(405, 'Method not allowed');
  }

  const item = await ctx.db.gradeItem.findFirst({ where: { activityId: act.id, itemNumber: n } });
  if (rest[1] === 'scores' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const userId = String(body.userId ?? '');
    const enrolled = await ctx.db.enrolment.findFirst({
      where: { courseId: act.courseId, userId, status: 'ACTIVE' },
    });
    if (!enrolled) return fail(400, 'Unknown userId');
    if (!item) return fail(409, 'Grades are not enabled for this activity');
    const timestamp = typeof body.timestamp === 'string' ? new Date(body.timestamp) : null;
    if (
      !timestamp ||
      Number.isNaN(timestamp.getTime()) ||
      !ACTIVITY_PROGRESS.has(String(body.activityProgress)) ||
      !GRADING_PROGRESS.has(String(body.gradingProgress))
    )
      return fail(400, 'timestamp, activityProgress and gradingProgress are required');
    // Only a fully graded score is the grade: one still being graded leaves the grade empty
    // until the tool sends the final one.
    const given =
      body.scoreGiven === undefined ||
      body.scoreGiven === null ||
      body.gradingProgress !== 'FullyGraded'
        ? null
        : Number(body.scoreGiven);
    const max = Number(body.scoreMaximum ?? li.scoreMaximum);
    if (given !== null && (!(max > 0) || given < 0 || Number.isNaN(given)))
      return fail(400, 'Invalid score');
    // A score older than the last one taken (by the tool's clock) arrived out of order: the
    // newer one stands. The same time again is taken, as the specification allows.
    const taken = await ctx.db.$queryRaw<unknown[]>`
      INSERT INTO "LtiScore" ("activityId", "itemNumber", "userId", "timestamp")
      VALUES (${act.id}::uuid, ${n}, ${userId}::uuid, ${timestamp})
      ON CONFLICT ("activityId", "itemNumber", "userId") DO UPDATE
        SET "timestamp" = EXCLUDED."timestamp"
        WHERE "LtiScore"."timestamp" <= EXCLUDED."timestamp"
      RETURNING 1`;
    if (!taken.length) return fail(409, 'A newer score has already been received');
    const raw = given === null ? null : (given / max) * Number(item.gradeMax);
    await ctx.grades.setGrades(act.id, [
      {
        userId,
        rawGrade: raw === null ? null : Math.min(Number(item.gradeMax), raw),
        // AGS comments are plain text: escape them so the gradebook shows them literally.
        feedback:
          typeof body.comment === 'string' ? textToHtml(body.comment.slice(0, 10_000)) : undefined,
        itemNumber: n,
      },
    ]);
    if (n === 0) await ctx.completion.recompute(act.id, userId);
    await ctx.log('lti.score', { activityId: act.id, userId, n });
    return new Response(null, { status: 200 });
  }
  if (rest[1] === 'results' && req.method === 'GET') {
    const userFilter = new URL(req.url).searchParams.get('user_id');
    const grades = item
      ? await ctx.db.grade.findMany({
          where: { gradeItemId: item.id, ...(userFilter ? { userId: userFilter } : {}) },
        })
      : [];
    return json(
      grades.map((g) => ({
        id: `${lineItemUrl(act.id, n)}/results/${g.userId}`,
        scoreOf: lineItemUrl(act.id, n),
        userId: g.userId,
        resultScore:
          g.finalGrade === null
            ? null
            : (Number(g.finalGrade) / Number(item!.gradeMax)) * li.scoreMaximum,
        resultMaximum: li.scoreMaximum,
        ...(g.feedback ? { comment: htmlToText(g.feedback) } : {}),
      })),
      200,
      'application/vnd.ims.lis.v2.resultcontainer+json',
    );
  }
  return fail(405, 'Method not allowed');
}

async function handleNrps(ctx: ModuleCtx, req: Request, activityId: string) {
  const found = await loadLti(ctx.db, activityId);
  if (!found) return fail(404, 'Not found');
  const tool = await bearer(ctx.db, req, [LTI.scopes.nrps]);
  if (!tool || tool.id !== found.tool.id) return fail(401, 'Invalid token');
  const course = await ctx.db.course.findUniqueOrThrow({
    where: { id: found.act.courseId },
    select: { id: true, shortName: true, fullName: true },
  });
  const enrolments = await ctx.db.enrolment.findMany({
    where: { courseId: course.id, status: 'ACTIVE', user: { status: 'ACTIVE' } },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          firstName: true,
          lastName: true,
          email: true,
          emailPlaceholder: true,
        },
      },
    },
    distinct: ['userId'],
  });
  const roles = await lisRolesOf(
    ctx,
    activityId,
    enrolments.map((e) => e.user.id),
  );
  const members = enrolments.map((e) => ({
    status: 'Active',
    user_id: e.user.id,
    roles: roles.get(e.user.id)!,
    ...(found.tool.sendName
      ? { name: e.user.name, given_name: e.user.firstName, family_name: e.user.lastName }
      : {}),
    ...(found.tool.sendEmail && !e.user.emailPlaceholder ? { email: e.user.email } : {}),
  }));
  return json(
    {
      id: endpoint(`nrps/${activityId}/memberships`),
      context: { id: course.id, label: course.shortName, title: course.fullName },
      members,
    },
    200,
    'application/vnd.ims.lti-nrps.v2.membershipcontainer+json',
  );
}

const isHttpUrl = (u: string) => {
  try {
    return ['https:', 'http:'].includes(new URL(u).protocol);
  } catch {
    return false;
  }
};

async function handleDeepLink(ctx: ModuleCtx, req: Request, activityId: string) {
  const found = await loadLti(ctx.db, activityId);
  if (!found) return fail(404, 'Not found');
  const p = await params(req);
  const jwt = p.get('JWT') ?? '';
  let payload: Record<string, unknown>;
  try {
    payload = (
      await verifyToolJwt(found.tool, jwt, { audience: issuer(), issuer: found.tool.clientId })
    ).payload as Record<string, unknown>;
  } catch (e) {
    return fail(400, `Invalid deep linking response: ${e instanceof Error ? e.message : ''}`);
  }
  if (payload[LTI.claim('message_type')] !== 'LtiDeepLinkingResponse')
    return fail(400, 'Wrong message type');
  if (payload[LTI.claim('deployment_id')] !== found.tool.deploymentId)
    return fail(400, 'Wrong deployment');
  // `data` must be the one we put in a deep linking request (not, say, a learner's launch
  // hint the tool has also seen), and its user must still be allowed to pick content.
  const data = readHint(String(payload[LTI.dl('data')] ?? ''));
  if (data?.m !== 'LtiDeepLinkingRequest' || data.a !== activityId || data.t !== found.tool.id)
    return fail(400, 'Invalid data');
  const picker = await ctx.db.user.findUnique({
    where: { id: data.u },
    select: { isSiteAdmin: true },
  });
  if (
    !picker ||
    !(
      picker.isSiteAdmin ||
      (await ctx.perm.usersWithCap('mod.lti:manage', activityId)).includes(data.u)
    )
  )
    return fail(403, 'Forbidden');
  const once = String(payload.nonce ?? payload.jti ?? '');
  if (!once || !(await claimNonce(ctx.db, `dl:${once}`, 3600)))
    return fail(400, 'Deep linking response reused');
  const items = (payload[LTI.dl('content_items')] as Record<string, unknown>[] | undefined) ?? [];
  const link = items.find((i) => i.type === 'ltiResourceLink');
  if (link) {
    const custom = (link.custom ?? {}) as Record<string, string>;
    const lineItem = link.lineItem as { scoreMaximum?: number } | undefined;
    const parsed = LtiSettings.safeParse({
      ...found.settings,
      contentUrl: typeof link.url === 'string' ? link.url : found.settings.contentUrl,
      contentTitle:
        typeof link.title === 'string' ? link.title.slice(0, 255) : found.settings.contentTitle,
      customParams: [
        found.settings.customParams,
        ...Object.entries(custom).map(([k, v]) => `${k}=${v}`),
      ]
        .filter(Boolean)
        .join('\n'),
      ...(lineItem?.scoreMaximum
        ? { sendGrades: true, gradeMax: Number(lineItem.scoreMaximum) }
        : {}),
    });
    if (!parsed.success || (parsed.data.contentUrl && !isHttpUrl(parsed.data.contentUrl)))
      return fail(400, 'Invalid content item');
    const next = parsed.data;
    await ctx.db.activity.update({
      where: { id: activityId },
      data: { settings: next as unknown as Prisma.InputJsonValue },
    });
    if (lineItem?.scoreMaximum) await ctx.grades.syncItems(activityId);
  }
  const back = `${appUrl()}/course/${found.act.courseId}/a/${activityId}`;
  return html(`<!doctype html><html><head><meta charset="utf-8"><title>OK</title></head><body>
<p>${link ? 'Content selected.' : 'Nothing selected.'} <a href="${back}" target="_top">Back to the course</a></p>
<script>try{window.top.location.href=${JSON.stringify(back)}}catch(e){}</script></body></html>`);
}

export const lti = defineModule<LtiSettingsT>({
  key: 'lti',
  archetype: 'activity',
  icon: 'Plug',
  supports: { grading: true, viewCompletion: true, backup: true },
  settings: {
    schema: LtiSettings as unknown as z.ZodType<LtiSettingsT>,
    defaults: () => LtiSettings.parse({ toolId: '00000000-0000-0000-0000-000000000000' }),
    // the tool adds and removes its grade columns through AGS
    managed: ['lineItems'],
  },
  grading: {
    items: (a) =>
      a.settings.sendGrades
        ? [
            {
              itemNumber: 0,
              name: '',
              gradeMax: a.settings.gradeMax,
              gradePass: a.settings.gradePass,
            },
            ...a.settings.lineItems.map((li) => ({
              itemNumber: li.n,
              name: li.label,
              gradeMax: li.scoreMaximum,
            })),
          ]
        : [],
  },
  reset: {
    // the grades go with the course reset: the tool's next scores start afresh
    async userData(ctx, a) {
      await ctx.db.ltiScore.deleteMany({ where: { activityId: a.id } });
    },
  },
  privacy: {
    async export(ctx, userId) {
      return ctx.db.ltiScore.findMany({
        where: { userId },
        select: { activityId: true, itemNumber: true, timestamp: true },
      });
    },
    async erase(ctx, userId) {
      await ctx.db.ltiScore.deleteMany({ where: { userId } });
    },
  },
  cron: [
    {
      name: 'lti.cleanup',
      schedule: '37 * * * *',
      async handler(ctx) {
        const now = new Date();
        const [n, t] = await Promise.all([
          ctx.db.ltiNonce.deleteMany({ where: { expiresAt: { lt: now } } }),
          ctx.db.ltiAccessToken.deleteMany({ where: { expiresAt: { lt: now } } }),
        ]);
        return { nonces: n.count, tokens: t.count };
      },
    },
  ],
  async http(ctx, req, p) {
    const [kind, id, ...rest] = p;
    switch (kind) {
      case 'jwks':
        return json(await jwks(ctx.db));
      case 'tools': {
        // tool picker for the activity form
        if (ctx.actor.kind !== 'user') return fail(401, 'Sign in');
        const tools = await ctx.db.ltiTool.findMany({
          where: { enabled: true },
          select: { id: true, name: true, deepLinkingUrl: true },
          orderBy: { name: 'asc' },
        });
        return json(
          tools.map((t) => ({ id: t.id, name: t.name, deepLinking: !!t.deepLinkingUrl })),
        );
      }
      case 'launch':
        return id
          ? handleLaunch(ctx, id, new URL(req.url).searchParams.get('dl') === '1')
          : fail(404, 'Not found');
      case 'auth':
        return handleAuth(ctx, req);
      case 'token':
        return req.method === 'POST' ? handleToken(ctx, req) : fail(405, 'POST only');
      case 'ags':
        return id && rest[0] === 'lineitems'
          ? handleAgs(ctx, req, id, rest.slice(1))
          : fail(404, 'Not found');
      case 'nrps':
        return id && rest[0] === 'memberships' && req.method === 'GET'
          ? handleNrps(ctx, req, id)
          : fail(404, 'Not found');
      case 'deeplink':
        return id && req.method === 'POST' ? handleDeepLink(ctx, req, id) : fail(404, 'Not found');
      default:
        return fail(404, 'Not found');
    }
  },
});

export const ltiModules = [lti];
