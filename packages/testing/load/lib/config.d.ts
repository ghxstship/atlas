// Types for config.js, so the unit tests can check it against src/budgets.ts.
export declare const SLO: {
  readP95: number;
  writeP95: number;
  p99: number;
  syncP95: number;
};
export declare const TARGETS: {
  platformUsers: number;
  tenantUsers: number;
  compassDevices: number;
};
export declare const SMOKE: typeof TARGETS;
export interface LoadEnv {
  mode: "smoke" | "full";
  supabaseUrl: string;
  atlasUrl: string;
  anonKey: string;
  password: string;
  users: string[];
  scale: typeof TARGETS;
  duration: string;
}
export declare function loadEnv(env: Record<string, string | undefined>): LoadEnv;
export declare function rampingScenario(
  vus: number,
  duration: string,
  exec: string,
): {
  executor: string;
  exec: string;
  startVUs: number;
  stages: { duration: string; target: number }[];
  gracefulRampDown: string;
};
export declare function parseDuration(text: string): number;
export declare function apiThresholds(): Record<string, string[]>;
