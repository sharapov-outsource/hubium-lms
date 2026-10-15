import { getAllSettings } from '@hubium/core';
import {
  Badge,
  Button,
  EmptyState,
  Input,
  PageHeader,
  Table,
  TBody,
  Td,
  THead,
  Th,
  Tr,
} from '@hubium/ui';
import { Plus, Upload } from 'lucide-react';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { CommandButton } from '@/components/confirm-button';
import { Pagination } from '@/components/pagination';
import { pageParam, textParam } from '@/lib/url-params';
import { purgeCourseAction, restoreCourseAction } from '@/server/actions/courses';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { requireCapability } from '@/server/session';

export const generateMetadata = titled('adminCourses', 'title');

const PAGE_SIZE = 50;

export default async function AdminCoursesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; bin?: string; page?: string }>;
}) {
  await requireCapability('category:manage');
  const sp = await searchParams;
  const [t, tc, tco, format, tb] = await Promise.all([
    getTranslations('adminCourses'),
    getTranslations('common'),
    getTranslations('course'),
    getFormatter(),
    getTranslations('backup'),
  ]);
  const bin = sp.bin === '1';
  const q = textParam(sp.q);
  const page = pageParam(sp.page);
  const keepDays = (await getAllSettings(db))['recyclebin.days'];
  const where = {
    deletedAt: bin ? { not: null } : null,
    ...(q
      ? {
          OR: [
            { fullName: { contains: q, mode: 'insensitive' as const } },
            { shortName: { contains: q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };
  const [total, courses] = await Promise.all([
    db.course.count({ where }),
    db.course.findMany({
      where,
      // the bin shows the latest removed first
      orderBy: [bin ? { deletedAt: 'desc' } : { createdAt: 'desc' }, { id: 'asc' }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { category: { select: { name: true } }, _count: { select: { enrolments: true } } },
    }),
  ]);
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
            <Button asChild variant="outline">
              <Link href="/course/import">
                <Upload />
                {tb('importTitle')}
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
      {bin ? (
        <p className="mb-4 text-sm text-muted-foreground">
          {keepDays ? t('binHint', { days: keepDays }) : t('binKeep')}
        </p>
      ) : null}
      <form className="mb-4 flex max-w-md gap-2">
        {bin ? <input type="hidden" name="bin" value="1" /> : null}
        <label htmlFor="cq" className="sr-only">
          {tc('search')}
        </label>
        <Input id="cq" name="q" defaultValue={q} placeholder={tc('searchPlaceholder')} />
        <Button type="submit" variant="secondary">
          {tc('search')}
        </Button>
      </form>
      {total === 0 ? (
        <EmptyState title={q ? tc('nothingFound') : bin ? t('binEmpty') : t('empty')} />
      ) : (
        <Table>
          <THead>
            <Tr>
              <Th>{tco('fullName')}</Th>
              <Th>{tco('category')}</Th>
              <Th className="text-right">{tco('tabs.participants')}</Th>
              <Th>{tc('created')}</Th>
              {bin ? (
                <Th>
                  <span className="sr-only">{tc('actions')}</span>
                </Th>
              ) : null}
            </Tr>
          </THead>
          <TBody>
            {courses.map((c) => (
              <Tr key={c.id}>
                <Td>
                  <Link href={`/course/${c.id}`} className="font-medium hover:underline">
                    {c.fullName}
                  </Link>
                  <span className="ml-2 font-mono text-xs text-muted-foreground">
                    {c.shortName}
                  </span>
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
                    <div className="flex justify-end gap-2">
                      <CommandButton
                        size="sm"
                        variant="secondary"
                        run={restoreCourseAction.bind(null, c.id)}
                      >
                        {t('restore')}
                      </CommandButton>
                      <CommandButton
                        size="sm"
                        variant="destructive"
                        run={purgeCourseAction.bind(null, c.id)}
                        confirm={t('purgeConfirm', { name: c.fullName })}
                      >
                        {t('purge')}
                      </CommandButton>
                    </div>
                  </Td>
                ) : null}
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        params={{ q, bin: bin ? '1' : undefined }}
      />
    </>
  );
}
