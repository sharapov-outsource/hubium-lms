import { bool, isoDate, optionalNumber } from '@hubium/module-sdk/fields';
import { z } from 'zod';

export const AssignSettings = z
  .object({
    allowText: bool(true),
    allowFiles: bool(true),
    maxFiles: z.coerce.number().int().min(1).max(20).default(5),
    maxFileMB: z.coerce.number().int().min(1).max(500).default(20),
    wordLimit: z.coerce.number().int().min(0).max(100_000).default(0),
    openAt: isoDate,
    dueAt: isoDate,
    cutoffAt: isoDate,
    gradeMax: z.coerce.number().min(1).max(10_000).default(100),
    gradePass: optionalNumber(0, 10_000),
    /** Grade on this scale instead of points (grades are its 1-based positions). */
    scaleId: z.preprocess((v) => (v === '' ? null : v), z.string().uuid().nullable()).default(null),
    submitButton: bool(true),
    reopen: z.enum(['none', 'manual', 'untilpass']).default('none'),
    maxAttempts: z.coerce.number().int().min(0).max(100).default(0),
    /** Students accept that the work is their own before they submit. */
    requireStatement: bool(false),
    /** Percent of the grade lost for every started day late, up to the cap. */
    latePenaltyPerDay: z.coerce.number().min(0).max(100).default(0),
    latePenaltyCap: z.coerce.number().min(0).max(100).default(100),
    /** Students submit as teams: the groups of the assignment's grouping. */
    teamSubmission: bool(false),
    /** A team's work is submitted once every member has submitted it. */
    requireAllTeamMembers: bool(false),
    /** Students in no group cannot submit (otherwise they submit alone). */
    preventSubmissionNotInGroup: bool(false),
  })
  .refine((s) => s.allowText || s.allowFiles, {
    message: 'Allow text or files',
    path: ['allowText'],
  })
  .refine((s) => !s.dueAt || !s.openAt || s.dueAt > s.openAt, {
    message: 'Due date must be after the opening date',
    path: ['dueAt'],
  })
  .refine((s) => !s.cutoffAt || !s.dueAt || s.cutoffAt >= s.dueAt, {
    message: 'Cut-off must not be before the due date',
    path: ['cutoffAt'],
  })
  .refine((s) => s.gradePass === undefined || s.gradePass <= s.gradeMax, {
    message: 'Pass grade exceeds maximum',
    path: ['gradePass'],
  });

export type AssignSettingsT = z.output<typeof AssignSettings>;
