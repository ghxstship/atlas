/** What every command receives: parsed global flags, the config and a client factory. */
import { XosClient } from "@ghxstship/xos-sdk";
import type { Config, ResolvedCredentials } from "./config.ts";
import { configPath, readConfig, resolveCredentials } from "./config.ts";
import type { Io } from "./io.ts";
import type { OutputFormat } from "./output.ts";

export interface GlobalFlags {
  readonly profile?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly output?: string | undefined;
}

export interface Context {
  readonly io: Io;
  readonly flags: GlobalFlags;
  readonly format: OutputFormat;
  readonly configFile: string;
  config(): Config;
  credentials(): ResolvedCredentials;
  client(credentials?: { readonly baseUrl: string; readonly apiKey: string }): XosClient;
}

export function createContext(io: Io, flags: GlobalFlags, format: OutputFormat): Context {
  const configFile = configPath(io.env);
  return {
    io,
    flags,
    format,
    configFile,
    config: () => readConfig(configFile),
    credentials() {
      return resolveCredentials(readConfig(configFile), io.env, flags);
    },
    client(credentials) {
      const c = credentials ?? resolveCredentials(readConfig(configFile), io.env, flags);
      return new XosClient({
        baseUrl: c.baseUrl,
        apiKey: c.apiKey,
        ...(io.fetch ? { fetch: io.fetch } : {}),
        ...(io.sleep ? { sleep: io.sleep } : {}),
      });
    },
  };
}
