import { createHash, createHmac } from 'node:crypto';
import { ModuleError, msg } from '@hubium/module-sdk';

// Webinar providers behind one interface: BigBlueButton (server API with checksums,
// callbacks, recordings) and Jitsi (JWT-protected self-hosted server or meet.jit.si).

export interface MeetingSpec {
  meetingId: string;
  name: string;
  welcome?: string;
  record: boolean;
  durationMin: number;
  logoutUrl: string;
  endCallbackUrl?: string;
  recordingReadyUrl?: string;
}

export interface Joiner {
  id: string;
  name: string;
  moderator: boolean;
}

export interface Recording {
  recordId: string;
  url: string;
  startedAt: Date | null;
  durationSec: number | null;
}

export interface LiveProvider {
  readonly kind: 'bbb' | 'jitsi';
  /** Idempotent: creating a running meeting again is fine. */
  createMeeting(m: MeetingSpec): Promise<void>;
  joinUrl(m: MeetingSpec, user: Joiner): Promise<string>;
  end(meetingId: string): Promise<void>;
  /** Null when the provider cannot report (Jitsi) or the meeting is not running. */
  info(
    meetingId: string,
  ): Promise<{ running: boolean; attendees: { userId: string; moderator: boolean }[] } | null>;
  recordings(meetingId: string): Promise<Recording[]>;
}

// ── BigBlueButton ────────────────────────────────────────────────────────────

/** `checksum = sha256(callName + queryString + secret)`. */
export function bbbChecksum(call: string, query: string, secret: string): string {
  return createHash('sha256')
    .update(call + query + secret)
    .digest('hex');
}

export function bbbUrl(
  base: string,
  secret: string,
  call: string,
  params: Record<string, string>,
): string {
  const query = new URLSearchParams(params).toString();
  const root = base.replace(/\/+$/, '').replace(/\/api$/, '');
  return `${root}/api/${call}?${query}${query ? '&' : ''}checksum=${bbbChecksum(call, query, secret)}`;
}

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();

/** All inner texts of <tag>…</tag> (enough for BBB's flat XML responses). */
export function xmlAll(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  return [...xml.matchAll(re)].map((m) => m[1]!);
}

export const xmlOne = (xml: string, tag: string) => {
  const v = xmlAll(xml, tag)[0];
  return v === undefined ? undefined : decode(v);
};

export function parseBbbInfo(xml: string) {
  if (xmlOne(xml, 'returncode') !== 'SUCCESS') return null;
  return {
    running: xmlOne(xml, 'running') === 'true',
    attendees: xmlAll(xml, 'attendee').map((a) => ({
      userId: xmlOne(a, 'userID') ?? '',
      moderator: xmlOne(a, 'role') === 'MODERATOR',
    })),
  };
}

export function parseBbbRecordings(xml: string): Recording[] {
  if (xmlOne(xml, 'returncode') !== 'SUCCESS') return [];
  return xmlAll(xml, 'recording').flatMap((r) => {
    const recordId = xmlOne(r, 'recordID');
    const formats = xmlAll(r, 'format');
    const pick =
      formats.find((f) => xmlOne(f, 'type') === 'presentation') ??
      formats.find((f) => xmlOne(f, 'url'));
    const url = pick ? xmlOne(pick, 'url') : undefined;
    if (!recordId || !url) return [];
    const start = Number(xmlOne(r, 'startTime'));
    const end = Number(xmlOne(r, 'endTime'));
    return [
      {
        recordId,
        url,
        startedAt: Number.isFinite(start) && start > 0 ? new Date(start) : null,
        durationSec: start && end && end > start ? Math.round((end - start) / 1000) : null,
      },
    ];
  });
}

export class BbbProvider implements LiveProvider {
  readonly kind = 'bbb' as const;
  constructor(
    private readonly base: string,
    private readonly secret: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async call(name: string, params: Record<string, string>): Promise<string> {
    const r = await this.fetcher(bbbUrl(this.base, this.secret, name, params), {
      signal: AbortSignal.timeout(15_000),
    });
    return r.text();
  }

  async createMeeting(m: MeetingSpec) {
    const params: Record<string, string> = {
      name: m.name,
      meetingID: m.meetingId,
      record: String(m.record),
      autoStartRecording: 'false',
      allowStartStopRecording: String(m.record),
      duration: String(m.durationMin + 60),
      logoutURL: m.logoutUrl,
    };
    if (m.welcome) params.welcome = m.welcome;
    if (m.endCallbackUrl) params.meta_endCallbackUrl = m.endCallbackUrl;
    if (m.recordingReadyUrl) params['meta_bbb-recording-ready-url'] = m.recordingReadyUrl;
    const xml = await this.call('create', params);
    if (xmlOne(xml, 'returncode') !== 'SUCCESS') {
      throw new ModuleError(
        'BAD_REQUEST',
        msg('mod.livesession.errors.bbbError', {
          value: xmlOne(xml, 'message') ?? 'create failed',
        }),
      );
    }
  }

  async joinUrl(m: MeetingSpec, user: Joiner) {
    return bbbUrl(this.base, this.secret, 'join', {
      fullName: user.name,
      meetingID: m.meetingId,
      role: user.moderator ? 'MODERATOR' : 'VIEWER',
      userID: user.id,
      redirect: 'true',
    });
  }

  async end(meetingId: string) {
    await this.call('end', { meetingID: meetingId });
  }

  async info(meetingId: string) {
    return parseBbbInfo(await this.call('getMeetingInfo', { meetingID: meetingId }));
  }

  async recordings(meetingId: string) {
    return parseBbbRecordings(await this.call('getRecordings', { meetingID: meetingId }));
  }
}

// ── Jitsi ────────────────────────────────────────────────────────────────────

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

/** HS256 JWT for Jitsi's token authentication (prosody `token` module). */
export function jitsiJwt(opts: {
  appId: string;
  secret: string;
  domain: string;
  room: string;
  user: Joiner;
  ttlSec?: number;
  now?: number;
}): string {
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    aud: 'jitsi',
    iss: opts.appId,
    sub: opts.domain,
    room: opts.room,
    nbf: now - 10,
    exp: now + (opts.ttlSec ?? 4 * 3600),
    context: { user: { id: opts.user.id, name: opts.user.name, moderator: opts.user.moderator } },
  };
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  return `${data}.${createHmac('sha256', opts.secret).update(data).digest('base64url')}`;
}

export class JitsiProvider implements LiveProvider {
  readonly kind = 'jitsi' as const;
  constructor(
    private readonly domain: string,
    private readonly appId?: string,
    private readonly secret?: string,
  ) {}
  async createMeeting() {}
  async joinUrl(m: MeetingSpec, user: Joiner) {
    const room = encodeURIComponent(m.meetingId);
    const token =
      this.appId && this.secret
        ? `?jwt=${jitsiJwt({ appId: this.appId, secret: this.secret, domain: this.domain, room: m.meetingId, user })}`
        : '';
    const hash = `#userInfo.displayName=${encodeURIComponent(JSON.stringify(user.name))}&config.subject=${encodeURIComponent(JSON.stringify(m.name))}`;
    return `https://${this.domain}/${room}${token}${hash}`;
  }
  async end() {}
  async info() {
    return null;
  }
  async recordings() {
    return [];
  }
}

export type ProviderKind = 'bbb' | 'jitsi';

let override: ((kind: ProviderKind) => LiveProvider) | undefined;

/** Tests: replace provider construction. */
export function setProviderFactory(f: ((kind: ProviderKind) => LiveProvider) | undefined): void {
  override = f;
}

export function providerConfigured(kind: ProviderKind, env = process.env): boolean {
  return kind === 'bbb' ? !!(env.BBB_URL && env.BBB_SECRET) : true;
}

export function getProvider(kind: ProviderKind, env = process.env): LiveProvider {
  if (override) return override(kind);
  if (kind === 'bbb') {
    if (!env.BBB_URL || !env.BBB_SECRET)
      throw new ModuleError('BAD_REQUEST', msg('mod.livesession.errors.bbbNotConfigured'));
    return new BbbProvider(env.BBB_URL, env.BBB_SECRET);
  }
  return new JitsiProvider(
    env.JITSI_DOMAIN || 'meet.jit.si',
    env.JITSI_APP_ID,
    env.JITSI_APP_SECRET,
  );
}
