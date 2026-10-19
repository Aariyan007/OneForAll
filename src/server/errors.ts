// User-facing messages for errors returned by the SECURITY DEFINER functions of migrations 20261022000001–
// 20261024000001. Those functions raise short, user-safe messages with specific SQLSTATEs; anything else (or anything
// that looks like an internal database message) becomes a generic message. Never returns SQL, table names or hints.

const SAFE_CODES = new Set(["42501", "22023", "23505", "23514", "55000", "40001", "P0002", "54000", "28000"]);
const INTERNAL = /permission denied|violates|relation |column |function |syntax|constraint|schema|jwt|null value/i;

export const GENERIC_ERROR = "Something went wrong. Please try again.";

export function rpcErrorMessage(error: { code?: string; message?: string } | null | undefined, fallback = GENERIC_ERROR): string {
  if (!error) return fallback;
  const message = (error.message ?? "").trim();
  if (error.code && SAFE_CODES.has(error.code) && message && message.length <= 300 && !INTERNAL.test(message)) return message;
  if (error.code === "42501") return "You do not have permission to do that.";
  return fallback;
}
