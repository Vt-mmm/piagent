import { toggle } from "../../mcp/mcp-command-actions.js";

export function setRuntimeMcpEnabled(options: {
  projectPath: string;
  name: string;
  scope: string;
  enabled: boolean;
}): void {
  toggle(options);
}
