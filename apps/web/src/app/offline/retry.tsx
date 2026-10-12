'use client';

import { Button } from '@hubium/ui';
import { useEffect } from 'react';

export function OfflineRetry({ label }: { label: string }) {
  useEffect(() => {
    const back = () => window.location.reload();
    window.addEventListener('online', back);
    return () => window.removeEventListener('online', back);
  }, []);
  return (
    <Button className="mx-auto w-fit" onClick={() => window.location.reload()}>
      {label}
    </Button>
  );
}
