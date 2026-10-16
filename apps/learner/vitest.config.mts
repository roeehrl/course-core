import { configDefaults, defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const alias = {
  "react-native": fileURLToPath(new URL("./node_modules/react-native-web", import.meta.url)),
};
const test = { environment: "jsdom", setupFiles: ["./tests/setup.ts"], restoreMocks: true };

export default defineConfig({
  test: {
    projects: [
      {
        // The web app: `.web` modules win, as they do in the Metro web export.
        resolve: { alias, extensions: [".web.tsx", ".web.ts", ".tsx", ".ts", ".jsx", ".js", ".json"] },
        test: { ...test, name: "web", include: ["tests/**/*.test.{ts,tsx}"], exclude: [...configDefaults.exclude, "tests/native/**"] },
      },
      {
        // The native app's own modules (no `.web` overrides), rendered through react-native-web in jsdom.
        // This checks native components' behaviour and accessibility tree, not a device build.
        resolve: { alias, extensions: [".native.tsx", ".native.ts", ".tsx", ".ts", ".jsx", ".js", ".json"] },
        test: { ...test, name: "native", include: ["tests/native/**/*.test.{ts,tsx}"] },
      },
    ],
  },
});
