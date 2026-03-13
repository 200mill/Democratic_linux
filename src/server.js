/**
 * Democratic Linux – WebSocket + Web terminal server
 *
 * Architecture:
 *   Browser  ──WS──►  server.js  ──SSH PTY──►  QEMU VM (user-mode net, port 2222→22)
 *
 * All connected browsers share one terminal session (broadcast model).
 * Input from any browser is forwarded to the VM's SSH PTY; output is
 * broadcast to every connected browser.
 *
 * The server listens on both HTTP (HTTP_PORT, default 3000) and HTTPS
 * (HTTPS_PORT, default 3443) simultaneously when SSL_CERT + SSL_KEY are set.
 * If TLS is not configured only the HTTP server starts.
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

const HTTP_PORT  = parseInt(process.env.HTTP_PORT  || process.env.PORT || 80,  10);
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || 443, 10);
const SSL_CERT   = process.env.SSL_CERT || '';   // path to TLS certificate (PEM)
const SSL_KEY    = process.env.SSL_KEY  || '';   // path to TLS private key (PEM)
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

// How many bytes of recent VM output to replay to newly-connected clients
// so they see the current terminal state immediately.
const OUTPUT_BUFFER_BYTES = 32 * 1024; // 32 KiB

// ── Express (static files) ───────────────────────────────────────────────────

const app = express();
app.use(express.static(PUBLIC_DIR));

// ── HTTP + HTTPS servers ──────────────────────────────────────────────────────

const httpServer  = http.createServer(app);

const useSSL = !!(SSL_CERT && SSL_KEY);
let httpsServer = null;

if (useSSL) {
  const tlsOptions = {
    cert: fs.readFileSync(SSL_CERT),
    key:  fs.readFileSync(SSL_KEY),
  };
  httpsServer = https.createServer(tlsOptions, app);
}

// ── WebSocket servers (one per transport) ─────────────────────────────────────

// Both WSS instances share the same clients set and message handlers so
// browsers connecting over ws:// or wss:// are treated identically.
const wssHttp  = new WebSocketServer({ server: httpServer,  path: '/ws' });
const wssHttps = useSSL
  ? new WebSocketServer({ server: httpsServer, path: '/ws' })
  : null;

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

function attachWss(wssInstance) { wssInstance.on('connection', handleConnection); }
attachWss(wssHttp);
if (wssHttps) attachWss(wssHttps);

function handleConnection(ws, req) {
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
}

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

httpServer.listen(HTTP_PORT, () => {
  console.log(`[Server] HTTP  → http://localhost:${HTTP_PORT}`);
});

if (httpsServer) {
  httpsServer.listen(HTTPS_PORT, () => {
    console.log(`[Server] HTTPS → https://localhost:${HTTPS_PORT}  (TLS enabled)`);
  });
}

vm.start().catch((err) => {
  console.error('[Server] Failed to start VM:', err.message);
});
