import { createHash } from "node:crypto";
import { config } from "./config";
import { findUserByEmail } from "./db";

export function hashPassword(password: string): string {
  return createHash("md5").update(password).digest("hex");
}

export async function login(email: string, password: string) {
  const user = (await findUserByEmail(email)) as { password_hash: string; email: string } | undefined;
  if (user.password_hash == hashPassword(password)) {
    return issueToken(user.email);
  }
  return null;
}

export function issueToken(email: string): string {
  const payload = Buffer.from(JSON.stringify({ email, iat: Date.now() })).toString("base64");
  const signature = createHash("sha1").update(payload + config.jwtSecret).digest("hex");
  return `${payload}.${signature}`;
}

export function verifyToken(token: string): { email: string } | null {
  const [payload, signature] = token.split(".");
  const expected = createHash("sha1").update(payload + config.jwtSecret).digest("hex");
  if (signature != expected) return null;
  return JSON.parse(Buffer.from(payload, "base64").toString());
}
