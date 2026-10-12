import { Badge, Button, Input, PageHeader, Table, TBody, Td, THead, Th, Tr } from '@hubium/ui';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { CommandButton } from '@/components/confirm-button';
import { restoreCourseAction } from '@/server/actions/courses';
import { db } from '@/server/db';
import { requireCapability } from '@/server/session';

export default async function AdminCoursesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; bin?: string }>;
}) {
  await requireCapability('category:manage');
  const sp = await searchParams;
  const [t, tc, tco, format] = await Promise.all([
    getTranslations('adminCourses'),
    getTranslations('common'),
    getTranslations('course'),
    getFormatter(),
  ]);
  const bin = sp.bin === '1';
  const courses = await db.course.findMany({
    where: {
      deletedAt: bin ? { not: null } : null,
      ...(sp.q
        ? {
            OR: [
              { fullName: { contains: sp.q, mode: 'insensitive' } },
              { shortName: { contains: sp.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: { category: { select: { name: true } }, _count: { select: { enrolments: true } } },
  });
  return (
    <>
      <PageHeader
        title={bin ? t('bin') : t('title')}
        actions={
          <>
            <Button asChild variant="ghost">
              <Link href={bin ? '/admin/courses' : '/admin/courses?bin=1'}>
                {bin ? t('title') : t('bin')}
              </Link>
            </Button>
            <Button asChild>
              <Link href="/course/new">
                <Plus />
                {t('new')}
              </Link>
            </Button>
          </>
        }
      />
      <form className="mb-4 flex max-w-md gap-2">
        {bin ? <input type="hidden" name="bin" value="1" /> : null}
        <label htmlFor="cq" className="sr-only">
          {tc('search')}
        </label>
        <Input id="cq" name="q" defaultValue={sp.q} placeholder={tc('searchPlaceholder')} />
        <Button type="submit" variant="secondary">
          {tc('search')}
        </Button>
      </form>
      <Table>
        <THead>
          <Tr>
            <Th>{tco('fullName')}</Th>
            <Th>{tco('category')}</Th>
            <Th className="text-right">{tco('tabs.participants')}</Th>
            <Th>{tc('created')}</Th>
            {bin ? <Th /> : null}
          </Tr>
        </THead>
        <TBody>
          {courses.map((c) => (
            <Tr key={c.id}>
              <Td>
                <Link href={`/course/${c.id}`} className="font-medium hover:underline">
                  {c.fullName}
                </Link>
                <span className="ml-2 font-mono text-xs text-muted-foreground">{c.shortName}</span>
                {!c.visible ? (
                  <Badge variant="warning" className="ml-2">
                    {tco('hiddenCourse')}
                  </Badge>
                ) : null}
              </Td>
              <Td>{c.category.name}</Td>
              <Td className="text-right tabular-nums">{c._count.enrolments}</Td>
              <Td className="whitespace-nowrap text-muted-foreground">
                {format.dateTime(c.createdAt, { dateStyle: 'medium' })}
              </Td>
              {bin ? (
                <Td className="text-right">
                  <CommandButton
                    size="sm"
                    variant="secondary"
                    run={restoreCourseAction.bind(null, c.id)}
                  >
                    {t('restore')}
                  </CommandButton>
                </Td>
              ) : null}
            </Tr>
          ))}
        </TBody>
      </Table>
    </>
  );
}
