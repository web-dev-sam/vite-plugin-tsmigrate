#!/usr/bin/env node
// One command for the tool/plugin dev loop. Runs two long-lived processes and
// keeps their ports in lockstep, so the tool always talks to its own backend —
// even when another playground (or a stale server) is squatting :7357.
//
//   app  — a playground dev server (default `playground`). Its Vite server loads
//          the plugin from source (`../src/index.ts`); the plugin serves the
//          JSON API on the coordinated backend port.
//   tool — the tool UI with hot reload, proxying /api to that same port.
//
// Edit `tool/**` → live HMR. Edit `src/**` → the app's Vite auto-restarts (the
// config imports the plugin from source) and the plugin reclaims its port, so
// the tool reconnects on its next poll. Ctrl-C tears both down.
//
//   TSMIGRATE_PLAYGROUND  which playground to run (default "playground")
//   TSMIGRATE_TOOL_PORT   pin the tool UI port (default: first free from 7358)
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const playground = process.env.TSMIGRATE_PLAYGROUND ?? "playground";

// A free port, preferring `wanted`; if it's taken, let the OS assign one.
function freePort(wanted) {
  return new Promise((resolve) => {
    const grab = (port, onFail) => {
      const srv = createNetServer();
      srv.once("error", onFail);
      srv.listen(port, "127.0.0.1", () => {
        const chosen = srv.address().port;
        srv.close(() => resolve(chosen));
      });
    };
    grab(wanted, () => grab(0, () => resolve(wanted)));
  });
}

const backendPort = await freePort(7357);
const toolPort = process.env.TSMIGRATE_TOOL_PORT ?? String(await freePort(7358));

// Hand both sides the SAME backend port: the playground's plugin binds
// TSMIGRATE_PORT and the tool's Vite proxy targets TSMIGRATE_API. They can't
// disagree, so a stale server on :7357 never orphans the tool.
const childEnv = {
  ...process.env,
  TSMIGRATE_PORT: String(backendPort),
  TSMIGRATE_API: `http://localhost:${backendPort}`,
};

const targets = [
  { name: "app", color: "\x1b[36m", cmd: "vp", args: ["dev"], cwd: join(root, playground) },
  {
    name: "tool",
    color: "\x1b[35m",
    cmd: "vp",
    args: ["exec", "vite", "tool", "--port", String(toolPort)],
    cwd: root,
  },
];

const children = new Map();
let shuttingDown = false;

function prefixer(color, name, out) {
  const tag = `${color}[${name}]\x1b[0m `;
  let buf = "";
  return (chunk) => {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      out.write(tag + line + "\n");
    }
  };
}

function start(target) {
  // `detached` puts each child in its own process group so shutdown can signal
  // the whole Vite tree, not just the `vp` wrapper.
  const child = spawn(target.cmd, target.args, {
    cwd: target.cwd,
    env: childEnv,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.set(target.name, child);
  child.startedAt = Date.now();
  child.stdout.on("data", prefixer(target.color, target.name, process.stdout));
  child.stderr.on("data", prefixer(target.color, target.name, process.stderr));

  child.on("exit", (code, signal) => {
    children.delete(target.name);
    if (shuttingDown) {
      return;
    }
    target.crashes = Date.now() - child.startedAt < 3000 ? (target.crashes ?? 0) + 1 : 0;
    const tag = `${target.color}[${target.name}]\x1b[0m`;
    if (target.crashes >= 5) {
      process.stderr.write(`${tag} crashed 5× immediately — giving up. Fix the error above.\n`);
      shutdown();
      return;
    }
    process.stdout.write(`${tag} exited (${signal ?? code}); restarting…\n`);
    setTimeout(() => start(target), 1000);
  });
}

function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const child of children.values()) {
    try {
      process.kill(-child.pid, "SIGTERM"); // kill the whole process group
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
  }
  setTimeout(() => process.exit(0), 500);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

process.stdout.write(
  `\x1b[1mtsmigrate dev\x1b[0m — tool UI: \x1b[35mhttp://localhost:${toolPort}\x1b[0m · ` +
    `playground: \x1b[36m${playground}\x1b[0m (API on :${backendPort})\n` +
    `edit tool/** → live HMR · edit src/** → app auto-restarts · Ctrl-C stops both\n\n`,
);

for (const target of targets) {
  start(target);
}
