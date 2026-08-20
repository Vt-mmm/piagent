import { GATEWAY_RUNTIME_UI_MARKER } from "../ownership/gateway-runtime-context.ts";

export function rpcUiContext(): object {
  const plain = (text: unknown): string => String(text ?? "");
  const theme = Object.freeze({
    fg: (_color: unknown, text: unknown) => plain(text),
    bg: (_color: unknown, text: unknown) => plain(text),
    bold: plain,
    italic: plain,
    underline: plain,
    inverse: plain,
    strikethrough: plain,
    getFgAnsi: () => "",
    getBgAnsi: () => "",
    getColorMode: () => "truecolor",
    getThinkingBorderColor: () => plain,
    getBashModeBorderColor: () => plain
  });
  return new Proxy({}, {
    get(_target, property) {
      if (property === GATEWAY_RUNTIME_UI_MARKER) return true;
      if (property === "theme") return theme;
      if (property === "confirm") return () => new Promise<boolean>(() => undefined);
      if (property === "select" || property === "input") return async () => undefined;
      return () => undefined;
    }
  });
}
