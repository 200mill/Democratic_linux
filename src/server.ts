import http from 'http';
import https from 'https';
import fs from 'fs';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from './config';
import { VMManager, TabSession } from './vm';
import { ServerTabRegistry, TabEntry } from './tab-registry';
import { ConnectionHandler } from './connection-handler';
import { ServerMessage } from './types';
import { sanitize } from './filter';

const app = express();
app.use(express.static(config.publicDir));

const vm = new VMManager();
const registry = new ServerTabRegistry(config.outputBufferBytes);

const clients = new Set<WebSocket>();

function broadcast(msg: ServerMessage): void {
  const payload = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

function sendTo(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function _wireSession(id: string, entry: TabEntry, session: TabSession): void {
  session.on('data', (data) => {
    const safe = sanitize(data);
    registry.appendBuffer(id, safe);
    const b64 = safe.toString('base64');
    const msg: ServerMessage = { type: 'output', tabId: id, data: b64 };
    const payload = JSON.stringify(msg);
    for (const sub of entry.subscribers) {
      if (sub.readyState === WebSocket.OPEN) sub.send(payload);
    }
  });

  session.on('close', () => {
    entry.session = null;
  });
}

const handler = new ConnectionHandler(vm, registry, broadcast, sendTo, _wireSession);

vm.on('ready', () => {
  broadcast({ type: 'vm:status', status: 'ready' });

  for (const [id, entry] of registry.entries()) {
    if (!entry.session) {
      vm.openTab(id)
        .then(session => {
          entry.session = session;
          _wireSession(id, entry, session);
        })
        .catch(err => {
          const text = err instanceof Error ? err.message : String(err);
          broadcast({ type: 'info', text: `Failed to reopen tab ${id}: ${text}` });
        });
    }
  }
});

vm.on('reset', () => {
  broadcast({ type: 'vm:status', status: 'resetting' });
  registry.clearAllBuffers();
  for (const [, entry] of registry.entries()) {
    entry.session?.close();
    entry.session = null;
  }
});

vm.on('spare', (s) => broadcast({ type: 'vm:spare', status: s }));
vm.on('error', (e) => broadcast({ type: 'info', text: e.message }));

function setupWss(server: http.Server | https.Server): void {
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    handler.handle(ws, req);
  });
}

// HTTP server
const httpServer = http.createServer(app);
setupWss(httpServer);
httpServer.listen(config.httpPort, () => {
  console.log(`HTTP server listening on port ${config.httpPort}`);
});

// HTTPS server (optional)
const useTls = config.sslCert && config.sslKey;
if (useTls) {
  let certPath = config.sslCert;
  let keyPath = config.sslKey;

  if (config.generateSelfSignedCert) {
    // Self-signed cert would be generated here — requires a cert generation library.
    // For now, we require the paths to exist.
  }

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    const tlsOptions = {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
    };
    const httpsServer = https.createServer(tlsOptions, app);
    setupWss(httpsServer);
    httpsServer.listen(config.httpsPort, () => {
      console.log(`HTTPS server listening on port ${config.httpsPort}`);
    });
  }
}

// Keep the service alive if a stray async error escapes (e.g. an ssh2 client
// transient); per-client handlers are the real fix, this is defense-in-depth.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

// Graceful shutdown
process.on('SIGTERM', () => { vm.stop(); process.exit(0); });
process.on('SIGINT',  () => { vm.stop(); process.exit(0); });

console.log(`Starting VM (base image: ${config.baseImage})`);
void vm.start().catch(err => {
  console.error('VM start failed:', err);
});

