import type { Readable } from 'node:stream';
import type { Prisma } from '@hubium/db';
import type { z } from 'zod';
import { isMsg, type Msg } from './msg.ts';

export { isMsg, Msg, type MsgInput, type MsgValues, msg, renderMsg } from './msg.ts';

// Contract between core and activity modules. Modules depend only on this package
// (and db types); core implements ModuleCtx and calls the hooks.

export type ModuleActor =
  | { kind: 'system' }
  | { kind: 'anonymous' }
  | { kind: 'user'; userId: string; isSiteAdmin: boolean };

export interface ModulePermissions {
  can(capability: string, contextId?: string): Promise<boolean>;
  require(capability: string, contextId?: string): Promise<void>;
  /** Users with an active enrolment holding the capability in the activity. */
  usersWithCap(
    capability: string,
    contextId: string,
    opts?: { groupId?: string },
  ): Promise<string[]>;
}

export interface ModuleFile {
  id: string;
  name: string;
  mimeType: string;
  size: bigint;
  path: string;
  itemId: string;
  url: string;
}

export interface ModuleFiles {
  /** Files of an area; without `itemId`, those of every item. */
  list(activityId: string, area: string, itemId?: string): Promise<ModuleFile[]>;
  store(
    activityId: string,
    area: string,
    file: { name: string; mimeType?: string; data: Buffer; itemId?: string; path?: string },
    opts?: { maxBytes?: number; replace?: boolean },
  ): Promise<ModuleFile>;
  /** Deletes files by id; with `itemId`, only those of that item (e.g. the caller's submission). */
  remove(activityId: string, area: string, ids: string[], itemId?: string): Promise<void>;
  /** Moves a finished resumable upload (see /api/uploads) into a file area. */
  storeUpload(
    activityId: string,
    area: string,
    uploadId: string,
    opts?: { itemId?: string; maxBytes?: number; allowedTypes?: RegExp; replace?: boolean },
  ): Promise<ModuleFile>;
  /** Reads a stored file's bytes (worker jobs such as transcoding). */
  open(fileId: string): Promise<{ stream: Readable; name: string; mimeType: string; size: number }>;
  /**
   * Plain text of a document (PDF, DOCX, PPTX, ODT, ODP, text, HTML) for AI and search;
   * null for other or unreadable files. Extracted once per file content, then cached.
   */
  text(fileId: string): Promise<string | null>;
}

/**
 * Raw object storage for generated assets (e.g. HLS segments). Keys must start with
 * `mod/<moduleKey>/`; modules track and delete their own keys.
 */
export interface ModuleStorage {
  put(key: string, body: Buffer | Readable, contentType: string): Promise<void>;
  get(key: string): Promise<Readable>;
  head(key: string): Promise<{ size: number } | null>;
  delete(keys: string[]): Promise<void>;
}

export interface ModuleJobs {
  /** Enqueues `<moduleKey>.<name>` declared in `ActivityModule.jobs`, after commit. */
  enqueue(
    name: string,
    data: object,
    /** `priority`: higher runs first (0 by default; negative for bulk background work). */
    opts?: { startAfter?: Date; singletonKey?: string; priority?: number },
  ): Promise<void>;
}

export interface ModuleRealtime {
  publish(
    userIds: string[],
    type: 'task.progress' | 'video.status',
    data?: Record<string, unknown>,
  ): Promise<void>;
}

export interface ModuleContent {
  /** Absolute URL on the content origin for this module's `content` hook. */
  url(
    activityId: string,
    path: string,
    opts?: { data?: Record<string, string | number>; ttlSec?: number; userId?: string },
  ): string;
  /** Origin of the LMS (for frame-ancestors and postMessage targets). */
  appOrigin(): string;
}

export interface AiGradeSuggestion {
  id: string;
  suggestedGrade: number;
  gradeMax: number;
  criteria: { name: string; score: number; comment: string }[];
  feedbackDraft: string;
  confidence: number;
  /** Attachments the assistant could not read. */
  unreadFiles: string[];
}

/** AI services for modules (grading assistant). Absent features report unavailable. */
export interface ModuleAi {
  status(
    feature: 'GRADING_ASSIST',
    courseId: string,
  ): Promise<{ available: boolean; consentRequired: boolean; notice: string }>;
  acceptConsent(feature: 'GRADING_ASSIST'): Promise<void>;
  /** `userId`: the student being graded (a team's submission has no student of its own). */
  suggestGrade(input: {
    submissionId: string;
    criteria?: string;
    userId?: string;
  }): Promise<AiGradeSuggestion>;
  markSuggestion(id: string, status: 'APPLIED' | 'DISCARDED'): Promise<void>;
}

export interface ModuleActivities {
  /** Loads an activity with the viewer's access (for module HTTP routes). */
  get(activityId: string): Promise<{
    activity: ActivityRef;
    canOpen: boolean;
    canManage: boolean;
  } | null>;
  /** Those of `userIds` who may open the activity now (for notifications and reminders). */
  openableBy(activityId: string, userIds: string[]): Promise<string[]>;
}

export interface ModuleGrades {
  /** Writes grades for the activity's grade item(s); creates items if missing. */
  setGrades(
    activityId: string,
    grades: {
      userId: string;
      rawGrade: number | null;
      feedback?: string | null;
      itemNumber?: number;
      gradedById?: string | null;
    }[],
  ): Promise<void>;
  syncItems(activityId: string): Promise<void>;
}

export interface ModuleCompletion {
  markViewed(activityId: string, userId: string): Promise<void>;
  /** Re-evaluates the module's automatic completion rules for the user. */
  recompute(activityId: string, userId: string): Promise<void>;
}

/** Plain text, or an i18n key (e.g. `mod.assign.notify.gradedTitle`) rendered per recipient. */
export type NotifyText = string | { key: string; values?: Record<string, string | number> };

export interface ModuleNotify {
  /**
   * Notifies users. `type` is `<moduleKey>.<name>` for a type declared in
   * `ActivityModule.notifications`. The acting user is never notified.
   */
  send(
    userIds: string[],
    n: {
      type: string;
      title: NotifyText;
      body?: NotifyText;
      url?: string;
      courseId?: string;
      contextId?: string;
      data?: Record<string, unknown>;
      /** Leave out who acted (an anonymous answer, say): recipients see no sender. */
      anonymous?: boolean;
    },
  ): Promise<void>;
}

/** Default channels of a notification type; users override them in their preferences. */
export interface NotificationTypeDef {
  email: 'OFF' | 'IMMEDIATE' | 'DIGEST';
  inApp?: boolean;
}

export interface ModuleCtx {
  db: Prisma.TransactionClient;
  actor: ModuleActor;
  now: Date;
  /** Language of the request: a code of an installed language pack. */
  locale: string;
  /** The client's address (see TRUSTED_PROXY_HOPS), or null outside a request. */
  ip: string | null;
  perm: ModulePermissions;
  files: ModuleFiles;
  grades: ModuleGrades;
  completion: ModuleCompletion;
  notify: ModuleNotify;
  storage: ModuleStorage;
  jobs: ModuleJobs;
  realtime: ModuleRealtime;
  activities: ModuleActivities;
  ai: ModuleAi;
  content: ModuleContent;
  log(event: string, data?: Record<string, unknown>): Promise<void>;
}

export interface ActivityRef<S = unknown> {
  id: string;
  courseId: string;
  sectionId: string;
  moduleKey: string;
  name: string;
  intro: string;
  settings: S;
  completionMode: 'NONE' | 'MANUAL' | 'AUTO';
  completionRules: Record<string, unknown>;
  groupMode: 'NONE' | 'SEPARATE' | 'VISIBLE';
  /** When set, group mode uses only the groups of this grouping. */
  groupingId: string | null;
  visibility: 'SHOWN' | 'HIDDEN' | 'STEALTH';
}

export interface GradeItemSpec {
  itemNumber: number;
  name: string;
  /**
   * A message key naming the item (e.g. `mod.forum.gradeItem.rating`), in the course's
   * language or the site's; used instead of `name` when given.
   */
  nameKey?: string;
  gradeMax: number;
  gradePass?: number;
  /** Grade on a scale (its grades are then 1..n and gradeMax is ignored). */
  scaleId?: string | null;
}

export interface CalendarEventSpec {
  kind: 'OPEN' | 'CLOSE' | 'DUE' | 'CUTOFF' | 'SESSION';
  title: string;
  startsAt: Date;
  endsAt?: Date;
}

export interface CompletionRuleDef<R extends z.ZodObject = z.ZodObject> {
  schema: R;
  evaluate(
    ctx: ModuleCtx,
    a: ActivityRef,
    userId: string,
    rules: z.output<R>,
  ): Promise<'complete' | 'incomplete' | 'pass' | 'fail' | null>;
}

export interface TodoItem {
  activityId: string;
  courseId: string;
  title: string;
  /** complete: an activity due for completion by its expected date (the core's own) */
  kind: 'grade' | 'submit' | 'attempt' | 'complete';
  dueAt?: Date | null;
  /** dueAt is a date without a time, kept as midnight UTC */
  allDay?: boolean;
  count?: number;
}

export interface ModuleAction<I extends z.ZodType = z.ZodType, O = unknown> {
  /** One line for the REST API reference (POST /api/v1/activities/{id}/actions/{name}). */
  summary?: string;
  input: I;
  /** Capability required at the activity context. */
  capability?: string;
  mutation?: boolean;
  handler(ctx: ModuleCtx, a: ActivityRef, input: z.output<I>): Promise<O>;
}

/**
 * A read of an activity's data for API clients (GET /api/v1/activities/{id}/queries/{name}):
 * no side effects and no transaction. Core first checks that the caller may open the
 * activity; the handler applies the module's own visibility rules. `input` is read from
 * query parameters, so its fields are flat and coerced (z.coerce.number() for numbers).
 * `output` documents the result in the API reference.
 */
export interface ModuleQuery<I extends z.ZodType = z.ZodType, O = unknown> {
  summary?: string;
  input: I;
  output?: z.ZodType;
  /** Capability required at the activity context. */
  capability?: string;
  handler(ctx: ModuleCtx, a: ActivityRef, input: z.output<I>): Promise<O>;
}

/** Words that link to a page of an activity wherever the course's texts use them. */
export interface AutoLink {
  /** The concept and its other forms. */
  words: string[];
  url: string;
  /** Shown on hover, e.g. "Glossary: concept". */
  title: string;
  caseSensitive: boolean;
  /** Only whole words. */
  fullMatch: boolean;
}

export interface ActivityModule<S = Record<string, unknown>> {
  key: string;
  archetype: 'activity' | 'resource' | 'inline';
  /** lucide-react icon name, e.g. 'FileText'. */
  icon: string;
  supports: { grading?: boolean; groups?: boolean; viewCompletion?: boolean; backup?: boolean };
  settings: {
    schema: z.ZodType<S>;
    defaults(): S;
    /** Fields the module keeps up itself rather than the settings form (an LTI tool's grade
     *  columns, say): creating an activity takes their defaults, updating it keeps the
     *  stored values, whatever the form or an API client sends. */
    managed?: readonly (keyof S & string)[];
  };
  completion?: CompletionRuleDef;
  grading?: { items(a: ActivityRef<S>): GradeItemSpec[] };
  calendar?: { events(a: ActivityRef<S>): CalendarEventSpec[] };
  lifecycle?: {
    onCreate?(ctx: ModuleCtx, a: ActivityRef<S>): Promise<void>;
    onUpdate?(ctx: ModuleCtx, a: ActivityRef<S>, prev: S): Promise<void>;
    onDelete?(ctx: ModuleCtx, a: ActivityRef<S>): Promise<void>;
    onUserUnenrolled?(ctx: ModuleCtx, courseId: string, userId: string): Promise<void>;
  };
  todo?(ctx: ModuleCtx, userId: string, courseIds: string[]): Promise<TodoItem[]>;
  /**
   * Scheduled jobs run by the worker with a system ModuleCtx, in a transaction unless
   * `transaction` is false (jobs that call other servers, which must not hold database
   * locks while they wait). Schedule is cron (UTC).
   */
  cron?: {
    name: string;
    schedule: string;
    transaction?: boolean;
    handler(ctx: ModuleCtx): Promise<unknown>;
  }[];
  /**
   * Background jobs, run by the worker with a system ModuleCtx (no transaction). The
   * `media` queue runs in the separate worker-media container.
   */
  jobs?: {
    name: string;
    queue?: 'default' | 'media';
    handler(ctx: ModuleCtx, data: never): Promise<unknown>;
  }[];
  /**
   * HTTP endpoints under /api/mod/<key>/<...path> (streaming media, provider callbacks).
   * The ModuleCtx carries the caller's session; anonymous callers are allowed.
   */
  http?(ctx: ModuleCtx, req: Request, path: string[]): Promise<Response>;
  /**
   * Untrusted content served from CONTENT_HOST at /c/<token>/<...path>. The signed token
   * identifies the activity, the user and module data; there is no session.
   */
  content?(
    ctx: ModuleCtx,
    grant: {
      activityId: string;
      userId: string;
      data: Record<string, string | number>;
      token: string;
    },
    req: Request,
    path: string[],
  ): Promise<Response>;
  actions?: Record<string, ModuleAction>;
  queries?: Record<string, ModuleQuery>;
  /**
   * AI integration. Text from `extract` (plain text with Markdown-style headings, or
   * sanitised HTML, which core converts) is indexed
   * for the course tutor and quiz generation; the activity intro is indexed by core.
   * `tutorPolicy`: 'exclude' keeps the activity out of retrieval; 'exclude-while-open'
   * also lets `blocksTutor` switch the tutor off while the user is mid-activity
   * (an open quiz attempt).
   */
  ai?: {
    extract?(ctx: ModuleCtx, a: ActivityRef<S>): Promise<{ title?: string; text: string }[]>;
    tutorPolicy?: 'include' | 'exclude' | 'exclude-while-open';
    blocksTutor?(ctx: ModuleCtx, a: ActivityRef<S>, userId: string): Promise<boolean>;
  };
  /**
   * Personal data held in module tables, for the user's data export and for erasure when
   * the user is deleted (identity is anonymised by core; modules drop content).
   */
  privacy?: {
    export?(ctx: ModuleCtx, userId: string): Promise<unknown>;
    erase?(ctx: ModuleCtx, userId: string): Promise<void>;
  };
  /**
   * Course reset: drops learners' work in the activity (attempts, submissions, posts,
   * overrides) and keeps the activity itself. Grades, completion and files in
   * `backup.userFileAreas` are cleared by core; dates in settings are shifted by core.
   */
  reset?: { userData(ctx: ModuleCtx, a: ActivityRef<S>): Promise<void> };
  /**
   * Words to link in the course's texts (a glossary's auto-linking), asked of each activity
   * of the module that the viewer may open.
   */
  autoLinks?(ctx: ModuleCtx, a: ActivityRef<S>): Promise<AutoLink[]>;
  /** Notification types; labels come from `mod.<key>.notify.<name>` messages. */
  notifications?: Record<string, NotificationTypeDef>;
  /** Who may read files in each file area (besides users who can manage the course). */
  files?: Record<
    string,
    {
      canRead(
        ctx: ModuleCtx,
        a: ActivityRef<S>,
        file: { itemId: string; uploadedById: string | null },
      ): Promise<boolean>;
    }
  >;
  /** Text for search and the AI tutor. */
  extractText?(a: ActivityRef<S>): string;
  /**
   * Course backup / restore / duplication. Settings, intro and the module's file areas
   * are handled by core; these hooks carry extra module data (e.g. quiz slots). `map`
   * translates ids from the source course (questions, categories, files, activities).
   */
  backup?: {
    /** File areas holding learners' data, left out of backups without user data. */
    userFileAreas?: string[];
    export?(ctx: ModuleCtx, a: ActivityRef<S>): Promise<unknown>;
    import?(
      ctx: ModuleCtx,
      a: ActivityRef<S>,
      data: unknown,
      map: (oldId: string) => string | undefined,
    ): Promise<void>;
  };
}

export function defineModule<S>(m: ActivityModule<S>): ActivityModule<S> {
  return m;
}

/** Parses raw settings with the module schema, falling back to defaults per field: a stored
 *  field the schema no longer takes gets its default, and the other fields are kept. */
export function parseSettings<S>(m: ActivityModule<S>, raw: unknown): S {
  const r = m.settings.schema.safeParse(raw);
  if (r.success) return r.data;
  const defaults = m.settings.defaults() as Record<string, unknown>;
  const merged: Record<string, unknown> = {
    ...defaults,
    ...((raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as object),
  };
  const reset = new Set<string>();
  for (;;) {
    const r2 = m.settings.schema.safeParse(merged);
    if (r2.success) return r2.data;
    // an issue on the whole object, or on a field already at its default, names nothing to drop
    const bad = r2.error.issues.map((i) => i.path[0]);
    if (bad.some((k) => typeof k !== 'string' || reset.has(k))) return m.settings.defaults();
    for (const k of bad as string[]) {
      reset.add(k);
      if (k in defaults) merged[k] = defaults[k];
      else delete merged[k];
    }
  }
}

/** Typed helper so action handlers infer their input from the zod schema. */
export function defineAction<I extends z.ZodType, O>(a: ModuleAction<I, O>): ModuleAction {
  return a as unknown as ModuleAction;
}

/**
 * An error with an API status for module handlers: a plain Error becomes 400 Bad Request,
 * this one answers 404, 403 or 409 (e.g. "Discussion not found").
 */
export class ModuleError extends Error {
  /** The message for people (see msg); `message` is its English text. */
  readonly msg: Msg | undefined;

  constructor(
    readonly status: 'BAD_REQUEST' | 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT',
    message: string | Msg,
  ) {
    super(String(message));
    this.name = 'ModuleError';
    this.msg = isMsg(message) ? message : undefined;
  }
}

/**
 * What an error says to people in a language: the message an error carries (a ModuleError's,
 * an UnsafeUrlError's, also one a PermanentJobError wraps) translated, else its own text.
 */
export function errorText(e: unknown, locale: string): string {
  const cause = e instanceof PermanentJobError ? e.cause : e;
  const said = (cause as { msg?: unknown } | null | undefined)?.msg;
  if (isMsg(said)) return said.in(locale);
  return e instanceof Error ? e.message : String(e);
}

/**
 * A job failure that trying again cannot mend: a package that is no SCORM or H5P package, a
 * video ffmpeg cannot read. The job ends there, recorded as failed by the module, instead
 * of being retried; any other error is taken as passing (storage, database) and retried.
 */
export class PermanentJobError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PermanentJobError';
  }
}

/** Typed helper so query handlers infer their input from the zod schema. */
export function defineQuery<I extends z.ZodType, O>(q: ModuleQuery<I, O>): ModuleQuery {
  return q as unknown as ModuleQuery;
}
