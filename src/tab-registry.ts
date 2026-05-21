import type { WebSocket } from 'ws';
import type { TabSession } from './vm';
import type { TabSummary } from './types';

export interface TabEntry {
  id: string;
  title: string;
  session: TabSession | null;
  outputBuffer: Buffer;
  subscribers: Set<WebSocket>;
}

export class ServerTabRegistry {
  private readonly _maxBufferBytes: number;
  private readonly _tabs = new Map<string, TabEntry>();

  constructor(maxBufferBytes: number) {
    this._maxBufferBytes = maxBufferBytes;
  }

  create(id: string, title: string): TabEntry {
    const entry: TabEntry = {
      id,
      title,
      session: null,
      outputBuffer: Buffer.alloc(0),
      subscribers: new Set(),
    };
    this._tabs.set(id, entry);
    return entry;
  }

  get(id: string): TabEntry | undefined {
    return this._tabs.get(id);
  }

  has(id: string): boolean {
    return this._tabs.has(id);
  }

  delete(id: string): void {
    this._tabs.delete(id);
  }

  entries(): IterableIterator<[string, TabEntry]> {
    return this._tabs.entries();
  }

  appendBuffer(id: string, data: Buffer): void {
    const entry = this._tabs.get(id);
    if (!entry) return;

    const combined = Buffer.concat([entry.outputBuffer, data]);
    if (combined.length > this._maxBufferBytes) {
      entry.outputBuffer = combined.slice(combined.length - this._maxBufferBytes);
    } else {
      entry.outputBuffer = combined;
    }
  }

  clearBuffer(id: string): void {
    const entry = this._tabs.get(id);
    if (entry) entry.outputBuffer = Buffer.alloc(0);
  }

  clearAllBuffers(): void {
    for (const entry of this._tabs.values()) {
      entry.outputBuffer = Buffer.alloc(0);
    }
  }

  toSummaryList(): TabSummary[] {
    return Array.from(this._tabs.values()).map(e => ({ id: e.id, title: e.title }));
  }

  unsubscribeAll(ws: WebSocket): void {
    for (const entry of this._tabs.values()) {
      entry.subscribers.delete(ws);
    }
  }
}
