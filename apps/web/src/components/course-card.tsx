import type { MyCourse } from '@hubium/core';
import { Badge, Card, Progress } from '@hubium/ui';
import { BookOpen } from 'lucide-react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

export function courseImageUrl(fileId: string | null) {
  return fileId ? `/files/${fileId}/cover` : null;
}

/** Deterministic soft gradient for courses without a cover. */
export function courseGradient(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `linear-gradient(135deg, oklch(0.78 0.09 ${h}), oklch(0.62 0.12 ${(h + 40) % 360}))`;
}

export async function CourseCard({
  course,
}: {
  course: Pick<
    MyCourse,
    'id' | 'fullName' | 'categoryName' | 'imageFileId' | 'progress' | 'visible'
  >;
}) {
  const t = await getTranslations('course');
  const img = courseImageUrl(course.imageFileId);
  return (
    <Card className="group overflow-hidden transition-shadow hover:shadow-md">
      <Link href={`/course/${course.id}`} className="block focus-visible:outline-none">
        <div
          className="flex h-28 items-end p-3"
          style={
            img
              ? {
                  backgroundImage: `url(${img})`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                }
              : { background: courseGradient(course.id) }
          }
        >
          {img ? null : <BookOpen className="size-7 text-white/80" aria-hidden />}
        </div>
        <div className="grid gap-2 p-4">
          <p className="text-xs text-muted-foreground">{course.categoryName}</p>
          <h3 className="line-clamp-2 font-semibold leading-snug group-hover:underline">
            {course.fullName}
          </h3>
          {!course.visible ? (
            <Badge variant="warning" className="w-fit">
              {t('hiddenCourse')}
            </Badge>
          ) : null}
          {course.progress !== null && course.progress !== undefined ? (
            <div className="grid gap-1">
              <Progress
                value={course.progress}
                label={t('progress', { percent: course.progress })}
              />
              <p className="text-xs text-muted-foreground">
                {t('progress', { percent: course.progress })}
              </p>
            </div>
          ) : null}
        </div>
      </Link>
    </Card>
  );
}
