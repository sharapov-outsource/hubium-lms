import { coursesWithCap, getModule } from '@hubium/core';
import { Button, Card, CardContent, Input, PageHeader } from '@hubium/ui';
import Link from 'next/link';
import { forbidden } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { titled } from '@/server/page-title';
import { getContext } from '@/server/session';
import { ImportForm } from './import-form';

export const generateMetadata = titled('courseImport', 'title');

// Import (as in Moodle): activities of another course the person can back up are copied
// into this one. First the course is chosen, then what to take from it.

export default async function CourseImportPage({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string }>;
  searchParams: Promise<{ q?: string; from?: string }>;
}) {
  const { courseId } = await params;
  const sp = await searchParams;
  const ctx = await getContext();
  if (!(await ctx.perm.can('restore:course', courseId).catch(() => false))) forbidden();
  const t = await getTranslations('courseImport');
  const source = sp.from && sp.from !== courseId ? await sourceCourse(sp.from) : null;

  return (
    <div className="grid max-w-3xl gap-6">
      <PageHeader title={t('title')} description={t('description')} className="mb-0" />
      {source ? await chosen(source) : await choose()}
    </div>
  );

  async function sourceCourse(id: string) {
    if (!(await ctx.perm.can('backup:create', id).catch(() => false))) return null;
    return ctx.db.course.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, fullName: true, shortName: true, format: true },
    });
  }

  async function choose() {
    const q = sp.q?.trim().slice(0, 200) ?? '';
    // without a query: the courses the person has a role in; with one: any course found
    const own = q
      ? undefined
      : (
          await ctx.db.roleAssignment.findMany({
            where: { userId: ctx.perm.userId ?? '' },
            select: { contextId: true },
          })
        ).map((r) => r.contextId);
    const courses = await coursesWithCap(ctx, 'backup:create', {
      where: {
        id: { not: courseId, in: own },
        ...(q
          ? {
              OR: [
                { fullName: { contains: q, mode: 'insensitive' } },
                { shortName: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: { id: true, fullName: true, shortName: true },
      take: 100,
    });
    return (
      <Card>
        <CardContent className="grid gap-4 pt-5">
          <form className="flex flex-wrap gap-2">
            <label htmlFor="import-q" className="sr-only">
              {t('search')}
            </label>
            <Input
              id="import-q"
              name="q"
              defaultValue={q}
              placeholder={t('search')}
              className="w-full sm:w-72"
            />
            <Button type="submit" variant="outline">
              {t('find')}
            </Button>
          </form>
          {courses.length ? (
            <ul className="grid gap-1" aria-label={t('courses')}>
              {courses.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/course/${courseId}/import?from=${c.id}`}
                    className="block rounded-md px-2 py-1.5 text-sm hover:bg-accent"
                  >
                    {c.fullName} <span className="text-muted-foreground">({c.shortName})</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{q ? t('noneFound') : t('noneOwn')}</p>
          )}
        </CardContent>
      </Card>
    );
  }

  async function chosen(c: NonNullable<typeof source>) {
    const tc = await getTranslations('course');
    const tm = await getTranslations('mod');
    const activities = {
      where: { deletedAt: null },
      orderBy: { rank: 'asc' as const },
      select: { id: true, name: true, moduleKey: true },
    };
    const sections = await ctx.db.courseSection.findMany({
      where: { courseId: c.id, parentId: null },
      orderBy: { rank: 'asc' },
      include: { activities, subsections: { orderBy: { rank: 'asc' }, include: { activities } } },
    });
    const title = (s: { title: string }, i: number) =>
      s.title ||
      (i === 0
        ? tc('general')
        : c.format === 'WEEKS'
          ? tc('week', { n: i })
          : tc('section', { n: i }));
    return (
      <ImportForm
        targetCourseId={courseId}
        source={{ id: c.id, name: `${c.fullName} (${c.shortName})` }}
        sections={sections
          .flatMap((s, i) => [
            { id: s.id, title: title(s, i), activities: s.activities },
            // what is in a subsection lands in the section with the same number
            ...s.subsections.map((c) => ({
              id: c.id,
              title: `${title(s, i)} › ${c.title || tc('subsection')}`,
              activities: c.activities,
            })),
          ])
          .map((s) => ({
            ...s,
            activities: s.activities.map((a) => ({
              id: a.id,
              name: a.name,
              type: getModule(a.moduleKey) ? tm(`${a.moduleKey}.name` as never) : a.moduleKey,
            })),
          }))
          .filter((s) => s.activities.length)}
      />
    );
  }
}
