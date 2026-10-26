export type Session = { userId: string; issuedAt: number }; // issuedAt: Unix time in milliseconds

export const SESSION_TTL_SECONDS = 3600;

export function isSessionExpired(session: Session, now: number = Date.now()): boolean {
  return now - session.issuedAt > SESSION_TTL_SECONDS;
}
