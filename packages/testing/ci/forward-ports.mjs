// Runs a command with local ports forwarded to the Docker host (Section 18, gate 9).
//
//   node forward-ports.mjs <command> [args...]
//
// The core-screen baselines render in mcr.microsoft.com/playwright with the host network, so the
// browser reaches the app and the Supabase stack at the same 127.0.0.1 addresses the app was
// configured with. On a Linux runner that already holds: the container shares the host's network.
// Docker Desktop's host network is its virtual machine's, which reaches the stack's published ports
// but not an app served on the Mac itself; VISUAL_FORWARD_PORTS (space separated) names the ports
// to forward from 127.0.0.1 in the container to host.docker.internal. A port already in use (the
// Linux case) is left alone.
import { spawn } from "node:child_process";
import net from "node:net";
import process from "node:process";

const ports = (process.env.VISUAL_FORWARD_PORTS ?? "").split(/\s+/).filter(Boolean).map(Number);
const target = process.env.VISUAL_FORWARD_HOST ?? "host.docker.internal";

function forward(port) {
  return new Promise((resolve) => {
    const server = net.createServer((client) => {
      const upstream = net.connect(port, target);
      client.pipe(upstream).pipe(client);
      const close = () => {
        client.destroy();
        upstream.destroy();
      };
      client.on("error", close);
      upstream.on("error", close);
    });
    server.once("error", () => resolve(null));
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

const servers = (await Promise.all(ports.map(forward))).filter(Boolean);
for (const server of servers) {
  const { port } = server.address();
  process.stdout.write(`forwarding 127.0.0.1:${port} to ${target}:${port}\n`);
}

const [command, ...args] = process.argv.slice(2);
if (!command) {
  process.stderr.write("usage: node forward-ports.mjs <command> [args...]\n");
  process.exit(2);
}
const child = spawn(command, args, { stdio: "inherit" });
child.on("exit", (code, signal) => {
  for (const server of servers) server.close();
  process.exit(code ?? (signal ? 1 : 0));
});
