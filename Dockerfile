FROM node:20-slim

# Install QEMU, debootstrap, and build tools.
# - debootstrap: bootstrap Debian root filesystem directly (no live ISO needed)
# - fdisk: provides sfdisk for partitioning loop devices
# - e2fsprogs: provides mkfs.ext4
# - mount: mount(8) and umount(8)
# - grub-pc: provides grub-install (host-side, writes MBR + /boot/grub)
# - grub-pc-bin/grub-common: GRUB i386-pc modules and shared files
# - build-essential/python3: needed for ssh2's optional native module cpu-features
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        qemu-system-x86 \
        qemu-utils \
        wget \
        ca-certificates \
        debootstrap \
        grub-pc \
        grub-pc-bin \
        grub-common \
        build-essential \
        python3 \
        fdisk \
        e2fsprogs \
        mount \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY src/   ./src/
COPY public/ ./public/
COPY scripts/ ./scripts/
RUN chmod +x scripts/create-image.sh

# Expose the web server port
EXPOSE 3000

# vm/ directory must be mounted as a volume so the base image persists.
VOLUME ["/app/vm"]

# Entrypoint: build the base image if it doesn't exist, then start the server.
CMD bash -c "[ -f vm/base.img ] || bash scripts/create-image.sh && node src/server.js"
