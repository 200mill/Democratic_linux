FROM node:20-slim

# Install QEMU
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        qemu-system-x86 \
        qemu-utils \
        wget \
        mtools \
        expect \
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
CMD bash -c "[ -f vm/base.qcow2 ] || bash scripts/create-image.sh && node src/server.js"
