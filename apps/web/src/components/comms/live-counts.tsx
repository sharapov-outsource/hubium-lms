'use client';

import { createContext, type ReactNode, useContext, useRef, useState } from 'react';
import { useRealtime } from '@/components/realtime';
import { getCommsCountsAction } from '@/server/actions/comms';

export interface CommsCounts {
  notifications: number;
  messages: number;
}

const Ctx = createContext<{ counts: CommsCounts; refresh(): void } | null>(null);

/** Unread notification and conversation counters, kept live over SSE. */
export function LiveCountsProvider({
  initial,
  children,
}: {
  initial: CommsCounts;
  children: ReactNode;
}) {
  const [counts, setCounts] = useState(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = () => {
    // coalesce bursts of events into one request
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      void getCommsCountsAction().then(setCounts, () => {});
    }, 150);
  };
  useRealtime(
    ['notification.new', 'notification.read', 'message.new', 'message.read', 'reconnect'],
    refresh,
  );
  return <Ctx.Provider value={{ counts, refresh }}>{children}</Ctx.Provider>;
}

export function useLiveCounts() {
  return useContext(Ctx) ?? { counts: { notifications: 0, messages: 0 }, refresh() {} };
}
