// Shared scaffolding for tests that load the guard extension against a copied
// platform tree. The guard resolves its platform root from its own module path,
// so a test that wants a different platform build copies the tree and imports
// the guard out of the copy.
import fs from "node:fs";
import path from "node:path";

export function writeModule(target, source) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
}

// The guard imports its host runtime by package name. A copied tree has no
// node_modules, so the few entry points it touches are stubbed.
export function writeRuntimeStubs(root) {
  writeModule(path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), JSON.stringify({
    type: "module",
    exports: "./index.js"
  }));
  writeModule(path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "index.js"), [
    "export function isToolCallEventType(name, event) {",
    "  return event?.toolName === name;",
    "}",
    ""
  ].join("\n"));

  writeModule(path.join(root, "node_modules", "@earendil-works", "pi-ai", "package.json"), JSON.stringify({
    type: "module",
    exports: "./index.js"
  }));
  writeModule(path.join(root, "node_modules", "@earendil-works", "pi-ai", "index.js"), [
    "export function StringEnum(values) {",
    "  return { enum: values };",
    "}",
    ""
  ].join("\n"));

  writeModule(path.join(root, "node_modules", "typebox", "package.json"), JSON.stringify({
    type: "module",
    exports: "./index.js"
  }));
  writeModule(path.join(root, "node_modules", "typebox", "index.js"), [
    "const passthrough = (schema = {}) => schema;",
    "export const Type = {",
    "  Object: (properties = {}, options = {}) => ({ type: 'object', properties, ...options }),",
    "  Optional: passthrough,",
    "  String: (options = {}) => ({ type: 'string', ...options }),",
    "  Number: (options = {}) => ({ type: 'number', ...options }),",
    "  Boolean: (options = {}) => ({ type: 'boolean', ...options }),",
    "  Array: (items = {}, options = {}) => ({ type: 'array', items, ...options })",
    "};",
    ""
  ].join("\n"));
}

export function createPiHarness() {
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const entries = [];
  let sessionName = "";
  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    sendUserMessage(message, options) {
      entries.push({ type: "user-message", payload: { message, options } });
    },
    sendMessage(message) {
      entries.push({ type: "message", payload: message });
    },
    appendEntry(type, payload) {
      entries.push({ type, payload });
    },
    setSessionName(name) {
      sessionName = name;
    },
    getThinkingLevel() {
      return "xhigh";
    }
  };
  return { pi, handlers, tools, commands, entries, getSessionName: () => sessionName };
}

export function createContext(cwd, options = {}) {
  const notices = [];
  const confirmations = [];
  const selections = Array.isArray(options.select) ? [...options.select] : [];
  const selectCalls = [];
  return {
    cwd,
    mode: "test",
    model: { provider: "test", id: "model" },
    ui: {
      notices,
      notify(message, level) {
        notices.push({ message, level });
      },
      confirm: async (message, title) => {
        confirmations.push({ message, title });
        return options.confirm ?? false;
      },
      select: async (...args) => {
        selectCalls.push(args);
        if (typeof options.select === "function") return options.select(...args);
        return selections.shift();
      }
    },
    isProjectTrusted: () => options.projectTrusted ?? true,
    getContextUsage: () => options.contextUsage ?? ({ tokens: 0, contextWindow: 1000, percent: 0 }),
    compact: () => {
      notices.push({ message: "compact called", level: "info" });
    },
    sessionManager: {
      getSessionFile: () => path.join(cwd, ".pi", "session.jsonl"),
      getSessionId: () => "session-test",
      getSessionName: () => "session",
      getEntries: () => [],
      getBranch: () => []
    },
    confirmations,
    selectCalls
  };
}

export async function callToolCall(handler, ctx, toolName, input) {
  return await handler({ toolName, input }, ctx) ?? {};
}

export async function callToolResult(handler, ctx, toolName, input, content) {
  return await handler({ toolName, input, content, isError: false }, ctx) ?? {};
}
