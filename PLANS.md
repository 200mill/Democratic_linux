# Democratic Linux — Implementation Plan

## Context

The `reimpl` branch is a clean slate (only README.md, coreidea.md, LICENSE, CLAUDE.md). A prior TypeScript attempt existed in commit `010e851` but was deleted (`0075764`) due to code quality/structure issues. The master branch has a working JavaScript implementation that serves as the behavioral reference.

The goal is a fresh, well-structured TypeScript rewrite of the full project — same architecture, same features, cleaner code. `coreidea.md` is the authoritative spec.

---

## Architecture (unchanged from spec)

```
Browser (xterm.js)
  └─ WebSocket /ws
       └─ src/server.ts  (Express + ws)
            └─ src/vm.ts  VMManager
                 ├─ active QEMU  (vm/work.img, SSH_PORT)
                 ├─ spare QEMU   (vm/spare.img, SSH_SPARE_PORT)
                 └─ TabSession per browser tab  (ssh2 SSH PTY)
```

---

## Files to Create

```
package.json
tsconfig.json
.gitignore
.dockerignore
Dockerfile
docker-compose.yml
src/
  config.ts
  types.ts
  utils/typed-emitter.ts
  filter.ts
  vm.ts
  tab-registry.ts
  connection-handler.ts
  server.ts
public/
  index.html
scripts/
  create-image.sh
```

---

## Module Responsibilities

### `src/config.ts`
Typed env-var parsing. Every other module imports from here — **no module ever reads `process.env` directly**. Exports a single frozen `config` object.

```ts
export interface Config {
  baseImage: string; workImage: string; spareImage: string;
  sshPort: number; sshSparePort: number; httpPort: number; httpsPort: number;
  sshUser: string; sshPassword: string;
  qemuBin: string; qemuMemory: string; qemuCpus: string;
  sslCert: string; sslKey: string; generateSelfSignedCert: boolean;
  restartDelayMs: number; sshRetryMs: number; sshTimeoutMs: number;
  watchdogIntervalMs: number; watchdogMaxFailures: number;
  outputBufferBytes: number; publicDir: string;
}
```

### `src/types.ts`
All shared interfaces and discriminated unions. No project imports — pure type declarations.

```ts
export type SpareStatus = 'none' | 'booting' | 'ready';
export type VmStatus   = 'booting' | 'ready' | 'resetting';

export interface VMEvents {
  ready: []; reset: []; error: [err: Error]; spare: [status: SpareStatus];
}

// Discriminated unions for WS protocol
export type ServerMessage =
  | { type: 'vm:status'; status: VmStatus }
  | { type: 'vm:spare';  status: SpareStatus }
  | { type: 'tab:list';  tabs: TabSummary[] }
  | { type: 'tab:opened'; tabId: string; title: string; tabs: TabSummary[] }
  | { type: 'tab:closed'; tabId: string; tabs: TabSummary[] }
  | { type: 'output';    tabId: string; data: string }   // base64
  | { type: 'info';      tabId?: string; text: string };

export type ClientMessage =
  | { type: 'tab:open';    tabId?: string; title?: string }
  | { type: 'tab:close';   tabId: string }
  | { type: 'tab:select';  tabId: string }
  | { type: 'input';       tabId: string; data: string }
  | { type: 'resize';      tabId: string; cols: number; rows: number }
  | { type: 'spare:request' }
  | { type: 'spare:load' };

export interface TabEntry {
  id: string; title: string;
  session: import('./vm.js').TabSession | null;
  outputBuffer: Buffer;
  subscribers: Set<import('ws').WebSocket>;
}
export interface TabSummary { id: string; title: string; }
```

Switch on `ClientMessage` gives exhaustiveness checking — TypeScript errors if a case is missing.

### `src/utils/typed-emitter.ts`
Thin typed wrapper over Node's `EventEmitter`. Makes `VMManager.on('spare', (status) => ...)` fully type-checked without a third-party library.

```ts
export class TypedEventEmitter<T extends Record<string, unknown[]>> extends EventEmitter {
  emit<K extends keyof T>(event: K, ...args: T[K]): boolean;
  on<K extends keyof T>(event: K, listener: (...args: T[K]) => void): this;
  once<K extends keyof T>(event: K, listener: (...args: T[K]) => void): this;
  off<K extends keyof T>(event: K, listener: (...args: T[K]) => void): this;
}
```

### `src/filter.ts`
Two exported functions replacing the old single `isBlocked`:

```ts
export function sanitize(data: Buffer): Buffer;   // strips Ctrl-A bytes
export function isBlocked(data: Buffer): boolean; // fork bomb check
```

Moving Ctrl-A stripping here removes inline logic that was scattered in `server.js`.

### `src/vm.ts`
Four collaborating classes. Key improvement: the old implementation mixed watchdog state, tab management, and QEMU lifecycle into one `VMManager` class. These are now separate.

**`VMInstance`** — owns exactly one QEMU process, no tab knowledge:
```ts
class VMInstance {
  readonly label: 'active' | 'spare';
  readonly port: number;
  readonly image: string;
  ready: boolean;

  launch(onOutput: (inst: VMInstance, data: Buffer) => void,
         onExit: (inst: VMInstance, code: number|null, signal: string|null) => void): void;
  kill(): void;
  waitForSsh(abortFn: () => boolean): Promise<boolean>;
  execHealthCheck(): Promise<boolean>;
}
```

**`Watchdog`** — extracted from the 4 scattered `VMManager` members in the old code:
```ts
class Watchdog {
  constructor(intervalMs: number, maxFailures: number, onTrigger: () => void);
  start(healthCheckFn: () => Promise<boolean>): void;
  stop(): void;
  reset(): void; // reset failure count without stopping
}
```

**`TabSession`** — one SSH PTY per browser tab:
```ts
export class TabSession extends TypedEventEmitter<{ data: [Buffer]; close: [] }> {
  readonly id: string;
  open(): Promise<void>;
  write(data: Buffer): void;
  resize(cols: number, rows: number): void;
  close(): void;
}
```

**`VMManager`** — public API, thin orchestration:
```ts
export class VMManager extends TypedEventEmitter<VMEvents> {
  get isReady(): boolean;
  get spareStatus(): SpareStatus;

  async start(): Promise<void>;
  stop(): void;
  async reset(): Promise<void>;
  requestSpare(): void;
  async openTab(id: string): Promise<TabSession>;
  closeTab(id: string): void;
}
```

Critical fix: old code exported `module.exports = new VMManager()` (stateful import side-effect). New code exports the class; `server.ts` creates `const vm = new VMManager()` explicitly.

### `src/tab-registry.ts`
Replaces the 3 standalone functions (`makeTabEntry`, `appendTabBuffer`, `tabList`) and the inline subscriber cleanup in `ws.on('close')`:

```ts
export class ServerTabRegistry {
  constructor(maxBufferBytes: number);
  create(id: string, title: string): TabEntry;
  get(id: string): TabEntry | undefined;
  has(id: string): boolean;
  delete(id: string): void;
  entries(): IterableIterator<[string, TabEntry]>;
  appendBuffer(id: string, data: Buffer): void;
  clearBuffer(id: string): void;
  clearAllBuffers(): void;
  toSummaryList(): TabSummary[];
  unsubscribeAll(ws: WebSocket): void;
}
```

### `src/connection-handler.ts`
Replaces the 120-line `handleConnection` switch statement. Each message type gets its own method with a narrowed parameter type:

```ts
export class ConnectionHandler {
  constructor(vm: VMManager, registry: ServerTabRegistry,
              broadcast: (msg: ServerMessage) => void,
              sendTo: (ws: WebSocket, msg: ServerMessage) => void);

  handle(ws: WebSocket, req: IncomingMessage): void;

  private _handleTabOpen(ws, msg: Extract<ClientMessage, {type:'tab:open'}>): Promise<void>;
  private _handleTabClose(ws, msg: Extract<ClientMessage, {type:'tab:close'}>): void;
  private _handleTabSelect(ws, msg: Extract<ClientMessage, {type:'tab:select'}>): void;
  private _handleInput(ws, msg: Extract<ClientMessage, {type:'input'}>): void;
  private _handleResize(ws, msg: Extract<ClientMessage, {type:'resize'}>): void;
  private _handleSpareRequest(ws: WebSocket): void;
  private _handleSpareLoad(): void;
}
```

`Extract<ClientMessage, {type:'tab:open'}>` narrows the parameter type automatically — no casts needed.

### `src/server.ts`
Thin orchestration only: create instances, wire VM events, start HTTP/WS servers.

Key deduplication: old code had identical `session.on('data')` + `session.on('close')` wiring in two places (inside `openTab` and inside `vm.on('ready')`). Extracted to a single private `_wireSession(id, entry, session)` helper called from both.

```ts
const vm       = new VMManager();
const registry = new ServerTabRegistry(config.outputBufferBytes);
const handler  = new ConnectionHandler(vm, registry, broadcast, sendTo);

vm.on('ready',  () => { /* broadcast + re-open sessions for existing tabs */ });
vm.on('reset',  () => { /* broadcast + clear buffers + close sessions     */ });
vm.on('spare',  (s) => broadcast({ type: 'vm:spare', status: s }));
vm.on('error',  (e) => broadcast({ type: 'info', text: e.message }));
```

### `public/index.html`
Single file, no build step. The embedded JS IIFE is restructured into named factory objects:

```js
const ui     = StatusUI();          // status dot, overlay
const spare  = SpareUI();           // spare button state machine
const tabs   = TabManager();        // local tab Map, pane DOM
const terms  = TerminalManager();   // xterm instances + fitAddon
const router = MessageRouter(ui, spare, tabs, terms);
const ws     = WSClient(router);
```

Same features: Ctrl+T/W/Tab shortcuts, auto-reconnect with exponential backoff (1s→10s), base64 I/O, 32 KiB replay on tab select.

### `scripts/create-image.sh`
Copy from master branch verbatim — it already works. Creates 2 GiB raw Debian bookworm image with OpenSSH, blank root password, GRUB, via debootstrap + losetup.

### `Dockerfile`
Two-stage build (improvement over single-stage in old code):
- **builder** stage: installs all devDeps, runs `tsc`
- **runtime** stage: copies `dist/`, installs prod deps only, copies `public/` and `scripts/`

Removes TypeScript tooling from the final image.

### `tsconfig.json`
```json
{
  "compilerOptions": {
    "target": "ES2020", "module": "CommonJS",
    "outDir": "./dist", "rootDir": "./src",
    "strict": true, "esModuleInterop": true,
    "noUnusedLocals": true, "noUnusedParameters": true,
    "exactOptionalPropertyTypes": true
  }
}
```

`exactOptionalPropertyTypes: true` is the key flag the old code lacked — prevents assigning `undefined` to optional properties where `| undefined` wasn't declared.

### `package.json` scripts
```json
{
  "build":       "tsc",
  "build:watch": "tsc --watch",
  "start":       "node dist/server.js",
  "dev":         "nodemon --exec ts-node src/server.ts --watch src",
  "typecheck":   "tsc --noEmit",
  "clean":       "rm -rf dist"
}
```

`ts-node` for local dev (no manual build step); compiled `dist/` for Docker.

---

## Implementation Order

1. `package.json` + `tsconfig.json` + `.gitignore` + `.dockerignore`
2. `src/utils/typed-emitter.ts` + `src/types.ts` + `src/config.ts`
3. `src/filter.ts`
4. `src/vm.ts` — `VMInstance` → `Watchdog` → `TabSession` → `VMManager` (bottom-up)
5. `src/tab-registry.ts`
6. `src/connection-handler.ts`
7. `src/server.ts`
8. `public/index.html`
9. `scripts/create-image.sh` (copy from master)
10. `Dockerfile` + `docker-compose.yml`

---

## Verification

```bash
# Type correctness
npm install && npm run typecheck   # must pass with zero errors

# Dev server (no QEMU needed to verify server boots)
npm run dev
# → VM will fail to start without base.img — expected; server itself should boot

# Full test with QEMU (Linux host, root required)
sudo bash scripts/create-image.sh  # ~5 min first run
npm run dev
# Open http://localhost:3000 → working terminal in VM
# Ctrl+T → second tab, independent shell, shared filesystem

# Docker end-to-end
docker compose up --build
# → base.img built automatically, open http://localhost:80
```

**Correctness gates:**
- `npm run typecheck` zero errors (strict + exactOptionalPropertyTypes)
- No `as any` casts in source
- All `switch (msg.type)` on `ClientMessage` are exhaustive
