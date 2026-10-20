import { writeFile } from "node:fs/promises";
import { runCli } from "./cli-main.js";

process.exitCode = await runCli(process.argv.slice(2), process.env, {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  writeFile: (file, text) => writeFile(file, text, { mode: 0o600 }),
});
