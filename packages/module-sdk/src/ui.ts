import type { ComponentType, ReactNode } from 'react';
import type { ActivityRef, ModuleCtx } from './index.ts';

export interface SettingsFieldsProps<S = Record<string, unknown>> {
  settings: S;
  /** Field errors keyed by `settings.<field>`. */
  errors?: Record<string, string[]>;
  activityId?: string;
  courseId: string;
  /** Existing files in module file areas (for edit forms). */
  files?: Record<string, { id: string; name: string; url: string }[]>;
  /** Grade scales the course can use (the site's and its own). */
  scales?: { id: string; name: string; items: string[] }[];
  /** The site's local nodes, for rules that name them (a quiz taken only in a branch). */
  nodes?: { id: string; name: string }[];
}

export interface ViewProps<S = Record<string, unknown>> {
  activity: ActivityRef<S>;
  course: { id: string; fullName: string; shortName: string };
  ctx: ModuleCtx;
  /** Can the viewer manage this activity (edit, grade)? */
  canManage: boolean;
  searchParams: Record<string, string | undefined>;
}

export interface ActivityModuleUI<S = Record<string, unknown>> {
  key: string;
  /** Client component rendered inside the generic activity form. */
  SettingsFields: ComponentType<SettingsFieldsProps<S>>;
  /** Server component for /course/:id/a/:activityId. */
  View(props: ViewProps<S>): Promise<ReactNode> | ReactNode;
  /** Extra completion rule fields (client), rendered when completion is automatic. */
  CompletionRulesFields?: ComponentType<{ rules: Record<string, unknown> }>;
  /** Optional inline rendering on the course page (labels, rich cards). */
  Inline?(props: { activity: ActivityRef<S> }): Promise<ReactNode> | ReactNode;
}

export function defineModuleUI<S>(ui: ActivityModuleUI<S>): ActivityModuleUI<S> {
  return ui;
}
