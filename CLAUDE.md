# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Context

This is the `reimpl` branch: a clean TypeScript rewrite of the master-branch JavaScript implementation. `coreidea.md` is the authoritative feature spec. `PLANS.md` has the detailed module-by-module implementation plan.

## Commands

```bash
# Development (TypeScript, no build step needed)
npm run dev        # nodemon + ts-node src/server.ts (auto-restart)

# Type checking
npm run typecheck  # tsc --noEmit (must pass with zero errors)

# Build for production
npm run build      # tsc → dist/
npm run clean      # rm -rf dist

# Run compiled output
npm start          # node dist/server.js

# Docker (production)
docker compose up --build   # two-stage build + start container
docker compose up -d        # run detached

# Build the base VM image manually (requires root + QEMU/debootstrap)
bash scripts/create-image.sh
```

There are no automated tests in this project.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `HTTP_PORT` | `80` | HTTP listen port |
| `HTTPS_PORT` | `443` | HTTPS listen port |
| `SSL_CERT` / `SSL_KEY` | — | Paths to TLS PEM files; both must be set to enable HTTPS |
| `GENERATE_SELF_SIGNED_CERT` | `false` | Auto-generate a self-signed cert at `SSL_CERT`/`SSL_KEY` paths |
| `SSH_PORT` | `2222` | Port the active QEMU VM listens on for SSH |
| `SSH_SPARE_PORT` | `2223` | Port the spare QEMU VM listens on for SSH |
| `QEMU_BIN` | `qemu-system-x86_64` | QEMU binary name |
| `QEMU_MEM` | `512M` | VM memory |
| `QEMU_CPUS` | `1` | VM CPU count |

## Architecture

```
Browser (xterm.js)
  └─ WebSocket /ws
       └─ src/server.ts  (Express + ws)
            ├─ src/connection-handler.ts  (per-WS message dispatch)
            ├─ src/tab-registry.ts        (tab state + output buffers)
            └─ src/vm.ts  VMManager
                 ├─ VMInstance (active)  (vm/work.img, SSH_PORT)
                 ├─ VMInstance (spare)   (vm/spare.img, SSH_SPARE_PORT)
                 ├─ Watchdog             (SSH health checks)
                 └─ TabSession per browser tab  (ssh2 SSH PTY)
```

**`src/config.ts`**
- Parses all `process.env` into a typed, frozen `Config` object. No other module ever reads `process.env` directly.

**`src/types.ts`**
- All shared interfaces and discriminated unions. No imports from the project — pure type declarations.
- `ClientMessage` and `ServerMessage` are discriminated unions; switch on `msg.type` should be exhaustive (TypeScript will error if a case is missing).

**`src/utils/typed-emitter.ts`**
- Thin generic wrapper over Node's `EventEmitter`. Used by `VMManager` and `TabSession` for fully type-checked events without a third-party library.

**`src/filter.ts`**
- `sanitize(data: Buffer): Buffer` — strips Ctrl-A bytes (QEMU monitor escape).
- `isBlocked(data: Buffer): boolean` — detects fork bomb patterns.

**`src/vm.ts`** — four collaborating classes:
- `VMInstance` — owns one QEMU process; knows nothing about tabs; exposes `launch()`, `kill()`, `waitForSsh()`, `execHealthCheck()`.
- `Watchdog` — runs `healthCheckFn` on an interval; triggers `onTrigger` after `maxFailures` consecutive failures.
- `TabSession` — one SSH PTY per browser tab; emits `data` and `close`.
- `VMManager` — public API: orchestrates active/spare instances, watchdog, failover. Emits `ready`, `reset`, `error`, `spare`. Public: `start()`, `stop()`, `reset()`, `requestSpare()`, `openTab(id)`, `closeTab(id)`.

Hot-spare failover: on reset, spare is promoted instantly (port swap, emit `ready`), then a fresh spare boots. Falls back to cold boot if spare isn't ready. SSH watchdog runs `echo ok` every 15 s; 3 consecutive failures trigger `reset()`. QEMU stdout is watched for `Kernel panic` / `EXT4-fs error` → immediate reset.

**`src/tab-registry.ts` — `ServerTabRegistry`**
- Manages `tabId → { session, outputBuffer (32 KiB), subscribers }`.
- Key methods: `create`, `get`, `delete`, `appendBuffer`, `clearAllBuffers`, `toSummaryList`, `unsubscribeAll(ws)`.

**`src/connection-handler.ts` — `ConnectionHandler`**
- Replaces a large switch statement. Each `ClientMessage` type gets its own private method with a narrowed parameter type via `Extract<ClientMessage, {type:'...'}>`.
- Constructor takes `(vm, registry, broadcast, sendTo)`.

**`src/server.ts`**
- Thin orchestration: creates `VMManager`, `ServerTabRegistry`, `ConnectionHandler`; wires VM events; starts HTTP/WS servers.
- Session wiring (subscribe to `data`/`close`) is extracted into a single `_wireSession(id, entry, session)` helper called from both `tab:open` and `vm.on('ready')` re-open paths.
- WS message protocol (browser → server): `tab:open`, `tab:close`, `tab:select`, `input`, `resize`, `spare:request`, `spare:load`.
- WS message protocol (server → browser): `vm:status`, `vm:spare`, `tab:list`, `tab:opened`, `tab:closed`, `output` (base64), `info`.

**`public/index.html`**
- Single file, no build step. Embedded JS structured as named factory objects: `StatusUI`, `SpareUI`, `TabManager`, `TerminalManager`, `MessageRouter`, `WSClient`.
- Decodes `output` messages from base64 before writing to xterm. Auto-reconnects with exponential backoff (1 s → 10 s).

**`scripts/create-image.sh`**
- Creates `vm/base.img`: 2 GiB raw Debian bookworm with OpenSSH (`PermitRootLogin yes`, blank root password), GRUB, via `debootstrap` + `losetup`. Must run as root.
- Docker `CMD` runs it automatically if `vm/base.img` is missing.

**Docker** — two-stage build:
- `builder`: installs all devDeps, runs `tsc`.
- `runtime`: copies `dist/`, installs prod deps only, copies `public/` and `scripts/`.

**VM image files** (in `vm/` volume, not in repo):
- `base.img` — clean read-only reference image
- `work.img` — active VM disk (copied from `base.img` on each reset)
- `spare.img` — spare VM disk (copied from `base.img` when spare boots)

## TypeScript constraints

- `tsconfig.json` uses `strict: true`, `noUnusedLocals`, `noUnusedParameters`, `exactOptionalPropertyTypes: true`.
- No `as any` casts in source.
- `npm run typecheck` must pass with zero errors before committing.
- All `switch (msg.type)` on `ClientMessage` must be exhaustive.
- `process.env` is only read in `src/config.ts`.
