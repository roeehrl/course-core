import { DEPENDENCY_FIELDS, ROOT, ensure, localModuleTarget, readModule } from './modules.mjs';

// The registry is the local allowlist. Never discover a sibling repository or
// infer a directory from an arbitrary dependency name. The SDK stays a release URL.
export async function resolveModuleGraph(selected, { root = ROOT, extraRoots = [] } = {}) {
  const modules = new Map();
  const dependencies = new Map();
  const state = new Map();
  const order = [];
  const stack = [];
  async function visit(name) {
    if (state.get(name) === 'done') return;
    ensure(state.get(name) !== 'visiting', `Local dependency cycle: ${[...stack, name].join(' -> ')}`);
    state.set(name, 'visiting');
    stack.push(name);
    const module = await readModule(name, root);
    modules.set(name, module);
    const direct = new Set();
    for (const field of DEPENDENCY_FIELDS) {
      for (const [packageName, spec] of Object.entries(module.manifest[field] ?? {})) {
        if (typeof spec !== 'string' || !spec.startsWith('file:')) continue;
        const target = localModuleTarget(packageName, spec, module.directory, root);
        ensure(target, `${module.manifest.name}: unapproved local dependency ${packageName}; name and path must match a registered module`);
        direct.add(target);
      }
    }
    const edges = [...direct].sort();
    dependencies.set(name, edges);
    for (const dependency of edges) await visit(dependency);
    stack.pop();
    state.set(name, 'done');
    order.push(name);
  }
  for (const name of new Set([...selected, ...extraRoots])) await visit(name);
  return { modules, dependencies, order };
}
