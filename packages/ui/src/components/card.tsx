import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.ts';

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      // min-w-0: as a grid or flex item a card never widens the page past the screen;
      // wide content (tables) scrolls inside it instead
      className={cn(
        'min-w-0 rounded-lg border border-border bg-card text-card-foreground shadow-xs',
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1 p-5 pb-3', className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<'h2'>) {
  return <h2 className={cn('text-base font-semibold leading-tight', className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('text-sm text-muted-foreground', className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('p-5 pt-0', className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex items-center gap-2 border-t border-border px-5 py-3', className)}
      {...props}
    />
  );
}
