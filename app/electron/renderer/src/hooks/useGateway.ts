import { useState, useEffect, useRef } from 'react';
import { gatewayStatus, gatewayStart, gatewayStop } from '../api/gateway';
import type { GatewayStatus } from '../types';

export interface GatewayState {
  status: GatewayStatus | null;
  lastAction: { ok: boolean; text: string } | null;
  loading: boolean;
}

export function useGateway() {
  const [state, setState] = useState<GatewayState>({
    status: null,
    lastAction: null,
    loading: false,
  });
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      let running = false;
      try {
        const status = await gatewayStatus();
        running = status.rpc?.ok ?? false;
        if (mountedRef.current) setState((s) => ({ ...s, status }));
      } catch { /* ignore */ }
      // Poll faster while not running (catching auto-startup), slower once stable
      if (mountedRef.current) timer = setTimeout(poll, running ? 8000 : 2000);
    };

    poll();
    return () => {
      mountedRef.current = false;
      clearTimeout(timer);
    };
  }, []);

  const refresh = async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const status = await gatewayStatus();
      setState((s) => ({ ...s, status, loading: false }));
    } catch {
      setState((s) => ({ ...s, loading: false }));
    }
  };

  const start = async () => {
    setState((s) => ({ ...s, loading: true, lastAction: null }));
    try {
      const res = await gatewayStart();
      setState((s) => ({ ...s, lastAction: { ok: res.ok, text: res.message }, loading: false }));
      if (res.ok) await refresh();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setState((s) => ({ ...s, lastAction: { ok: false, text: msg }, loading: false }));
    }
  };

  const stop = async () => {
    setState((s) => ({ ...s, loading: true, lastAction: null }));
    try {
      const res = await gatewayStop();
      setState((s) => ({ ...s, lastAction: { ok: res.ok, text: res.message }, loading: false }));
      await refresh();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setState((s) => ({ ...s, lastAction: { ok: false, text: msg }, loading: false }));
    }
  };

  return { ...state, refresh, start, stop };
}
