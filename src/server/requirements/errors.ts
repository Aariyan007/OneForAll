// Shared by the requirement and task actions. Maps database error codes to user-facing messages
// without leaking internals. The database (RLS, constraints, lifecycle triggers) is the authority.

export const PERMISSION_MESSAGE = "You do not have permission to do that.";
export const GENERIC_MESSAGE = "Something went wrong. Please try again.";

export function toErrorMessage(error: { code?: string; message: string }): string {
  switch (error.code) {
    case "42501":
      return PERMISSION_MESSAGE;
    case "23514":
      return error.message.includes("status transition")
        ? "That status change is not allowed."
        : "Some of the submitted values are not valid.";
    case "55000":
      // Raised by our own lifecycle rules with a readable message (e.g. open tasks block completing a requirement).
      return error.message;
    default:
      return GENERIC_MESSAGE;
  }
}
