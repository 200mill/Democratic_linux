import { EventEmitter } from 'events';

// Extend the generic EventEmitter<T> introduced in @types/node v20+.
// T must satisfy Record<keyof T, any[]> — the constraint EventEmitter uses.
export class TypedEventEmitter<T extends Record<keyof T, any[]>> extends EventEmitter<T> {}
