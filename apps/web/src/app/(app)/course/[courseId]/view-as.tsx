'use client';

import { Button } from '@hubium/ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@hubium/ui/dropdown';
import { Eye } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { switchRoleAction } from '@/server/actions/courses';

export function ViewAsMenu({
  courseId,
  roles,
  label,
  active,
}: {
  courseId: string;
  roles: { id: string; name: string }[];
  label: string;
  active?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const go = (roleId: string | null) =>
    start(async () => {
      await switchRoleAction(courseId, roleId);
      router.refresh();
    });
  if (active) {
    return (
      <Button size="sm" variant="secondary" disabled={pending} onClick={() => go(null)}>
        {label}
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" disabled={pending}>
          <Eye />
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {roles.map((r) => (
          <DropdownMenuItem key={r.id} onSelect={() => go(r.id)}>
            {r.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
