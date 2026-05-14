# Democratic Linux — Core Idea & Implementation

## Core Idea

A **shared, disposable Linux VM accessible from any browser**. Multiple users connect to the same QEMU Debian VM via a web terminal (xterm.js). Everyone sees and shares the same filesystem — the "democratic" part. Because it's intentionally ephemeral, destructive commands like `rm -rf /` are harmless: the VM auto-resets to a clean image on any failure.

---

## Architecture

```
Browser (xterm.js)
  └─ WebSocket /ws
       └─ Node.js server (Express + ws)
            └─ SSH PTY per tab  (ssh2 library)
                 └─ QEMU Debian VM
```

**Key design decisions:**

| Concern | Approach |
|---|---|
| Multi-user terminal | Each browser tab = one independent SSH PTY shell, all into the same VM |
| Shared state | One QEMU process, one filesystem — all tabs share OS and disk |
| Disposability | On reset, `base.img` is copied fresh to `work.img`; destructive changes vanish |
| Fast recovery | **Hot-spare model**: a second QEMU boots in background (`spare.img`). On failure, spare is promoted instantly — no cold-boot wait |
| Health monitoring | SSH watchdog runs `echo ok` via exec every 15s; 3 consecutive failures trigger reset |
| Fault detection | QEMU stdout is watched for `Kernel panic`, `EXT4-fs error`, etc. — triggers immediate reset |
| Input safety | Blocks Ctrl-A (QEMU monitor escape) and fork bombs; everything else is allowed (VM is throwaway) |

---

## Key Components

- **`src/vm.ts`** — `VMManager` (singleton): manages `VMInstance` for active + spare QEMU processes, watchdog, failover logic, and `TabSession` (one SSH PTY per browser tab)
- **`src/server.ts`** — Express HTTP + WebSocket server; routes each tab's WS messages to its `TabSession`; broadcasts VM events back to browsers
- **`src/filter.ts`** — Minimal input filter: strips Ctrl-A bytes, blocks fork bomb pattern
- **`public/index.html`** — Single-page browser client: xterm.js terminal, auto-reconnecting WebSocket, base64 output decoding
- **`scripts/create-image.sh`** — Builds the base Debian image via `debootstrap` + GRUB + OpenSSH with blank root password
