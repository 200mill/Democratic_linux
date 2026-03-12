#!/usr/bin/env bash
# scripts/create-image.sh
#
# Creates the base QEMU disk image for Democratic Linux.
#
# Requirements (installed in Docker image):
#   - qemu-img   (qemu-utils)
#   - debootstrap
#   - grub-pc-bin, grub-common
#   - util-linux (losetup, sfdisk, mkfs.ext4)
#
# Strategy: debootstrap Debian bookworm into a raw image file mounted via
# losetup (loop device), then convert to qcow2. No qemu-nbd / nbd module
# needed; loop devices are always available in privileged containers.
#
# Produces vm/base.qcow2 – a bootable Debian bookworm image with:
#   - openssh-server running at boot
#   - PermitRootLogin yes + PermitEmptyPasswords yes
#   - Blank root password
#   - sudo available to all users with no password

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
VM_DIR="$PROJECT_DIR/vm"
BASE_IMAGE="$VM_DIR/base.qcow2"
RAW_IMAGE="$VM_DIR/base.raw"
DISK_SIZE_BYTES=$((4 * 1024 * 1024 * 1024))   # 4 GiB
DEBIAN_SUITE="bookworm"
DEBIAN_MIRROR="https://deb.debian.org/debian"

mkdir -p "$VM_DIR"

# ── 1. Create blank raw disk image ───────────────────────────────────────────
echo "[create-image] Creating blank 4G raw disk image…"
truncate -s "$DISK_SIZE_BYTES" "$RAW_IMAGE"

# ── 2. Attach to a loop device ───────────────────────────────────────────────
echo "[create-image] Attaching image to loop device…"
LOOP_DEV="$(losetup --find --show --partscan "$RAW_IMAGE")"
echo "[create-image] Using loop device: $LOOP_DEV"

cleanup() {
  echo "[create-image] Cleaning up…"
  umount /mnt/proc    2>/dev/null || true
  umount /mnt/sys     2>/dev/null || true
  umount /mnt/dev/pts 2>/dev/null || true
  umount /mnt/dev     2>/dev/null || true
  umount /mnt         2>/dev/null || true
  losetup -d "$LOOP_DEV" 2>/dev/null || true
  rm -f "$RAW_IMAGE"
}
trap cleanup EXIT

# ── 3. Partition the disk ─────────────────────────────────────────────────────
# MBR layout:
#   p1 – small (2 MiB)  – boot marker (not used by GRUB directly, just a flag)
#   p2 – rest           – ext4 root
echo "[create-image] Partitioning ${LOOP_DEV}…"
sfdisk "$LOOP_DEV" <<'SFDISK_EOF'
label: dos
unit: sectors

p1 : start=2048, size=4096, type=83, bootable
p2 : start=6144, type=83
SFDISK_EOF

# Wait for the kernel to re-read partitions
partprobe "$LOOP_DEV" 2>/dev/null || true
sleep 1

ROOT_PART="${LOOP_DEV}p2"

# ── 4. Format root partition ─────────────────────────────────────────────────
echo "[create-image] Formatting root partition…"
mkfs.ext4 -L root -q "$ROOT_PART"

# ── 5. Mount and debootstrap ─────────────────────────────────────────────────
echo "[create-image] Mounting root partition…"
mount "$ROOT_PART" /mnt

echo "[create-image] Running debootstrap (this may take several minutes)…"
debootstrap \
  --arch=amd64 \
  --include=openssh-server,sudo,bash,locales,ca-certificates \
  "$DEBIAN_SUITE" \
  /mnt \
  "$DEBIAN_MIRROR"

# ── 6. Configure the installed system ────────────────────────────────────────
echo "[create-image] Configuring Debian system…"

# Bind-mount kernel filesystems for chroot tools.
mount --bind /proc    /mnt/proc
mount --bind /sys     /mnt/sys
mount --bind /dev     /mnt/dev
mount --bind /dev/pts /mnt/dev/pts

# fstab (root is /dev/vda2 in QEMU with virtio-blk)
cat > /mnt/etc/fstab <<'FSTAB_EOF'
/dev/vda2  /     ext4  errors=remount-ro  0  1
proc       /proc proc  defaults           0  0
FSTAB_EOF

# Hostname
echo "democratic-linux" > /mnt/etc/hostname
cat > /mnt/etc/hosts <<'HOSTS_EOF'
127.0.0.1  localhost
127.0.1.1  democratic-linux
HOSTS_EOF

# Locale
echo "en_US.UTF-8 UTF-8" >> /mnt/etc/locale.gen
chroot /mnt locale-gen

# Blank root password (passwd -d)
chroot /mnt passwd -d root

# sshd: allow root login with empty password
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin yes/'             /mnt/etc/ssh/sshd_config
sed -i 's/^#*PermitEmptyPasswords.*/PermitEmptyPasswords yes/'   /mnt/etc/ssh/sshd_config
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication yes/' /mnt/etc/ssh/sshd_config

# sudoers: passwordless sudo for everyone
echo "ALL ALL=(ALL) NOPASSWD: ALL" >> /mnt/etc/sudoers

# Network: systemd-networkd DHCP on all ethernet interfaces (en*)
mkdir -p /mnt/etc/systemd/network
cat > /mnt/etc/systemd/network/20-dhcp.network <<'NET_EOF'
[Match]
Name=en*

[Network]
DHCP=yes
NET_EOF

chroot /mnt systemctl enable systemd-networkd
chroot /mnt systemctl enable systemd-resolved 2>/dev/null || true

# ── 7. Install GRUB ──────────────────────────────────────────────────────────
echo "[create-image] Installing GRUB bootloader…"

# Make the loop device accessible inside the chroot for grub-install
LOOP_MINOR="$(stat -c '%T' "$LOOP_DEV")"
LOOP_MINOR_DEC=$((16#$LOOP_MINOR))
if [[ ! -b "/mnt/dev/$(basename "$LOOP_DEV")" ]]; then
  mknod "/mnt/dev/$(basename "$LOOP_DEV")" b 7 "$LOOP_MINOR_DEC" 2>/dev/null || true
fi

chroot /mnt grub-install \
  --target=i386-pc \
  --recheck \
  --force \
  "$LOOP_DEV"

# GRUB config: use serial console (ttyS0) so Node can see output
cat > /mnt/etc/default/grub <<'GRUB_EOF'
GRUB_DEFAULT=0
GRUB_TIMEOUT=1
GRUB_CMDLINE_LINUX_DEFAULT="quiet"
GRUB_CMDLINE_LINUX="console=ttyS0,115200n8 console=tty0"
GRUB_TERMINAL="console serial"
GRUB_SERIAL_COMMAND="serial --speed=115200 --unit=0 --word=8 --parity=no --stop=1"
GRUB_DISTRIBUTOR="Democratic Linux"
GRUB_EOF

chroot /mnt update-grub

# ── 8. Unmount cleanly ────────────────────────────────────────────────────────
echo "[create-image] Unmounting…"
umount /mnt/proc
umount /mnt/sys
umount /mnt/dev/pts
umount /mnt/dev
umount /mnt

losetup -d "$LOOP_DEV"
trap - EXIT   # disable cleanup trap – we'll do the final step manually

# ── 9. Convert raw → qcow2 ───────────────────────────────────────────────────
echo "[create-image] Converting raw image to qcow2…"
qemu-img convert -f raw -O qcow2 "$RAW_IMAGE" "$BASE_IMAGE"
rm -f "$RAW_IMAGE"

echo ""
echo "[create-image] ✓ Base image created: $BASE_IMAGE"
echo "[create-image]   $(du -h "$BASE_IMAGE" | cut -f1) on disk."
echo "[create-image] Start the server with:  npm start"
