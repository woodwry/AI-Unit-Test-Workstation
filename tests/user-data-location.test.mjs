import assert from 'node:assert/strict';
import test from 'node:test';
import {
  configureApplicationUserData
} from '../src/main/user-data-location.ts';

test('安装版使用稳定的生产 userData 目录', () => {
  const calls = [];
  const app = {
    isPackaged: true,
    getPath(name) {
      return name === 'appData' ? 'C:\\Users\\demo\\AppData\\Roaming' : 'C:\\legacy';
    },
    setPath(name, value) {
      calls.push([name, value]);
    }
  };

  assert.equal(
    configureApplicationUserData(app),
    'C:\\Users\\demo\\AppData\\Roaming\\AI Unit Test Workstation'
  );
  assert.deepEqual(calls, [[
    'userData',
    'C:\\Users\\demo\\AppData\\Roaming\\AI Unit Test Workstation'
  ]]);
});

test('开发版保留 Electron 默认 userData 目录', () => {
  const calls = [];
  const app = {
    isPackaged: false,
    getPath(name) {
      return name === 'userData'
        ? 'C:\\Users\\demo\\AppData\\Roaming\\ai-unit-test-workstation'
        : 'unused';
    },
    setPath(name, value) {
      calls.push([name, value]);
    }
  };

  assert.equal(
    configureApplicationUserData(app),
    'C:\\Users\\demo\\AppData\\Roaming\\ai-unit-test-workstation'
  );
  assert.deepEqual(calls, []);
});
