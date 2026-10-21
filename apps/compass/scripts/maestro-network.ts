/**
 * "Offline" for Maestro on the iOS simulator. Maestro sets airplane mode only on Android, and the
 * simulator shares the Mac's network, so the iOS runs cut the server instead: this helper stops the local
 * stack's API gateway (the Kong container) and starts it again, as A39 did by hand. Compass then sees a
 * server outage rather than a lost connection: its writes queue, retry with backoff and drain once the
 * gateway answers again.
 *
 *   node --experimental-strip-types scripts/maestro-network.ts serve | offline | online
 *
 * `serve` answers POST /offline and POST /online on 127.0.0.1:NETWORK_HELPER_PORT (default 57158) for
 * .maestro/scripts/network.js. Needs SUPABASE_URL (a local stack only) and SUPABASE_PROJECT_ID, the
 * project_id in that stack's supabase/config.toml. It refuses a container that does not publish the
 * port in SUPABASE_URL, so it can never stop another stack's gateway.
 */
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
};

const url = env("SUPABASE_URL");
const local = /^http:\/\/(127\.0\.0\.1|localhost):(\d+)$/.exec(url);
if (!local) throw new Error("Local stacks only.");
const port = local[2] ?? "";
const container = `supabase_kong_${env("SUPABASE_PROJECT_ID")}`;

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

/** The gateway container must publish this stack's API port; any other container is refused. */
function checkContainer(): void {
  const published = docker("inspect", "--format", "{{json .HostConfig.PortBindings}}", container);
  if (!published.includes(`"HostPort":"${port}"`))
    throw new Error(`${container} does not publish port ${port}; refusing to touch it.`);
}

async function answers(): Promise<boolean> {
  try {
    const res = await fetch(`${url}/auth/v1/health`, { signal: AbortSignal.timeout(2_000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function until(want: boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if ((await answers()) === want) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

export async function offline(): Promise<boolean> {
  checkContainer();
  docker("stop", "--time", "2", container);
  return until(false, 15_000);
}

export async function online(): Promise<boolean> {
  checkContainer();
  docker("start", container);
  return until(true, 60_000);
}

async function serve(): Promise<void> {
  const listenPort = Number(process.env["NETWORK_HELPER_PORT"] ?? "57158");
  const steps: Record<string, () => Promise<boolean>> = { offline, online };
  const server = createServer((req, res) => {
    const step = steps[(req.url ?? "").replace(/^\//, "")];
    if (req.method !== "POST" || !step) {
      res.writeHead(404).end();
      return;
    }
    step().then(
      (ok) =>
        res
          .writeHead(ok ? 200 : 504, { "Content-Type": "application/json" })
          .end(JSON.stringify({ ok })),
      (error: unknown) =>
        res
          .writeHead(500, { "Content-Type": "application/json" })
          .end(JSON.stringify({ ok: false, error: String(error) })),
    );
  });
  server.listen(listenPort, "127.0.0.1");
  // A run that stops part way through must not leave the gateway down.
  const restore = () => {
    try {
      docker("start", container);
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", restore);
  process.on("SIGTERM", restore);
}

const command = process.argv[2];
if (command === "serve") await serve();
else if (command === "offline") console.log((await offline()) ? "offline" : "still answering");
else if (command === "online") console.log((await online()) ? "online" : "not answering yet");
else throw new Error("Usage: maestro-network.ts serve | offline | online");
