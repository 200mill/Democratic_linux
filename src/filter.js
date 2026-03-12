/**
 * Command filter for Democratic Linux.
 *
 * Blocks commands that would permanently destroy the VM in ways that
 * cannot be recovered by an automatic reset, or that would expose
 * sensitive host information.
 *
 * The VM is shared and anyone can run sudo, so we only block the
 * absolute worst offenders.  Everything else (rm -rf /, mkfs, etc.)
 * is allowed because the VM will auto-reset anyway.
 */

'use strict';

// Patterns that match dangerous commands we want to block entirely.
// These are matched against the raw bytes the user types before they
// are forwarded to the VM.
const BLOCKED_PATTERNS = [
  // Fork bomb
  /:\(\)\s*\{\s*:|&\s*\}/,
  // Writing to the host serial device from inside the VM is harmless,
  // but block attempts to reach the QEMU monitor escape sequence.
  // (Ctrl-A c) — we strip this at the byte level instead, see server.js
];

// Strings that, if found anywhere in a line, cause the whole line to be
// dropped.  Checked case-insensitively.
const BLOCKED_SUBSTRINGS = [
  // Prevent users from shutting down / rebooting from the terminal
  // (the VM manager handles planned reboots itself).
  // Uncomment if you want to block these:
  // 'shutdown', 'reboot', 'halt', 'poweroff',
];

/**
 * Returns true if the given input chunk should be blocked.
 * @param {Buffer|string} data
 */
function isBlocked(data) {
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(text)) return true;
  }

  const lower = text.toLowerCase();
  for (const sub of BLOCKED_SUBSTRINGS) {
    if (lower.includes(sub)) return true;
  }

  return false;
}

module.exports = { isBlocked };
