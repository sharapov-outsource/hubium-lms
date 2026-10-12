'use client';

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from 'react';

// One EventSource per browser, not per tab: the tab holding a Web Lock connects and
// relays events to other tabs over a BroadcastChannel. When it closes, another tab takes
// over. After a reconnect a synthetic `reconnect` event tells consumers to refetch.

export type RealtimeType =
  | 'notification.new'
  | 'notification.read'
  | 'message.new'
  | 'message.read'
  | 'typing'
  | 'task.progress'
  | 'reconnect';

type Handler = (data: Record<string, unknown>) => void;
type Status = 'connecting' | 'open' | 'error';

interface Bus {
  on(type: RealtimeType, fn: Handler): () => void;
  status: Status;
}

const RealtimeContext = createContext<Bus | null>(null);

const TYPES: RealtimeType[] = [
  'notification.new',
  'notification.read',
  'message.new',
  'message.read',
  'typing',
  'task.progress',
];

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const handlers = useRef(new Map<RealtimeType, Set<Handler>>());
  const [status, setStatus] = useState<Status>('connecting');

  const emit = useCallback((type: RealtimeType, data: Record<string, unknown>) => {
    for (const fn of handlers.current.get(type) ?? []) fn(data);
  }, []);

  useEffect(() => {
    const channel =
      typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('hubium-rt');
    let source: EventSource | null = null;
    let release: (() => void) | null = null;
    let stopped = false;

    const relay = (type: RealtimeType, data: Record<string, unknown>) => {
      emit(type, data);
      channel?.postMessage({ type, data });
    };
    const announce = (s: Status) => {
      setStatus(s);
      channel?.postMessage({ status: s });
    };

    const connect = () => {
      let failed = false;
      source = new EventSource('/api/realtime');
      source.onopen = () => {
        announce('open');
        if (failed) relay('reconnect', {});
        failed = false;
      };
      source.onerror = () => {
        failed = true;
        announce('error');
      };
      for (const type of TYPES) {
        source.addEventListener(type, (e) => {
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse((e as MessageEvent<string>).data);
          } catch {}
          relay(type, data);
        });
      }
    };

    if (channel) {
      channel.onmessage = (
        e: MessageEvent<{ type?: RealtimeType; data?: Record<string, unknown>; status?: Status }>,
      ) => {
        if (e.data.status) setStatus(e.data.status);
        if (e.data.type) emit(e.data.type, e.data.data ?? {});
      };
    }

    if (channel && navigator.locks) {
      void navigator.locks.request('hubium-rt-leader', () => {
        if (stopped) return;
        connect();
        // Hold the lock until this tab goes away.
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      });
    } else {
      connect();
    }

    return () => {
      stopped = true;
      source?.close();
      release?.();
      channel?.close();
    };
  }, [emit]);

  const on = useCallback((type: RealtimeType, fn: Handler) => {
    let set = handlers.current.get(type);
    if (!set) handlers.current.set(type, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }, []);
  const bus = useMemo<Bus>(() => ({ status, on }), [status, on]);
  return <RealtimeContext.Provider value={bus}>{children}</RealtimeContext.Provider>;
}

/** Subscribes to realtime events of the given types for the component's lifetime. */
export function useRealtime(types: RealtimeType | RealtimeType[], fn: Handler): void {
  const on = useContext(RealtimeContext)?.on;
  const onEvent = useEffectEvent(fn);
  const key = Array.isArray(types) ? types.join(',') : types;
  useEffect(() => {
    if (!on) return;
    const offs = key.split(',').map((t) => on(t as RealtimeType, (d) => onEvent(d)));
    return () => {
      for (const off of offs) off();
    };
  }, [key, on]);
}

export function useRealtimeStatus(): Status {
  return useContext(RealtimeContext)?.status ?? 'connecting';
}
