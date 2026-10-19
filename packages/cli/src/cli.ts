/** Command dispatch, help and error reporting for `xos`. */
import {
  API_VERSION,
  XosApiError,
  XosAuthenticationError,
  XosError,
  XosNotFoundError,
  XosRefusalError,
} from "@xos/sdk";
import { orgCurrent, orgList, orgUse, login, logout, status } from "./commands/auth.ts";
import { canonCommand } from "./commands/canon.ts";
import { call, listOperations, listResources, resourceCommand } from "./commands/resources.ts";
import { exportCommand, importCommand } from "./commands/transfer.ts";
import { webhooksCommand } from "./commands/webhooks.ts";
import type { GlobalFlags } from "./context.ts";
import { createContext } from "./context.ts";
import type { Io } from "./io.ts";
import { EXIT, UsageError } from "./io.ts";
import { outputFormat } from "./output.ts";

export const CLI_VERSION = "4.0.0";

export const HELP = `xos: command line for the XOS public API (v${API_VERSION})

Usage: xos [--profile NAME] [--base-url URL] [--output json|table] <command> [...]

Sign in and choose an organization
  auth login --base-url URL [--key-stdin]   Save an API key (from XOS_API_KEY or stdin) as a profile
  auth status                               Show who the current credential acts as
  auth logout                               Forget the current profile
  org list [--remote]                       Profiles (one per organization), or organizations visible to the key
  org use PROFILE                           Make a profile the default
  org current                               Show the active profile and organization

Work with resources
  resources [--tag MODULE]                  List every resource and its operations
  ops RESOURCE                              List the operations of one resource
  RESOURCE VERB [PATH...] [flags]           Call an operation, for example: xos projects list
  call OPERATION_ID [PATH...] [flags]       Call an operation by id, for example: xos call projects.get ID
    --filter field.op=value  --fields a,b  --sort -a,b  --limit N  --cursor C  --all
    --data JSON|@file|-  --if-match ETAG|auto  --idempotency-key KEY  --query name=value

Import and export
  export RESOURCE [--format ndjson|json|csv] [--out FILE] [--filter ...]
  export job create --data JSON|@file | export job status ID
  import RESOURCE --file rows.csv|.ndjson|.json [--dry-run] [--stop-on-error]
  import job create --data JSON|@file
  import job dry-run ID | commit ID | status ID
  import undo BATCH_ID

Canon and webhooks
  canon validate --file FILE [--column name=canonResource]
  webhooks sign|verify|send --file BODY (--secret-env NAME | --secret-stdin) [...]
  webhooks events | webhooks replay DELIVERY_ID

Environment: XOS_API_KEY, XOS_BASE_URL and XOS_PROFILE override the saved profile.
Exit codes: 0 ok, 1 failed, 2 usage, 3 not signed in or key rejected, 4 not found, 5 refused.
`;

const GLOBAL_WITH_VALUE = new Map([
  ["--profile", "profile"],
  ["--base-url", "baseUrl"],
  ["--output", "output"],
  ["-o", "output"],
]);

/** Pulls global flags out of argv, wherever they appear. */
export function splitGlobals(argv: readonly string[]): {
  flags: GlobalFlags;
  rest: string[];
  help: boolean;
  version: boolean;
} {
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  let help = false;
  let version = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const [name, inline] =
      arg.startsWith("--") && arg.includes("=")
        ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
        : [arg, undefined];
    const key = GLOBAL_WITH_VALUE.get(name);
    if (key) {
      const value = inline ?? argv[++i];
      if (value === undefined) throw new UsageError(`${name} needs a value.`);
      flags[key] = value;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--version" || arg === "-v") {
      version = true;
    } else {
      rest.push(arg);
    }
  }
  return { flags, rest, help, version };
}

function describeError(error: XosApiError): string {
  const p = error.problem;
  const lines = [`${p.title} (${error.status})${p.detail ? `: ${p.detail}` : ""}`];
  if (error instanceof XosRefusalError) {
    lines.push(
      `Refused (${error.refusal}): ${error.reason}${error.rule ? ` [rule ${error.rule}]` : ""}`,
    );
  }
  for (const e of p.errors ?? []) lines.push(`  ${e.pointer || "/"} ${e.detail}`);
  if (error instanceof XosAuthenticationError)
    lines.push("Run `xos auth login` with a current API key.");
  return `${lines.join("\n")}\n`;
}

async function dispatch(io: Io, argv: readonly string[]): Promise<number> {
  const { flags, rest, help, version } = splitGlobals(argv);
  if (version) {
    io.stdout(`xos ${CLI_VERSION} (API ${API_VERSION})\n`);
    return EXIT.ok;
  }
  const [command, sub, ...args] = rest;
  if (help || !command || command === "help") {
    io.stdout(HELP);
    return EXIT.ok;
  }
  const ctx = createContext(io, flags, outputFormat(flags.output, io));
  const tail = sub === undefined ? [] : [sub, ...args];
  switch (command) {
    case "auth":
      if (sub === "login") return login(ctx, args);
      if (sub === "status") return status(ctx);
      if (sub === "logout") return logout(ctx);
      throw new UsageError("Use `xos auth login`, `xos auth status` or `xos auth logout`.");
    case "org":
      if (sub === "list") return orgList(ctx, args);
      if (sub === "use") return orgUse(ctx, args);
      if (sub === "current") return orgCurrent(ctx);
      throw new UsageError("Use `xos org list`, `xos org use <profile>` or `xos org current`.");
    case "resources":
      return listResources(ctx, tail);
    case "ops":
      return listOperations(ctx, tail);
    case "call":
      return call(ctx, tail);
    case "export":
      return exportCommand(ctx, tail);
    case "import":
      return importCommand(ctx, tail);
    case "canon":
      return canonCommand(ctx, tail);
    case "webhooks":
      return webhooksCommand(ctx, tail);
    default:
      return resourceCommand(ctx, command, tail);
  }
}

/** Runs one invocation and returns the exit code. Never throws. */
export async function run(io: Io, argv: readonly string[]): Promise<number> {
  try {
    return await dispatch(io, argv);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (
      error instanceof UsageError ||
      (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS_"))
    ) {
      io.stderr(`${(error as Error).message}\nRun \`xos --help\` for usage.\n`);
      return EXIT.usage;
    }
    if (error instanceof XosApiError) {
      io.stderr(describeError(error));
      if (error instanceof XosAuthenticationError) return EXIT.auth;
      if (error instanceof XosNotFoundError) return EXIT.notFound;
      if (error instanceof XosRefusalError) return EXIT.refused;
      return EXIT.failure;
    }
    if (error instanceof XosError || error instanceof TypeError || error instanceof SyntaxError) {
      io.stderr(`${error.message}\n`);
      return EXIT.failure;
    }
    io.stderr(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    return EXIT.failure;
  }
}
