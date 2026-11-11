// Metro for the Compass app inside the pnpm workspace.
// Workspace packages (@xos/ui-native, @xos/sync, @xos/i18n) are imported as TypeScript source, and some of
// them carry their own React for tests. React Native needs exactly one React, matching its renderer, so
// react and react-native always resolve to this app's copies (ADR 0001 deviation 6).
const { createHash } = require("node:crypto");
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

// The component gallery (app/dev, A141) is for gallery builds only. Unless EXPO_PUBLIC_XOS_GALLERY=1, Metro never
// sees the folder, so no other build, the store builds included, carries the gallery or routes to it.
const galleryRoutes = new RegExp(
  `^${path.join(projectRoot, "app", "dev").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/.*)?$`,
);
if (process.env.EXPO_PUBLIC_XOS_GALLERY !== "1") {
  config.resolver.blockList = [config.resolver.blockList ?? []].flat().concat(galleryRoutes);
}

// EXPO_PUBLIC_* values are inlined into the bundle when a file is transformed, and Metro reuses a cached transform
// whose key does not change, --reset-cache in EXTRA_PACKAGER_ARGS or not. A Release rebuild with a new
// EXPO_PUBLIC_SUPABASE_URL still shipped the previous server URL (C-27). The values are now part of the cache key, as
// a digest, so any change transforms afresh and the same values keep the cache.
const publicEnv = Object.keys(process.env)
  .filter((name) => name.startsWith("EXPO_PUBLIC_"))
  .sort()
  .map((name) => `${name}=${process.env[name]}`)
  .join("\n");
config.cacheVersion = `${config.cacheVersion ?? ""}+public-env-${createHash("sha256")
  .update(publicEnv)
  .digest("hex")
  .slice(0, 16)}`;

module.exports = config;
