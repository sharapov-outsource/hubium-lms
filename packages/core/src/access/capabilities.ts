import type { ContextLevel, RoleArchetype } from '@hubium/db';

export type Archetype = `${RoleArchetype}`;
export type Level = `${ContextLevel}`;

export interface CapabilityDef {
  /** Lowest context level the capability makes sense at. */
  level: Level;
  /** Archetypes that get ALLOW when the capability is first synced. */
  archetypes: readonly Archetype[];
  /** Risky capabilities are highlighted in the role editor. */
  risk?: readonly ('config' | 'personal' | 'xss' | 'spam' | 'dataloss')[];
  /** Participation capabilities that site admins do not get implicitly. */
  excludeAdmin?: boolean;
}

const M = 'MANAGER';
const CC = 'COURSECREATOR';
const ET = 'EDITINGTEACHER';
const T = 'TEACHER';
const S = 'STUDENT';
const O = 'OBSERVER';
const G = 'GUEST';
const U = 'USER';

// Code-defined capability registry. Keys form the Capability string-literal type,
// so a typo in `ctx.perm.require('cours:update')` fails to compile.
export const coreCapabilities = {
  // site
  'site:config': { level: 'SYSTEM', archetypes: [], risk: ['config'] },
  'user:create': { level: 'SYSTEM', archetypes: [M], risk: ['personal'] },
  'user:update': { level: 'SYSTEM', archetypes: [M], risk: ['personal'] },
  'user:delete': { level: 'SYSTEM', archetypes: [M], risk: ['personal', 'dataloss'] },
  'user:viewdetails': { level: 'COURSE', archetypes: [M, ET, T] },
  'user:loginas': { level: 'COURSE', archetypes: [M], risk: ['personal'] },
  'cohort:manage': { level: 'CATEGORY', archetypes: [M] },
  'category:manage': { level: 'CATEGORY', archetypes: [M] },
  'role:manage': { level: 'SYSTEM', archetypes: [], risk: ['config'] },
  'role:assign': { level: 'COURSE', archetypes: [M, ET] },
  'role:override': { level: 'COURSE', archetypes: [M], risk: ['config'] },
  'role:review': { level: 'COURSE', archetypes: [M, ET] },
  // courses
  'course:create': { level: 'CATEGORY', archetypes: [M, CC] },
  'course:view': { level: 'COURSE', archetypes: [M] },
  'course:update': { level: 'COURSE', archetypes: [M, ET], risk: ['xss'] },
  'course:delete': { level: 'COURSE', archetypes: [M], risk: ['dataloss'] },
  'course:viewhidden': { level: 'COURSE', archetypes: [M, ET] },
  'course:manageactivities': { level: 'COURSE', archetypes: [M, ET], risk: ['xss'] },
  'course:viewparticipants': { level: 'COURSE', archetypes: [M, ET, T, S, O] },
  'course:switchrole': { level: 'COURSE', archetypes: [M, ET] },
  'course:reset': { level: 'COURSE', archetypes: [M], risk: ['dataloss'] },
  'enrol:manage': { level: 'COURSE', archetypes: [M, ET] },
  'enrol:self': { level: 'COURSE', archetypes: [U] },
  'group:manage': { level: 'COURSE', archetypes: [M, ET] },
  'group:accessall': { level: 'COURSE', archetypes: [M, ET, T] },
  'completion:viewreports': { level: 'COURSE', archetypes: [M, ET, T, O] },
  'completion:override': { level: 'COURSE', archetypes: [M, ET] },
  'report:view': { level: 'COURSE', archetypes: [M, ET, T, O] },
  'report:logs': { level: 'COURSE', archetypes: [M, ET] },
  // grades
  'grade:view': { level: 'COURSE', archetypes: [S] },
  'grade:viewall': { level: 'COURSE', archetypes: [M, ET, T, O] },
  'grade:edit': { level: 'COURSE', archetypes: [M, ET, T] },
  'grade:manage': { level: 'COURSE', archetypes: [M, ET] },
  'grade:export': { level: 'COURSE', archetypes: [M, ET, T] },
  'grade:import': { level: 'COURSE', archetypes: [M, ET] },
  // communication
  'announcement:post': { level: 'COURSE', archetypes: [M, ET], risk: ['spam'] },
  'message:send': { level: 'SYSTEM', archetypes: [U] },
  // REST API personal access tokens (a token never exceeds its user's capabilities)
  'webservice:createtoken': { level: 'SYSTEM', archetypes: [U], risk: ['personal'] },
  'calendar:manageown': { level: 'SYSTEM', archetypes: [U] },
  'calendar:managecourse': { level: 'COURSE', archetypes: [M, ET] },
  'calendar:managesite': { level: 'SYSTEM', archetypes: [M] },
  // questions, backup, import
  'question:manage': { level: 'COURSE', archetypes: [M, ET] },
  'question:use': { level: 'COURSE', archetypes: [M, ET] },
  'backup:create': { level: 'COURSE', archetypes: [M, ET] },
  'restore:course': { level: 'COURSE', archetypes: [M, ET], risk: ['xss'] },
  'import:moodle': { level: 'COURSE', archetypes: [M, ET], risk: ['xss'] },
  // AI
  'ai:quizgen': { level: 'COURSE', archetypes: [M, ET] },
  'ai:gradingassist': { level: 'COURSE', archetypes: [M, ET, T] },
  'ai:tutor': { level: 'COURSE', archetypes: [U] },
  // activities (shared by all modules)
  'activity:view': { level: 'ACTIVITY', archetypes: [M, ET, T, S, O, G] },
  // assignment
  'mod.assign:submit': { level: 'ACTIVITY', archetypes: [S], excludeAdmin: true },
  'mod.assign:grade': { level: 'ACTIVITY', archetypes: [M, ET, T] },
  'mod.assign:grantextension': { level: 'ACTIVITY', archetypes: [M, ET] },
  // quiz
  'mod.quiz:attempt': { level: 'ACTIVITY', archetypes: [S], excludeAdmin: true },
  'mod.quiz:grade': { level: 'ACTIVITY', archetypes: [M, ET, T] },
  'mod.quiz:preview': { level: 'ACTIVITY', archetypes: [M, ET, T] },
  'mod.quiz:viewreports': { level: 'ACTIVITY', archetypes: [M, ET, T] },
  // forum
  'mod.forum:post': { level: 'ACTIVITY', archetypes: [M, ET, T, S], excludeAdmin: false },
  'mod.forum:startdiscussion': { level: 'ACTIVITY', archetypes: [M, ET, T, S] },
  'mod.forum:moderate': { level: 'ACTIVITY', archetypes: [M, ET, T] },
  // video / live
  'mod.video:viewprogress': { level: 'ACTIVITY', archetypes: [M, ET, T] },
  'mod.livesession:join': { level: 'ACTIVITY', archetypes: [M, ET, T, S] },
  'mod.livesession:moderate': { level: 'ACTIVITY', archetypes: [M, ET, T] },
  // standards
  'mod.scorm:launch': { level: 'ACTIVITY', archetypes: [M, ET, T, S] },
  'mod.scorm:viewreports': { level: 'ACTIVITY', archetypes: [M, ET, T] },
  'mod.lti:launch': { level: 'ACTIVITY', archetypes: [M, ET, T, S] },
  'mod.lti:manage': { level: 'COURSE', archetypes: [M, ET], risk: ['config'] },
} as const satisfies Record<string, CapabilityDef>;

export type Capability = keyof typeof coreCapabilities;

export const capabilities: ReadonlyMap<Capability, CapabilityDef> = new Map(
  Object.entries(coreCapabilities) as [Capability, CapabilityDef][],
);

export function isCapability(value: string): value is Capability {
  return capabilities.has(value as Capability);
}

export function getCapability(cap: string): CapabilityDef {
  const def = capabilities.get(cap as Capability);
  if (!def) throw new Error(`Unknown capability: ${cap}`);
  return def;
}

/** Capabilities a fresh role of the given archetype receives. */
export function defaultCapabilitiesFor(archetype: Archetype): Capability[] {
  const out: Capability[] = [];
  for (const [cap, def] of capabilities) {
    if (def.archetypes.includes(archetype)) out.push(cap);
  }
  return out;
}

/** Capability "component" — the prefix before ':' — used to group rows in the role editor. */
export function capabilityComponent(cap: string): string {
  return cap.slice(0, cap.indexOf(':'));
}
