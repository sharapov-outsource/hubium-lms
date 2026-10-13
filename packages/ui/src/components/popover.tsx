'use client';

import { Popover as P } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.ts';

export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverAnchor = P.Anchor;
export const PopoverClose = P.Close;

export function PopoverContent({
  className,
  align = 'start',
  sideOffset = 6,
  ...props
}: ComponentProps<typeof P.Content>) {
  return (
    <P.Portal>
      <P.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(
          'z-50 rounded-lg border border-border bg-card text-card-foreground shadow-lg outline-none data-[state=open]:animate-pop-in',
          className,
        )}
        {...props}
      />
    </P.Portal>
  );
}
