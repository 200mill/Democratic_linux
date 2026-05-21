export type SpareStatus = 'none' | 'booting' | 'ready';
export type VmStatus = 'booting' | 'ready' | 'resetting';

export interface VMEvents {
  ready: [];
  reset: [];
  error: [err: Error];
  spare: [status: SpareStatus];
}

export type ClientMessage =
  | { type: 'tab:open'; tabId?: string; title?: string }
  | { type: 'tab:close'; tabId: string }
  | { type: 'tab:select'; tabId: string }
  | { type: 'input'; tabId: string; data: string }
  | { type: 'resize'; tabId: string; cols: number; rows: number }
  | { type: 'spare:request' }
  | { type: 'spare:load' };

export type ServerMessage =
  | { type: 'vm:status'; status: VmStatus }
  | { type: 'vm:spare'; status: SpareStatus }
  | { type: 'tab:list'; tabs: TabSummary[] }
  | { type: 'tab:opened'; tabId: string; title: string; tabs: TabSummary[] }
  | { type: 'tab:closed'; tabId: string; tabs: TabSummary[] }
  | { type: 'output'; tabId: string; data: string }
  | { type: 'info'; tabId?: string; text: string };

export interface TabSummary {
  id: string;
  title: string;
}
