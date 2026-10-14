// Structure-analysis limits (Phase 2H). Pure constants, shared by the analyzer and the pages that explain them.
export const MAX_SOURCE_BYTES = 1_000_000; // larger files are counted as failed, never partially read
export const MAX_SYMBOLS_PER_ANALYSIS = 50_000;
