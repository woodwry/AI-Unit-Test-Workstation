import { createRoot } from 'react-dom/client';
import { WorkspaceModelSettingsSection } from '../../../src/renderer/src/WorkspaceModelSettingsSection';

const fixture = (window as any).modelConnectionFixture;
(window as any).workstation = {
  getWorkstationModelInterfaces: async () => fixture.view,
  testModelInterfaceConnection: (request: unknown) => (window as any).testConnectionBridge(request),
  updateModelInterface: async () => { throw new Error('Connection test must not save the draft.'); },
  createModelInterface: async () => { throw new Error('Connection test must not save the draft.'); }
};
createRoot(document.getElementById('root')!).render(<WorkspaceModelSettingsSection />);
