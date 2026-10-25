import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./client", import.meta.url)),
  plugins: [react()],
  publicDir: false,
  build: {
    outDir: fileURLToPath(new URL("./dist/client", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
    // The UI framework pieces that several chunks share go into one cached
    // chunk, so the first paint loads a handful of scripts rather than a file
    // per component. Editor, terminal, markdown and the inspector stay lazy.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: "vendor", priority: 2, test: /node_modules[\\/](react|react-dom|scheduler|react-is|@mui|@emotion|@babel[\\/]runtime|@popperjs|react-transition-group|clsx|stylis|prop-types|hoist-non-react-statics)[\\/]/, minShareCount: 2 }
          ]
        }
      }
    }
  }
});
