'use client';

import { cn } from '@hubium/ui/cn';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { type CommsCounts, useLiveCounts } from '@/components/comms/live-counts';

export function NavLink({
  href,
  icon,
  label,
  variant = 'sidebar',
  liveBadge,
}: {
  href: string;
  icon: ReactNode;
  label: string;
  variant?: 'sidebar' | 'bottom';
  liveBadge?: keyof CommsCounts;
}) {
  const pathname = usePathname();
  const { counts } = useLiveCounts();
  const badge = liveBadge ? counts[liveBadge] : 0;
  const active = pathname === href || pathname.startsWith(`${href}/`);
  if (variant === 'bottom') {
    return (
      <Link
        href={href}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'relative flex flex-1 flex-col items-center gap-0.5 px-1 py-2 text-[11px] [&_svg]:size-5',
          active ? 'text-accent' : 'text-muted-foreground',
        )}
      >
        {icon}
        <span className="max-w-full truncate">{label}</span>
        {badge ? (
          <span className="absolute right-1/4 top-1 min-w-4 rounded-full bg-accent px-1 text-[10px] leading-4 text-accent-foreground">
            {badge > 99 ? '99+' : badge}
          </span>
        ) : null}
      </Link>
    );
  }
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors [&_svg]:size-4 [&_svg]:shrink-0',
        active
          ? 'bg-accent-soft text-accent'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {icon}
      <span className="flex-1 truncate">{label}</span>
      {badge ? (
        <span className="rounded-full bg-accent px-1.5 text-xs leading-5 text-accent-foreground">
          {badge > 99 ? '99+' : badge}
        </span>
      ) : null}
    </Link>
  );
}
