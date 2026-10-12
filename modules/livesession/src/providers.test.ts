import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BbbProvider,
  bbbChecksum,
  bbbUrl,
  JitsiProvider,
  jitsiJwt,
  parseBbbInfo,
  parseBbbRecordings,
} from './providers.ts';

describe('BigBlueButton', () => {
  it('signs calls with sha256(call + query + secret)', () => {
    const q = 'meetingID=abc&fullName=Ann';
    expect(bbbChecksum('join', q, 's3cret')).toBe(
      createHash('sha256').update(`join${q}s3cret`).digest('hex'),
    );
    const url = bbbUrl('https://bbb.test/bigbluebutton/', 's3cret', 'join', {
      meetingID: 'abc',
      fullName: 'Ann',
    });
    expect(url).toBe(
      `https://bbb.test/bigbluebutton/api/join?${q}&checksum=${bbbChecksum('join', q, 's3cret')}`,
    );
    expect(bbbUrl('https://bbb.test/bigbluebutton/api', 'x', 'getMeetings', {})).toMatch(
      /^https:\/\/bbb\.test\/bigbluebutton\/api\/getMeetings\?checksum=[0-9a-f]{64}$/,
    );
  });

  it('maps roles in join URLs', async () => {
    const p = new BbbProvider('https://bbb.test/bigbluebutton', 'k');
    const m = {
      meetingId: 'm1',
      name: 'Урок',
      record: false,
      durationMin: 60,
      logoutUrl: 'https://lms',
    };
    const t = new URL(await p.joinUrl(m, { id: 'u1', name: 'Анна', moderator: true }));
    expect(t.searchParams.get('role')).toBe('MODERATOR');
    expect(t.searchParams.get('userID')).toBe('u1');
    const s = new URL(await p.joinUrl(m, { id: 'u2', name: 'Иван', moderator: false }));
    expect(s.searchParams.get('role')).toBe('VIEWER');
  });

  it('creates meetings with callbacks and reports errors', async () => {
    const calls: string[] = [];
    const ok = (async (url: string) => {
      calls.push(url);
      return new Response('<response><returncode>SUCCESS</returncode></response>');
    }) as typeof fetch;
    const p = new BbbProvider('https://bbb.test/bigbluebutton', 'k', ok);
    await p.createMeeting({
      meetingId: 'm1',
      name: 'Урок',
      record: true,
      durationMin: 60,
      logoutUrl: 'https://lms/x',
      endCallbackUrl: 'https://lms/cb',
    });
    const u = new URL(calls[0]!);
    expect(u.pathname).toBe('/bigbluebutton/api/create');
    expect(u.searchParams.get('meta_endCallbackUrl')).toBe('https://lms/cb');
    expect(u.searchParams.get('record')).toBe('true');
    const fail = (async () =>
      new Response(
        '<response><returncode>FAILED</returncode><message>Bad checksum</message></response>',
      )) as unknown as typeof fetch;
    await expect(
      new BbbProvider('https://bbb.test', 'k', fail).createMeeting({
        meetingId: 'm',
        name: 'n',
        record: false,
        durationMin: 1,
        logoutUrl: 'x',
      }),
    ).rejects.toThrow('Bad checksum');
  });

  it('parses meeting info and recordings', () => {
    const info = parseBbbInfo(`<response><returncode>SUCCESS</returncode><running>true</running>
      <attendees><attendee><userID>u1</userID><fullName>A</fullName><role>MODERATOR</role></attendee>
      <attendee><userID>u2</userID><role>VIEWER</role></attendee></attendees></response>`);
    expect(info).toEqual({
      running: true,
      attendees: [
        { userId: 'u1', moderator: true },
        { userId: 'u2', moderator: false },
      ],
    });
    expect(parseBbbInfo('<response><returncode>FAILED</returncode></response>')).toBeNull();
    const recs = parseBbbRecordings(`<response><returncode>SUCCESS</returncode><recordings>
      <recording><recordID>r1</recordID><startTime>1700000000000</startTime><endTime>1700003600000</endTime>
      <playback><format><type>presentation</type><url>https://bbb.test/playback/presentation/2.3/r1?a=1&amp;b=2</url></format></playback></recording>
      </recordings></response>`);
    expect(recs).toEqual([
      {
        recordId: 'r1',
        url: 'https://bbb.test/playback/presentation/2.3/r1?a=1&b=2',
        startedAt: new Date(1700000000000),
        durationSec: 3600,
      },
    ]);
  });
});

describe('Jitsi', () => {
  it('issues HS256 tokens with the moderator flag', () => {
    const jwt = jitsiJwt({
      appId: 'hubium',
      secret: 'shh',
      domain: 'meet.example.com',
      room: 'hubium-1',
      user: { id: 'u1', name: 'Анна', moderator: true },
      now: 1_700_000_000_000,
    });
    const [h, p, sig] = jwt.split('.');
    expect(createHmac('sha256', 'shh').update(`${h}.${p}`).digest('base64url')).toBe(sig);
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
    expect(payload).toMatchObject({
      aud: 'jitsi',
      iss: 'hubium',
      sub: 'meet.example.com',
      room: 'hubium-1',
    });
    expect(payload.context.user).toEqual({ id: 'u1', name: 'Анна', moderator: true });
    expect(payload.exp - payload.nbf).toBeGreaterThan(3600);
  });

  it('builds join URLs with or without tokens', async () => {
    const m = {
      meetingId: 'hubium-1',
      name: 'Урок',
      record: false,
      durationMin: 60,
      logoutUrl: '',
    };
    const open = await new JitsiProvider('meet.jit.si').joinUrl(m, {
      id: 'u',
      name: 'Ann',
      moderator: false,
    });
    expect(open).toMatch(/^https:\/\/meet\.jit\.si\/hubium-1#userInfo\.displayName=/);
    const secured = await new JitsiProvider('meet.example.com', 'app', 'key').joinUrl(m, {
      id: 'u',
      name: 'Ann',
      moderator: false,
    });
    expect(secured).toMatch(/^https:\/\/meet\.example\.com\/hubium-1\?jwt=[\w-]+\.[\w-]+\.[\w-]+#/);
  });
});
