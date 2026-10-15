import Link from 'next/link';
import { Button } from './button.tsx';

/**
 * Previous and next links under a long list, with the page it is on (server-friendly).
 * Nothing when everything fits on one page.
 */
export function PageNav({
  page,
  pageSize,
  total,
  href,
  labels,
}: {
  page: number;
  pageSize: number;
  total: number;
  /** The address of a page. */
  href: (page: number) => string;
  /** From the `common` messages: previous, next and pageOf ("Page {page} of {pages}"). */
  labels: { previous: string; next: string; pageOf: (page: number, pages: number) => string };
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  const at = labels.pageOf(page, pages);
  return (
    <nav className="flex items-center justify-between gap-2 text-sm" aria-label={at}>
      <span className="text-muted-foreground">{at}</span>
      <div className="flex gap-2">
        {page > 1 ? (
          <Button asChild variant="outline" size="sm">
            <Link href={href(page - 1)}>{labels.previous}</Link>
          </Button>
        ) : null}
        {page < pages ? (
          <Button asChild variant="outline" size="sm">
            <Link href={href(page + 1)}>{labels.next}</Link>
          </Button>
        ) : null}
      </div>
    </nav>
  );
}
