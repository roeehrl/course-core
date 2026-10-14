// Hermetic Expo dependency check.
//
// `expo install --check` normally asks Expo's online API for the newest patch of
// the SDK, so an upstream publish turns CI red without any change here. In
// offline mode the CLI validates against `expo/bundledNativeModules.json` of the
// lockfile-installed expo package instead. This script runs that mode with all
// outbound sockets refused, then proves on a synthetic fixture that a genuinely
// mismatched local dependency still fails the check.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const expoCli = path.join(appRoot, "node_modules/expo/bin/cli");
const blocker = path.join(appRoot, "scripts/no-network.cjs");

function fail(message) {
  console.error(`check:expo: ${message}`);
  process.exit(1);
}

export function runOfflineCheck(cwd) {
  const networkLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "expo-check-net-")), "attempts.log");
  const nodeOptions = [process.env.NODE_OPTIONS, `--require=${blocker}`].filter(Boolean).join(" ");
  const result = spawnSync(process.execPath, [expoCli, "install", "--check", "--json"], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      EXPO_OFFLINE: "1",
      EXPO_NO_TELEMETRY: "1",
      CI: "1",
      NODE_OPTIONS: nodeOptions,
      COURSE_CORE_NETWORK_LOG: networkLog,
    },
  });
  const attempts = fs.existsSync(networkLog) ? fs.readFileSync(networkLog, "utf8").trim() : "";
  fs.rmSync(path.dirname(networkLog), { recursive: true, force: true });
  if (attempts) fail(`expo attempted network access in offline mode:\n${attempts}`);
  const output = `${result.stdout}${result.stderr}`;
  const start = result.stdout.search(/^\{/m);
  let report;
  try {
    report = JSON.parse(result.stdout.slice(start));
  } catch {
    fail(`no JSON report from expo (exit ${result.status}):\n${output}`);
  }
  if (start < 0 || typeof report?.upToDate !== "boolean") fail(`no JSON report from expo (exit ${result.status}):\n${output}`);
  return { status: result.status, report, output };
}

function selfTestMismatch() {
  const bundled = JSON.parse(fs.readFileSync(path.join(appRoot, "node_modules/expo/bundledNativeModules.json"), "utf8"));
  const name = "react-native-safe-area-context";
  const expected = bundled[name];
  if (!expected) fail(`${name} is not in the installed expo dependency map`);
  const expoVersion = JSON.parse(fs.readFileSync(path.join(appRoot, "node_modules/expo/package.json"), "utf8")).version;
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "expo-check-fixture-"));
  try {
    const wrong = "0.0.1";
    fs.writeFileSync(
      path.join(fixture, "package.json"),
      JSON.stringify({ name: "expo-check-fixture", private: true, dependencies: { expo: expoVersion, [name]: wrong } }),
    );
    fs.mkdirSync(path.join(fixture, "node_modules", name), { recursive: true });
    fs.symlinkSync(path.join(appRoot, "node_modules/expo"), path.join(fixture, "node_modules/expo"), "dir");
    fs.writeFileSync(path.join(fixture, "node_modules", name, "package.json"), JSON.stringify({ name, version: wrong }));
    const { status, report, output } = runOfflineCheck(fixture);
    const flagged = report.dependencies?.find((entry) => entry.packageName === name);
    if (status === 0 || report.upToDate !== false || !flagged) {
      fail(`offline check did not reject ${name}@${wrong} (expected ${expected}):\n${output}`);
    }
    console.log(`check:expo: self-test rejected ${name}@${wrong} (expected ${flagged.expectedVersionOrRange})`);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!fs.existsSync(expoCli)) fail("expo is not installed; run the learner install first");
  selfTestMismatch();
  const { status, report, output } = runOfflineCheck(appRoot);
  if (status !== 0 || report.upToDate !== true) fail(`learner dependencies do not match the installed expo SDK:\n${output}`);
  console.log("check:expo: learner dependencies match the lockfile-installed expo dependency map");
}
