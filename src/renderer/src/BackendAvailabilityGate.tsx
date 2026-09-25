import { RefreshCw, ServerOff } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from 'react';
import type { ManagedBackendRuntimeStatus } from '../../shared/types';

const BACKEND_PROBE_INTERVAL_MS = 5_000;

type BackendAvailabilityPhase = 'checking' | 'available' | 'unavailable' | 'retrying';

type BackendAvailabilityGateProps = Readonly<{
  children: ReactNode;
  loading: ReactNode;
}>;

export function BackendUnavailableView({
  retrying,
  onRetry,
  code = 'SERVER_UNAVAILABLE'
}: Readonly<{
  retrying: boolean;
  onRetry: () => void;
  code?: string;
}>): JSX.Element {
  return (
    <main className="backend-unavailable" role="alert" aria-busy={retrying}>
      <section className="backend-unavailable-content">
        <div className="backend-unavailable-icon" aria-hidden="true">
          <ServerOff size={32} strokeWidth={1.55} />
        </div>
        <div className="backend-unavailable-status">
          <span aria-hidden="true" />
          服务器连接失败
        </div>
        <h1>无法连接服务器，请稍后重试</h1>
        <button type="button" disabled={retrying} onClick={onRetry}>
          <RefreshCw className={retrying ? 'spin' : undefined} size={15} aria-hidden="true" />
          <span>{retrying ? '正在重试…' : '重试'}</span>
        </button>
        <div className="backend-unavailable-code">
          故障编号 <span>{code}</span> · 刚刚完成检查
        </div>
      </section>
    </main>
  );
}

export function BackendAvailabilityGate({
  children,
  loading
}: BackendAvailabilityGateProps): JSX.Element {
  const [phase, setPhase] = useState<BackendAvailabilityPhase>('checking');
  const [hasConnected, setHasConnected] = useState(false);
  const activeRef = useRef(true);
  const hasConnectedRef = useRef(false);
  const retryingRef = useRef(false);
  const probeSequenceRef = useRef(0);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      probeSequenceRef.current += 1;
    };
  }, []);

  const markUnavailable = useCallback((): void => {
    probeSequenceRef.current += 1;
    retryingRef.current = false;
    if (activeRef.current) setPhase('unavailable');
  }, []);

  const probe = useCallback(async (): Promise<void> => {
    const sequence = probeSequenceRef.current + 1;
    probeSequenceRef.current = sequence;
    try {
      const available = await window.workstation.probeBackendAvailability();
      if (!activeRef.current || probeSequenceRef.current !== sequence) return;
      retryingRef.current = false;
      if (!available) {
        setPhase('unavailable');
        return;
      }
      hasConnectedRef.current = true;
      setHasConnected(true);
      setPhase('available');
    } catch {
      if (!activeRef.current || probeSequenceRef.current !== sequence) return;
      retryingRef.current = false;
      setPhase('unavailable');
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let receivedStatusEvent = false;

    const applyRuntimeStatus = (status: ManagedBackendRuntimeStatus | null): void => {
      if (disposed) return;
      if (status === null || status.state === 'ready') {
        void probe();
        return;
      }
      if (status.state === 'failed' || status.state === 'stopped') {
        markUnavailable();
        return;
      }
      probeSequenceRef.current += 1;
      if (retryingRef.current) {
        setPhase('retrying');
        return;
      }
      if (status.state === 'stopping') {
        setPhase(hasConnectedRef.current ? 'unavailable' : 'checking');
        return;
      }
      setPhase(hasConnectedRef.current ? 'unavailable' : 'checking');
    };

    // 先订阅再取快照，避免服务恰好在两步之间退出而漏掉断线事件。
    const unsubscribe = window.workstation.onManagedBackendRuntimeStatusChanged((status) => {
      receivedStatusEvent = true;
      applyRuntimeStatus(status);
    });
    void window.workstation.getManagedBackendRuntimeStatus()
      .then((status) => {
        if (disposed || receivedStatusEvent) return;
        applyRuntimeStatus(status);
      })
      .catch(() => {
        if (!disposed) markUnavailable();
      });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [markUnavailable, probe]);

  useEffect(() => {
    if (phase !== 'available') return undefined;
    const timer = window.setInterval(() => void probe(), BACKEND_PROBE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [phase, probe]);

  const retry = useCallback((): void => {
    if (retryingRef.current) return;
    retryingRef.current = true;
    probeSequenceRef.current += 1;
    setPhase('retrying');
    void window.workstation.retryManagedBackendRuntime()
      .then((status) => {
        if (!activeRef.current) return;
        if (status && status.state !== 'ready') {
          if (status.state === 'failed' || status.state === 'stopped') {
            markUnavailable();
          }
          return;
        }
        void probe();
      })
      .catch(() => markUnavailable());
  }, [markUnavailable, probe]);

  if (!hasConnected && phase === 'checking') return <>{loading}</>;

  return (
    <>
      {hasConnected && (
        <div
          className={phase === 'available'
            ? 'backend-workbench-host'
            : 'backend-workbench-host backend-workbench-suspended'}
          aria-hidden={phase === 'available' ? undefined : true}
        >
          {children}
        </div>
      )}
      {phase !== 'available' && (
        <BackendUnavailableView retrying={phase === 'retrying'} onRetry={retry} />
      )}
    </>
  );
}
