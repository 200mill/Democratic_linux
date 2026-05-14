/**
 * Democratic Linux – WebSocket + Web terminal server
 *
 * Architecture:
 *   Browser  ──WS──►  server.ts  ──TCP serial──►  QEMU VM
 *
 * All connected browsers share one terminal session (broadcast model).
 * Input from any browser is forwarded to the VM; output from the VM is
 * broadcast to every connected browser.
 */

import * as http from 'http';
import * as path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import express from 'express';
import type { IncomingMessage } from 'http';

import vm from './vm';
import { isBlocked } from './filter';

// ── Config ───────────────────────────────────────────────────────────────────

const PORT       = process.env.PORT ?? '3000';
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

// ── Express (static files) ───────────────────────────────────────────────────

const app = express();
app.use(express.static(PUBLIC_DIR));

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer(app);

// ── WebSocket server ──────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server, path: '/ws' });

// Keep track of all connected browser clients.
const clients = new Set<WebSocket>();

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  const ip = req.socket.remoteAddress;
  console.log(`[WS] Client connected: ${ip}  (total: ${clients.size + 1})`);
  clients.add(ws);

  // Send a welcome banner so the user sees something even before the VM
  // produces output.
  ws.send(JSON.stringify({
    type: 'info',
    text: '\r\n\x1b[1;32mWelcome to Democratic Linux!\x1b[0m\r\n' +
          '\x1b[90mYou are sharing this terminal with everyone connected.\r\n' +
          'sudo is available to all users.\x1b[0m\r\n\r\n',
  }));

  ws.on('message', (raw: Buffer | string) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      // Binary / non-JSON frame – treat as raw terminal input.
      forwardToVM(raw as Buffer);
      return;
    }

    if (msg.type === 'input') {
      forwardToVM(msg.data as Buffer | string);
    } else if (msg.type === 'resize') {
      // Terminal resize – nothing to do for a raw serial connection,
      // but we could send a SIGWINCH if using PTY in future.
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[WS] Client disconnected: ${ip}  (total: ${clients.size})`);
  });

  ws.on('error', (err: Error) => {
    console.error(`[WS] Client error (${ip}):`, err.message);
    clients.delete(ws);
  });
});

// ── VM → browsers ─────────────────────────────────────────────────────────────

vm.on('data', (data: Buffer) => {
  broadcast({ type: 'output', data: data.toString('base64') });
});

vm.on('reset', () => {
  broadcast({
    type: 'info',
    text: '\r\n\x1b[1;33m[Democratic Linux] VM is resetting, please wait…\x1b[0m\r\n',
  });
});

vm.on('error', (err: Error) => {
  console.error('[VM error]', err.message);
  broadcast({
    type: 'info',
    text: `\r\n\x1b[1;31m[VM error] ${err.message}\x1b[0m\r\n`,
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Forward user input to the VM, applying the command filter first.
 */
function forwardToVM(data: Buffer | string): void {
  // Strip QEMU monitor escape sequence (Ctrl-A) to prevent takeover.
  const buf       = Buffer.isBuffer(data) ? data : Buffer.from(data as string);
  const sanitized = Buffer.from(buf.filter((byte) => byte !== 0x01 /* Ctrl-A */));

  if (isBlocked(sanitized)) {
    broadcast({
      type: 'info',
      text: '\r\n\x1b[1;31m[Blocked] That command is not allowed.\x1b[0m\r\n',
    });
    return;
  }

  vm.write(sanitized);
}

/**
 * Send a JSON message to all connected browser clients.
 */
function broadcast(msg: object): void {
  const frame = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(frame);
    }
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`[Server] Democratic Linux running at http://localhost:${PORT}`);
});

vm.start().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[Server] Failed to start VM:', message);
});
