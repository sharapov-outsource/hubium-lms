import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.ts';

export function Table({ className, ...props }: ComponentProps<'table'>) {
  return (
    <div className="w-full overflow-x-auto rounded-lg border border-border">
      <table className={cn('w-full caption-bottom text-sm', className)} {...props} />
    </div>
  );
}
export function THead({ className, ...props }: ComponentProps<'thead'>) {
  return (
    <thead className={cn('bg-surface text-left text-muted-foreground', className)} {...props} />
  );
}
export function TBody({ className, ...props }: ComponentProps<'tbody'>) {
  return <tbody className={cn('[&_tr:last-child]:border-0', className)} {...props} />;
}
export function Tr({ className, ...props }: ComponentProps<'tr'>) {
  return <tr className={cn('border-b border-border', className)} {...props} />;
}
export function Th({ className, ...props }: ComponentProps<'th'>) {
  return <th className={cn('h-10 px-3 font-medium whitespace-nowrap', className)} {...props} />;
}
export function Td({ className, ...props }: ComponentProps<'td'>) {
  return <td className={cn('px-3 py-2.5 align-middle', className)} {...props} />;
}
