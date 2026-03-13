FROM node:20-slim

# Install QEMU, debootstrap, and build tools.
# - debootstrap: bootstrap Debian root filesystem directly (no live ISO needed)
# - fdisk: provides sfdisk for partitioning loop devices
# - e2fsprogs: provides mkfs.ext4
# - mount: mount(8) and umount(8)
# - grub-pc-bin: provides grub-mkimage + grub-bios-setup (host-side tools only)
# - grub-common: shared GRUB files (grub-mkimage dependency)
# NOTE: grub-pc (the bootloader target package) is intentionally excluded —
#       it is only needed inside the VM image, where debootstrap installs it.
# - build-essential/python3: needed for ssh2's optional native module cpu-features
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        qemu-system-x86 \
        qemu-utils \
        wget \
        ca-certificates \
        openssl \
        debootstrap \
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

# Expose HTTP and HTTPS ports
EXPOSE 80
EXPOSE 443

# vm/ directory must be mounted as a volume so the base image persists.
VOLUME ["/app/vm"]

# Entrypoint: (1) build the base VM image if missing, (2) generate a
# self-signed TLS cert if GENERATE_SELF_SIGNED_CERT=true and the cert files
# don't already exist, then (3) start the server.
CMD bash -c "\
  [ -f vm/base.img ] || bash scripts/create-image.sh; \
  if [ \"\${GENERATE_SELF_SIGNED_CERT:-false}\" = 'true' ] \
     && [ -n \"\${SSL_CERT}\" ] && [ -n \"\${SSL_KEY}\" ] \
     && [ ! -f \"\${SSL_CERT}\" ]; then \
    mkdir -p \"\$(dirname \${SSL_CERT})\"; \
    openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
      -keyout \"\${SSL_KEY}\" -out \"\${SSL_CERT}\" \
      -subj '/CN=democratic-linux' \
      -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1'; \
    echo '[SSL] Self-signed certificate generated.'; \
  fi; \
  node src/server.js"
