import { createRoot } from 'react-dom/client';
import { useEffect } from 'react';
import { BackendAvailabilityGate } from '../../../src/renderer/src/BackendAvailabilityGate';

type RuntimeState = 'ready' | 'failed' | 'stopped';
const listeners = new Set<(status: { state: RuntimeState } | null) => void>();
const pending: Array<() => void> = [];
const control = {
  available: (window as unknown as { initialBackendAvailable: boolean }).initialBackendAvailable,
  reject: false,
  hold: false,
  probes: 0,
  workbenchMounts: 0,
  release() {
    control.hold = false;
    for (const resolve of pending.splice(0)) resolve();
  },
  emit(state: RuntimeState) {
    for (const listener of listeners) listener({ state });
  }
};

Object.assign(window, {
  availabilityFixture: control,
  workstation: {
    async probeBackendAvailability() {
      control.probes += 1;
      if (control.hold) await new Promise<void>(resolve => pending.push(resolve));
      if (control.reject) throw new Error('Health request timed out');
      return control.available;
    },
    async getManagedBackendRuntimeStatus() { return null; },
    onManagedBackendRuntimeStatusChanged(listener: (status: { state: RuntimeState } | null) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async retryManagedBackendRuntime() { return null; }
  }
});

function Workbench(): JSX.Element {
  useEffect(() => { control.workbenchMounts += 1; }, []);
  return <section aria-label="工作台"><input aria-label="未保存的内容" defaultValue="保留当前任务" /></section>;
}

createRoot(document.getElementById('root')!).render(
  <BackendAvailabilityGate loading={<p>正在检查连接</p>}><Workbench /></BackendAvailabilityGate>
);
