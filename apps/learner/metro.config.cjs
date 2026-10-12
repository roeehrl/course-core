const fs = require("node:fs");
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");
const config = getDefaultConfig(__dirname);
const appModules = path.join(__dirname, "node_modules");
const singletonRoots = Object.fromEntries(
  ["react", "react-dom"].map((name) => [
    name,
    fs.realpathSync(
      path.dirname(
        require.resolve(`${name}/package.json`, { paths: [__dirname] }),
      ),
    ),
  ]),
);

// A copied file dependency and a linked development checkout are both supported.
// Only the public visuals package is added; private course content is never watched.
const visualsRoot = fs.realpathSync(
  path.join(appModules, "@course-core/visuals"),
);
config.watchFolders = [...new Set([__dirname, visualsRoot])];
config.resolver.nodeModulesPaths = [appModules];
config.resolver.disableHierarchicalLookup = true;
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  ...singletonRoots,
};
const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, name, platform) => {
  const singleton =
    name === "react" || name.startsWith("react/")
      ? "react"
      : name === "react-dom" || name.startsWith("react-dom/")
        ? "react-dom"
        : undefined;
  const resolve = upstream ?? context.resolveRequest;
  if (!singleton) return resolve(context, name, platform);

  // extraNodeModules alone is only a fallback in Metro. Resolve bare React
  // imports from the app with exclusive search paths, including JSX subpaths.
  // Delegate to Metro so browser/react-server export conditions stay intact.
  const result = resolve(
    {
      ...context,
      originModulePath: path.join(__dirname, "index.ts"),
      allowHaste: false,
      disableHierarchicalLookup: true,
      nodeModulesPaths: [appModules],
      extraNodeModules: { ...context.extraNodeModules, ...singletonRoots },
    },
    name,
    platform,
  );
  const expected = singletonRoots[singleton] + path.sep;
  if (
    result.type !== "sourceFile" ||
    !fs.realpathSync(result.filePath).startsWith(expected)
  ) {
    throw new Error(
      `Metro must resolve ${name} from the learner's ${singleton} package`,
    );
  }
  return result;
};
module.exports = config;
