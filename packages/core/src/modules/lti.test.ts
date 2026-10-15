import { endpoint, issuer, LTI, saveTool } from '@hubium/mod-lti/server';
import { createLocalJWKSet, exportSPKI, generateKeyPair, type JWK, jwtVerify, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { updateActivity } from '../courses/activities.ts';
import { buildModuleCtx } from './module-ctx.ts';
import { getModule } from './registry.ts';

const REDIRECT = 'https://tool.test/launch';

describe('mod-lti (LTI 1.3 platform)', () => {
  const t = useTestDb();
  let f: Awaited<ReturnType<typeof courseFixture>>;
  let toolKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let tool: { id: string; clientId: string; deploymentId: string };
  let ltiId: string;

  const http = async (
    user: string | 'anon',
    method: string,
    path: string,
    init: RequestInit = {},
  ) => {
    const ctx = buildModuleCtx(await ctxFor(t.db, user === 'anon' ? 'system' : user));
    const anon = user === 'anon' ? { ...ctx, actor: { kind: 'anonymous' as const } } : ctx;
    const url = `http://localhost:3000/api/mod/lti/${path}`;
    return getModule('lti')!.http!(
      anon,
      new Request(url, { method, ...init }),
      new URL(url).pathname.split('/').slice(4),
    );
  };

  /** Runs login initiation + authorization like a browser and returns the id_token. */
  const launch = async (user: string, query = '') => {
    const r = await http(user, 'GET', `launch/${ltiId}${query}`);
    expect(r.status).toBe(302);
    const login = new URL(r.headers.get('location')!);
    expect(login.origin + login.pathname).toBe('https://tool.test/login');
    const p = new URLSearchParams({
      scope: 'openid',
      response_type: 'id_token',
      response_mode: 'form_post',
      prompt: 'none',
      client_id: login.searchParams.get('client_id')!,
      redirect_uri: REDIRECT,
      login_hint: login.searchParams.get('login_hint')!,
      lti_message_hint: login.searchParams.get('lti_message_hint')!,
      state: 'st-1',
      nonce: `n-${Math.random()}`,
    });
    const auth = await http(user, 'POST', 'auth', {
      body: p.toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const html = await auth.text();
    return { html, idToken: html.match(/name="id_token" value="([^"]+)"/)?.[1], params: p };
  };

  const verifyIdToken = async (jwt: string) => {
    const keys = (await (await http('anon', 'GET', 'jwks')).json()) as { keys: JWK[] };
    return (
      await jwtVerify(jwt, createLocalJWKSet(keys), { issuer: issuer(), audience: tool.clientId })
    ).payload;
  };

  const serviceToken = async (scope: string) => {
    const assertion = await new SignJWT({ jti: crypto.randomUUID() })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(tool.clientId)
      .setSubject(tool.clientId)
      .setAudience(endpoint('token'))
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(toolKey);
    const r = await http('anon', 'POST', 'token', {
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion,
        scope,
      }).toString(),
    });
    return r;
  };

  beforeAll(async () => {
    f = await courseFixture(t.db, 'LTI1');
    const pair = await generateKeyPair('RS256', { extractable: true });
    toolKey = pair.privateKey;
    tool = await saveTool(t.db, {
      name: 'Test tool',
      oidcLoginUrl: 'https://tool.test/login',
      targetLinkUri: 'https://tool.test/launch',
      redirectUris: REDIRECT,
      jwksUrl: '',
      publicKeyPem: await exportSPKI(pair.publicKey),
      deepLinkingUrl: 'https://tool.test/deeplink',
      customParams: 'Course_Code=$Context.label',
      sendEmail: 'on',
    });
    ltiId = (
      await f.addActivity('lti', 'Тренажёр', {
        toolId: tool.id,
        gradeMax: 100,
        customParams: 'level=2',
      })
    ).id;
  });

  it('launches with an id_token signed by the platform', async () => {
    const { idToken } = await launch(f.users.student1!);
    expect(idToken).toBeTruthy();
    const c = await verifyIdToken(idToken!);
    expect(c.sub).toBe(f.users.student1);
    expect(c[LTI.claim('message_type')]).toBe('LtiResourceLinkRequest');
    expect(c[LTI.claim('version')]).toBe('1.3.0');
    expect(c[LTI.claim('deployment_id')]).toBe(tool.deploymentId);
    expect(c[LTI.claim('roles')]).toEqual([LTI.roles.learner]);
    expect(c[LTI.claim('resource_link')]).toEqual({ id: ltiId, title: 'Тренажёр' });
    expect(c[LTI.claim('context')]).toMatchObject({ id: f.courseId, label: 'LTI1' });
    expect(c[LTI.claim('custom')]).toEqual({ course_code: '$Context.label', level: '2' });
    expect(c.email).toBe('student1@hubium.local');
    expect((c[LTI.ags] as { lineitem: string }).lineitem).toBe(
      endpoint(`ags/${ltiId}/lineitems/0`),
    );
    const teacher = await verifyIdToken((await launch(f.users.teacher!)).idToken!);
    expect(teacher[LTI.claim('roles')]).toEqual([LTI.roles.instructor]);
  });

  it('rejects replayed nonces, foreign redirect URIs and tampered hints', async () => {
    const first = await launch(f.users.student1!);
    const again = await http(f.users.student1!, 'POST', 'auth', { body: first.params.toString() });
    expect(await again.text()).toContain('nonce reused');
    const bad = new URLSearchParams(first.params);
    bad.set('redirect_uri', 'https://evil.test/');
    expect((await http(f.users.student1!, 'POST', 'auth', { body: bad.toString() })).status).toBe(
      400,
    );
    const forged = new URLSearchParams(first.params);
    forged.set('nonce', 'other');
    forged.set('login_hint', f.users.student2!);
    expect(
      await (await http(f.users.student1!, 'POST', 'auth', { body: forged.toString() })).text(),
    ).toContain('Invalid or expired launch');
  });

  it('issues service tokens only for a valid client assertion', async () => {
    const ok = await serviceToken(
      `${LTI.scopes.score} ${LTI.scopes.lineitem} ${LTI.scopes.result} ${LTI.scopes.nrps}`,
    );
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { access_token: string; scope: string };
    expect(body.scope.split(' ')).toHaveLength(4);
    const forged = await new SignJWT({ jti: 'x' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(tool.clientId)
      .setSubject(tool.clientId)
      .setAudience(endpoint('token'))
      .setExpirationTime('5m')
      .sign((await generateKeyPair('RS256')).privateKey);
    const r = await http('anon', 'POST', 'token', {
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: forged,
        scope: LTI.scopes.score,
      }).toString(),
    });
    expect(r.status).toBe(401);
  });

  it('AGS: scores land in the gradebook; tools manage line items', async () => {
    const { access_token } = (await (
      await serviceToken(`${LTI.scopes.score} ${LTI.scopes.lineitem} ${LTI.scopes.result}`)
    ).json()) as { access_token: string };
    const auth = { authorization: `Bearer ${access_token}`, 'content-type': 'application/json' };
    const score = await http('anon', 'POST', `ags/${ltiId}/lineitems/0/scores`, {
      headers: auth,
      body: JSON.stringify({
        userId: f.users.student1,
        scoreGiven: 8,
        scoreMaximum: 10,
        activityProgress: 'Completed',
        gradingProgress: 'FullyGraded',
        timestamp: new Date().toISOString(),
        comment: 'Отлично <img src=x onerror=alert(1)>',
      }),
    });
    expect(score.status).toBe(200);
    const item = await t.db.gradeItem.findFirstOrThrow({
      where: { activityId: ltiId, itemNumber: 0 },
    });
    const g = await t.db.grade.findUniqueOrThrow({
      where: { gradeItemId_userId: { gradeItemId: item.id, userId: f.users.student1! } },
    });
    expect(Number(g.finalGrade)).toBe(80);
    // plain-text comment from the tool is stored escaped, never as markup
    expect(g.feedback).toBe('<p>Отлично &lt;img src=x onerror=alert(1)&gt;</p>');
    const results = (await (
      await http('anon', 'GET', `ags/${ltiId}/lineitems/0/results`, { headers: auth })
    ).json()) as {
      resultScore: number;
    }[];
    expect(results[0]).toMatchObject({
      userId: f.users.student1,
      comment: 'Отлично <img src=x onerror=alert(1)>',
      resultScore: 80,
      resultMaximum: 100,
    });

    const created = await http('anon', 'POST', `ags/${ltiId}/lineitems`, {
      headers: auth,
      body: JSON.stringify({ label: 'Квиз 2', scoreMaximum: 20, tag: 'quiz' }),
    });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { id: string }).id).toBe(
      endpoint(`ags/${ltiId}/lineitems/1`),
    );
    expect(await t.db.gradeItem.count({ where: { activityId: ltiId } })).toBe(2);
    const list = (await (
      await http('anon', 'GET', `ags/${ltiId}/lineitems?tag=quiz`, { headers: auth })
    ).json()) as unknown[];
    expect(list).toHaveLength(1);
    // the tool's own column and its grades survive the teacher editing the activity, which
    // sends only what the form has
    expect(
      (
        await http('anon', 'POST', `ags/${ltiId}/lineitems/1/scores`, {
          headers: auth,
          body: JSON.stringify({ userId: f.users.student1, scoreGiven: 15, scoreMaximum: 20 }),
        })
      ).status,
    ).toBe(200);
    await updateActivity.run(await ctxFor(t.db, f.users.teacher!), {
      id: ltiId,
      name: 'Тренажёр',
      settings: { toolId: tool.id, gradeMax: 100, height: 900, lineItems: [] },
    });
    expect(await t.db.gradeItem.count({ where: { activityId: ltiId } })).toBe(2);
    const column = await t.db.gradeItem.findFirstOrThrow({
      where: { activityId: ltiId, itemNumber: 1 },
    });
    const kept = await t.db.grade.findFirst({
      where: { gradeItemId: column.id, userId: f.users.student1 },
    });
    expect(Number(kept?.rawGrade)).toBe(15);
    // unenrolled users and missing tokens are refused
    expect(
      (
        await http('anon', 'POST', `ags/${ltiId}/lineitems/0/scores`, {
          headers: auth,
          body: JSON.stringify({ userId: '00000000-0000-0000-0000-000000000000', scoreGiven: 1 }),
        })
      ).status,
    ).toBe(400);
    expect((await http('anon', 'GET', `ags/${ltiId}/lineitems`)).status).toBe(401);
  });

  it('NRPS lists course members with LIS roles', async () => {
    const { access_token } = (await (await serviceToken(LTI.scopes.nrps)).json()) as {
      access_token: string;
    };
    const r = await http('anon', 'GET', `nrps/${ltiId}/memberships`, {
      headers: { authorization: `Bearer ${access_token}` },
    });
    const body = (await r.json()) as { members: { user_id: string; roles: string[] }[] };
    expect(body.members.find((m) => m.user_id === f.users.teacher)?.roles).toEqual([
      LTI.roles.instructor,
    ]);
    expect(body.members.find((m) => m.user_id === f.users.student2)?.roles).toEqual([
      LTI.roles.learner,
    ]);
  });

  it('Deep Linking: teachers pick content that the activity then launches', async () => {
    expect((await http(f.users.student1!, 'GET', `launch/${ltiId}?dl=1`)).status).toBe(403);
    const { idToken } = await launch(f.users.teacher!, '?dl=1');
    const req = await verifyIdToken(idToken!);
    expect(req[LTI.claim('message_type')]).toBe('LtiDeepLinkingRequest');
    const settings = req[LTI.dl('deep_linking_settings')] as {
      deep_link_return_url: string;
      data: string;
    };
    expect(settings.deep_link_return_url).toBe(endpoint(`deeplink/${ltiId}`));
    const response = await new SignJWT({
      [LTI.claim('message_type')]: 'LtiDeepLinkingResponse',
      [LTI.claim('version')]: '1.3.0',
      [LTI.claim('deployment_id')]: tool.deploymentId,
      [LTI.dl('data')]: settings.data,
      [LTI.dl('content_items')]: [
        {
          type: 'ltiResourceLink',
          url: 'https://tool.test/item/42',
          title: 'Задача 42',
          lineItem: { scoreMaximum: 50 },
        },
      ],
      nonce: 'dl-1',
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(tool.clientId)
      .setAudience(issuer())
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(toolKey);
    const r = await http('anon', 'POST', `deeplink/${ltiId}`, {
      body: new URLSearchParams({ JWT: response }).toString(),
    });
    expect(r.status).toBe(200);
    const act = await t.db.activity.findUniqueOrThrow({ where: { id: ltiId } });
    expect(act.settings).toMatchObject({
      contentUrl: 'https://tool.test/item/42',
      contentTitle: 'Задача 42',
      gradeMax: 50,
    });
    const launchAfter = await verifyIdToken((await launch(f.users.student1!)).idToken!);
    expect(launchAfter[LTI.claim('target_link_uri')]).toBe('https://tool.test/item/42');

    // the same response cannot be replayed
    const replay = await http('anon', 'POST', `deeplink/${ltiId}`, {
      body: new URLSearchParams({ JWT: response }).toString(),
    });
    expect(replay.status).toBe(400);
  });

  it('Deep Linking: a learner launch hint cannot be passed off as request data', async () => {
    const { params } = await launch(f.users.student1!);
    const forged = await new SignJWT({
      [LTI.claim('message_type')]: 'LtiDeepLinkingResponse',
      [LTI.claim('version')]: '1.3.0',
      [LTI.claim('deployment_id')]: tool.deploymentId,
      [LTI.dl('data')]: params.get('lti_message_hint'),
      [LTI.dl('content_items')]: [{ type: 'ltiResourceLink', url: 'https://evil.test/' }],
      nonce: 'dl-forged',
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(tool.clientId)
      .setAudience(issuer())
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(toolKey);
    const r = await http('anon', 'POST', `deeplink/${ltiId}`, {
      body: new URLSearchParams({ JWT: forged }).toString(),
    });
    expect(r.status).toBe(400);
    const act = await t.db.activity.findUniqueOrThrow({ where: { id: ltiId } });
    expect(act.settings).toMatchObject({ contentUrl: 'https://tool.test/item/42' });
  });
});
