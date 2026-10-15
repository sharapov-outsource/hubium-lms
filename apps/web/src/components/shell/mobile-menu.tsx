'use client';

import { Button } from '@hubium/ui';
import { Dialog, DialogContent, DialogTrigger } from '@hubium/ui/dialog';
import { Menu } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';

/**
 * Every item of the main menu on screens without the sidebar, where the bottom bar holds
 * only the main few (the catalog and reports would be out of reach). Closes on navigation.
 */
export function MobileMenu({
  label,
  title,
  children,
}: {
  label: string;
  title: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new page closes the menu
  useEffect(() => setOpen(false), [pathname]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={label} className="lg:hidden">
          <Menu aria-hidden />
        </Button>
      </DialogTrigger>
      <DialogContent title={title}>
        <nav aria-label={title} className="grid gap-0.5">
          {children}
        </nav>
      </DialogContent>
    </Dialog>
  );
}
