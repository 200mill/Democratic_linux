# Democratic Linux

A shared, disposable Linux VM accessible from any browser. Multiple users connect to the same QEMU Debian VM through a web terminal (xterm.js). Everyone shares the same filesystem. Destructive commands are harmless — the VM auto-resets to a clean image on any failure.

## Quick start (Docker / Podman)

```bash
docker compose up --build
# or
podman compose up --build
```

Opens on `http://localhost:80`. On first run, `scripts/create-image.sh` builds the 2 GiB base Debian image automatically (takes ~5 minutes, requires the container to run privileged).

## Development

```bash
npm install
npm run dev        # ts-node + nodemon, auto-restart on save
```

The server starts even without a VM image — it will log an error and wait. To get a working terminal, build the image first:

```bash
sudo bash scripts/create-image.sh   # requires root, QEMU, debootstrap
```

Then open `http://localhost:80` (or whatever `HTTP_PORT` is set to).

Other commands:

```bash
npm run typecheck  # tsc --noEmit — must pass with zero errors
npm run build      # compile TypeScript → dist/
npm start          # run compiled output
npm run clean      # rm -rf dist
```

## Requirements

- **Runtime**: Node.js 20+, `qemu-system-x86_64`
- **Image build**: root access, `debootstrap`, `losetup`
- **Docker**: `docker compose` or `podman compose` (container runs privileged for KVM + losetup)

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `HTTP_PORT` | `80` | HTTP listen port |
| `HTTPS_PORT` | `443` | HTTPS listen port |
| `SSL_CERT` / `SSL_KEY` | — | Paths to TLS PEM files; both required to enable HTTPS |
| `SSH_PORT` | `2222` | SSH port for the active QEMU VM |
| `SSH_SPARE_PORT` | `2223` | SSH port for the spare QEMU VM |
| `QEMU_BIN` | `qemu-system-x86_64` | QEMU binary |
| `QEMU_MEM` | `512M` | VM memory |
| `QEMU_CPUS` | `1` | VM CPU count |

## Architecture

```
Browser (xterm.js)
  └─ WebSocket /ws
       └─ src/server.ts  (Express + ws)
            ├─ src/connection-handler.ts  (per-WS message dispatch)
            ├─ src/tab-registry.ts        (tab state + 32 KiB output buffers)
            └─ src/vm.ts  VMManager
                 ├─ VMInstance (active)   vm/work.img  on SSH_PORT
                 ├─ VMInstance (spare)    vm/spare.img on SSH_SPARE_PORT
                 ├─ Watchdog             (SSH health checks every 15 s)
                 └─ TabSession per tab   (ssh2 SSH PTY)
```

Each browser tab gets an independent SSH PTY shell into the same VM, so all tabs share the OS and filesystem.

**Hot-spare failover** — a second QEMU boots in the background. On reset, the spare is promoted instantly (zero downtime if ready); then a fresh spare starts. Falls back to a cold boot if the spare isn't ready yet.

**Health monitoring** — the watchdog runs `echo ok` over SSH every 15 seconds; 3 consecutive failures trigger a reset. QEMU stdout is also watched for `Kernel panic` / `EXT4-fs error` patterns, which trigger an immediate reset.

**VM images** (stored in `vm/`, not committed):

| File | Purpose |
|---|---|
| `vm/base.img` | Clean reference image (built by `create-image.sh`) |
| `vm/work.img` | Active VM disk (fresh copy of `base.img` on each reset) |
| `vm/spare.img` | Spare VM disk (copy of `base.img` when spare boots) |

## Browser keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+T` | New terminal tab |
| `Ctrl+W` | Close current tab |
| `Ctrl+Tab` | Next tab |
