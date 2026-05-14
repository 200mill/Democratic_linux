# Democratic Linux

Democratic Linux is a shared web terminal backed by a QEMU Linux VM.

Users open a browser, get an xterm.js terminal, and interact with a Debian VM
through WebSocket messages handled by a Node.js server. Every browser tab gets
its own SSH PTY shell, but all shells run inside the same VM and share the same
filesystem and operating system.

The VM is intentionally disposable. Each boot starts from `vm/base.img`, so
destructive commands are temporary and the VM can be reset back to a clean
state.

## Features

- Browser terminal UI powered by xterm.js
- Multiple terminal tabs per browser
- Shared QEMU VM for all connected users
- One SSH PTY session per tab
- Automatic VM reset when QEMU exits or the guest becomes unhealthy
- Hot-spare VM support for faster failover
- Optional HTTPS with user-provided or Docker-generated self-signed certs
- Minimal input filtering for the worst abuse patterns

## Requirements

### Direct host run

Direct image creation is designed for Linux or WSL2 because it uses loop
devices, mounts, `debootstrap`, and GRUB tooling.

| Tool | Notes |
| --- | --- |
| Node.js 18+ | Runs the web server |
| QEMU | Provides `qemu-system-x86_64` |
| qemu-utils | Provides QEMU image utilities |
| debootstrap | Builds the Debian root filesystem |
| grub-pc-bin, grub-common | Installs the bootloader into the VM image |
| fdisk, e2fsprogs, mount | Partitioning, ext4, loop mount support |
| bash | Runs the image creation script |

On Debian or Ubuntu:

```bash
sudo apt install qemu-system-x86 qemu-utils debootstrap grub-pc-bin grub-common fdisk e2fsprogs util-linux
```

### Docker run

Docker Compose is the easiest way to run the project on machines where the host
has Docker and supports privileged containers. The image build happens inside
the container and `vm/base.img` is kept in a Docker volume.

## Quickstart

### Option A: Docker Compose

```bash
git clone <repo-url> democratic-linux
cd democratic-linux
docker compose up --build
```

By default Docker exposes:

- HTTP: `http://localhost`
- HTTPS: `https://localhost` when TLS is configured

The first run creates `vm/base.img` automatically inside the `vm-data` volume.
That can take several minutes.

### Option B: Direct run on Linux or WSL2

```bash
git clone <repo-url> democratic-linux
cd democratic-linux
npm install
sudo bash scripts/create-image.sh
npm run build
HTTP_PORT=3000 npm start
```

Open `http://localhost:3000`.

For development without compiling first:

```bash
HTTP_PORT=3000 npm run dev
```

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `HTTP_PORT` | `80` | HTTP and WebSocket listen port |
| `PORT` | unset | Legacy alias used when `HTTP_PORT` is not set |
| `HTTPS_PORT` | `443` | HTTPS and WSS listen port |
| `SSL_CERT` | unset | Path to TLS certificate PEM |
| `SSL_KEY` | unset | Path to TLS private key PEM |
| `GENERATE_SELF_SIGNED_CERT` | `false` | Docker entrypoint can generate a local self-signed cert when cert paths are set |
| `QEMU_BIN` | `qemu-system-x86_64` | QEMU executable |
| `QEMU_MEM` | `512M` | VM memory |
| `QEMU_CPUS` | `1` | VM virtual CPU count |
| `SSH_PORT` | `2222` | Host port forwarded to the active VM's SSH port 22 |
| `SSH_SPARE_PORT` | `2223` | Host port forwarded to the spare VM's SSH port 22 |

Example:

```bash
HTTP_PORT=8080 QEMU_MEM=1G QEMU_CPUS=2 npm start
```

## Architecture

```text
Browser terminal (xterm.js)
  |
  | WebSocket /ws
  v
Node server (Express + ws)
  |
  | SSH PTY per browser tab
  v
QEMU VM (Debian bookworm, OpenSSH)
```

The "democratic" part is that users share one VM. Each tab has independent shell
state, history, working directory, and processes, but every tab sees the same
guest OS and disk contents.

## VM Lifecycle

`scripts/create-image.sh` creates a 2 GiB raw disk image at `vm/base.img`.
The image contains Debian bookworm, OpenSSH, sudo, a blank root password, and
passwordless sudo.

At runtime:

1. The active VM starts from a fresh copy of `vm/base.img` as `vm/work.img`.
2. The server waits until SSH accepts connections.
3. Browser tabs open SSH PTY sessions into the active VM.
4. A spare VM is warmed in the background as `vm/spare.img`.
5. If the active VM exits, panics, or fails repeated SSH health checks, the
   manager resets it.
6. If the spare VM is ready, it is promoted immediately. Otherwise a cold boot
   starts from a fresh copy of `vm/base.img`.

To rebuild the base image:

```bash
rm -f vm/base.img vm/work.img vm/spare.img
sudo bash scripts/create-image.sh
```

## Command Filtering

Input is intentionally permissive because the VM is disposable. Users can run
destructive guest commands such as `rm -rf /`, `mkfs`, or `dd`; the damage is
confined to the temporary VM copy.

The server currently blocks:

| Blocked input | Reason |
| --- | --- |
| Ctrl-A byte (`0x01`) | Prevents QEMU control escape abuse |
| Fork bomb pattern `:(){:|:&};:` | Prevents obvious CPU/process exhaustion |

To change filtering rules, edit `src/filter.ts` and rebuild, or edit
`src/filter.js` if you are running the JavaScript source directly.

## Project Structure

```text
democratic-linux/
|-- src/
|   |-- server.ts       # HTTP, HTTPS, WebSocket, tab registry
|   |-- vm.ts           # QEMU lifecycle, SSH PTY sessions, hot spare
|   `-- filter.ts       # Input filter
|-- public/
|   `-- index.html      # xterm.js browser UI
|-- scripts/
|   `-- create-image.sh # Debian VM image builder
|-- vm/                 # Runtime VM images: base.img, work.img, spare.img
|-- package.json
|-- Dockerfile
`-- docker-compose.yml
```

## Notes

- `npm start` runs `dist/server.js`, so run `npm run build` first.
- Docker starts `node src/server.js` directly and does not require a TypeScript
  build step.
- The repository currently contains both TypeScript and JavaScript sources.
  Keep them in sync if you change runtime behavior.
- The `vm/` directory is for VM image state. Large runtime images should not be
  committed.
