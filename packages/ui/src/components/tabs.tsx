import Link from 'next/link';
import { cn } from '../lib/cn.ts';

/** Navigation tabs rendered as links (server-friendly, keyboard accessible). */
export function LinkTabs({
  items,
  active,
  label,
}: {
  items: { href: string; label: string; key: string }[];
  active: string;
  label: string;
}) {
  return (
    <nav aria-label={label} className="mb-6 flex gap-1 overflow-x-auto border-b border-border">
      {items.map((it) => (
        <Link
          key={it.key}
          href={it.href}
          aria-current={it.key === active ? 'page' : undefined}
          className={cn(
            '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors',
            it.key === active
              ? 'border-accent text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          {it.label}
        </Link>
      ))}
    </nav>
  );
}
