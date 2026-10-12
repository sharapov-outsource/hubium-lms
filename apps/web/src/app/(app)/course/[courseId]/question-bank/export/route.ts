import { listQuestions } from '@hubium/core';
import { exportMoodleXml } from '@hubium/interchange';
import { type QuestionData, type QuestionType, toGift } from '@hubium/questions';
import { getContext } from '@/server/session';

export const dynamic = 'force-dynamic';

const plain = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();

export async function GET(req: Request, { params }: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await params;
  const ctx = await getContext();
  if (!(await ctx.perm.can('question:manage', courseId).catch(() => false)))
    return new Response('Forbidden', { status: 403 });
  const sp = new URL(req.url).searchParams;
  const categoryId = sp.get('category') ?? undefined;
  if (sp.get('format') === 'xml')
    return new Response(await exportMoodleXml(ctx, courseId, categoryId), {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': 'attachment; filename="questions.moodle.xml"',
      },
    });
  const qs = await listQuestions(ctx, courseId, { categoryId });
  const body = qs
    .map((q) =>
      toGift({
        type: q.type as QuestionType,
        name: q.name,
        text: plain(q.text),
        generalFeedback: plain(q.generalFeedback),
        data: q.data as QuestionData,
      }),
    )
    .join('\n\n');
  return new Response(`${body}\n`, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="questions.gift.txt"',
    },
  });
}
