import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

// Encryption of provider credentials (GitHub token, Jira API token) before they reach the database. Pure: the secret is
// passed in by the caller, which reads the server-only INTEGRATION_ENCRYPTION_KEY (see integration-key.ts).
//
// AES-256-GCM with a key derived by HKDF-SHA256 from the secret, a random 96-bit IV per encryption and additional
// authenticated data binding the ciphertext to one project and one integration kind: a ciphertext copied to another
// project or kind fails to decrypt. Format (stored in private.integration_credentials):
//   v1.<iv, 12 bytes base64url>.<tag, 16 bytes base64url>.<ciphertext base64url>

const VERSION = "v1";
const INFO = "OFA-INTEGRATION-V1";

export class CredentialError extends Error {}

function deriveKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from("oneforall-integrations"), Buffer.from(INFO), 32));
}

export function credentialAad(projectId: string, kind: "GITHUB" | "JIRA"): string {
  return `${INFO}|${projectId.toLowerCase()}|${kind}`;
}

export function encryptCredential(secret: string, plaintext: string, aad: string): string {
  if (plaintext.length < 3 || plaintext.length > 4096) throw new CredentialError("The credential has an unexpected length.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secret), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptCredential(secret: string, token: string, aad: string): string {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new CredentialError("Unsupported credential format.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret), Buffer.from(parts[1], "base64url"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], "base64url")), decipher.final()]).toString("utf8");
  } catch {
    // Wrong key (rotated), tampered ciphertext or a ciphertext of another project/kind. Never include details.
    throw new CredentialError("The stored credential cannot be decrypted. Enter it again.");
  }
}
