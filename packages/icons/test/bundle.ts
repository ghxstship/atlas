import { build } from "vite";
import type { Rollup } from "vite";

/** Icon names (kebab-case, as lucide-react stores them) present in a bundle's icon data objects. */
export function bundledIconNames(code: string): Set<string> {
  return new Set([...code.matchAll(/name: "([a-z0-9-]+)",\s*size: 24,/g)].map((m) => m[1] ?? ""));
}

/** Bundles one entry for production with React external and returns the unminified code. */
export async function bundle(entry: string): Promise<string> {
  const result = await build({
    configFile: false,
    logLevel: "silent",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      write: false,
      minify: false,
      lib: { entry, formats: ["es"], fileName: "bundle" },
      rollupOptions: { external: ["react", "react/jsx-runtime", "react-dom"] },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]) as Rollup.RollupOutput[];
  return outputs
    .flatMap((o) => o.output)
    .map((chunk) => (chunk.type === "chunk" ? chunk.code : ""))
    .join("\n");
}
