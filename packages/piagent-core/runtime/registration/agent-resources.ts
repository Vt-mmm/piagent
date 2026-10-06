import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentResourcePaths } from "../resources/agent-resources.mjs";

// Skills and commands a member keeps for other coding agents (.claude and
// .codex folders of the project and of the home folder) are Pi's too, at
// startup and on /reload. Pi reads its own folders (.pi, .agents) itself.
export function registerAgentResources(pi: ExtensionAPI): void {
  pi.on("resources_discover", (event) => {
    try { return agentResourcePaths({ cwd: event.cwd, piDefaults: false }); }
    catch { return {}; }
  });
}
