export function sanitize(data: Buffer): Buffer {
  return Buffer.from(data.filter(b => b !== 0x01));
}

const FORK_BOMB = /:\(\)\s*\{\s*:|&\s*\}/;

export function isBlocked(data: Buffer): boolean {
  return FORK_BOMB.test(data.toString('utf8'));
}
