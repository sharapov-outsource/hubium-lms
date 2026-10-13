import { cn } from '@hubium/ui/cn';
import Link from 'next/link';

export function SectionNav({
  items,
  active,
}: {
  items: { key: string; href: string; label: string }[];
  active: string;
}) {
  return (
    <nav
      className="scrollbar-hairline flex gap-1 overflow-x-auto lg:flex-col"
      aria-label="Settings sections"
    >
      {items.map((i) => (
        <Link
          key={i.key}
          href={i.href}
          aria-current={i.key === active ? 'page' : undefined}
          className={cn(
            'whitespace-nowrap rounded-md px-3 py-2 text-sm',
            i.key === active
              ? 'bg-accent-soft font-medium text-accent'
              : 'text-muted-foreground hover:bg-muted',
          )}
        >
          {i.label}
        </Link>
      ))}
    </nav>
  );
}
