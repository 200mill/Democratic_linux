# Democratic Linux

WebSocket + Web terminal emulator backed by a shared QEMU Linux VM.

접속하는 누구나 `sudo` 명령어를 사용할 수 있으며, 일부 위험한 명령어는 필터링됩니다.
VM 이미지가 손상되면 자동으로 초기 상태로 재시작됩니다.

---

## Quickstart

### Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 18+ | [nodejs.org](https://nodejs.org) |
| QEMU | any recent | `qemu-system-x86_64` must be in `PATH` |
| qemu-img | same package as QEMU | used to create the disk image |
| wget | any | used by the image creation script |
| mtools | any | `mcopy` used by the image creation script |
| bash | 4+ | for the setup script |

**Linux (Debian/Ubuntu):**
```bash
sudo apt install qemu-system-x86 qemu-utils wget mtools
```

**macOS (Homebrew):**
```bash
brew install qemu wget mtools
```

**Windows:** Use Docker (see below) or WSL2 with the Linux instructions above.

---

### Option A – Run directly (Linux / macOS / WSL2)

```bash
# 1. Clone and enter the project
git clone <repo-url> democratic-linux
cd democratic-linux

# 2. Install Node dependencies
npm install

# 3. Build the base Alpine Linux image  (~2–5 min, one-time)
bash scripts/create-image.sh

# 4. Start the server
npm start
```

Open **http://localhost:3000** in your browser.

---

### Option B – Docker Compose (recommended for Windows / servers)

```bash
# 1. Clone the project
git clone <repo-url> democratic-linux
cd democratic-linux

# 2. Build and start
docker compose up --build
```

The first run will download Alpine Linux and build the base image automatically.
Open **http://localhost:3000** once you see `Democratic Linux running at http://localhost:3000`.

---

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP / WebSocket listen port |
| `QEMU_BIN` | `qemu-system-x86_64` | Path to the QEMU binary |
| `QEMU_MEM` | `256M` | VM memory |
| `QEMU_CPUS` | `1` | VM virtual CPU count |

```bash
# Example: more memory, custom port
PORT=8080 QEMU_MEM=512M npm start
```

---

## Architecture

```
Browser (xterm.js)
      │  WebSocket /ws
      ▼
 server.js  (Express + ws)
      │  TCP 127.0.0.1:4444
      ▼
  QEMU VM  (Alpine Linux, serial console)
```

- All connected browsers **share one terminal session** (broadcast model).
- Input from any browser is forwarded to the VM; VM output is broadcast to every browser.
- On every boot, `vm/base.qcow2` is copied to `vm/work.qcow2` so the VM always starts clean.
- If QEMU exits unexpectedly, the VM manager automatically resets and relaunches after 3 s.

---

## Command Filtering

Dangerous inputs are dropped before reaching the VM:

| What is blocked | Why |
|---|---|
| `Ctrl-A` byte (0x01) | Prevents QEMU monitor escape sequence takeover |
| Fork bomb pattern `:(){:|:&};:` | Prevents DoS |

Everything else — including `rm -rf /`, `mkfs`, `dd` — is **intentionally allowed**.
The VM resets to a clean state on every restart, so destruction is temporary.

To add more blocked patterns, edit `src/filter.js`:

```js
const BLOCKED_PATTERNS = [
  /:\(\)\s*\{\s*:|&\s*\}/,   // fork bomb
  // add your own RegExp here
];

const BLOCKED_SUBSTRINGS = [
  // 'shutdown', 'reboot',   // uncomment to block these
];
```

---

## VM Reset

The VM resets automatically whenever:
- QEMU process exits (crash, `poweroff`, `reboot` from inside the VM, etc.)

On reset:
1. `vm/base.qcow2` is copied fresh to `vm/work.qcow2`.
2. QEMU is relaunched.
3. All connected browsers receive a yellow banner: *VM is resetting, please wait…*

To **rebuild the base image** from scratch:
```bash
rm vm/base.qcow2
bash scripts/create-image.sh
```

---

## Project Structure

```
democratic-linux/
├── src/
│   ├── server.js       # HTTP + WebSocket server (entry point)
│   ├── vm.js           # QEMU process manager (start / auto-reset)
│   └── filter.js       # Input filter (fork bombs, Ctrl-A, etc.)
├── public/
│   └── index.html      # xterm.js web terminal frontend
├── scripts/
│   └── create-image.sh # One-time Alpine Linux image builder
├── vm/                 # base.qcow2 lives here (git-ignored)
├── package.json
├── Dockerfile
└── docker-compose.yml
```