import { IncomingMessage } from 'http';
import { WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { VMManager } from './vm';
import { ServerTabRegistry } from './tab-registry';
import { ClientMessage, ServerMessage } from './types';
import { isBlocked, sanitize } from './filter';

type WireSession = (
  id: string,
  entry: ReturnType<ServerTabRegistry['get']> & object,
  session: Awaited<ReturnType<VMManager['openTab']>>,
) => void;

export class ConnectionHandler {
  private readonly _vm: VMManager;
  private readonly _registry: ServerTabRegistry;
  private readonly _broadcast: (msg: ServerMessage) => void;
  private readonly _sendTo: (ws: WebSocket, msg: ServerMessage) => void;
  private readonly _wireSession: WireSession;

  constructor(
    vm: VMManager,
    registry: ServerTabRegistry,
    broadcast: (msg: ServerMessage) => void,
    sendTo: (ws: WebSocket, msg: ServerMessage) => void,
    wireSession: WireSession,
  ) {
    this._vm = vm;
    this._registry = registry;
    this._broadcast = broadcast;
    this._sendTo = sendTo;
    this._wireSession = wireSession;
  }

  handle(ws: WebSocket, _req: IncomingMessage): void {
    // Send current state immediately on connect
    this._sendTo(ws, {
      type: 'vm:status',
      status: this._vm.isReady ? 'ready' : 'booting',
    });
    this._sendTo(ws, { type: 'vm:spare', status: this._vm.spareStatus });
    this._sendTo(ws, { type: 'tab:list', tabs: this._registry.toSummaryList() });

    ws.on('message', (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        this._sendTo(ws, { type: 'info', text: 'Invalid message format' });
        return;
      }

      switch (msg.type) {
        case 'tab:open':    void this._handleTabOpen(ws, msg); break;
        case 'tab:close':   this._handleTabClose(ws, msg);     break;
        case 'tab:select':  this._handleTabSelect(ws, msg);    break;
        case 'input':       this._handleInput(ws, msg);        break;
        case 'resize':      this._handleResize(ws, msg);       break;
        case 'spare:request': this._handleSpareRequest(ws);    break;
        case 'spare:load':  this._handleSpareLoad();           break;
        default: {
          const _exhaustive: never = msg;
          void _exhaustive;
        }
      }
    });

    ws.on('close', () => {
      this._registry.unsubscribeAll(ws);
    });
  }

  private async _handleTabOpen(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: 'tab:open' }>,
  ): Promise<void> {
    if (!this._vm.isReady) {
      this._sendTo(ws, { type: 'info', text: 'VM is not ready yet' });
      return;
    }

    const id = msg.tabId ?? uuidv4();
    const title = msg.title ?? 'Terminal';

    if (this._registry.has(id)) {
      this._sendTo(ws, { type: 'info', text: `Tab ${id} already exists` });
      return;
    }

    const entry = this._registry.create(id, title);
    entry.subscribers.add(ws);

    try {
      const session = await this._vm.openTab(id);
      entry.session = session;
      this._wireSession(id, entry, session);
    } catch (err) {
      this._registry.delete(id);
      const text = err instanceof Error ? err.message : String(err);
      this._sendTo(ws, { type: 'info', text: `Failed to open tab: ${text}` });
      return;
    }

    this._broadcast({ type: 'tab:opened', tabId: id, title, tabs: this._registry.toSummaryList() });
  }

  private _handleTabClose(
    _ws: WebSocket,
    msg: Extract<ClientMessage, { type: 'tab:close' }>,
  ): void {
    const entry = this._registry.get(msg.tabId);
    if (!entry) return;

    entry.session?.close();
    this._vm.closeTab(msg.tabId);
    this._registry.delete(msg.tabId);

    this._broadcast({ type: 'tab:closed', tabId: msg.tabId, tabs: this._registry.toSummaryList() });
  }

  private _handleTabSelect(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: 'tab:select' }>,
  ): void {
    const entry = this._registry.get(msg.tabId);
    if (!entry) {
      this._sendTo(ws, { type: 'info', text: `Tab ${msg.tabId} not found` });
      return;
    }

    entry.subscribers.add(ws);

    if (entry.outputBuffer.length > 0) {
      this._sendTo(ws, {
        type: 'output',
        tabId: msg.tabId,
        data: entry.outputBuffer.toString('base64'),
      });
    }
  }

  private _handleInput(
    _ws: WebSocket,
    msg: Extract<ClientMessage, { type: 'input' }>,
  ): void {
    const entry = this._registry.get(msg.tabId);
    if (!entry?.session) return;

    const data = Buffer.from(msg.data, 'base64');
    if (isBlocked(data)) return;
    entry.session.write(sanitize(data));
  }

  private _handleResize(
    _ws: WebSocket,
    msg: Extract<ClientMessage, { type: 'resize' }>,
  ): void {
    const entry = this._registry.get(msg.tabId);
    entry?.session?.resize(msg.cols, msg.rows);
  }

  private _handleSpareRequest(_ws: WebSocket): void {
    this._vm.requestSpare();
  }

  private _handleSpareLoad(): void {
    if (this._vm.spareStatus === 'ready') {
      void this._vm.reset();
    }
  }
}
