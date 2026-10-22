import { readFileSync } from 'node:fs';
import tls from 'node:tls';
import { type Browser, type BrowserContext, chromium, expect, type Page } from '@playwright/test';
import { DEMO_PASSWORD, login } from '../tests/helpers';
import {
  branchIp,
  CLOUD_IP,
  CONTENT_DOMAIN,
  DOMAIN,
  LMS,
  labState,
  nodeCompose,
  nodeStatus,
} from './lab';

/**
 * Chromium resolving the LMS's names to a server, as the DNS of its network would, and
 * reaching it directly (not through a proxy the environment names).
 */
export const resolveTo = (ip: string) => [
  `--host-resolver-rules=MAP ${DOMAIN} ${ip}, MAP ${CONTENT_DOMAIN} ${ip}`,
  '--no-proxy-server',
];

/**
 * A browser context in the network of a server: the cloud (people outside the branches) or
 * branch i. The caller closes it (its browser goes with it).
 */
export async function contextAt(where: 'cloud' | number): Promise<BrowserContext> {
  const browser = await chromium.launch({
    executablePath: process.env.PW_CHROMIUM_PATH || undefined,
    args: resolveTo(where === 'cloud' ? CLOUD_IP : branchIp(where)),
  });
  const context = await browser.newContext({
    baseURL: LMS,
    ignoreHTTPSErrors: true,
    locale: 'ru-RU',
    reducedMotion: 'reduce',
  });
  context.on('close', () => void browser.close());
  return context;
}

const opened: BrowserContext[] = [];

/**
 * A page of its own (a context of the test's browser, in branch 1's network) for a person
 * signed in to the LMS; closeOpened() closes it after the test.
 */
export async function signedIn(browser: Browser, user: string, password = DEMO_PASSWORD) {
  const context = await browser.newContext();
  opened.push(context);
  const page = await context.newPage();
  await login(page, user, password);
  return page;
}

/** Closes the pages signedIn() opened, so that none outlives its test. */
export async function closeOpened() {
  await Promise.all(opened.splice(0).map((c) => c.close()));
}

/** Waits until branch i's node is in a mode, polling its agent (`hubium node status`). */
export async function expectMode(i: number, mode: string, timeout = 180_000) {
  await expect
    .poll(
      () => {
        try {
          return nodeStatus(i).mode;
        } catch {
          return '?';
        }
      },
      { timeout, intervals: [2000] },
    )
    .toBe(mode);
}

/**
 * A query on branch i's own database (B, which the node writes while it works alone), as
 * JSON rows: psql in the db-b container of the node.
 */
export function branchSql<T = Record<string, unknown>>(i: number, query: string): T[] {
  const out = nodeCompose(i, [
    'exec',
    '-T',
    'db-b',
    'psql',
    // the cloud's own superuser: the node's databases are physical copies of the cloud's
    '-U',
    'hubium',
    '-d',
    'hubium',
    '-At',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `SELECT coalesce(json_agg(t), '[]') FROM (${query}) t`,
  ]).trim();
  return JSON.parse(out) as T[];
}

/** The banner a node shows while it is not on the line, or null. */
export async function banner(page: Page) {
  const b = page.getByText(/Нет связи с основным сервером|передаётся на основной сервер/).first();
  return (await b.isVisible().catch(() => false)) ? b.textContent() : null;
}

/**
 * The certificate a server answers with for the LMS's name: its fingerprint, and whether the
 * cloud's authority (the one the nodes get with --hub-ca) vouches for it.
 */
export function certificateAt(ip: string): Promise<{ authorized: boolean; fingerprint: string }> {
  return new Promise((ok, fail) => {
    const socket = tls.connect(
      { host: ip, port: 443, servername: DOMAIN, ca: readFileSync(labState().hubCa) },
      () => {
        ok({
          authorized: socket.authorized,
          fingerprint: socket.getPeerCertificate().fingerprint256,
        });
        socket.end();
      },
    );
    socket.on('error', fail);
    socket.setTimeout(10_000, () => socket.destroy(new Error(`no TLS answer from ${ip}`)));
  });
}
