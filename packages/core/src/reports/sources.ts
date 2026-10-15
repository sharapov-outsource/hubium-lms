// The sources of custom reports and the fields each offers: the only SQL a report runs
// comes from here. A report picks fields by key; values it compares with are bound as
// parameters. Fields of custom profile and course fields are added at run time by their
// short names (bound as parameters too).

export const FIELD_TYPES = ['text', 'number', 'date', 'boolean', 'enum'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface FieldDef {
  key: string;
  type: FieldType;
  /** A fixed SQL expression over the source's aliases. */
  sql: string;
  /** enum: its values (labels under reports.values.<key>). */
  options?: readonly string[];
}

export interface SourceDef {
  key: string;
  /** FROM … JOIN …: fixed SQL. */
  from: string;
  /** Always applied. */
  where: string;
  /** The entities whose fields the source offers. */
  entities: readonly Entity[];
  /** Custom fields offered: of users (u) and/or of courses (c). */
  customFields: readonly ('user' | 'course')[];
  defaultColumns: readonly string[];
}

type Entity =
  | 'user'
  | 'course'
  | 'enrolment'
  | 'completion'
  | 'grade'
  | 'badge'
  | 'certificate'
  | 'competency'
  | 'plan';

const user: FieldDef[] = [
  { key: 'user.fullName', type: 'text', sql: 'u."name"' },
  { key: 'user.firstName', type: 'text', sql: 'u."firstName"' },
  { key: 'user.lastName', type: 'text', sql: 'u."lastName"' },
  { key: 'user.username', type: 'text', sql: 'u."username"::text' },
  {
    key: 'user.email',
    type: 'text',
    sql: 'CASE WHEN u."emailPlaceholder" THEN NULL ELSE u."email"::text END',
  },
  {
    key: 'user.status',
    type: 'enum',
    sql: 'u."status"::text',
    options: ['ACTIVE', 'SUSPENDED'],
  },
  { key: 'user.createdAt', type: 'date', sql: 'u."createdAt"' },
  { key: 'user.lastLoginAt', type: 'date', sql: 'u."lastLoginAt"' },
  { key: 'user.lastAccessAt', type: 'date', sql: 'u."lastAccessAt"' },
  { key: 'user.twoFactor', type: 'boolean', sql: 'u."twoFactorEnabled"' },
];

const course: FieldDef[] = [
  { key: 'course.fullName', type: 'text', sql: 'c."fullName"' },
  { key: 'course.shortName', type: 'text', sql: 'c."shortName"::text' },
  { key: 'course.idNumber', type: 'text', sql: 'c."idNumber"' },
  { key: 'course.category', type: 'text', sql: 'cat."name"' },
  { key: 'course.startDate', type: 'date', sql: 'c."startDate"' },
  { key: 'course.endDate', type: 'date', sql: 'c."endDate"' },
  { key: 'course.visible', type: 'boolean', sql: 'c."visible"' },
  {
    key: 'course.format',
    type: 'enum',
    sql: 'c."format"::text',
    options: ['TOPICS', 'WEEKS', 'SINGLE'],
  },
  { key: 'course.createdAt', type: 'date', sql: 'c."createdAt"' },
];

const courseStats: FieldDef[] = [
  {
    key: 'course.participants',
    type: 'number',
    sql: `(SELECT COUNT(DISTINCT x."userId") FROM "Enrolment" x WHERE x."courseId" = c.id AND x."status" = 'ACTIVE')`,
  },
  {
    key: 'course.completed',
    type: 'number',
    sql: `(SELECT COUNT(*) FROM "CourseCompletion" x WHERE x."courseId" = c.id AND x."completedAt" IS NOT NULL)`,
  },
];

const enrolment: FieldDef[] = [
  {
    key: 'enrolment.method',
    type: 'enum',
    sql: 'm."type"::text',
    options: ['MANUAL', 'SELF', 'COHORT', 'GUEST'],
  },
  {
    key: 'enrolment.status',
    type: 'enum',
    sql: 'e."status"::text',
    options: ['ACTIVE', 'SUSPENDED'],
  },
  { key: 'enrolment.createdAt', type: 'date', sql: 'e."createdAt"' },
  { key: 'enrolment.endsAt', type: 'date', sql: 'e."endsAt"' },
  {
    key: 'enrolment.roles',
    type: 'text',
    sql: `(SELECT STRING_AGG(DISTINCT r."shortName", ', ') FROM "RoleAssignment" ra JOIN "Role" r ON r.id = ra."roleId" WHERE ra."contextId" = e."courseId" AND ra."userId" = e."userId")`,
  },
];

const completion: FieldDef[] = [
  { key: 'completion.progress', type: 'number', sql: 'COALESCE(cc."progressPercent", 0)' },
  { key: 'completion.completed', type: 'boolean', sql: '(cc."completedAt" IS NOT NULL)' },
  { key: 'completion.completedAt', type: 'date', sql: 'cc."completedAt"' },
  { key: 'completion.startedAt', type: 'date', sql: 'cc."startedAt"' },
];

const grade: FieldDef[] = [
  {
    key: 'grade.item',
    type: 'text',
    sql: `CASE WHEN gi."kind" = 'COURSE' THEN c."fullName" ELSE gi."name" END`,
  },
  {
    key: 'grade.kind',
    type: 'enum',
    sql: 'gi."kind"::text',
    options: ['COURSE', 'CATEGORY', 'MODULE', 'MANUAL'],
  },
  { key: 'grade.grade', type: 'number', sql: 'g."finalGrade"' },
  { key: 'grade.max', type: 'number', sql: 'gi."gradeMax"' },
  {
    key: 'grade.percent',
    type: 'number',
    sql: `CASE WHEN gi."gradeMax" > gi."gradeMin" THEN ROUND((g."finalGrade" - gi."gradeMin") / (gi."gradeMax" - gi."gradeMin") * 100, 1) END`,
  },
  { key: 'grade.updatedAt', type: 'date', sql: 'g."updatedAt"' },
];

const badge: FieldDef[] = [
  { key: 'badge.name', type: 'text', sql: 'b."name"' },
  { key: 'badge.site', type: 'boolean', sql: '(b."courseId" IS NULL)' },
  { key: 'badge.issuedAt', type: 'date', sql: 'ba."issuedAt"' },
  { key: 'badge.expiresAt', type: 'date', sql: 'ba."expiresAt"' },
  { key: 'badge.revoked', type: 'boolean', sql: '(ba."revokedAt" IS NOT NULL)' },
];

const certificate: FieldDef[] = [
  { key: 'certificate.name', type: 'text', sql: 'ce."name"' },
  { key: 'certificate.code', type: 'text', sql: 'ci."code"' },
  { key: 'certificate.issuedAt', type: 'date', sql: 'ci."issuedAt"' },
  { key: 'certificate.revoked', type: 'boolean', sql: '(ci."revokedAt" IS NOT NULL)' },
];

const competency: FieldDef[] = [
  { key: 'competency.framework', type: 'text', sql: 'fw."shortName"' },
  { key: 'competency.name', type: 'text', sql: 'comp."shortName"' },
  { key: 'competency.idNumber', type: 'text', sql: 'comp."idNumber"' },
  { key: 'competency.rating', type: 'text', sql: '(COALESCE(cs."items", fs."items"))[uc."grade"]' },
  { key: 'competency.proficient', type: 'boolean', sql: 'COALESCE(uc."proficiency", false)' },
  {
    key: 'competency.status',
    type: 'enum',
    sql: 'uc."status"::text',
    options: ['IDLE', 'WAITING_FOR_REVIEW', 'IN_REVIEW'],
  },
  { key: 'competency.updatedAt', type: 'date', sql: 'uc."updatedAt"' },
];

const plan: FieldDef[] = [
  { key: 'plan.name', type: 'text', sql: 'lp."name"' },
  {
    key: 'plan.status',
    type: 'enum',
    sql: 'lp."status"::text',
    options: ['DRAFT', 'WAITING_FOR_REVIEW', 'IN_REVIEW', 'ACTIVE', 'COMPLETE'],
  },
  { key: 'plan.dueDate', type: 'date', sql: 'lp."dueDate"' },
  { key: 'plan.template', type: 'text', sql: 'lpt."name"' },
  { key: 'plan.createdAt', type: 'date', sql: 'lp."createdAt"' },
];

const FIELDS: Record<Entity, FieldDef[]> = {
  user,
  course,
  enrolment,
  completion,
  grade,
  badge,
  certificate,
  competency,
  plan,
};

const LIVE_USER = 'u."deletedAt" IS NULL';
const LIVE_COURSE = 'c."deletedAt" IS NULL';
const COURSE_JOIN = 'JOIN "Category" cat ON cat.id = c."categoryId"';

export const SOURCES: Record<string, SourceDef> = {
  users: {
    key: 'users',
    from: '"User" u',
    where: `${LIVE_USER} AND u."kind" = 'PERSON'`,
    entities: ['user'],
    customFields: ['user'],
    defaultColumns: ['user.fullName', 'user.email', 'user.lastAccessAt'],
  },
  courses: {
    key: 'courses',
    from: `"Course" c ${COURSE_JOIN}`,
    where: LIVE_COURSE,
    entities: ['course'],
    customFields: ['course'],
    defaultColumns: ['course.fullName', 'course.category', 'course.participants'],
  },
  participants: {
    key: 'participants',
    from: `"Enrolment" e JOIN "EnrolmentMethod" m ON m.id = e."methodId" JOIN "User" u ON u.id = e."userId" JOIN "Course" c ON c.id = e."courseId" ${COURSE_JOIN} LEFT JOIN "CourseCompletion" cc ON cc."courseId" = e."courseId" AND cc."userId" = e."userId"`,
    where: `${LIVE_USER} AND ${LIVE_COURSE}`,
    entities: ['course', 'user', 'enrolment', 'completion'],
    customFields: ['user', 'course'],
    defaultColumns: [
      'course.fullName',
      'user.fullName',
      'enrolment.createdAt',
      'completion.progress',
    ],
  },
  completion: {
    key: 'completion',
    from: `"CourseCompletion" cc JOIN "User" u ON u.id = cc."userId" JOIN "Course" c ON c.id = cc."courseId" ${COURSE_JOIN}`,
    where: `${LIVE_USER} AND ${LIVE_COURSE}`,
    entities: ['course', 'user', 'completion'],
    customFields: ['user', 'course'],
    defaultColumns: [
      'course.fullName',
      'user.fullName',
      'completion.progress',
      'completion.completedAt',
    ],
  },
  grades: {
    key: 'grades',
    from: `"Grade" g JOIN "GradeItem" gi ON gi.id = g."gradeItemId" JOIN "User" u ON u.id = g."userId" JOIN "Course" c ON c.id = gi."courseId" ${COURSE_JOIN}`,
    where: `${LIVE_USER} AND ${LIVE_COURSE} AND g."finalGrade" IS NOT NULL`,
    entities: ['course', 'user', 'grade'],
    customFields: ['user', 'course'],
    defaultColumns: ['course.fullName', 'user.fullName', 'grade.item', 'grade.grade'],
  },
  badges: {
    key: 'badges',
    from: `"BadgeAward" ba JOIN "Badge" b ON b.id = ba."badgeId" JOIN "User" u ON u.id = ba."userId" LEFT JOIN "Course" c ON c.id = b."courseId" LEFT JOIN "Category" cat ON cat.id = c."categoryId"`,
    where: LIVE_USER,
    entities: ['badge', 'user', 'course'],
    customFields: ['user'],
    defaultColumns: ['badge.name', 'user.fullName', 'badge.issuedAt'],
  },
  certificates: {
    key: 'certificates',
    from: `"CertificateIssue" ci JOIN "Certificate" ce ON ce.id = ci."certificateId" JOIN "User" u ON u.id = ci."userId" JOIN "Course" c ON c.id = ce."courseId" ${COURSE_JOIN}`,
    where: `${LIVE_USER} AND ${LIVE_COURSE}`,
    entities: ['certificate', 'user', 'course'],
    customFields: ['user', 'course'],
    defaultColumns: [
      'certificate.name',
      'course.fullName',
      'user.fullName',
      'certificate.issuedAt',
    ],
  },
  competencies: {
    key: 'competencies',
    from: `"UserCompetency" uc JOIN "Competency" comp ON comp.id = uc."competencyId" JOIN "CompetencyFramework" fw ON fw.id = comp."frameworkId" JOIN "Scale" fs ON fs.id = fw."scaleId" LEFT JOIN "Scale" cs ON cs.id = comp."scaleId" JOIN "User" u ON u.id = uc."userId"`,
    where: LIVE_USER,
    entities: ['competency', 'user'],
    customFields: ['user'],
    defaultColumns: [
      'user.fullName',
      'competency.name',
      'competency.rating',
      'competency.proficient',
    ],
  },
  plans: {
    key: 'plans',
    from: `"LearningPlan" lp JOIN "User" u ON u.id = lp."userId" LEFT JOIN "LearningPlanTemplate" lpt ON lpt.id = lp."templateId"`,
    where: LIVE_USER,
    entities: ['plan', 'user'],
    customFields: ['user'],
    defaultColumns: ['user.fullName', 'plan.name', 'plan.status', 'plan.dueDate'],
  },
};

export const SOURCE_KEYS = Object.keys(SOURCES);

/** The fixed fields of a source, in the order its entities come. */
export function sourceFields(source: SourceDef): FieldDef[] {
  return source.entities.flatMap((e) =>
    e === 'course' && source.key === 'courses' ? [...FIELDS.course, ...courseStats] : FIELDS[e],
  );
}

/** A custom profile or course field, by its short name (bound as a parameter). */
export function customField(kind: 'user' | 'course', shortName: string): FieldDef {
  return {
    key: `${kind}.custom.${shortName}`,
    type: 'text',
    sql: kind === 'user' ? 'u."customFields"->>' : 'c."customFields"->>',
  };
}

/** Aggregations each type of field allows. */
export const AGGREGATES: Record<FieldType, readonly string[]> = {
  text: ['count', 'countDistinct', 'list'],
  number: ['sum', 'avg', 'min', 'max', 'count'],
  date: ['min', 'max', 'count'],
  boolean: ['countTrue', 'count'],
  enum: ['count', 'countDistinct', 'list'],
};

/** Comparisons each type of field allows. */
export const OPERATORS: Record<FieldType, readonly string[]> = {
  text: ['contains', 'notContains', 'equals', 'startsWith', 'empty', 'notEmpty'],
  number: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'empty', 'notEmpty'],
  date: ['after', 'before', 'lastDays', 'nextDays', 'empty', 'notEmpty'],
  boolean: ['isTrue', 'isFalse'],
  enum: ['in', 'notIn'],
};
