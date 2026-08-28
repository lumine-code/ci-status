#!/usr/bin/env node

// Run one Electron spec process in its own process group. The editor reports a
// definitive status after Jasmine has flushed its output; at that point every
// remaining process is an orphaned helper and the whole group can be reaped.

const { spawn, spawnSync } = require("child_process");

function parseArguments(argv) {
  let timeout = 900;
  let cwd = process.cwd();
  let index = 0;
  for (; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      index += 1;
      break;
    }
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value.`);
      index += 1;
      return value;
    };
    if (argument === "--timeout") timeout = Number(next());
    else if (argument === "--cwd") cwd = next();
    else throw new Error(`Unknown argument: ${argument}`);
  }
  const command = argv[index];
  const args = argv.slice(index + 1);
  if (!Number.isInteger(timeout) || timeout < 1) {
    throw new Error("--timeout must be a positive number of seconds.");
  }
  if (!command) throw new Error("A command is required after --.");
  return { timeout, cwd, command, args };
}

function killTree(pid) {
  if (!Number.isInteger(pid)) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], {
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: process.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let result = null;
  let stderrTail = "";

  const finish = (status) => {
    if (result !== null) return;
    result = status;
    clearTimeout(timeout);
    killTree(child.pid);
    setTimeout(() => process.exit(status), 5000).unref();
  };

  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    stderrTail = (stderrTail + chunk.toString()).slice(-4096);
    const match = stderrTail.match(/LUMINE_TEST_EXIT_STATUS=(\d+)/);
    if (match) finish(Number(match[1]));
  });
  child.on("error", (error) => {
    process.stderr.write(`${error.stack || error}\n`);
    finish(1);
  });
  child.on("close", (code) => process.exit(result ?? (code === null ? 1 : code)));

  const timeout = setTimeout(() => finish(124), options.timeout * 1000);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
}
