// Stable aggregation surface for core services. This module contains no
// product behavior; composition and package verification may import it without
// reversing the core -> runtime dependency boundary.
export * from "./context-engine.js";
export * from "./context-index-policy.js";
export * from "./execution-backend.js";
export * from "./policy-core.js";
export * from "./shell-write-targets.js";
export * from "./repository-memory.js";
export * from "./runtime-evidence.js";
export * from "./task-journal.js";
export * from "./task-lifecycle.js";
export * from "./task-runtime-audit.js";
export * from "./task-state.js";
export * from "./verification-intelligence.js";
