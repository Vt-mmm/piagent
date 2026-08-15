import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const GATEWAY_RUNTIME_UI_MARKER = Symbol.for("piagent.webui.gateway-runtime-ui.v1");

export function isGatewayRuntimeContext(ctx: Pick<ExtensionContext, "ui">): boolean {
  try { return Reflect.get(ctx.ui as object, GATEWAY_RUNTIME_UI_MARKER) === true; }
  catch { return false; }
}
