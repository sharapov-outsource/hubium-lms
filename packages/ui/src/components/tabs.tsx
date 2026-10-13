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
    // The divider is an inset shadow rather than a border: it stays inside the scroll box, so
    // the active tab's underline covers it and the 1px scrollbar runs along it.
    <nav
      aria-label={label}
      className="scrollbar-hairline mb-6 flex gap-1 overflow-x-auto shadow-[inset_0_-1px_0_var(--color-border)]"
    >
      {items.map((it) => (
        <Link
          key={it.key}
          href={it.href}
          aria-current={it.key === active ? 'page' : undefined}
          className={cn(
            'whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-offset-[-2px]',
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
