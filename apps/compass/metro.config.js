// Metro for the Compass app inside the pnpm workspace.
// Workspace packages (@xos/ui-native, @xos/sync, @xos/i18n) are imported as TypeScript source, and some of
// them carry their own React for tests. React Native needs exactly one React, matching its renderer, so
// react and react-native always resolve to this app's copies (ADR 0001 deviation 6).
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");
const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

const single = new Set(["react", "react-native", "react/jsx-runtime", "react/jsx-dev-runtime"]);
const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const base = moduleName
    .split("/")
    .slice(0, moduleName.startsWith("@") ? 2 : 1)
    .join("/");
  if (single.has(moduleName) || base === "react" || base === "react-native") {
    return context.resolveRequest(
      { ...context, originModulePath: path.join(projectRoot, "package.json") },
      moduleName,
      platform,
    );
  }
  return upstream
    ? upstream(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
