'use client';

import { LinkTabs } from '@hubium/ui/tabs';
import { usePathname } from 'next/navigation';

export function CourseTabs({
  items,
  base,
  label,
}: {
  items: { key: string; href: string; label: string }[];
  base: string;
  label: string;
}) {
  const pathname = usePathname();
  const rest = pathname.slice(base.length).split('/')[1] ?? '';
  const active = items.find((i) => i.key === rest)?.key ?? 'course';
  return <LinkTabs items={items} active={active} label={label} />;
}
