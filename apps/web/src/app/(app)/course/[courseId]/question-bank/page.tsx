import { aiFeaturesFor, listQuestionCategories, listQuestions } from '@hubium/core';
import { questionTypes } from '@hubium/questions';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Table,
  TBody,
  Td,
  THead,
  Th,
  Tr,
} from '@hubium/ui';
import { cn } from '@hubium/ui/cn';
import { Download, Plus, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { forbidden } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { titled } from '@/server/page-title';
import { getContext } from '@/server/session';
import {
  CategoryForm,
  DeleteCategoryButton,
  DeleteQuestionButton,
  GiftImportForm,
} from './bank-parts';

export const generateMetadata = titled('course', 'tabs.questionBank');

export default async function QuestionBankPage({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string }>;
  searchParams: Promise<{ category?: string; q?: string }>;
}) {
  const [{ courseId }, sp] = await Promise.all([params, searchParams]);
  const ctx = await getContext();
  if (!(await ctx.perm.can('question:manage', courseId))) forbidden();
  const [t, format] = await Promise.all([getTranslations('qbank'), getFormatter()]);
  const categories = await listQuestionCategories(ctx, courseId);
  const current =
    categories.find((c) => c.id === sp.category) ?? categories.find((c) => !c.parentId)!;
  const questions = await listQuestions(ctx, courseId, {
    categoryId: current.id,
    q: sp.q,
    includeHidden: true,
  });
  const base = `/course/${courseId}/question-bank`;
  const ai = await aiFeaturesFor(ctx, courseId);
  return (
    <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
      <div className="grid content-start gap-4">
        <Card>
          <CardHeader>
            <CardTitle>{t('categories')}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-1">
            {categories.map((c) => (
              <Link
                key={c.id}
                href={`${base}?category=${c.id}`}
                aria-current={c.id === current.id ? 'page' : undefined}
                className={cn(
                  'flex justify-between rounded-md px-2 py-1.5 text-sm',
                  c.id === current.id ? 'bg-accent-soft font-medium text-accent' : 'hover:bg-muted',
                  c.parentId && 'pl-5',
                )}
              >
                <span className="truncate">{c.name || t('defaultCategory')}</span>
                <span className="text-xs text-muted-foreground">{c._count.questions}</span>
              </Link>
            ))}
            <CategoryForm courseId={courseId} />
          </CardContent>
        </Card>
      </div>
      <div className="grid content-start gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-auto text-lg font-semibold">{current.name || t('defaultCategory')}</h2>
          {/* only an empty category below the default one can go */}
          {current.parentId &&
          !current._count.questions &&
          !categories.some((c) => c.parentId === current.id) ? (
            <DeleteCategoryButton courseId={courseId} id={current.id} name={current.name} />
          ) : null}
          {ai.QUIZGEN ? (
            <Button asChild size="sm">
              <Link href={`${base}/ai?category=${current.id}`}>
                <Sparkles />
                {t('aiGenerate')}
              </Link>
            </Button>
          ) : null}
          <Button asChild variant="outline" size="sm">
            <a href={`${base}/export?category=${current.id}`}>
              <Download />
              {t('export')}
            </a>
          </Button>
          <Button asChild variant="outline" size="sm">
            <a href={`${base}/export?category=${current.id}&format=xml`}>
              <Download />
              {t('exportXml')}
            </a>
          </Button>
        </div>
        <Card>
          <CardContent className="flex flex-wrap gap-2 pt-5">
            <span className="w-full text-sm font-medium">{t('newQuestion')}</span>
            {questionTypes.map((type) => (
              <Button key={type} asChild size="sm" variant="secondary">
                <Link href={`${base}/edit?type=${type}&category=${current.id}`}>
                  <Plus />
                  {t(`types.${type}`)}
                </Link>
              </Button>
            ))}
          </CardContent>
        </Card>
        {questions.length === 0 ? (
          <EmptyState title={t('empty')} />
        ) : (
          <Table>
            <THead>
              <Tr>
                <Th>{t('name')}</Th>
                <Th>{t('chooseType')}</Th>
                <Th>{t('status')}</Th>
                <Th>{t('defaultMark')}</Th>
                <Th />
              </Tr>
            </THead>
            <TBody>
              {questions.map((q) => (
                <Tr key={q.id}>
                  <Td>
                    <Link href={`${base}/edit?id=${q.id}`} className="font-medium hover:underline">
                      {q.name}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {format.relativeTime(q.updatedAt)}
                    </p>
                  </Td>
                  <Td>{t(`types.${q.type}`)}</Td>
                  <Td>
                    <Badge variant={q.status === 'READY' ? 'success' : 'warning'}>
                      {t(`statuses.${q.status}`)}
                    </Badge>
                  </Td>
                  <Td className="tabular-nums">{Number(q.defaultMark)}</Td>
                  <Td className="text-right">
                    <DeleteQuestionButton courseId={courseId} id={q.id} />
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
        <Card>
          <CardHeader>
            <CardTitle>{t('import')}</CardTitle>
          </CardHeader>
          <CardContent>
            <GiftImportForm courseId={courseId} categoryId={current.id} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
