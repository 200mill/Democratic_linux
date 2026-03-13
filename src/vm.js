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
 *  Hot-spare model
 *  ───────────────
 *  A second QEMU instance (the "spare") is pre-booted in the background
 *  on a different port.  When the active VM is detected as broken (via the
 *  exec-based watchdog or a kernel panic), the spare is promoted instantly:
 *    1. Kill the broken active QEMU.
 *    2. Emit 'reset' so server.js closes all browser tabs.
 *    3. Swap the active port to the spare's port.
 *    4. Emit 'ready' — browser tabs reconnect to the new VM immediately.
 *    5. Boot a fresh spare in the background for the next reset.
 *  If no spare is ready yet (still booting) the manager falls back to a
 *  conventional boot cycle rather than failing.
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
  // Active VM
  workImage:        path.resolve(__dirname, '..', 'vm', 'work.img'),
  sshPort:          parseInt(process.env.SSH_PORT       || '2222', 10),
  // Spare VM
  spareImage:       path.resolve(__dirname, '..', 'vm', 'spare.img'),
  sparePort:        parseInt(process.env.SSH_SPARE_PORT || '2223', 10),

  sshUser:          'root',
  sshPassword:      '',
  restartDelayMs:   5000,
  qemuBin:          process.env.QEMU_BIN || 'qemu-system-x86_64',
  memory:           process.env.QEMU_MEM  || '512M',
  cpus:             process.env.QEMU_CPUS || '1',
  sshRetryMs:       5000,
  sshTimeoutMs:     15 * 60 * 1000,
  // Watchdog: exec-based health check on the active VM.
  // Three consecutive failures → promote spare (or cold-boot if spare not ready).
  watchdogIntervalMs:  15000,
  watchdogMaxFailures: 3,
};

// ── TabSession ───────────────────────────────────────────────────────────────

/**
 * Represents a single SSH PTY shell session (one browser tab).
 * The port it connects to is read from vmManager.activePort at open() time,
 * so promoting the spare just means reopening tabs.
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
        port:         this._vm.activePort,   // always use the current active port
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

// ── VMInstance ───────────────────────────────────────────────────────────────

/**
 * A single QEMU process + its lifecycle helpers.
 * VMManager holds up to two of these: active and spare.
 */
class VMInstance {
  constructor({ label, image, port, qemuBin, memory, cpus }) {
    this.label    = label;   // 'active' | 'spare'
    this.image    = image;
    this.port     = port;
    this.qemuBin  = qemuBin;
    this.memory   = memory;
    this.cpus     = cpus;
    this.proc     = null;
    this.ready    = false;
  }

  /** Copy the base image and launch QEMU. Attaches onOutput and onExit callbacks. */
  launch(onOutput, onExit) {
    // Copy base image → instance image
    const vmDir = path.dirname(this.image);
    if (!fs.existsSync(vmDir)) fs.mkdirSync(vmDir, { recursive: true });

    try {
      require('child_process').execFileSync(
        'cp', ['--sparse=always', config.baseImage, this.image]
      );
    } catch (_) {
      fs.copyFileSync(config.baseImage, this.image);
    }
    console.log(`[VM:${this.label}] Prepared fresh image → ${path.basename(this.image)}`);

    const args = [
      '-m',     this.memory,
      '-smp',   this.cpus,
      '-drive', `file=${this.image},format=raw,if=virtio`,
      '-netdev', `user,id=net0,hostfwd=tcp:127.0.0.1:${this.port}-:22`,
      '-device', 'virtio-net-pci,netdev=net0',
      '-nographic',
      '-monitor', 'none',
      ...(fs.existsSync('/dev/kvm') ? ['-enable-kvm'] : []),
    ];

    console.log(`[VM:${this.label}] Launching QEMU on port ${this.port}`);
    this.proc = spawn(this.qemuBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    this.proc.stdout.on('data', (d) => onOutput(this, d));
    this.proc.stderr.on('data', (d) => process.stderr.write(`[QEMU:${this.label}] ${d}`));
    this.proc.on('exit',  (code, signal) => { this.proc = null; this.ready = false; onExit(this, code, signal); });
    this.proc.on('error', (err) => console.error(`[VM:${this.label}] spawn error:`, err.message));
  }

  kill() {
    if (this.proc) {
      try { this.proc.kill('SIGKILL'); } catch (_) {}
      this.proc  = null;
      this.ready = false;
    }
  }

  /** Probe SSH: connect and immediately disconnect. */
  probeSsh() {
    return new Promise((resolve) => {
      const client = new Client();
      const done = (r) => { try { client.end(); } catch (_) {} resolve(r); };
      client.on('ready', () => done(true));
      client.on('error', () => done(false));
      client.connect({
        host: '127.0.0.1', port: this.port,
        username: config.sshUser, password: config.sshPassword,
        hostVerifier: () => true, readyTimeout: 8000,
      });
    });
  }

  /** Exec-based health check: run `echo ok` over SSH. */
  execHealthCheck() {
    return new Promise((resolve) => {
      const client = new Client();
      let resolved = false;
      const done = (r) => {
        if (resolved) return; resolved = true;
        try { client.end(); } catch (_) {}
        resolve(r);
      };
      const timer = setTimeout(() => done(false), 10000);
      client.on('ready', () => {
        client.exec('echo ok', (err, stream) => {
          if (err) return done(false);
          let out = '';
          stream.on('data', (d) => { out += d; });
          stream.stderr.on('data', () => {});
          stream.on('close', () => { clearTimeout(timer); done(out.trim() === 'ok'); });
          stream.on('error', () => { clearTimeout(timer); done(false); });
        });
      });
      client.on('error', () => { clearTimeout(timer); done(false); });
      client.connect({
        host: '127.0.0.1', port: this.port,
        username: config.sshUser, password: config.sshPassword,
        hostVerifier: () => true, readyTimeout: 8000,
      });
    });
  }

  /** Poll SSH until it accepts connections, a deadline is exceeded, or abort() is called. */
  async waitForSsh(abortFn) {
    const deadline = Date.now() + config.sshTimeoutMs;
    let attempt = 0;
    while (!abortFn()) {
      if (Date.now() > deadline) return false;
      attempt++;
      console.log(`[VM:${this.label}] Waiting for SSH (attempt ${attempt})…`);
      if (await this.probeSsh()) { this.ready = true; return true; }
      await new Promise((r) => setTimeout(r, config.sshRetryMs));
    }
    return false;
  }
}

// ── VMManager ────────────────────────────────────────────────────────────────

class VMManager extends EventEmitter {
  constructor() {
    super();
    this._running          = false;
    this._resetInProgress  = false;

    // The two VM slots
    this._active = null;   // VMInstance currently serving users
    this._spare  = null;   // VMInstance pre-booting in the background

    this._tabs            = new Map();  // id → TabSession
    this._watchdogTimer   = null;
    this._watchdogFailures = 0;
  }

  /** The SSH port users connect to — always the active VM's port. */
  get activePort() {
    return this._active ? this._active.port : config.sshPort;
  }

  get isReady() {
    return !!(this._active && this._active.ready);
  }

  // ── Public API ──────────────────────────────────────────────────────────

  async start() {
    if (this._running) return;
    this._running = true;

    if (!fs.existsSync(config.baseImage)) {
      this.emit('error', new Error(
        `Base image not found: ${config.baseImage}\n` +
        `Run  scripts/create-image.sh  to create it first.`
      ));
      this._running = false;
      return;
    }

    // Boot the active VM and wait for it to be ready.
    this._active = this._makeInstance('active', config.workImage, config.sshPort);
    this._active.launch(
      (inst, d) => this._onQemuOutput(inst, d),
      (inst, code, signal) => this._onQemuExit(inst, code, signal)
    );
    const ok = await this._active.waitForSsh(() => !this._running);
    if (!ok) {
      if (this._running) this.emit('error', new Error('Active VM SSH timed out.'));
      return;
    }
    console.log('[VM:active] SSH is ready.');
    this._active.ready = true;
    this._watchdogFailures = 0;
    this._startWatchdog();
    this.emit('ready');

    // Start warming up the spare in the background.
    this._bootSpare();
  }

  stop() {
    this._running = false;
    this._stopWatchdog();
    this._closeAllTabs();
    if (this._active) { this._active.kill(); this._active = null; }
    if (this._spare)  { this._spare.kill();  this._spare  = null; }
  }

  /**
   * Reset: promote the spare if it is ready, otherwise cold-boot.
   * This is the same entry point used by the watchdog, exit handler,
   * and the public API (server.js can call vm.reset() directly).
   */
  async reset() {
    if (this._resetInProgress) return;
    this._resetInProgress = true;
    this._stopWatchdog();

    console.log('[VM] Reset triggered.');
    this.emit('reset');
    this._closeAllTabs();

    // Kill the broken active VM.
    if (this._active) { this._active.kill(); this._active = null; }

    if (this._spare && this._spare.ready) {
      // ── Fast path: spare is already booted, promote it instantly ──
      console.log('[VM] Promoting spare → active (instant failover).');
      this._active = this._spare;
      this._active.label = 'active';
      this._spare = null;

      this._resetInProgress = false;
      this._watchdogFailures = 0;
      this._startWatchdog();
      this.emit('ready');

      // Boot a new spare asynchronously.
      this._bootSpare();
    } else {
      // ── Slow path: spare not ready yet, wait for it or cold-boot ──
      if (this._spare) {
        // There is a spare still booting — wait for it.
        console.log('[VM] Spare is still booting — waiting for it to become ready…');
        const ok = await this._spare.waitForSsh(() => !this._running);
        if (ok && this._running) {
          console.log('[VM] Spare became ready — promoting to active.');
          this._spare.ready = true;
          this._active = this._spare;
          this._active.label = 'active';
          this._spare = null;

          this._resetInProgress = false;
          this._watchdogFailures = 0;
          this._startWatchdog();
          this.emit('ready');

          this._bootSpare();
          return;
        }
        // Spare failed or we stopped; kill it and fall through to cold boot.
        if (this._spare) { this._spare.kill(); this._spare = null; }
      }

      if (!this._running) { this._resetInProgress = false; return; }

      // Cold boot.
      console.log(`[VM] Cold-booting active VM (no spare available).`);
      await this._sleep(config.restartDelayMs);
      if (!this._running) { this._resetInProgress = false; return; }

      this._active = this._makeInstance('active', config.workImage, config.sshPort);
      this._active.launch(
        (inst, d) => this._onQemuOutput(inst, d),
        (inst, code, signal) => this._onQemuExit(inst, code, signal)
      );
      const coldOk = await this._active.waitForSsh(() => !this._running);
      if (coldOk && this._running) {
        console.log('[VM:active] SSH is ready (cold boot).');
        this._active.ready = true;
        this._resetInProgress = false;
        this._watchdogFailures = 0;
        this._startWatchdog();
        this.emit('ready');
        this._bootSpare();
      } else {
        if (this._active) { this._active.kill(); this._active = null; }
        this._resetInProgress = false;
        if (this._running) this.emit('error', new Error('Cold-boot SSH timed out.'));
      }
    }
  }

  /**
   * Open a new SSH PTY session (a new tab).
   * Returns a TabSession that emits 'data' and 'close'.
   * Throws if the VM is not yet ready.
   */
  async openTab(id) {
    if (!this.isReady) {
      throw new Error('VM is not ready yet. Please wait for it to boot.');
    }
    if (this._tabs.has(id)) {
      throw new Error(`Tab ${id} already exists.`);
    }

    const tab = new TabSession(id, this);
    this._tabs.set(id, tab);

    tab.on('close', () => { this._tabs.delete(id); });

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

  _makeInstance(label, image, port) {
    return new VMInstance({
      label,
      image,
      port,
      qemuBin: config.qemuBin,
      memory:  config.memory,
      cpus:    config.cpus,
    });
  }

  /** Boot the spare VM in the background. Safe to call at any time. */
  async _bootSpare() {
    if (!this._running) return;
    if (this._spare) return;  // already booting

    if (!fs.existsSync(config.baseImage)) return;

    console.log('[VM:spare] Starting warm-up…');
    this._spare = this._makeInstance('spare', config.spareImage, config.sparePort);
    this._spare.launch(
      (inst, d) => this._onQemuOutput(inst, d),
      (inst, code, signal) => this._onQemuExit(inst, code, signal)
    );

    const ok = await this._spare.waitForSsh(() => !this._running || this._spare === null);
    if (ok && this._spare) {
      this._spare.ready = true;
      console.log('[VM:spare] SSH is ready — spare is warm and waiting.');
    } else if (this._spare) {
      console.warn('[VM:spare] SSH timed out — spare will not be available for next reset.');
      this._spare.kill();
      this._spare = null;
    }
  }

  /** Handle stdout data from either VM instance. */
  _onQemuOutput(inst, d) {
    const prefix = inst.label === 'active' ? '[QEMU] ' : '[QEMU:spare] ';
    process.stdout.write(prefix + d);

    // Only react to active VM output.
    if (inst !== this._active) return;
    if (!this._active.ready || this._resetInProgress) return;

    const text = d.toString();
    if (
      text.includes('Kernel panic') || text.includes('end Kernel panic') ||
      text.includes('kernel BUG')   || text.includes('I/O error')        ||
      text.includes('EXT4-fs error') || text.includes('Buffer I/O error')
    ) {
      console.error('[VM:active] Guest OS fault detected in QEMU output — triggering reset.');
      this._stopWatchdog();
      this.reset().catch((err) => console.error('[VM] Fault-triggered reset failed:', err.message));
    }
  }

  /** Handle QEMU process exit for either VM instance. */
  _onQemuExit(inst, code, signal) {
    console.log(`[VM:${inst.label}] QEMU exited (code=${code}, signal=${signal})`);

    if (inst === this._spare) {
      // Spare died on its own — clear the slot and re-warm if we're still running.
      console.warn('[VM:spare] Spare QEMU exited unexpectedly.');
      this._spare = null;
      if (this._running && !this._resetInProgress) this._bootSpare();
      return;
    }

    // Active VM exited.
    this._active = null;
    if (!this._running || this._resetInProgress) return;

    if (!fs.existsSync(config.baseImage)) {
      console.error('[VM] Base image missing — not restarting.');
      this._running = false;
      return;
    }

    console.log('[VM:active] Unexpected exit — triggering reset.');
    this._stopWatchdog();
    this.reset().catch((err) => console.error('[VM] Exit-triggered reset failed:', err.message));
  }

  // ── Watchdog ──────────────────────────────────────────────────────────────

  _startWatchdog() {
    this._stopWatchdog();
    this._watchdogTimer = setInterval(async () => {
      if (!this._running || this._resetInProgress || !this._active) return;

      const ok = await this._active.execHealthCheck();
      if (ok) { this._watchdogFailures = 0; return; }

      this._watchdogFailures++;
      const spareStatus = this._spare
        ? (this._spare.ready ? 'spare ready' : 'spare booting')
        : 'no spare';
      console.warn(
        `[VM] Watchdog: health check failed ` +
        `(${this._watchdogFailures}/${config.watchdogMaxFailures}) [${spareStatus}]`
      );

      if (this._watchdogFailures >= config.watchdogMaxFailures) {
        console.error('[VM] Watchdog: VM unresponsive — triggering reset.');
        this._stopWatchdog();
        this.reset().catch((err) => console.error('[VM] Watchdog reset failed:', err.message));
      }
    }, config.watchdogIntervalMs);
  }

  _stopWatchdog() {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
    this._watchdogFailures = 0;
  }

  // ── Misc ──────────────────────────────────────────────────────────────────

  _closeAllTabs() {
    for (const tab of this._tabs.values()) {
      try { tab.close(); } catch (_) {}
    }
    this._tabs.clear();
  }

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
}

module.exports = new VMManager();
module.exports.VMManager  = VMManager;
module.exports.TabSession = TabSession;
module.exports.VMInstance = VMInstance;
module.exports.config     = config;
