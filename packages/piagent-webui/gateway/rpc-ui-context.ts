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
  const noop = () => undefined;
  // Pi copies this context when wrapping prompts. Keep methods and the ownership
  // marker enumerable so notification delivery and gateway detection survive.
  return {
    [GATEWAY_RUNTIME_UI_MARKER]: true,
    theme,
    confirm: () => new Promise<boolean>(() => undefined),
    select: async () => undefined,
    input: async () => undefined,
    editor: async () => undefined,
    custom: async () => undefined,
    notify: noop,
    onTerminalInput: () => noop,
    setStatus: noop,
    setWorkingMessage: noop,
    setWorkingVisible: noop,
    setWorkingIndicator: noop,
    setHiddenThinkingLabel: noop,
    setWidget: noop,
    setFooter: noop,
    setHeader: noop,
    setTitle: noop,
    pasteToEditor: noop,
    setEditorText: noop,
    getEditorText: () => "",
    addAutocompleteProvider: noop,
    setEditorComponent: noop,
    getEditorComponent: noop,
    getAllThemes: () => [],
    getTheme: noop,
    setTheme: () => ({ success: false, error: "UI not available" }),
    getToolsExpanded: () => false,
    setToolsExpanded: noop
  };
}
