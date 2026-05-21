import { spawn, ChildProcess } from 'child_process';
import { existsSync, copyFileSync } from 'fs';
import { Client as SshClient } from 'ssh2';
import { config } from './config';
import { TypedEventEmitter } from './utils/typed-emitter';
import { VMEvents, SpareStatus } from './types';

const FAULT_PATTERNS = /Kernel panic|kernel BUG|I\/O error|EXT4-fs error|Buffer I\/O error/;

// ─── VMInstance ────────────────────────────────────────────────────────────────

class VMInstance {
  readonly label: 'active' | 'spare';
  readonly port: number;
  readonly image: string;
  ready = false;

  private _proc: ChildProcess | null = null;

  constructor(label: 'active' | 'spare', port: number, image: string) {
    this.label = label;
    this.port = port;
    this.image = image;
  }

  launch(
    onOutput: (inst: VMInstance, data: Buffer) => void,
    onExit: (inst: VMInstance, code: number | null, signal: string | null) => void,
  ): void {
    const args = [
      '-m', config.qemuMemory,
      '-smp', config.qemuCpus,
      '-drive', `file=${this.image},format=raw,if=virtio`,
      '-netdev', `user,id=net0,hostfwd=tcp:127.0.0.1:${this.port}-:22`,
      '-device', 'virtio-net-pci,netdev=net0',
      '-nographic',
      '-monitor', 'none',
      ...(existsSync('/dev/kvm') ? ['-enable-kvm'] : []),
    ];

    this._proc = spawn(config.qemuBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const handleData = (data: Buffer) => onOutput(this, data);
    this._proc.stdout?.on('data', handleData);
    this._proc.stderr?.on('data', handleData);

    this._proc.on('exit', (code, signal) => {
      this.ready = false;
      this._proc = null;
      onExit(this, code, signal);
    });
  }

  kill(): void {
    try { this._proc?.kill('SIGKILL'); } catch { /* ignore */ }
  }

  waitForSsh(abortFn: () => boolean): Promise<boolean> {
    return new Promise(resolve => {
      const start = Date.now();

      const attempt = () => {
        if (abortFn()) { resolve(false); return; }
        if (Date.now() - start > config.sshTimeoutMs) { resolve(false); return; }

        // Probe a full SSH handshake so we only resolve true when the daemon is
        // genuinely ready to accept authenticated sessions, not just TCP connections.
        const client = new SshClient();
        let settled = false;
        const fail = () => {
          if (!settled) { settled = true; client.end(); setTimeout(attempt, config.sshRetryMs); }
        };

        client.on('error', fail);
        client.once('ready', () => {
          if (!settled) { settled = true; client.end(); resolve(true); }
        });

        client.connect({
          host: '127.0.0.1',
          port: this.port,
          username: config.sshUser,
          password: config.sshPassword,
          hostVerifier: () => true,
          readyTimeout: 8000,
        });
      };

      attempt();
    });
  }

  execHealthCheck(): Promise<boolean> {
    return new Promise(resolve => {
      const client = new SshClient();
      let settled = false;
      const done = (result: boolean) => {
        if (!settled) { settled = true; client.end(); resolve(result); }
      };

      const timer = setTimeout(() => done(false), 10000);

      client.on('error', () => { clearTimeout(timer); done(false); });

      client.once('ready', () => {
        client.exec('echo ok', (err, stream) => {
          if (err) { clearTimeout(timer); done(false); return; }
          let output = '';
          stream.on('data', (d: Buffer) => { output += d.toString(); });
          stream.once('close', () => {
            clearTimeout(timer);
            done(output.trim() === 'ok');
          });
        });
      });

      client.connect({
        host: '127.0.0.1',
        port: this.port,
        username: config.sshUser,
        password: config.sshPassword,
        hostVerifier: () => true,
        readyTimeout: 8000,
      });
    });
  }
}

// ─── Watchdog ─────────────────────────────────────────────────────────────────

class Watchdog {
  private readonly _intervalMs: number;
  private readonly _maxFailures: number;
  private readonly _onTrigger: () => void;
  private _timer: NodeJS.Timeout | null = null;
  private _failures = 0;
  private _running = false;

  constructor(intervalMs: number, maxFailures: number, onTrigger: () => void) {
    this._intervalMs = intervalMs;
    this._maxFailures = maxFailures;
    this._onTrigger = onTrigger;
  }

  start(healthCheckFn: () => Promise<boolean>): void {
    if (this._running) return;
    this._running = true;
    this._failures = 0;

    const tick = async () => {
      if (!this._running) return;
      const ok = await healthCheckFn();
      if (!this._running) return;

      if (ok) {
        this._failures = 0;
      } else {
        this._failures++;
        if (this._failures >= this._maxFailures) {
          this._running = false;
          if (this._timer) { clearTimeout(this._timer); this._timer = null; }
          this._onTrigger();
          return;
        }
      }

      this._timer = setTimeout(tick, this._intervalMs);
    };

    this._timer = setTimeout(tick, this._intervalMs);
  }

  stop(): void {
    this._running = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  reset(): void {
    this._failures = 0;
  }
}

// ─── TabSession ───────────────────────────────────────────────────────────────

export class TabSession extends TypedEventEmitter<{ data: [Buffer]; close: [] }> {
  readonly id: string;
  private readonly _port: number;
  private _client: SshClient | null = null;
  private _stream: import('ssh2').ClientChannel | null = null;

  constructor(id: string, port: number) {
    super();
    this.id = id;
    this._port = port;
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const client = new SshClient();
      this._client = client;
      let settled = false;

      // Persistent error handler: ssh2 can emit 'error' multiple times (e.g.
      // once() already consumed on initial connect, then again when VM resets).
      // Any post-resolve errors are silently absorbed; stream 'close' handles cleanup.
      client.on('error', (err) => {
        if (!settled) { settled = true; this._client = null; reject(err); }
      });

      client.once('ready', () => {
        client.shell({ term: 'xterm-256color', cols: 220, rows: 50 }, (err, stream) => {
          if (err) {
            if (!settled) { settled = true; this._client = null; reject(err); }
            client.end();
            return;
          }
          this._stream = stream;
          settled = true; // connected — further errors absorbed, stream close handles teardown

          stream.on('data', (data: Buffer) => this.emit('data', data));
          stream.stderr.on('data', (data: Buffer) => this.emit('data', data));

          stream.once('close', () => {
            this._stream = null;
            this._client = null;
            this.emit('close');
          });

          resolve();
        });
      });

      client.connect({
        host: '127.0.0.1',
        port: this._port,
        username: config.sshUser,
        password: config.sshPassword,
        hostVerifier: () => true,
        readyTimeout: 8000,
      });
    });
  }

  write(data: Buffer): void {
    this._stream?.write(data);
  }

  resize(cols: number, rows: number): void {
    this._stream?.setWindow(rows, cols, 0, 0);
  }

  close(): void {
    try { this._client?.end(); } catch { /* ignore */ }
    this._stream = null;
    this._client = null;
  }
}

// ─── VMManager ────────────────────────────────────────────────────────────────

export class VMManager extends TypedEventEmitter<VMEvents> {
  private _active: VMInstance | null = null;
  private _spare: VMInstance | null = null;
  private _spareStatus: SpareStatus = 'none';
  private _ready = false;
  private _resetting = false;
  private _abortActive = false;
  private _watchdog: Watchdog;
  private _sessions = new Map<string, TabSession>();

  constructor() {
    super();
    this._watchdog = new Watchdog(
      config.watchdogIntervalMs,
      config.watchdogMaxFailures,
      () => { void this.reset(); },
    );
  }

  get isReady(): boolean { return this._ready; }
  get spareStatus(): SpareStatus { return this._spareStatus; }

  async start(): Promise<void> {
    this._abortActive = false;
    copyFileSync(config.baseImage, config.workImage);

    const inst = new VMInstance('active', config.sshPort, config.workImage);
    this._active = inst;

    inst.launch(
      (i, data) => this._onVmOutput(i, data),
      (i, code, signal) => this._onVmExit(i, code, signal),
    );

    const ok = await inst.waitForSsh(() => this._abortActive);
    if (!ok || this._abortActive) return;

    inst.ready = true;
    this._ready = true;
    this.emit('ready');

    this._watchdog.start(() => inst.execHealthCheck());
    this.requestSpare();
  }

  stop(): void {
    this._abortActive = true;
    this._watchdog.stop();
    this._active?.kill();
    this._spare?.kill();
    this._active = null;
    this._spare = null;
    this._ready = false;
  }

  async reset(): Promise<void> {
    if (this._resetting) return;
    this._resetting = true;
    this._ready = false;
    this._abortActive = true;
    this._watchdog.stop();

    for (const session of this._sessions.values()) {
      session.close();
    }

    this.emit('reset');

    if (this._spare && this._spareStatus === 'ready') {
      // Hot-spare promotion: swap active with spare instantly
      this._active?.kill();
      this._active = this._spare;
      this._spare = null;
      this._spareStatus = 'none';
      this.emit('spare', 'none');

      this._ready = true;
      this._resetting = false;
      this._abortActive = false;
      this.emit('ready');

      this._watchdog = new Watchdog(
        config.watchdogIntervalMs,
        config.watchdogMaxFailures,
        () => { void this.reset(); },
      );
      this._watchdog.start(() => this._active!.execHealthCheck());
      this.requestSpare();
    } else {
      // Cold boot
      this._active?.kill();
      this._active = null;

      await new Promise(r => setTimeout(r, config.restartDelayMs));

      this._abortActive = false;
      this._resetting = false;

      try {
        copyFileSync(config.baseImage, config.workImage);
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
        return;
      }

      const inst = new VMInstance('active', config.sshPort, config.workImage);
      this._active = inst;
      inst.launch(
        (i, data) => this._onVmOutput(i, data),
        (i, code, signal) => this._onVmExit(i, code, signal),
      );

      const ok = await inst.waitForSsh(() => this._abortActive);
      if (!ok || this._abortActive) return;

      inst.ready = true;
      this._ready = true;
      this.emit('ready');

      this._watchdog = new Watchdog(
        config.watchdogIntervalMs,
        config.watchdogMaxFailures,
        () => { void this.reset(); },
      );
      this._watchdog.start(() => inst.execHealthCheck());
      this.requestSpare();
    }
  }

  requestSpare(): void {
    if (this._spare || this._spareStatus !== 'none') return;

    this._spareStatus = 'booting';
    this.emit('spare', 'booting');

    const inst = new VMInstance('spare', config.sshSparePort, config.spareImage);
    this._spare = inst;

    try {
      copyFileSync(config.baseImage, config.spareImage);
    } catch (err) {
      this._spare = null;
      this._spareStatus = 'none';
      this.emit('spare', 'none');
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
      return;
    }

    inst.launch(
      () => { /* spare output ignored */ },
      () => {
        if (this._spare === inst) {
          this._spare = null;
          this._spareStatus = 'none';
          this.emit('spare', 'none');
        }
      },
    );

    inst.waitForSsh(() => this._spare !== inst).then(ok => {
      if (!ok || this._spare !== inst) return;
      inst.ready = true;
      this._spareStatus = 'ready';
      this.emit('spare', 'ready');
    });
  }

  async openTab(id: string): Promise<TabSession> {
    if (!this._active) throw new Error('VM not ready');
    const session = new TabSession(id, this._active.port);
    await session.open();
    this._sessions.set(id, session);
    return session;
  }

  closeTab(id: string): void {
    const session = this._sessions.get(id);
    if (session) {
      session.close();
      this._sessions.delete(id);
    }
  }

  private _onVmOutput(inst: VMInstance, data: Buffer): void {
    if (inst !== this._active) return;
    const text = data.toString('utf8');
    if (FAULT_PATTERNS.test(text)) {
      void this.reset();
    }
  }

  private _onVmExit(inst: VMInstance, _code: number | null, _signal: string | null): void {
    if (inst !== this._active) return;
    if (!this._resetting && !this._abortActive) {
      void this.reset();
    }
  }
}
