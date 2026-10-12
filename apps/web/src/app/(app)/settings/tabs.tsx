'use client';

import { LinkTabs } from '@hubium/ui/tabs';
import { usePathname } from 'next/navigation';

export function SettingsTabs(props: {
  label: string;
  items: { key: string; href: string; label: string }[];
}) {
  const pathname = usePathname();
  const active = props.items.find((i) => pathname.startsWith(i.href))?.key ?? props.items[0]!.key;
  return <LinkTabs {...props} active={active} />;
}
