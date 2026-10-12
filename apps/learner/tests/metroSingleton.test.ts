import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { ResolutionContext } from "metro-resolver";
const require = createRequire(import.meta.url);
const { resolve } =
  require("metro-resolver") as typeof import("metro-resolver");
const app = path.resolve(import.meta.dirname, "..");
const config = require("../metro.config.cjs");
const scratchRoot = path.join(app, ".expo", "peer-resolution-tests");
fs.mkdirSync(scratchRoot, { recursive: true });
const foreign = fs.mkdtempSync(path.join(scratchRoot, "foreign-"));
for (const name of ["react", "react-dom"]) {
  const root = path.join(foreign, "node_modules", name);
  fs.mkdirSync(root, { recursive: true });
  const entries =
    name === "react"
      ? ["index", "jsx-runtime", "jsx-dev-runtime", "compiler-runtime"]
      : ["index", "client", "server.browser", "server.node"];
  const exports: Record<string, unknown> = { ".": "./index.js" };
  for (const entry of entries) {
    fs.writeFileSync(
      path.join(root, entry + ".js"),
      "// deliberately conflicting test peer\n",
    );
    if (entry !== "index") exports["./" + entry] = "./" + entry + ".js";
  }
  if (name === "react-dom")
    exports["./server"] = {
      browser: "./server.browser.js",
      default: "./server.node.js",
    };
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name, version: "99.0.0", main: "index.js", exports }),
  );
}
fs.writeFileSync(
  path.join(foreign, "package.json"),
  JSON.stringify({ name: "linked-public-visual-peer-fixture" }),
);
fs.writeFileSync(path.join(foreign, "entry.js"), "// test resolver origin\n");
afterAll(() => fs.rmSync(foreign, { recursive: true, force: true }));
function context(): ResolutionContext {
  const getPackage = (file: string) => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  };
  return {
    allowHaste: false,
    assetExts: new Set(),
    customResolverOptions: {},
    dev: false,
    disableHierarchicalLookup: false,
    doesFileExist: (file) => {
      try {
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    },
    fileSystemLookup: (file) => {
      try {
        const realPath = fs.realpathSync(file),
          stat = fs.statSync(realPath);
        return { exists: true, type: stat.isDirectory() ? "d" : "f", realPath };
      } catch {
        return { exists: false };
      }
    },
    getPackage,
    getPackageForModule: (file) => {
      let dir = path.dirname(file);
      try {
        if (fs.statSync(file).isDirectory()) dir = file;
      } catch {}
      while (dir !== path.dirname(dir)) {
        const packageJson = getPackage(path.join(dir, "package.json"));
        if (packageJson)
          return {
            rootPath: dir,
            packageJson,
            packageRelativePath: path.relative(dir, file),
          };
        dir = path.dirname(dir);
      }
      return null;
    },
    redirectModulePath: (specifier) => specifier,
    unstable_incrementalResolution: false,
    mainFields: ["browser", "main"],
    nodeModulesPaths: [
      path.join(foreign, "node_modules"),
      path.join(app, "node_modules"),
    ],
    originModulePath: path.join(foreign, "entry.js"),
    preferNativePlatform: false,
    resolveAsset: () => null,
    resolveHasteModule: () => null,
    resolveHastePackage: () => null,
    resolveRequest: resolve,
    sourceExts: ["js", "json"],
    unstable_conditionNames: ["require"],
    unstable_conditionsByPlatform: { web: ["browser"] },
    unstable_enablePackageExports: true,
    unstable_logWarning: () => {},
    extraNodeModules: {
      react: path.join(foreign, "node_modules/react"),
      "react-dom": path.join(foreign, "node_modules/react-dom"),
    },
  };
}
describe("actual Metro React singleton resolution", () => {
  it("proves the foreign peer is selected without the app pin", () => {
    expect(resolve(context(), "react", "web")).toMatchObject({
      type: "sourceFile",
      filePath: path.join(foreign, "node_modules/react/index.js"),
    });
  });
  it.each([
    "react",
    "react/jsx-runtime",
    "react/jsx-dev-runtime",
    "react/compiler-runtime",
    "react-dom",
    "react-dom/client",
    "react-dom/server",
  ])(
    "pins %s to the learner, including linked origins and JSX subpaths",
    (name) => {
      const result = config.resolver.resolveRequest(context(), name, "web");
      expect(result.type).toBe("sourceFile");
      expect(result.filePath).toContain(
        path.join(
          app,
          "node_modules",
          name.startsWith("react-dom") ? "react-dom" : "react",
        ) + path.sep,
      );
      expect(result.filePath).not.toContain(foreign);
      if (name === "react-dom/server")
        expect(result.filePath).toBe(
          path.join(app, "node_modules/react-dom/server.browser.js"),
        );
    },
  );
  it("retains conditional react-server exports instead of using Node require resolution", () => {
    const result = config.resolver.resolveRequest(
      { ...context(), unstable_conditionNames: ["react-server"] },
      "react",
      "web",
    );
    expect(result.filePath).toBe(
      path.join(app, "node_modules/react/react.react-server.js"),
    );
  });
  it("does not redirect unrelated React-named dependencies", () => {
    let seen = "";
    const original = context();
    const result = config.resolver.resolveRequest(
      {
        ...original,
        resolveRequest: (ctx: ResolutionContext, name: string) => {
          seen = name;
          expect(ctx.originModulePath).toBe(original.originModulePath);
          return { type: "empty" };
        },
      },
      "react-is",
      "web",
    );
    expect(seen).toBe("react-is");
    expect(result.type).toBe("empty");
  });
});
