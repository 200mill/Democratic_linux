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
# losetup (loop device), then convert to qcow2.  The root partition is
# accessed by mounting a *second* loop device at the explicit sector offset,
# since kernel auto-creation of /dev/loopNpM is unreliable in containers.
#
# Produces vm/base.img – a bootable Debian bookworm image (raw format) with:
#   - openssh-server running at boot
#   - PermitRootLogin yes + PermitEmptyPasswords yes
#   - Blank root password
#   - sudo available to all users with no password

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
VM_DIR="$PROJECT_DIR/vm"
BASE_IMAGE="$VM_DIR/base.img"
RAW_IMAGE="$VM_DIR/base.img"   # We write directly to base.img (raw format)
DISK_SIZE_BYTES=$((2 * 1024 * 1024 * 1024))   # 2 GiB (kernel+sshd+grub ~900 MiB)
# Using raw format directly avoids the qemu-img conversion step that would
# require ~3 GiB of temporary disk space (raw + qcow2 simultaneously).
DEBIAN_SUITE="bookworm"
DEBIAN_MIRROR="https://deb.debian.org/debian"

# Partition layout (512-byte sectors):
#   p1: start=2048  size=4096  (2 MiB – tiny boot flag partition)
#   p2: start=6144  size=rest  (root)
SECTOR_SIZE=512
P2_START_SECTOR=6144
P2_OFFSET=$(( P2_START_SECTOR * SECTOR_SIZE ))

mkdir -p "$VM_DIR"

# Remove any leftover raw image from a previous failed run
rm -f "$RAW_IMAGE"

# ── 1. Create blank raw disk image ───────────────────────────────────────────
echo "[create-image] Creating blank 2G raw disk image…"
truncate -s "$DISK_SIZE_BYTES" "$RAW_IMAGE"

# ── 2. Attach whole disk to loop device ──────────────────────────────────────
echo "[create-image] Attaching whole disk to loop device…"
LOOP_WHOLE="$(losetup --find --show "$RAW_IMAGE")"
echo "[create-image] Whole-disk loop: $LOOP_WHOLE"

LOOP_ROOT=""   # will be set after partitioning

cleanup() {
  echo "[create-image] Cleaning up…"
  umount /mnt/proc    2>/dev/null || true
  umount /mnt/sys     2>/dev/null || true
  umount /mnt/dev/pts 2>/dev/null || true
  umount /mnt/dev     2>/dev/null || true
  umount /mnt         2>/dev/null || true
  [[ -n "${LOOP_ROOT:-}" ]] && losetup -d "$LOOP_ROOT" 2>/dev/null || true
  losetup -d "$LOOP_WHOLE" 2>/dev/null || true
  # Remove the partially-written image only if it exists and is incomplete
  # (i.e. we didn't reach the trap-disable line at the end of the script).
  rm -f "$BASE_IMAGE"
}
trap cleanup EXIT

# ── 3. Partition the disk ─────────────────────────────────────────────────────
# MBR layout:
#   p1 – 2 MiB  – bootable flag (GRUB writes to MBR/gap, not this partition)
#   p2 – rest   – ext4 root
echo "[create-image] Partitioning ${LOOP_WHOLE}…"
sfdisk "$LOOP_WHOLE" <<SFDISK_EOF
label: dos
unit: sectors

p1 : start=2048, size=4096, type=83, bootable
p2 : start=${P2_START_SECTOR}, type=83
SFDISK_EOF

# ── 4. Attach root partition via explicit offset ──────────────────────────────
echo "[create-image] Attaching root partition at offset ${P2_OFFSET}…"
LOOP_ROOT="$(losetup --find --show --offset "$P2_OFFSET" "$RAW_IMAGE")"
echo "[create-image] Root partition loop: $LOOP_ROOT"

# ── 5. Format root partition ─────────────────────────────────────────────────
echo "[create-image] Formatting root partition (ext4)…"
mkfs.ext4 -L root -q "$LOOP_ROOT"

# ── 6. Mount and debootstrap ─────────────────────────────────────────────────
echo "[create-image] Mounting root partition…"
mkdir -p /mnt
mount "$LOOP_ROOT" /mnt

echo "[create-image] Running debootstrap (this may take several minutes)…"
# Pre-create policy-rc.d BEFORE debootstrap second stage so dpkg never starts
# services (systemd, sshd, etc.) inside the container during package configure.
# This prevents the "Failed to connect to bus" errors from systemd postinsts.
mkdir -p /mnt/usr/sbin
cat > /mnt/usr/sbin/policy-rc.d <<'POLICY_EOF'
#!/bin/sh
exit 101
POLICY_EOF
chmod +x /mnt/usr/sbin/policy-rc.d

# Prevent interactive prompts from blocking debootstrap
export DEBIAN_FRONTEND=noninteractive

debootstrap \
  --arch=amd64 \
  --include=openssh-server,sudo,bash,locales,ca-certificates,linux-image-amd64,grub-pc \
  "$DEBIAN_SUITE" \
  /mnt \
  "$DEBIAN_MIRROR"

# ── 7. Configure the installed system ────────────────────────────────────────
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
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin yes/'               /mnt/etc/ssh/sshd_config
sed -i 's/^#*PermitEmptyPasswords.*/PermitEmptyPasswords yes/'     /mnt/etc/ssh/sshd_config
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

# ── 8. Install GRUB ──────────────────────────────────────────────────────────
echo "[create-image] Installing GRUB bootloader…"

# We bypass grub-install entirely because it embeds a UUID-based "search"
# command into core.img which fails at boot (the UUID it records is from the
# loop device, which differs from what QEMU's virtio disk reports as hd0).
#
# Instead we:
#  1. grub-mkimage: build core.img with a hard-coded (hd0,msdos2) prefix
#     and embed a tiny early config that skips all UUID probing.
#  2. Copy modules + grub.cfg into /mnt/boot/grub/
#  3. grub-bios-setup: embed boot.img into MBR and patch sector addresses.
#
# This produces a bootloader that references (hd0,msdos2) directly, with no
# UUID search at any stage.

# Create the early grub config to embed into core.img.
# This sets root=(hd0,msdos2) before any script is loaded, so even if the
# normal config search fails we still know where the root is.
EARLY_CFG=$(mktemp)
cat > "$EARLY_CFG" <<'EARLYCFG_EOF'
set root=(hd0,msdos2)
set prefix=(hd0,msdos2)/boot/grub
EARLYCFG_EOF

mkdir -p /mnt/boot/grub/i386-pc

# Copy all i386-pc modules to the image so grub can load them at runtime.
# boot.img is also required by grub-bios-setup in the --directory path.
cp /usr/lib/grub/i386-pc/boot.img /mnt/boot/grub/i386-pc/
cp /usr/lib/grub/i386-pc/*.mod  /mnt/boot/grub/i386-pc/ 2>/dev/null || true
cp /usr/lib/grub/i386-pc/*.lst  /mnt/boot/grub/i386-pc/ 2>/dev/null || true

# Build core.img with the modules needed for a basic boot.
# biosdisk+part_msdos+ext2: read the disk/partition/filesystem
# linux+normal: load kernel and run grub.cfg
# --prefix is baked into core.img so GRUB knows where to find its files.
grub-mkimage \
  --directory /usr/lib/grub/i386-pc \
  --output /mnt/boot/grub/i386-pc/core.img \
  --format i386-pc \
  --prefix '(hd0,msdos2)/boot/grub' \
  --config "$EARLY_CFG" \
  biosdisk part_msdos ext2 linux normal configfile echo ls

rm -f "$EARLY_CFG"
echo "[create-image] grub-mkimage done."

# Use grub-bios-setup to:
#   - Write boot.img (the 512-byte MBR loader) to sector 0 of the loop device
#   - Patch boot.img with the sector address of core.img (from the gap between
#     p1 end and p2 start — the "BIOS boot area")
#   - Embed core.img into the MBR gap (sectors 1–62) or just after boot.img
#
# --directory: where to find boot.img and core.img
# $LOOP_WHOLE:  the raw loop device for the whole disk

grub-bios-setup \
  --directory /mnt/boot/grub/i386-pc \
  --skip-fs-probe \
  "$LOOP_WHOLE"

echo "[create-image] grub-bios-setup completed."

# ── Generate grub.cfg manually (bypass update-grub) ────────────────────────
# update-grub emits "search --fs-uuid <loop-uuid>" which causes GRUB rescue at
# boot time because the UUID recorded is from the loop device, and while the
# underlying ext4 UUID is the same, GRUB's search command fails in TCG QEMU
# before the virtio disk is fully probed.  Writing grub.cfg directly lets us
# reference (hd0,msdos2) / /dev/vda2 without any UUID lookup.

# Find the kernel and initrd filenames installed by debootstrap
VMLINUZ=$(ls /mnt/boot/vmlinuz-* 2>/dev/null | sort -V | tail -1)
INITRD=$(ls /mnt/boot/initrd.img-* 2>/dev/null | sort -V | tail -1)
VMLINUZ_NAME="$(basename "$VMLINUZ")"
INITRD_NAME="$(basename "$INITRD")"
echo "[create-image] Kernel: $VMLINUZ_NAME   Initrd: $INITRD_NAME"

mkdir -p /mnt/boot/grub
cat > /mnt/boot/grub/grub.cfg <<GRUBCFG_EOF
set default=0
set timeout=1

# Serial + console terminal (so Node.js sees output via QEMU -nographic)
serial --speed=115200 --unit=0 --word=8 --parity=no --stop=1
terminal_input  serial console
terminal_output serial console

menuentry "Democratic Linux" {
  set root=(hd0,msdos2)
  linux  /boot/${VMLINUZ_NAME} root=/dev/vda2 ro quiet console=ttyS0,115200n8 console=tty0
  initrd /boot/${INITRD_NAME}
}
GRUBCFG_EOF

echo "[create-image] grub.cfg written (no UUID search)."

# ── 9. Unmount cleanly ────────────────────────────────────────────────────────
echo "[create-image] Unmounting…"
umount /mnt/proc
umount /mnt/sys
umount /mnt/dev/pts
umount /mnt/dev
umount /mnt

losetup -d "$LOOP_ROOT"; LOOP_ROOT=""
losetup -d "$LOOP_WHOLE"
trap - EXIT   # disable cleanup trap – done

echo ""
echo "[create-image] ✓ Base image created: $BASE_IMAGE"
echo "[create-image]   $(du -h "$BASE_IMAGE" | cut -f1) on disk."
echo "[create-image] Start the server with:  npm start"
