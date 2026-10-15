'use client';

import { Combobox, type ComboboxOption } from '@hubium/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { permissionContextsAction } from '@/server/actions/admin';

/** The whole site, or a category or course found by name as the search is typed. */
export function ContextPick({ site, chosen }: { site: string; chosen: ComboboxOption | null }) {
  const tc = useTranslations('common');
  const [q, setQ] = useState('');
  const [found, setFound] = useState<ComboboxOption[]>([]);
  useEffect(() => {
    // an answer to an earlier search that arrives late is not shown
    let current = true;
    const h = setTimeout(
      async () => {
        const r = await permissionContextsAction(q).catch(() => null);
        if (current && r?.ok) setFound(r.data);
      },
      q ? 250 : 0,
    );
    return () => {
      current = false;
      clearTimeout(h);
    };
  }, [q]);
  const options = [
    { value: '', label: site },
    ...(chosen && !found.some((o) => o.value === chosen.value) ? [chosen] : []),
    ...found,
  ];
  return (
    <Combobox
      id="context"
      name="context"
      options={options}
      defaultValue={chosen?.value ?? ''}
      onSearch={setQ}
      searchPlaceholder={tc('searchPlaceholder')}
      emptyText={tc('nothingFound')}
    />
  );
}
