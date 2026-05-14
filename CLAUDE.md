# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
npm start          # run the server (node src/server.js)
npm run dev        # run with nodemon (auto-restart on changes)

# Docker (production)
docker compose up --build   # build image + start container
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
       └─ src/server.js  (Express + ws)
            └─ src/vm.js  VMManager
                 ├─ active QEMU process  (vm/work.img, SSH on SSH_PORT)
                 ├─ spare QEMU process   (vm/spare.img, SSH on SSH_SPARE_PORT)
                 └─ TabSession per browser tab  (ssh2 SSH PTY)
```

**`src/vm.js` — `VMManager` (singleton)**
- Manages two QEMU instances: *active* (serves users) and *spare* (pre-booted in background).
- Hot-spare failover: on reset, spare is promoted instantly (swap ports, emit `ready`), then a fresh spare boots. Falls back to cold boot if spare isn't ready.
- SSH watchdog runs `echo ok` via ssh exec every 15 s; 3 consecutive failures trigger `vm.reset()`.
- Watches QEMU stdout for `Kernel panic` / `EXT4-fs error` → immediate reset.
- Emits: `ready`, `reset`, `error`, `spare` (state: `'booting'|'ready'|'none'`).
- Public: `vm.start()`, `vm.stop()`, `vm.reset()`, `vm.isReady`, `vm.spareStatus`, `vm.requestSpare()`, `vm.openTab(id)` → `TabSession`.

**`src/server.js` — HTTP/WebSocket server**
- Serves `public/` statically and upgrades `/ws` to WebSocket.
- Maintains a `tabRegistry`: `tabId → { session, outputBuffer (32 KiB replay), subscribers }`.
- WS message protocol (browser → server): `tab:open`, `tab:close`, `tab:select`, `input`, `resize`, `spare:request`, `spare:load`.
- WS message protocol (server → browser): `vm:status`, `vm:spare`, `tab:list`, `tab:opened`, `tab:closed`, `output` (base64), `info`.
- On `vm.on('reset')`: closes all `TabSession`s, clears output buffers, sends `vm:status: resetting`.
- On `vm.on('ready')`: reopens SSH sessions for any tabs that existed during reset.

**`src/filter.js`**
- `isBlocked(data)` returns `true` for fork bomb patterns. Ctrl-A bytes (QEMU monitor escape) are stripped byte-level in `server.js` before calling `filter`.

**`public/index.html`**
- Single-page client: xterm.js terminal + multi-tab bar + spare status button.
- Decodes `output` messages from base64 before writing to xterm.
- Auto-reconnects WebSocket on disconnect.

**`scripts/create-image.sh`**
- Creates `vm/base.img`: a 2 GiB raw Debian bookworm disk image with OpenSSH (`PermitRootLogin yes`, blank root password), GRUB bootloader, installed via `debootstrap` into a loop device.
- Must run as root (needs `losetup`, `sfdisk`, `mkfs.ext4`, `grub-bios-setup`).
- Docker `CMD` runs it automatically if `vm/base.img` is missing.

**VM image files** (in `vm/` volume, not in repo):
- `base.img` — clean read-only reference image
- `work.img` — active VM disk (copied from `base.img` on each reset)
- `spare.img` — spare VM disk (copied from `base.img` when spare boots)
