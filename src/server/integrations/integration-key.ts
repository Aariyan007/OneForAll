import "server-only";

// The key that encrypts provider credentials at rest. SERVER-ONLY: read from the environment on the server, never
// NEXT_PUBLIC_*, never logged, never sent to the browser or the database. Unlike STRUCTURE_PERSIST_KEY it has no Vault
// counterpart: the database only ever stores ciphertext. Rotating it makes stored credentials unreadable, so
// integrations must be re-entered after a rotation (see docs/manual-setup-checklist.md).

const MIN_KEY_LENGTH = 32;

export const INTEGRATION_KEY_MISSING = "Integrations are not configured on this server (INTEGRATION_ENCRYPTION_KEY is missing).";

export function getIntegrationKey(): string | null {
  const key = process.env.INTEGRATION_ENCRYPTION_KEY;
  return key !== undefined && key.length >= MIN_KEY_LENGTH ? key : null;
}
