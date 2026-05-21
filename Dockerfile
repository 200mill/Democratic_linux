FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY public/ ./public/
COPY scripts/ ./scripts/
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       qemu-system-x86 debootstrap \
    && rm -rf /var/lib/apt/lists/*
VOLUME ["/app/vm"]
CMD ["sh", "-c", "[ -f vm/base.img ] || bash scripts/create-image.sh && exec node dist/server.js"]
