import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelCallLogAccessService } from '../src/main/services/model-call-log-access.service.ts';

const ADMIN = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  loginName: 'admin',
  role: 'ADMIN',
  isAvailable: 1,
  lastLoginAt: null
};

const USER = { ...ADMIN, id: '33333333-3333-4333-8333-333333333333', role: 'USER' };

function createStore() {
  const calls = [];
  return {
    calls,
    async get() {
      calls.push('get');
      return { enabled: true, directory: 'D:\\model-logs' };
    },
    async save(request) {
      calls.push(['save', request]);
      return request;
    }
  };
}

test('ordinary users cannot read or change log settings and runtime logging is forced off', async () => {
  const store = createStore();
  const access = new ModelCallLogAccessService(store, {
    getState: () => ({ status: 'authenticated', user: USER })
  });

  assert.deepEqual(await access.get(), { enabled: false });
  await assert.rejects(access.getForManagement(), /只有管理员/);
  await assert.rejects(access.saveForManagement({ enabled: false }), /只有管理员/);
  assert.deepEqual(store.calls, []);
});

test('administrators keep model-call log management and the legacy local mode remains compatible', async () => {
  const adminStore = createStore();
  const adminAccess = new ModelCallLogAccessService(adminStore, {
    getState: () => ({ status: 'authenticated', user: ADMIN })
  });

  assert.deepEqual(await adminAccess.get(), {
    enabled: true,
    directory: 'D:\\model-logs'
  });
  await adminAccess.saveForManagement({ enabled: false });
  assert.deepEqual(adminStore.calls, ['get', ['save', { enabled: false }]]);

  const localStore = createStore();
  const localAccess = new ModelCallLogAccessService(localStore, {
    getState: () => ({ status: 'disabled', user: null })
  });
  assert.equal((await localAccess.getForManagement()).enabled, true);
  assert.deepEqual(localStore.calls, ['get']);
});
