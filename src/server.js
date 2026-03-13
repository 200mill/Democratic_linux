/**
 * Democratic Linux – WebSocket + Web terminal server
 *
 * Architecture:
 *   Browser  ──WS──►  server.js  ──SSH PTY──►  QEMU VM (user-mode net, port 2222→22)
 *
 * All connected browsers share one terminal session (broadcast model).
 * Input from any browser is forwarded to the VM's SSH PTY; output is
 * broadcast to every connected browser.
 */

'use strict';

const fs     = require('fs');
const http   = require('http');
const https  = require('https');
const path   = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const express = require('express');

const vm = require('./vm');
const { isBlocked } = require('./filter');

// ── Config ───────────────────────────────────────────────────────────────────

const PORT       = process.env.PORT     || 3000;
const SSL_CERT   = process.env.SSL_CERT || '';   // path to TLS certificate (PEM)
const SSL_KEY    = process.env.SSL_KEY  || '';   // path to TLS private key (PEM)
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

// How many bytes of recent VM output to replay to newly-connected clients
// so they see the current terminal state immediately.
const OUTPUT_BUFFER_BYTES = 32 * 1024; // 32 KiB

// ── Express (static files) ───────────────────────────────────────────────────

const app = express();
app.use(express.static(PUBLIC_DIR));

// ── HTTP / HTTPS server ───────────────────────────────────────────────────────

let server;
const useSSL = SSL_CERT && SSL_KEY;

if (useSSL) {
  const tlsOptions = {
    cert: fs.readFileSync(SSL_CERT),
    key:  fs.readFileSync(SSL_KEY),
  };
  server = https.createServer(tlsOptions, app);
} else {
  server = http.createServer(app);
}

// ── WebSocket server ──────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server, path: '/ws' });

// Keep track of all connected browser clients.
const clients = new Set();

// Ring-buffer of recent VM output, replayed to newly-connected clients.
let outputBuffer = Buffer.alloc(0);

function appendOutputBuffer(data) {
  outputBuffer = Buffer.concat([outputBuffer, data]);
  if (outputBuffer.length > OUTPUT_BUFFER_BYTES) {
    outputBuffer = outputBuffer.slice(outputBuffer.length - OUTPUT_BUFFER_BYTES);
  }
}

wss.on('connection', (ws, req) => {
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

  // Replay the recent VM output so the new client sees the current state.
  if (outputBuffer.length > 0) {
    ws.send(JSON.stringify({ type: 'output', data: outputBuffer.toString('base64') }));
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      // Binary / non-JSON frame – treat as raw terminal input.
      forwardToVM(raw);
      return;
    }

    if (msg.type === 'input') {
      forwardToVM(msg.data);
    } else if (msg.type === 'resize') {
      const cols = parseInt(msg.cols, 10) || 220;
      const rows = parseInt(msg.rows, 10) || 50;
      vm.resize(cols, rows);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[WS] Client disconnected: ${ip}  (total: ${clients.size})`);
  });

  ws.on('error', (err) => {
    console.error(`[WS] Client error (${ip}):`, err.message);
    clients.delete(ws);
  });
});

// ── VM → browsers ─────────────────────────────────────────────────────────────

vm.on('data', (data) => {
  appendOutputBuffer(data);
  broadcast({ type: 'output', data: data.toString('base64') });
});

vm.on('reset', () => {
  // Clear the output buffer when the VM resets so new clients don't see
  // stale output from the previous boot.
  outputBuffer = Buffer.alloc(0);
  broadcast({
    type: 'info',
    text: '\r\n\x1b[1;33m[Democratic Linux] VM is resetting, please wait…\x1b[0m\r\n',
  });
});

vm.on('error', (err) => {
  console.error('[VM error]', err.message);
  broadcast({
    type: 'info',
    text: `\r\n\x1b[1;31m[VM error] ${err.message}\x1b[0m\r\n`,
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Forward user input to the VM, applying the command filter first.
 * @param {Buffer|string} data
 */
function forwardToVM(data) {
  // Strip QEMU monitor escape sequence (Ctrl-A) to prevent takeover.
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const sanitized = buf.filter((byte) => byte !== 0x01 /* Ctrl-A */);

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
 * @param {object} msg
 */
function broadcast(msg) {
  const frame = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(frame);
    }
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  const proto = useSSL ? 'https' : 'http';
  console.log(`[Server] Democratic Linux running at ${proto}://localhost:${PORT}${useSSL ? '  (TLS enabled)' : ''}`);
});

vm.start().catch((err) => {
  console.error('[Server] Failed to start VM:', err.message);
});
