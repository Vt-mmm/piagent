import { redactSensitiveText } from "./sensitive-text.js";
import {
  redactSensitiveCssText,
  redactSensitiveMarkupText,
  redactSensitiveObjectiveCText,
  redactSensitiveShellSourceText,
  redactSensitiveSourceText,
  redactSensitiveYamlText,
  redactSourceText
} from "./sensitive-source-formats.js";

const PROJECT_SOURCE_CODE_PATH = /\.(?:[cm]?[jt]sx?|py|rb|php|java|kt|kts|swift|go|rs|c|cc|cpp|cxx|h|hh|hpp|hxx|cs|scala|lua|r|dart|ex|exs|erl|hrl|fs|fsx|vb|sql|vue|svelte)$/i;
const PROJECT_SHELL_SOURCE_PATH = /\.(?:sh|bash|zsh|fish)$/i;
const PROJECT_HASH_COMMENT_SOURCE_PATH = /\.(?:py|rb|php|r|ex|exs)$/i;
const PROJECT_YAML_PATH = /\.ya?ml$/i;
const PROJECT_MARKUP_PATH = /\.(?:html?|xml|svg)$/i;
const PROJECT_CSS_PATH = /\.(?:css|scss)$/i;
const PROJECT_OBJECTIVE_C_PATH = /\.mm?$/i;

export function redactSensitiveProjectFileText(filePath, input) {
  const source = typeof input === "string" ? input : "";
  const result = PROJECT_SHELL_SOURCE_PATH.test(String(filePath ?? ""))
    ? redactSensitiveShellSourceText(source)
    : PROJECT_YAML_PATH.test(String(filePath ?? ""))
      ? redactSensitiveYamlText(source)
      : PROJECT_MARKUP_PATH.test(String(filePath ?? ""))
        ? redactSensitiveMarkupText(source)
        : PROJECT_CSS_PATH.test(String(filePath ?? ""))
          ? redactSensitiveCssText(source)
          : PROJECT_OBJECTIVE_C_PATH.test(String(filePath ?? ""))
            ? redactSensitiveObjectiveCText(source)
    : PROJECT_SOURCE_CODE_PATH.test(String(filePath ?? ""))
      ? redactSourceText(source, {
        shellOnly: false,
        hashComments: PROJECT_HASH_COMMENT_SOURCE_PATH.test(String(filePath ?? ""))
      })
      : redactSensitiveText(source);
  return {
    ...result,
    lineCountPreserved: (source.match(/\n/g) ?? []).length === (result.text.match(/\n/g) ?? []).length
  };
}
