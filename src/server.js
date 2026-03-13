/**
 * Democratic Linux – WebSocket + Web terminal server  (multi-tab edition)
 *
 * Architecture
 * ────────────
 *   Browser  ──WS──►  server.js  ──SSH PTY (per tab)──►  QEMU VM
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
const crypto = require('crypto');
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

// Per-tab output replay buffer size (bytes sent to a newly-subscribing client).
const OUTPUT_BUFFER_BYTES = 32 * 1024; // 32 KiB

// ── Express ───────────────────────────────────────────────────────────────────

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

// All connected browser WebSocket clients.
const clients = new Set();

// ── Tab registry ──────────────────────────────────────────────────────────────

/**
 * tabRegistry maps tabId → {
 *   id:           string,
 *   title:        string,
 *   session:      TabSession | null,
 *   outputBuffer: Buffer,          // replay buffer for late-joining clients
 *   subscribers:  Set<WebSocket>,  // clients currently viewing this tab
 * }
 */
const tabRegistry = new Map();

function makeTabEntry(id, title) {
  return { id, title, session: null, outputBuffer: Buffer.alloc(0), subscribers: new Set() };
}

function appendTabBuffer(entry, data) {
  entry.outputBuffer = Buffer.concat([entry.outputBuffer, data]);
  if (entry.outputBuffer.length > OUTPUT_BUFFER_BYTES) {
    entry.outputBuffer = entry.outputBuffer.slice(
      entry.outputBuffer.length - OUTPUT_BUFFER_BYTES
    );
  }
}

function tabList() {
  return Array.from(tabRegistry.values()).map(({ id, title }) => ({ id, title }));
}

// ── Broadcast helpers ─────────────────────────────────────────────────────────

function broadcast(msg) {
  const frame = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(frame);
  }
}

function broadcastToSubscribers(tabId, msg) {
  const entry = tabRegistry.get(tabId);
  if (!entry) return;
  const frame = JSON.stringify(msg);
  for (const ws of entry.subscribers) {
    if (ws.readyState === WebSocket.OPEN) ws.send(frame);
  }
}

function sendTo(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ── Open / close tab ──────────────────────────────────────────────────────────

async function openTab(id, title) {
  if (tabRegistry.has(id)) return tabRegistry.get(id);

  const entry = makeTabEntry(id, title || `Tab ${tabRegistry.size + 1}`);
  tabRegistry.set(id, entry);

  broadcast({ type: 'tab:list', tabs: tabList() });

  if (!vm.isReady) return entry;

  try {
    const session = await vm.openTab(id);
    entry.session = session;

    session.on('data', (data) => {
      appendTabBuffer(entry, data);
      broadcastToSubscribers(id, { type: 'output', tabId: id, data: data.toString('base64') });
    });

    session.on('close', () => {
      if (tabRegistry.has(id)) {
        broadcastToSubscribers(id, {
          type: 'info', tabId: id,
          text: '\r\n\x1b[1;33m[Tab closed by remote]\x1b[0m\r\n',
        });
        closeTab(id);
      }
    });
  } catch (err) {
    console.error(`[Server] Failed to open tab ${id}:`, err.message);
    broadcastToSubscribers(id, {
      type: 'info', tabId: id,
      text: `\r\n\x1b[1;31m[Error] Could not open shell: ${err.message}\x1b[0m\r\n`,
    });
  }

  return entry;
}

function closeTab(id) {
  const entry = tabRegistry.get(id);
  if (!entry) return;
  if (entry.session) {
    try { entry.session.close(); } catch (_) {}
    entry.session = null;
  }
  tabRegistry.delete(id);
  broadcast({ type: 'tab:closed', tabId: id, tabs: tabList() });
}

// ── WebSocket attachment ──────────────────────────────────────────────────────

function attachWss(wssInstance) { wssInstance.on('connection', handleConnection); }

function handleConnection(ws, req) {
  const ip = req.socket.remoteAddress;
  console.log(`[WS] Client connected: ${ip}  (total: ${clients.size + 1})`);
  clients.add(ws);

  // Send current VM status and tab list.
  sendTo(ws, {
    type: 'vm:status',
    status: vm.isReady ? 'ready' : 'booting',
  });
  sendTo(ws, { type: 'tab:list', tabs: tabList() });
  sendTo(ws, { type: 'vm:spare', status: vm.spareStatus });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {

      case 'tab:open': {
        const id    = msg.tabId || crypto.randomUUID();
        const title = msg.title || null;
        openTab(id, title).then((entry) => {
          // Subscribe this client to the new tab automatically.
          entry.subscribers.add(ws);
          // Replay buffer so the client sees any output already produced.
          if (entry.outputBuffer.length > 0) {
            sendTo(ws, {
              type: 'output',
              tabId: id,
              data: entry.outputBuffer.toString('base64'),
            });
          }
          sendTo(ws, { type: 'tab:opened', tabId: id, title: entry.title, tabs: tabList() });
        }).catch((err) => {
          sendTo(ws, {
            type: 'info',
            tabId: msg.tabId,
            text: `\r\n\x1b[1;31m[Error] ${err.message}\x1b[0m\r\n`,
          });
        });
        break;
      }

      case 'tab:close': {
        const { tabId } = msg;
        if (!tabId) break;
        closeTab(tabId);
        break;
      }

      case 'tab:select': {
        // Subscribe this client to a tab and replay its buffer.
        const { tabId } = msg;
        const entry = tabRegistry.get(tabId);
        if (!entry) {
          sendTo(ws, { type: 'info', tabId, text: '\r\n\x1b[1;31m[Tab not found]\x1b[0m\r\n' });
          break;
        }
        entry.subscribers.add(ws);
        if (entry.outputBuffer.length > 0) {
          sendTo(ws, {
            type: 'output',
            tabId,
            data: entry.outputBuffer.toString('base64'),
          });
        }
        break;
      }

      case 'input': {
        const { tabId, data } = msg;
        if (!tabId || data == null) break;
        const entry = tabRegistry.get(tabId);
        if (!entry || !entry.session) break;
        forwardToTab(entry, data);
        break;
      }

      case 'resize': {
        const { tabId, cols, rows } = msg;
        if (!tabId) break;
        const entry = tabRegistry.get(tabId);
        if (!entry || !entry.session) break;
        entry.session.resize(
          parseInt(cols, 10) || 220,
          parseInt(rows, 10) || 50
        );
        break;
      }

      case 'spare:request': {
        vm.requestSpare();
        // Immediately echo current spare status back to the requester.
        sendTo(ws, { type: 'vm:spare', status: vm.spareStatus });
        break;
      }

      case 'spare:load': {
        // Promote the spare to active (instant failover if spare is ready).
        vm.reset().catch((err) => console.error('[Server] spare:load reset failed:', err.message));
        break;
      }
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    // Unsubscribe from all tabs.
    for (const entry of tabRegistry.values()) {
      entry.subscribers.delete(ws);
    }
    console.log(`[WS] Client disconnected: ${ip}  (total: ${clients.size})`);
  });

  ws.on('error', (err) => {
    console.error(`[WS] Client error (${ip}):`, err.message);
    clients.delete(ws);
    for (const entry of tabRegistry.values()) {
      entry.subscribers.delete(ws);
    }
  });
}

attachWss(wssHttp);
if (wssHttps) attachWss(wssHttps);

// ── VM events ─────────────────────────────────────────────────────────────────

vm.on('ready', () => {
  broadcast({ type: 'vm:status', status: 'ready' });

  // Open SSH sessions for any tabs that were created while the VM was booting.
  for (const [id, entry] of tabRegistry.entries()) {
    if (!entry.session) {
      vm.openTab(id).then((session) => {
        entry.session = session;
        session.on('data', (data) => {
          appendTabBuffer(entry, data);
          broadcastToSubscribers(id, {
            type: 'output', tabId: id, data: data.toString('base64'),
          });
        });
        session.on('close', () => {
          if (tabRegistry.has(id)) closeTab(id);
        });
      }).catch((err) => {
        console.error(`[Server] Tab ${id} session open error:`, err.message);
      });
    }
  }
});

vm.on('reset', () => {
  broadcast({ type: 'vm:status', status: 'resetting' });
  // Close all tab sessions (the VM is gone); clear their output buffers.
  for (const [id, entry] of tabRegistry.entries()) {
    if (entry.session) {
      try { entry.session.close(); } catch (_) {}
      entry.session = null;
    }
    entry.outputBuffer = Buffer.alloc(0);
    broadcastToSubscribers(id, {
      type: 'info',
      tabId: id,
      text: '\r\n\x1b[1;33m[Democratic Linux] VM is resetting, please wait…\x1b[0m\r\n',
    });
  }
});

vm.on('error', (err) => {
  console.error('[VM error]', err.message);
  broadcast({
    type: 'info',
    text: `\r\n\x1b[1;31m[VM error] ${err.message}\x1b[0m\r\n`,
  });
});

vm.on('spare', (status) => {
  broadcast({ type: 'vm:spare', status });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function forwardToTab(entry, data) {
  const buf       = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const sanitized = buf.filter((byte) => byte !== 0x01);

  if (isBlocked(sanitized)) {
    broadcastToSubscribers(entry.id, {
      type: 'info',
      tabId: entry.id,
      text: '\r\n\x1b[1;31m[Blocked] That command is not allowed.\x1b[0m\r\n',
    });
    return;
  }

  entry.session.write(sanitized);
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
