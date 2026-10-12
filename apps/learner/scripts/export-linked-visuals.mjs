// Exercise Metro against the public package's own development peers. All
// mutations stay in the learner; always restore its installed copied package.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const app = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));
const manifest = JSON.parse(
  fs.readFileSync(path.join(app, "package.json"), "utf8"),
);
const dependency = manifest.dependencies["@course-core/visuals"];
if (dependency !== "file:../../packages/visuals")
  throw new Error("Expected the declared public visuals file dependency");
const source = fs.realpathSync(path.resolve(app, dependency.slice(5)));
const installed = path.join(app, "node_modules/@course-core/visuals");
if (fs.lstatSync(installed).isSymbolicLink())
  throw new Error("Install the copied visuals dependency before this check");
if (
  JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"))
    .name !== "@course-core/visuals"
)
  throw new Error("Unexpected package");
// Fail before altering resolution if the copy hasn't been refreshed after a build.
for (const entry of fs.readdirSync(path.join(source, "dist"))) {
  if (!fs.statSync(path.join(source, "dist", entry)).isFile()) continue;
  if (
    !fs
      .readFileSync(path.join(source, "dist", entry))
      .equals(fs.readFileSync(path.join(installed, "dist", entry)))
  )
    throw new Error(
      `Refresh the learner's visuals copy first: dist/${entry} differs`,
    );
}
const appReact = require("react/package.json").version;
const peerReact = createRequire(path.join(source, "package.json"))(
  "react/package.json",
).version;
console.log(
  `Linked visuals export: learner React ${appReact}; public package dev React ${peerReact}`,
);
const scratchRoot = path.join(app, ".expo");
fs.mkdirSync(scratchRoot, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchRoot, "visual-peer-check-"));
const backup = path.join(scratch, "installed-visuals");
let child;
let interrupted = false;
const stop = () => {
  interrupted = true;
  child?.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
fs.renameSync(installed, backup);
try {
  fs.symlinkSync(source, installed, "dir");
  await new Promise((resolve, reject) => {
    child = spawn(
      process.execPath,
      [
        require.resolve("expo/bin/cli"),
        "export",
        "--platform",
        "web",
        "--clear",
        "--source-maps",
      ],
      { cwd: app, stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 && !interrupted
        ? resolve()
        : reject(new Error(`Linked export failed (${signal ?? code})`)),
    );
  });
  const sources = [];
  function inspect(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) inspect(file);
      else if (entry.name.endsWith(".map")) {
        const map = JSON.parse(fs.readFileSync(file, "utf8"));
        sources.push(
          ...map.sources.map((name, index) => ({
            name,
            content: map.sourcesContent[index],
          })),
        );
      }
    }
  }
  inspect(path.join(app, "dist"));
  const reactSources = sources.filter((s) =>
    /(?:^|\/)node_modules\/(?:react|react-dom)\//.test(s.name),
  );
  if (!reactSources.length)
    throw new Error("Export source maps contained no React modules");
  for (const { name, content } of reactSources) {
    // Expo's maps use project-relative paths with a leading slash, including
    // /../../packages/... for a linked package outside the application root.
    if (!/^\/?node_modules\/(?:react|react-dom)\//.test(name))
      throw new Error(`Foreign React in export: ${name}`);
    const resolved = path.resolve(app, name.replace(/^\//, ""));
    if (content !== fs.readFileSync(resolved, "utf8"))
      throw new Error(
        `Bundled React source differs from learner install: ${name}`,
      );
  }
  if (
    !sources.some(
      ({ name }) => name === "/../../packages/visuals/dist/react.js",
    )
  )
    throw new Error("Export did not exercise the linked public React renderer");
  console.log(
    `Verified ${reactSources.length} bundled React/React DOM modules resolve inside the learner.`,
  );
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  // Only remove the symlink created by this script, never another install.
  if (fs.existsSync(installed)) {
    if (
      !fs.lstatSync(installed).isSymbolicLink() ||
      fs.realpathSync(installed) !== source
    )
      throw new Error(
        `Cannot restore visuals: installed path changed concurrently; backup is ${backup}`,
      );
    fs.unlinkSync(installed);
  }
  fs.renameSync(backup, installed);
  fs.rmdirSync(scratch);
}
