'use client';

import { LinkTabs } from '@hubium/ui/tabs';
import { usePathname } from 'next/navigation';

export function AdminNav({
  label,
  items,
}: {
  label: string;
  items: { key: string; href: string; label: string; exact?: boolean }[];
}) {
  const pathname = usePathname();
  const active =
    [...items]
      .reverse()
      .find((i) =>
        i.exact ? pathname === i.href : pathname.startsWith(i.href.replace(/\/general$/, '')),
      )?.key ?? 'overview';
  return <LinkTabs label={label} items={items} active={active} />;
}
