/**
 * QEMU VM Manager  +  TabSession
 *
 * Architecture
 * ────────────
 *  One QEMU process is shared by all users (the "democratic" part).
 *  Each browser tab opens its own independent SSH PTY shell into that
 *  one VM, so every tab has its own shell history, working directory,
 *  and running processes — but they all share the same filesystem / OS.
 *
 * Public API (VMManager)
 * ──────────────────────
 *   vm.start()                  – boot the VM (called once at startup)
 *   vm.stop()                   – shut everything down
 *   vm.reset()                  – kill + restart the VM (fresh image)
 *   vm.isReady                  – true once SSH is accepting connections
 *   vm.on('ready', ()=>{})      – fired when SSH first becomes available
 *   vm.on('reset', ()=>{})      – fired just before a VM restart
 *   vm.on('error', (err)=>{})   – non-fatal error notification
 *
 * Public API (TabSession)
 * ───────────────────────
 *   const tab = vm.openTab(id)  – open a new SSH shell, returns TabSession
 *   tab.write(data)             – send bytes to this tab's PTY
 *   tab.resize(cols, rows)      – resize this tab's PTY
 *   tab.close()                 – close this tab's SSH session
 *   tab.on('data', (chunk)=>{}) – raw bytes from this tab's PTY
 *   tab.on('close', ()=>{})     – fired when the shell exits
 */

'use strict';

const { spawn }     = require('child_process');
const EventEmitter  = require('events');
const fs            = require('fs');
const path          = require('path');
const { Client }    = require('ssh2');

// ── Configuration ────────────────────────────────────────────────────────────

const config = {
  baseImage:        path.resolve(__dirname, '..', 'vm', 'base.img'),
  workImage:        path.resolve(__dirname, '..', 'vm', 'work.img'),
  sshPort:          parseInt(process.env.SSH_PORT || '2222', 10),
  sshUser:          'root',
  sshPassword:      '',
  restartDelayMs:   5000,
  qemuBin:          process.env.QEMU_BIN || 'qemu-system-x86_64',
  memory:           process.env.QEMU_MEM  || '512M',
  cpus:             process.env.QEMU_CPUS || '1',
  sshRetryMs:       5000,
  sshTimeoutMs:     15 * 60 * 1000,
  // Watchdog: probe SSH every watchdogIntervalMs while the VM is running.
  // If SSH fails watchdogMaxFailures times in a row, trigger a reset.
  watchdogIntervalMs:  15000,
  watchdogMaxFailures: 3,
};

// ── TabSession ───────────────────────────────────────────────────────────────

/**
 * Represents a single SSH PTY shell session (one browser tab).
 * Multiple TabSessions can coexist, each connected to the same VM via SSH.
 */
class TabSession extends EventEmitter {
  constructor(id, vmManager) {
    super();
    this.id          = id;
    this._vm         = vmManager;
    this._client     = null;
    this._stream     = null;
    this._cols       = 220;
    this._rows       = 50;
    this._closed     = false;
  }

  /** Open a new SSH shell for this tab. Returns a promise that resolves when connected. */
  async open() {
    return new Promise((resolve, reject) => {
      const client = new Client();

      client.on('ready', () => {
        client.shell(
          { term: 'xterm-256color', cols: this._cols, rows: this._rows },
          (err, stream) => {
            if (err) {
              client.end();
              return reject(err);
            }

            this._client = client;
            this._stream = stream;

            stream.on('data', (data) => {
              if (!this._closed) this.emit('data', data);
            });

            stream.stderr.on('data', (data) => {
              if (!this._closed) this.emit('data', data);
            });

            stream.on('close', () => {
              this._stream = null;
              if (!this._closed) {
                this._closed = true;
                this.emit('close');
              }
              try { client.end(); } catch (_) {}
            });

            stream.on('error', (err) => {
              console.error(`[Tab ${this.id}] SSH stream error:`, err.message);
            });

            resolve();
          }
        );
      });

      client.on('error', (err) => {
        reject(err);
      });

      client.connect({
        host:         '127.0.0.1',
        port:         config.sshPort,
        username:     config.sshUser,
        password:     config.sshPassword,
        hostVerifier: () => true,
        readyTimeout: 8000,
      });
    });
  }

  /** Send raw bytes to this tab's PTY. */
  write(data) {
    if (this._stream && !this._stream.destroyed) {
      this._stream.write(data);
    }
  }

  /** Resize this tab's PTY. */
  resize(cols, rows) {
    this._cols = cols;
    this._rows = rows;
    if (this._stream && !this._stream.destroyed) {
      this._stream.setWindow(rows, cols, rows * 16, cols * 8);
    }
  }

  /** Close this tab's SSH session. */
  close() {
    if (this._closed) return;
    this._closed = true;
    if (this._stream) {
      try { this._stream.close(); } catch (_) {}
      this._stream = null;
    }
    if (this._client) {
      try { this._client.end(); } catch (_) {}
      this._client = null;
    }
    this.emit('close');
  }
}

// ── VMManager ────────────────────────────────────────────────────────────────

class VMManager extends EventEmitter {
  constructor() {
    super();
    this._qemuProc           = null;
    this._running            = false;
    this._resetInProgress    = false;
    this._ready              = false;   // true once SSH is accepting connections
    this._tabs               = new Map(); // id → TabSession
    this._watchdogTimer      = null;
    this._watchdogFailures   = 0;
  }

  get isReady() { return this._ready; }

  // ── Public API ──────────────────────────────────────────────────────────

  async start() {
    if (this._running) return;
    this._running = true;
    await this._boot();
  }

  stop() {
    this._running = false;
    this._ready   = false;
    this._stopWatchdog();
    this._closeAllTabs();
    this._killQemu();
  }

  async reset() {
    if (this._resetInProgress) return;
    this._resetInProgress = true;
    this._ready = false;
    this._stopWatchdog();
    this.emit('reset');
    this._closeAllTabs();
    this._killQemu();
    await this._sleep(500);
    await this._boot();
    this._resetInProgress = false;
  }

  /**
   * Open a new SSH PTY session (a new tab).
   * Returns a TabSession that emits 'data' and 'close'.
   * Throws if the VM is not yet ready.
   */
  async openTab(id) {
    if (!this._ready) {
      throw new Error('VM is not ready yet. Please wait for it to boot.');
    }
    if (this._tabs.has(id)) {
      throw new Error(`Tab ${id} already exists.`);
    }

    const tab = new TabSession(id, this);
    this._tabs.set(id, tab);

    tab.on('close', () => {
      this._tabs.delete(id);
    });

    try {
      await tab.open();
    } catch (err) {
      this._tabs.delete(id);
      throw err;
    }

    return tab;
  }

  /** Close a specific tab by id. */
  closeTab(id) {
    const tab = this._tabs.get(id);
    if (tab) tab.close();
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  async _boot() {
    const ready = this._prepareImage();
    if (!ready) return;   // base image missing — do not attempt to launch QEMU
    this._launchQemu();
    await this._waitForSSH();
  }

  /** Returns true if the working image was prepared successfully, false otherwise. */
  _prepareImage() {
    const vmDir = path.dirname(config.workImage);
    if (!fs.existsSync(vmDir)) fs.mkdirSync(vmDir, { recursive: true });

    if (!fs.existsSync(config.baseImage)) {
      this.emit('error', new Error(
        `Base image not found: ${config.baseImage}\n` +
        `Run  scripts/create-image.sh  to create it first.`
      ));
      this._running = false;   // stop the restart loop — there is nothing to boot
      return false;
    }

    try {
      require('child_process').execFileSync(
        'cp', ['--sparse=always', config.baseImage, config.workImage]
      );
    } catch (_) {
      fs.copyFileSync(config.baseImage, config.workImage);
    }
    console.log('[VM] Prepared fresh working image.');
    return true;
  }

  _launchQemu() {
    const args = [
      '-m',    config.memory,
      '-smp',  config.cpus,
      '-drive', `file=${config.workImage},format=raw,if=virtio`,
      '-netdev', `user,id=net0,hostfwd=tcp:127.0.0.1:${config.sshPort}-:22`,
      '-device', 'virtio-net-pci,netdev=net0',
      '-nographic',
      '-monitor', 'none',
      ...(fs.existsSync('/dev/kvm') ? ['-enable-kvm'] : []),
    ];

    console.log(`[VM] Launching: ${config.qemuBin} ${args.join(' ')}`);
    this._qemuProc = spawn(config.qemuBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    this._qemuProc.stdout.on('data', (d) => process.stdout.write(`[QEMU] ${d}`));
    this._qemuProc.stderr.on('data', (d) => process.stderr.write(`[QEMU] ${d}`));

    this._qemuProc.on('exit', (code, signal) => {
      console.log(`[VM] QEMU exited (code=${code}, signal=${signal})`);
      this._qemuProc = null;
      this._ready = false;
      this._stopWatchdog();
      this._closeAllTabs();

      if (this._running && !this._resetInProgress) {
        if (!fs.existsSync(config.baseImage)) {
          console.error('[VM] Base image missing — not restarting. Run scripts/create-image.sh first.');
          this._running = false;
          return;
        }
        console.log(`[VM] Scheduling automatic restart in ${config.restartDelayMs} ms…`);
        this.emit('reset');
        setTimeout(() => this._boot(), config.restartDelayMs);
      }
    });

    this._qemuProc.on('error', (err) => {
      console.error('[VM] Failed to spawn QEMU:', err.message);
      this.emit('error', err);
    });
  }

  async _waitForSSH() {
    const deadline = Date.now() + config.sshTimeoutMs;
    let attempt = 0;

    while (this._running) {
      if (Date.now() > deadline) {
        console.error('[VM] Timed out waiting for SSH.');
        this.emit('error', new Error('SSH timed out — VM may have failed to boot.'));
        return;
      }

      attempt++;
      console.log(`[VM] Waiting for SSH (attempt ${attempt})…`);

      const ok = await this._probeSsh();
      if (ok) {
        console.log('[VM] SSH is ready.');
        this._ready = true;
        this._watchdogFailures = 0;
        this._startWatchdog();
        this.emit('ready');
        return;
      }

      await this._sleep(config.sshRetryMs);
    }
  }

  /** Start the SSH watchdog that detects a broken-but-running VM (e.g. after rm -rf /). */
  _startWatchdog() {
    this._stopWatchdog();
    this._watchdogTimer = setInterval(async () => {
      if (!this._running || this._resetInProgress) return;

      const ok = await this._probeSsh();
      if (ok) {
        this._watchdogFailures = 0;
        return;
      }

      this._watchdogFailures++;
      console.warn(
        `[VM] Watchdog: SSH probe failed (${this._watchdogFailures}/${config.watchdogMaxFailures})`
      );

      if (this._watchdogFailures >= config.watchdogMaxFailures) {
        console.error('[VM] Watchdog: VM appears unresponsive — triggering reset.');
        this._stopWatchdog();
        this.reset().catch((err) => {
          console.error('[VM] Watchdog-triggered reset failed:', err.message);
        });
      }
    }, config.watchdogIntervalMs);
  }

  /** Stop the SSH watchdog timer. */
  _stopWatchdog() {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
    this._watchdogFailures = 0;
  }

  /** Probe SSH without opening a shell — just connect and disconnect. */
  _probeSsh() {
    return new Promise((resolve) => {
      const client = new Client();
      const done = (result) => {
        try { client.end(); } catch (_) {}
        resolve(result);
      };
      client.on('ready', () => done(true));
      client.on('error', () => done(false));
      client.connect({
        host:         '127.0.0.1',
        port:         config.sshPort,
        username:     config.sshUser,
        password:     config.sshPassword,
        hostVerifier: () => true,
        readyTimeout: 8000,
      });
    });
  }

  _closeAllTabs() {
    for (const tab of this._tabs.values()) {
      try { tab.close(); } catch (_) {}
    }
    this._tabs.clear();
  }

  _killQemu() {
    if (this._qemuProc) {
      try { this._qemuProc.kill('SIGKILL'); } catch (_) {}
      this._qemuProc = null;
    }
  }

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
}

module.exports = new VMManager();
module.exports.VMManager  = VMManager;
module.exports.TabSession = TabSession;
module.exports.config     = config;
