import { isMain } from './is-main.mjs';
import { execFileSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODULES, ROOT, ensure, readJson, requireNode26 } from './modules.mjs';
import { auditDependencies, auditFilename, auditLocalInstallMode, auditNpmrc, auditText } from './public-policy.mjs';
import { resolveModuleGraph } from './dependency-graph.mjs';

export async function auditPublic(root = ROOT, modules = Object.keys(MODULES)) {
  requireNode26();
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  }).split('\0').filter(Boolean))];
  for (const filename of files) {
    ensure(!path.isAbsolute(filename) && filename.split('/').every((part) => part !== '..'), 'Unsafe source inventory path');
    auditFilename(filename);
    const entry = await lstat(path.join(root, filename));
    ensure(entry.isFile() && !entry.isSymbolicLink(), `${filename}: symlinks, submodules, and special files are not public source inputs`);
    ensure(entry.size <= 5 * 1024 * 1024, `${filename}: source file exceeds the review size limit`);
    const bytes = await readFile(path.join(root, filename));
    if (bytes.includes(0)) {
      ensure(/\.(?:png|jpe?g|gif|webp|ico|woff2?)$/i.test(filename), `${filename}: unapproved binary source file`);
      continue;
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    auditText(filename, text);
    if (path.basename(filename) === '.npmrc') auditNpmrc(filename, text);
  }
  const graph = await resolveModuleGraph(modules, { root });
  for (const name of graph.order) {
    const { directory, manifest } = graph.modules.get(name);
    const lock = await readJson(path.join(directory, 'package-lock.json'));
    auditDependencies(manifest, lock, directory, root, MODULES[name].directory);
    let npmrc = '';
    try { npmrc = await readFile(path.join(directory, '.npmrc'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    auditLocalInstallMode(name, lock, npmrc);
  }
  console.log(`Public audit passed: ${files.length} source files and ${graph.order.length} required standalone dependency locks (${graph.order.join(', ')}). No SDK release availability or application acceptance is implied.`);
}
if (isMain(import.meta.url)) {
  auditPublic().catch((error) => { console.error(`Public audit failed: ${error.message}`); process.exitCode = 1; });
}
