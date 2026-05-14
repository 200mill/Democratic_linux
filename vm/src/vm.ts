/**
 * QEMU VM Manager
 *
 * Responsible for:
 *  - Starting a QEMU process with a serial port exposed on a local TCP socket.
 *  - Watching the process and restarting it (with a fresh image copy) when it
 *    exits unexpectedly or when a health-check detects corruption.
 *  - Providing a simple event-emitter API so the WebSocket layer can subscribe
 *    to VM output and write input.
 */

import { spawn } from 'child_process';
import * as net  from 'net';
import { EventEmitter } from 'events';
import * as fs   from 'fs';
import * as path from 'path';

// ── Configuration ────────────────────────────────────────────────────────────

export interface VMConfig {
  baseImage:      string;
  workImage:      string;
  serialPort:     number;
  restartDelayMs: number;
  qemuBin:        string;
  extraArgs:      string[];
  memory:         string;
  cpus:           string;
}

export const config: VMConfig = {
  // Path to the "golden" (read-only) disk image that is copied on every reset.
  baseImage:      path.resolve(__dirname, '..', 'vm', 'base.qcow2'),
  // Path to the working copy that QEMU actually runs.
  workImage:      path.resolve(__dirname, '..', 'vm', 'work.qcow2'),
  // TCP port QEMU exposes the VM's first serial port on.
  serialPort:     4444,
  // How long (ms) to wait before attempting a restart after an unexpected exit.
  restartDelayMs: 3000,
  // QEMU binary name (must be in PATH or set to absolute path).
  qemuBin:        process.env.QEMU_BIN ?? 'qemu-system-x86_64',
  // Extra QEMU arguments (appended after the defaults).
  extraArgs:      [],
  // Memory for the VM.
  memory:         process.env.QEMU_MEM ?? '256M',
  // Number of virtual CPUs.
  cpus:           process.env.QEMU_CPUS ?? '1',
};

// ── VMManager event map ──────────────────────────────────────────────────────

export interface VMManagerEvents {
  data:  (chunk: Buffer) => void;
  reset: () => void;
  error: (err: Error) => void;
}

// ── VM Manager ───────────────────────────────────────────────────────────────

export class VMManager extends EventEmitter {
  private _qemuProc:       ReturnType<typeof spawn> | null = null;
  private _serialServer:   net.Server | null               = null;
  private _serialClients:  Set<net.Socket>                 = new Set();
  private _running         = false;
  private _resetInProgress = false;

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Start the VM (copies the base image, then launches QEMU).
   */
  async start(): Promise<void> {
    if (this._running) return;
    this._running = true;
    await this._boot();
  }

  /**
   * Write raw bytes to the VM's serial port (broadcast to all serial clients).
   */
  write(data: Buffer | string): void {
    for (const client of this._serialClients) {
      if (!client.destroyed) client.write(data);
    }
  }

  /**
   * Gracefully stop the VM.
   */
  stop(): void {
    this._running = false;
    if (this._qemuProc) {
      this._qemuProc.kill('SIGTERM');
      this._qemuProc = null;
    }
  }

  /**
   * Trigger an immediate reset (copies base image, restarts QEMU).
   */
  async reset(): Promise<void> {
    if (this._resetInProgress) return;
    this._resetInProgress = true;
    this.emit('reset');
    this._killQemu();
    await this._sleep(500);
    await this._boot();
    this._resetInProgress = false;
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  private async _boot(): Promise<void> {
    this._prepareImage();
    this._startSerialServer();
    this._launchQemu();
  }

  private _prepareImage(): void {
    const vmDir = path.dirname(config.workImage);
    if (!fs.existsSync(vmDir)) fs.mkdirSync(vmDir, { recursive: true });

    if (!fs.existsSync(config.baseImage)) {
      // No base image yet – the user must create one with scripts/create-image.sh
      this.emit('error', new Error(
        `Base image not found: ${config.baseImage}\n` +
        `Run  scripts/create-image.sh  to create it first.`
      ));
      return;
    }

    // Always start from a fresh copy so the VM state is clean.
    fs.copyFileSync(config.baseImage, config.workImage);
    console.log('[VM] Prepared fresh working image.');
  }

  private _startSerialServer(): void {
    // If the server is already listening, nothing to do.
    if (this._serialServer && this._serialServer.listening) return;

    this._serialServer = net.createServer((socket) => {
      console.log('[VM] Serial client connected.');
      this._serialClients.add(socket);

      socket.on('data', (data: Buffer) => {
        // Forward VM output to all WebSocket subscribers.
        this.emit('data', data);
      });

      socket.on('close', () => {
        this._serialClients.delete(socket);
      });

      socket.on('error', () => {
        this._serialClients.delete(socket);
      });
    });

    this._serialServer.listen(config.serialPort, '127.0.0.1', () => {
      console.log(`[VM] Serial TCP server listening on 127.0.0.1:${config.serialPort}`);
    });

    this._serialServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        // Port already in use – QEMU might still connect; that's fine.
        console.warn('[VM] Serial port already in use, continuing.');
      } else {
        this.emit('error', err);
      }
    });
  }

  private _launchQemu(): void {
    const args: string[] = [
      '-m', config.memory,
      '-smp', config.cpus,
      // Use the working image copy (backed by base image).
      '-drive', `file=${config.workImage},format=qcow2,if=virtio`,
      // No graphical output.
      '-nographic',
      // Expose serial port over TCP (QEMU connects to our server).
      '-serial', `tcp:127.0.0.1:${config.serialPort},server=off`,
      // Disable monitor (we do not need it).
      '-monitor', 'none',
      // Enable KVM if available (Linux host only).
      ...(process.platform === 'linux' ? ['-enable-kvm'] : []),
      ...config.extraArgs,
    ];

    console.log(`[VM] Launching: ${config.qemuBin} ${args.join(' ')}`);
    this._qemuProc = spawn(config.qemuBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    this._qemuProc.stdout!.on('data', (d: Buffer) => process.stdout.write(`[QEMU] ${d}`));
    this._qemuProc.stderr!.on('data', (d: Buffer) => process.stderr.write(`[QEMU] ${d}`));

    this._qemuProc.on('exit', (code, signal) => {
      console.log(`[VM] QEMU exited (code=${code}, signal=${signal})`);
      this._qemuProc = null;
      this._serialClients.clear();

      if (this._running && !this._resetInProgress) {
        console.log(`[VM] Scheduling automatic restart in ${config.restartDelayMs} ms…`);
        this.emit('reset');
        setTimeout(() => void this._boot(), config.restartDelayMs);
      }
    });

    this._qemuProc.on('error', (err: Error) => {
      console.error('[VM] Failed to spawn QEMU:', err.message);
      this.emit('error', err);
    });
  }

  private _killQemu(): void {
    if (this._qemuProc) {
      try { this._qemuProc.kill('SIGKILL'); } catch (_) { /* ignore */ }
      this._qemuProc = null;
    }
    this._serialClients.clear();
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

// Export a singleton instance as the default export (mirrors the original JS).
const vmManager = new VMManager();
export default vmManager;
