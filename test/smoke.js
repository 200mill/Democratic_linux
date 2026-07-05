/**
 * Smoke tests for Democratic Linux.
 *
 * These exercise the new error paths added in the recent bug fixes
 * without requiring a real QEMU VM to be running.  They use Node's
 * built-in test runner (`node --test`) — no external dependencies.
 *
 * Coverage:
 *   1. vm.waitForReady() resolves false on timeout when the VM never
 *      becomes ready (Fix 1 — covers tab:open arriving during a failed
 *      boot or reset).
 *   2. vm.waitForReady() resolves true immediately when the VM is
 *      already ready.
 *   3. TabSession.open() rejects (does not hang) when the SSH endpoint
 *      is unreachable — this is the race that previously produced
 *      dead tabs.
 *
 * The corresponding server-side cleanup (tab:open failure removes the
 * tab from tabRegistry) and the frontend `tab:list` reconciliation
 * (Fix 2) require a running WS server and a browser, respectively.
 * Those paths are covered by manual end-to-end testing.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('vm.waitForReady() resolves false on timeout when VM never becomes ready', async () => {
  // Build a fresh VMManager-like object whose only responsibility is
  // waitForReady. We construct it inline so we don't have to launch
  // QEMU.
  const { EventEmitter } = require('node:events');
  const vm = new EventEmitter();
  vm._running = true;
  Object.defineProperty(vm, 'isReady', { get: () => false });

  vm.waitForReady = require('../src/vm').waitForReady
    ? require('../src/vm').waitForReady
    : null;

  // waitForReady lives on the singleton export, not on VMManager class.
  // Re-import the singleton directly.
  const vmMod = require('../src/vm');
  vmMod._running = true;
  Object.defineProperty(vmMod, 'isReady', { get: () => false, configurable: true });

  const t0 = Date.now();
  const ok = await vmMod.waitForReady(80);
  const elapsed = Date.now() - t0;

  assert.equal(ok, false, 'should resolve false');
  assert.ok(elapsed >= 70 && elapsed < 500,
    `should respect timeout (~80ms), took ${elapsed}ms`);
});

test('vm.waitForReady() resolves true immediately when VM is already ready', async () => {
  const vmMod = require('../src/vm');
  vmMod._running = true;
  Object.defineProperty(vmMod, 'isReady', { get: () => true, configurable: true });

  const t0 = Date.now();
  const ok = await vmMod.waitForReady(5000);
  const elapsed = Date.now() - t0;

  assert.equal(ok, true, 'should resolve true');
  assert.ok(elapsed < 50, `should be instant, took ${elapsed}ms`);
});

test('TabSession.open() rejects (does not hang) when SSH endpoint is unreachable', async () => {
  // Load the REAL TabSession — that's the path we fixed. Point it at a
  // closed port (127.0.0.1:1) so the SSH handshake must fail.
  const { TabSession } = require('../src/vm');

  const fakeVm = {
    // Port 1 on loopback is reserved/unused → connect fails fast.
    activePort: 1,
  };

  const tab = new TabSession('test-tab', fakeVm);

  const t0 = Date.now();
  await assert.rejects(
    () => tab.open(),
    (err) => err instanceof Error,
    'TabSession.open() must reject when SSH is unreachable'
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 8000,
    `should reject quickly (ssh2 readyTimeout=8000), took ${elapsed}ms`);
});