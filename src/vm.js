/**
 * QEMU VM Manager
 *
 * Responsible for:
 *  - Starting QEMU with user-mode networking and an SSH port-forward
 *    (host 127.0.0.1:2222  →  guest :22).
 *  - After QEMU is up, opening one SSH shell session (with a PTY) as root.
 *  - Watching the QEMU process and the SSH session; restarting everything
 *    (with a fresh image copy) when the VM exits or the SSH session dies.
 *  - Providing a simple EventEmitter API consumed by server.js:
 *      vm.on('data', (chunk) => ...)   – raw bytes from the PTY
 *      vm.write(data)                  – send bytes into the PTY
 *      vm.on('reset', () => ...)       – fired just before a VM restart
 *      vm.on('error', (err) => ...)    – non-fatal error notification
 *      vm.resize(cols, rows)           – forward terminal resize to PTY
 */

'use strict';

const { spawn }     = require('child_process');
const EventEmitter  = require('events');
const fs            = require('fs');
const path          = require('path');
const { Client }    = require('ssh2');

// ── Configuration ────────────────────────────────────────────────────────────

const config = {
  baseImage:      path.resolve(__dirname, '..', 'vm', 'base.img'),
  workImage:      path.resolve(__dirname, '..', 'vm', 'work.img'),
  // Host-side port that QEMU forwards to guest SSH port 22.
  sshPort:        parseInt(process.env.SSH_PORT || '2222', 10),
  // Credentials for the root account inside the VM (empty password).
  sshUser:        'root',
  sshPassword:    '',
  restartDelayMs: 5000,
  qemuBin:        process.env.QEMU_BIN || 'qemu-system-x86_64',
  memory:         process.env.QEMU_MEM  || '512M',
  cpus:           process.env.QEMU_CPUS || '1',
  // How long to wait between SSH connection attempts while the VM is booting.
  sshRetryMs:     5000,
  // Maximum time to wait for SSH to become available after QEMU starts.
  sshTimeoutMs:   15 * 60 * 1000, // 15 minutes (TCG boot is slow)
};

// ── VM Manager ───────────────────────────────────────────────────────────────

class VMManager extends EventEmitter {
  constructor() {
    super();
    this._qemuProc       = null;
    this._sshClient      = null;
    this._sshStream      = null;
    this._running        = false;
    this._resetInProgress = false;
    // Current PTY dimensions forwarded by connected browser clients.
    this._ptycols = 220;
    this._ptyrows = 50;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  async start() {
    if (this._running) return;
    this._running = true;
    await this._boot();
  }

  /** Send raw bytes to the SSH PTY. */
  write(data) {
    if (this._sshStream && !this._sshStream.destroyed) {
      this._sshStream.write(data);
    }
  }

  /** Resize the SSH PTY. */
  resize(cols, rows) {
    this._ptycols = cols;
    this._ptyrows = rows;
    if (this._sshStream && !this._sshStream.destroyed) {
      this._sshStream.setWindow(rows, cols, rows * 16, cols * 8);
    }
  }

  stop() {
    this._running = false;
    this._teardownSSH();
    this._killQemu();
  }

  async reset() {
    if (this._resetInProgress) return;
    this._resetInProgress = true;
    this.emit('reset');
    this._teardownSSH();
    this._killQemu();
    await this._sleep(500);
    await this._boot();
    this._resetInProgress = false;
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  async _boot() {
    this._prepareImage();
    this._launchQemu();
    // SSH becomes available only after Alpine finishes booting (~8 min TCG).
    await this._waitForSSH();
  }

  _prepareImage() {
    const vmDir = path.dirname(config.workImage);
    if (!fs.existsSync(vmDir)) fs.mkdirSync(vmDir, { recursive: true });

    if (!fs.existsSync(config.baseImage)) {
      this.emit('error', new Error(
        `Base image not found: ${config.baseImage}\n` +
        `Run  scripts/create-image.sh  to create it first.`
      ));
      return;
    }

    // Use cp --sparse=always to preserve holes and avoid inflating disk usage.
    try {
      require('child_process').execFileSync(
        'cp', ['--sparse=always', config.baseImage, config.workImage]
      );
    } catch (_) {
      fs.copyFileSync(config.baseImage, config.workImage);
    }
    console.log('[VM] Prepared fresh working image.');
  }

  _launchQemu() {
    const args = [
      '-m',    config.memory,
      '-smp',  config.cpus,
      '-drive', `file=${config.workImage},format=raw,if=virtio`,
      // User-mode networking: forward host 2222 → guest 22.
      '-netdev', `user,id=net0,hostfwd=tcp:127.0.0.1:${config.sshPort}-:22`,
      '-device', 'virtio-net-pci,netdev=net0',
      // No graphical output, no monitor.
      '-nographic',
      '-monitor', 'none',
      // KVM if available.
      ...(fs.existsSync('/dev/kvm') ? ['-enable-kvm'] : []),
    ];

    console.log(`[VM] Launching: ${config.qemuBin} ${args.join(' ')}`);
    this._qemuProc = spawn(config.qemuBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    this._qemuProc.stdout.on('data', (d) => process.stdout.write(`[QEMU] ${d}`));
    this._qemuProc.stderr.on('data', (d) => process.stderr.write(`[QEMU] ${d}`));

    this._qemuProc.on('exit', (code, signal) => {
      console.log(`[VM] QEMU exited (code=${code}, signal=${signal})`);
      this._qemuProc = null;
      this._teardownSSH();

      if (this._running && !this._resetInProgress) {
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

  /**
   * Poll SSH port until the VM is up and accepting connections, then open
   * a shell session with a PTY.
   */
  async _waitForSSH() {
    const deadline = Date.now() + config.sshTimeoutMs;
    let attempt = 0;

    while (this._running) {
      if (Date.now() > deadline) {
        console.error('[VM] Timed out waiting for SSH to become available.');
        this.emit('error', new Error('SSH timed out — VM may have failed to boot.'));
        return;
      }

      attempt++;
      console.log(`[VM] Waiting for SSH (attempt ${attempt})…`);

      const connected = await this._trySSH();
      if (connected) return;

      await this._sleep(config.sshRetryMs);
    }
  }

  /**
   * Try to open an SSH shell.  Returns true if successful, false otherwise.
   */
  _trySSH() {
    return new Promise((resolve) => {
      const client = new Client();

      const fail = () => {
        try { client.end(); } catch (_) {}
        resolve(false);
      };

      client.on('ready', () => {
        console.log('[VM] SSH connected. Opening shell…');

        client.shell(
          { term: 'xterm-256color', cols: this._ptycols, rows: this._ptyrows },
          (err, stream) => {
            if (err) {
              console.error('[VM] SSH shell error:', err.message);
              client.end();
              resolve(false);
              return;
            }

            this._sshClient = client;
            this._sshStream = stream;

            stream.on('data', (data) => {
              this.emit('data', data);
            });

            // stderr from the shell also goes to the terminal.
            stream.stderr.on('data', (data) => {
              this.emit('data', data);
            });

            stream.on('close', () => {
              console.log('[VM] SSH shell session closed.');
              this._sshStream = null;
              if (this._running && !this._resetInProgress) {
                console.log('[VM] SSH shell ended unexpectedly — resetting VM.');
                this.reset();
              }
            });

            stream.on('error', (err) => {
              console.error('[VM] SSH stream error:', err.message);
            });

            resolve(true);
          }
        );
      });

      client.on('error', (err) => {
        // Common during boot — don't log every attempt to avoid noise.
        fail();
      });

      client.connect({
        host:           '127.0.0.1',
        port:           config.sshPort,
        username:       config.sshUser,
        password:       config.sshPassword,
        // Don't verify host key (VM is ephemeral, key changes on every reset).
        hostVerifier:   () => true,
        readyTimeout:   8000,
      });
    });
  }

  _teardownSSH() {
    if (this._sshStream) {
      try { this._sshStream.close(); } catch (_) {}
      this._sshStream = null;
    }
    if (this._sshClient) {
      try { this._sshClient.end(); } catch (_) {}
      this._sshClient = null;
    }
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
module.exports.VMManager = VMManager;
module.exports.config = config;
