#!/usr/bin/env bash
# scripts/create-image.sh
#
# Creates the base QEMU disk image for Democratic Linux.
#
# Requirements (must be installed on the host):
#   - qemu-system-x86_64
#   - qemu-img
#   - wget  (or curl)
#
# Usage:
#   bash scripts/create-image.sh
#
# What it does:
#   1. Downloads a tiny Alpine Linux ISO.
#   2. Creates a qcow2 disk image.
#   3. Installs Alpine in headless/serial mode using an answer file.
#   4. Configures passwordless sudo for all users.
#   5. Enables the serial console on boot.
#   6. Saves the result as vm/base.qcow2.
#
# The resulting image is ~200 MB on disk.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
VM_DIR="$PROJECT_DIR/vm"
BASE_IMAGE="$VM_DIR/base.qcow2"
DISK_SIZE="2G"
ALPINE_VERSION="3.19.1"
ALPINE_ISO="alpine-virt-${ALPINE_VERSION}-x86_64.iso"
ALPINE_URL="https://dl-cdn.alpinelinux.org/alpine/v3.19/releases/x86_64/${ALPINE_ISO}"

mkdir -p "$VM_DIR"

# ── 1. Download Alpine ISO ────────────────────────────────────────────────────
if [[ ! -f "$VM_DIR/$ALPINE_ISO" ]]; then
  echo "[create-image] Downloading Alpine Linux ${ALPINE_VERSION}…"
  wget -q --show-progress -O "$VM_DIR/$ALPINE_ISO" "$ALPINE_URL"
else
  echo "[create-image] Alpine ISO already present, skipping download."
fi

# ── 2. Create blank disk image ────────────────────────────────────────────────
echo "[create-image] Creating blank ${DISK_SIZE} qcow2 image…"
qemu-img create -f qcow2 "$BASE_IMAGE" "$DISK_SIZE"

# ── 3. Write Alpine answer file (fully automated install) ─────────────────────
ANSWER_FILE="$(mktemp)"
cat > "$ANSWER_FILE" <<'EOF'
KEYMAPOPTS="us us"
HOSTNAMEOPTS="-n democratic-linux"
INTERFACESOPTS="auto lo
iface lo inet loopback

auto eth0
iface eth0 inet dhcp
"
DNSOPTS="-d local -n 8.8.8.8"
TIMEZONEOPTS="-z UTC"
PROXYOPTS="none"
APKREPOSOPTS="-1"
SSHDOPTS="-d"
NTPOPTS="-c busybox"
DISKOPTS="-m sys /dev/vda"
EOF

# ── 4. Cloud-init / firstboot script embedded in a fat ISO ───────────────────
# We use a simpler approach: boot the installer with a kernel cmdline that
# points at the answer file via a virtual FAT disk.
SEED_DIR="$(mktemp -d)"
cp "$ANSWER_FILE" "$SEED_DIR/answers"

# Firstboot script – runs after Alpine installs; sets up sudo and serial console.
cat > "$SEED_DIR/setup.sh" <<'SETUP'
#!/bin/sh
set -e

# Enable community repo
sed -i 's|#.*community|http://dl-cdn.alpinelinux.org/alpine/v3.19/community|' /etc/apk/repositories
apk update -q

# Install sudo and bash
apk add -q sudo bash

# Allow ALL users to run ALL commands without password
echo "ALL ALL=(ALL) NOPASSWD: ALL" >> /etc/sudoers

# Make sure ttyS0 (serial) is an agetty login console
# Alpine uses OpenRC; add a ttys0 service.
echo 'ttyS0::respawn:/sbin/getty -L 115200 ttyS0 vt100' >> /etc/inittab

# Set a blank root password so login over serial works without a password
passwd -d root

echo "[setup.sh] Done."
SETUP
chmod +x "$SEED_DIR/setup.sh"

# Package the seed directory as a raw disk image so QEMU can mount it.
SEED_IMG="$(mktemp --suffix=.img)"
dd if=/dev/zero of="$SEED_IMG" bs=1M count=4 2>/dev/null
mkfs.vfat "$SEED_IMG" >/dev/null
mcopy -i "$SEED_IMG" "$SEED_DIR/answers" ::answers
mcopy -i "$SEED_IMG" "$SEED_DIR/setup.sh" ::setup.sh

# ── 5. Run QEMU to install Alpine ────────────────────────────────────────────
echo "[create-image] Installing Alpine Linux into the image (this may take a few minutes)…"

# We drive the install via the serial console.
# The Alpine virt image boots straight to a shell.
# We pipe in keystrokes to run setup-alpine and then our setup script.

INSTALL_SCRIPT="$(mktemp)"
cat > "$INSTALL_SCRIPT" <<'INST'
#!/usr/bin/expect -f
set timeout 300

spawn qemu-system-x86_64 \
  -m 512M \
  -nographic \
  -drive file=$env(BASE_IMAGE),format=qcow2,if=virtio \
  -drive file=$env(SEED_IMG),format=raw,if=virtio,readonly=on \
  -cdrom $env(ALPINE_ISO_PATH) \
  -boot d \
  -serial stdio \
  -no-reboot

# Wait for the shell prompt
expect -re {localhost:~#}
send "setup-alpine -f /dev/vdb/answers\r"
expect -re {Installation is complete}
send "mount /dev/vda3 /mnt && chroot /mnt sh /dev/vdb/setup.sh && umount /mnt\r"
expect -re {Done}
send "poweroff\r"
expect eof
INST

# Check if expect is available
if command -v expect &>/dev/null; then
  BASE_IMAGE="$BASE_IMAGE" \
  SEED_IMG="$SEED_IMG" \
  ALPINE_ISO_PATH="$VM_DIR/$ALPINE_ISO" \
  expect "$INSTALL_SCRIPT"
else
  echo ""
  echo "╔══════════════════════════════════════════════════════════════════╗"
  echo "║  'expect' is not installed.  Manual steps required:             ║"
  echo "║                                                                  ║"
  echo "║  Run the following command, then inside the VM:                 ║"
  echo "║    1. setup-alpine  (use defaults, target disk: vda)            ║"
  echo "║    2. After install: mount /dev/vda3 /mnt                       ║"
  echo "║    3. chroot /mnt sh /dev/vdb/setup.sh                          ║"
  echo "║    4. poweroff                                                   ║"
  echo "╚══════════════════════════════════════════════════════════════════╝"
  echo ""
  echo "Starting QEMU interactive install…"
  qemu-system-x86_64 \
    -m 512M \
    -nographic \
    -drive "file=$BASE_IMAGE,format=qcow2,if=virtio" \
    -drive "file=$SEED_IMG,format=raw,if=virtio,readonly=on" \
    -cdrom "$VM_DIR/$ALPINE_ISO" \
    -boot d \
    -serial stdio \
    -no-reboot || true
fi

# ── Cleanup ───────────────────────────────────────────────────────────────────
rm -f "$ANSWER_FILE" "$INSTALL_SCRIPT" "$SEED_IMG"
rm -rf "$SEED_DIR"

echo ""
echo "[create-image] Base image created at: $BASE_IMAGE"
echo "[create-image] You can now start the server with:  npm start"
