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

export interface ModuleNotify {
  send(
    userIds: string[],
    n: {
      type: string;
      title: string;
      body?: string;
      url?: string;
      courseId?: string;
      contextId?: string;
    },
  ): Promise<void>;
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
  actions?: Record<string, ModuleAction>;
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
  backup?: {
    export(ctx: ModuleCtx, a: ActivityRef<S>): Promise<unknown>;
    import(ctx: ModuleCtx, a: ActivityRef<S>, data: unknown): Promise<void>;
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
