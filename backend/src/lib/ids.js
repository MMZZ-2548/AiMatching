/**
 * Stable ids for seeded data.
 *
 * The demo world and every test scenario name entities readably — "CR-01", "CG_FAR_PERFECT_01".
 * Those are not uuids, and the Postgres schema keys on uuid. Rather than weaken the keys to text,
 * a seeded row keeps a uuid primary key derived from its code, plus the code itself in a unique
 * column.
 *
 * The derivation is UUIDv5 (RFC 4122 §4.3): SHA-1 over a fixed namespace plus the code. It is
 * deterministic, so re-seeding — on any machine, against either store — produces the same ids and
 * the scenarios stay reproducible.
 */

import { createHash } from 'node:crypto';

/** Fixed namespace for TrustCare demo data. Any constant uuid works; this one must not change. */
const NAMESPACE = 'b7d1f0c2-9a54-4e3b-8c17-6f2a5d0e4b91';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

function namespaceBytes(uuid) {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

/** UUIDv5 of `code` within the TrustCare namespace. */
export function codeToUuid(code) {
  const hash = createHash('sha1')
    .update(namespaceBytes(NAMESPACE))
    .update(Buffer.from(String(code), 'utf8'))
    .digest();

  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Accept either form wherever an id is expected. A caller that says "CR-01" gets the row whose
 * code is CR-01; a caller that passes a uuid is left alone. This is what lets the tester, the
 * scenarios and the tests keep using readable names against a uuid-keyed database.
 */
export function resolveId(idOrCode) {
  if (idOrCode == null) return null;
  return isUuid(idOrCode) ? idOrCode : codeToUuid(idOrCode);
}
