// Runtime limits live outside the Pi extension entrypoint so every feature
// reads the same operational policy instead of carrying a private copy.

export const CONTEXT_WATCH_PERCENT = 50;
export const CONTEXT_COMPACT_PERCENT = 70;
export const CONTEXT_FRESH_PERCENT = 82;
export const LONG_INPUT_CHARS = 8000;
export const MAX_INLINE_COLLAPSED_TASK_CHARS = 2200;
export const RUNTIME_INTAKE_MESSAGE_MAX_CHARS = 6_000;
export const SEMANTIC_COMPACTION_MAX_CHARS = 8_000;
export const CONTEXT_PACK_MAX_TOKENS = 900;

export const TOOL_RESULT_COMPACT_CHAR_THRESHOLD = 12_000;
export const TOOL_RESULT_COMPACT_LINE_THRESHOLD = 180;
export const TOOL_RESULT_PREVIEW_HEAD_LINES = 24;
export const TOOL_RESULT_PREVIEW_TAIL_LINES = 24;
export const TOOL_RESULT_PREVIEW_INTERESTING_LINES = 24;
export const TOOL_RESULT_PREVIEW_MAX_CHARS = 6_000;
export const TOOL_RESULT_CAPTURE_MAX_CHARS = 500_000;

export const CAPTURE_INDEX_MAX_BYTES = 4 * 1024 * 1024;
export const CAPTURE_RETENTION_MAX_BYTES = 128 * 1024 * 1024;
export const CAPTURE_RETENTION_MAX_FILES = 500;
export const CAPTURE_RETENTION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const TASK_JOURNAL_MAX_EVENTS = 5_000;
