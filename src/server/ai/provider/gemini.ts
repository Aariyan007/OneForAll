import "server-only";

// Server-only entry point for the Gemini adapter: the app imports the provider from here, so it can never be bundled
// into browser code. The implementation lives in ./gemini-client (shared with the evaluation script).
export { createGeminiProvider } from "./gemini-client";
