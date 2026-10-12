import type { Readable } from 'node:stream';
import type { Prisma } from '@hubium/db';
import type { z } from 'zod';

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
  list(activityId: string, area: string, itemId?: string): Promise<ModuleFile[]>;
  store(
    activityId: string,
    area: string,
    file: { name: string; mimeType?: string; data: Buffer; itemId?: string; path?: string },
    opts?: { maxBytes?: number; replace?: boolean },
  ): Promise<ModuleFile>;
  remove(activityId: string, area: string, ids: string[]): Promise<void>;
  /** Moves a finished resumable upload (see /api/uploads) into a file area. */
  storeUpload(
    activityId: string,
    area: string,
    uploadId: string,
    opts?: { itemId?: string; maxBytes?: number; allowedTypes?: RegExp; replace?: boolean },
  ): Promise<ModuleFile>;
  /** Reads a stored file's bytes (worker jobs such as transcoding). */
  open(fileId: string): Promise<{ stream: Readable; name: string; mimeType: string; size: number }>;
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
    opts?: { startAfter?: Date; singletonKey?: string },
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
  suggestGrade(input: { submissionId: string; criteria?: string }): Promise<AiGradeSuggestion>;
  markSuggestion(id: string, status: 'APPLIED' | 'DISCARDED'): Promise<void>;
}

export interface ModuleActivities {
  /** Loads an activity with the viewer's access (for module HTTP routes). */
  get(activityId: string): Promise<{
    activity: ActivityRef;
    canOpen: boolean;
    canManage: boolean;
  } | null>;
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
  locale: 'ru' | 'en';
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
  visibility: 'SHOWN' | 'HIDDEN' | 'STEALTH';
}

export interface GradeItemSpec {
  itemNumber: number;
  name: string;
  gradeMax: number;
  gradePass?: number;
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
  kind: 'grade' | 'submit' | 'attempt';
  dueAt?: Date | null;
  count?: number;
}

export interface ModuleAction<I extends z.ZodType = z.ZodType, O = unknown> {
  input: I;
  /** Capability required at the activity context. */
  capability?: string;
  mutation?: boolean;
  handler(ctx: ModuleCtx, a: ActivityRef, input: z.output<I>): Promise<O>;
}

export interface ActivityModule<S = Record<string, unknown>> {
  key: string;
  archetype: 'activity' | 'resource' | 'inline';
  /** lucide-react icon name, e.g. 'FileText'. */
  icon: string;
  supports: { grading?: boolean; groups?: boolean; viewCompletion?: boolean; backup?: boolean };
  settings: { schema: z.ZodType<S>; defaults(): S };
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
  /** Scheduled jobs run by the worker with a system ModuleCtx. Schedule is cron (UTC). */
  cron?: { name: string; schedule: string; handler(ctx: ModuleCtx): Promise<unknown> }[];
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

/** Parses raw settings with the module schema, falling back to defaults per field. */
export function parseSettings<S>(m: ActivityModule<S>, raw: unknown): S {
  const r = m.settings.schema.safeParse(raw);
  if (r.success) return r.data;
  const merged = {
    ...(m.settings.defaults() as object),
    ...((raw && typeof raw === 'object' ? raw : {}) as object),
  };
  const r2 = m.settings.schema.safeParse(merged);
  return r2.success ? r2.data : m.settings.defaults();
}

/** Typed helper so action handlers infer their input from the zod schema. */
export function defineAction<I extends z.ZodType, O>(a: ModuleAction<I, O>): ModuleAction {
  return a as unknown as ModuleAction;
}
