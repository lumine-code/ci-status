"use strict";

// Run one shard of the plan produced by `plan-specs.js`.
//
// Each package is cloned at its resolved ref, its dependencies installed, and
// its Jasmine suite run inside the prebuilt editor checkout — the same
// invocation every package's own CI uses, so a failure here means the same
// thing it would there. The checkout is discarded afterwards: a hundred package
// trees with their `node_modules` do not fit on a runner.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

function parseArguments(argv) {
  const options = {
    plan: "plan.json",
    shard: 0,
    editor: null,
    out: null,
    timeout: 900,
    workspace: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value.`);
      index += 1;
      return value;
    };
    if (argument === "--plan") options.plan = next();
    else if (argument === "--shard") options.shard = Number(next());
    else if (argument === "--editor") options.editor = next();
    else if (argument === "--out") options.out = next();
    else if (argument === "--timeout") options.timeout = Number(next());
    else if (argument === "--workspace") options.workspace = next();
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isInteger(options.shard) || options.shard < 0) {
    throw new Error("--shard must be a non-negative integer.");
  }
  if (!Number.isInteger(options.timeout) || options.timeout < 1) {
    throw new Error("--timeout must be a positive number of seconds.");
  }
  if (!options.editor) throw new Error("--editor <path> is required.");
  // Every platform's shard 0 writes a file; name it after the platform too, so
  // the results survive being collected into one directory.
  const platform = (process.env.RUNNER_OS || process.platform).toLowerCase();
  options.out = options.out || `results/shard-${platform}-${options.shard}.json`;
  return options;
}

const PLATFORM = process.env.RUNNER_OS || process.platform;

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, {
    cwd,
    env: env || process.env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) return { code: 1, message: result.error.message };
  if (result.status !== 0) {
    return { code: result.status === null ? 1 : result.status, message: `${command} failed` };
  }
  return { code: 0 };
}

// Every runner has bash on PATH, but a local Windows run does not: `npm run`
// goes through cmd, which knows nothing of Git's bash. Fall back to where Git
// for Windows installs it, so the same command works from PowerShell, cmd and
// a POSIX shell alike.
let resolvedBash = null;
function bash() {
  if (resolvedBash) return resolvedBash;
  const candidates = ["bash"];
  if (process.platform === "win32") {
    for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramW6432]) {
      if (base) candidates.push(path.join(base, "Git", "bin", "bash.exe"));
    }
  }
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["-c", "exit 0"]);
    if (!probe.error && probe.status === 0) {
      resolvedBash = candidate;
      return resolvedBash;
    }
  }
  throw new Error(
    "No bash found. The sweep drives npm and the spec timeout through it; " +
      "on Windows, install Git for Windows or run from a shell that has bash on PATH.",
  );
}

// npm is a `.cmd` shim on Windows, which Node refuses to spawn directly, and
// the spec run wants a `timeout` guard in front of it. Both are simplest
// through a shell.
function shell(command, cwd, env) {
  const result = spawnSync(bash(), ["-c", command], {
    cwd,
    env: env || process.env,
    stdio: "inherit",
  });
  if (result.error) return { code: 1, message: result.error.message };
  return { code: result.status === null ? 1 : result.status };
}

function capture(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  return result.status === 0 ? String(result.stdout).trim() : null;
}

function has(command) {
  return spawnSync(bash(), ["-c", `command -v ${command} >/dev/null 2>&1`]).status === 0;
}

function quote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function group(title, body) {
  process.stdout.write(`::group::${title}\n`);
  try {
    return body();
  } finally {
    process.stdout.write("::endgroup::\n");
  }
}

function remove(target) {
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
}

// A clone and an install are each one network round trip from a shared runner,
// and a single unlucky one — a TLS handshake that fails, a registry that
// rate-limits — reports a package as broken until the next sweep. Try again,
// and say on the run's summary that it was retried: a package that is genuinely
// unreachable still fails, with the message of its last attempt.
function withRetries(label, attempts, body) {
  let result;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = body();
    if (result.code === 0) {
      if (attempt > 1) {
        process.stdout.write(`::notice title=${label}::succeeded on attempt ${attempt}\n`);
      }
      return result;
    }
    if (attempt < attempts) {
      process.stdout.write(
        `::warning title=${label}::attempt ${attempt} of ${attempts} failed (${result.message}); retrying\n`,
      );
    }
  }
  return result;
}

function checkout(entry, directory) {
  remove(directory);
  if (entry.refType === "commit") {
    fs.mkdirSync(directory, { recursive: true });
    const steps = [
      ["init", "--quiet"],
      ["remote", "add", "origin", entry.cloneUrl],
      ["fetch", "--depth", "1", "--quiet", "origin", entry.ref],
      ["checkout", "--quiet", "--detach", "FETCH_HEAD"],
    ];
    for (const args of steps) {
      const result = run("git", args, directory);
      if (result.code !== 0) return result;
    }
    return { code: 0 };
  }
  return run("git", [
    "clone",
    "--depth",
    "1",
    "--quiet",
    "--branch",
    entry.ref,
    entry.cloneUrl,
    directory,
  ]);
}

// Not `--ignore-scripts`: npm's allow-scripts gate already blocks every
// dependency hook a repository has not approved in its own `allowScripts`, so
// this runs what a package deliberately signed off and nothing else. No planned
// repository has an install hook of its own, so the gate is the whole story.
// Skipping wholesale instead would install a git-hosted fork whose `prepare` is
// what emits its entry point without a `main` -- the same reason the editor's
// own install in the workflow does not skip either.
function install(directory) {
  const lockfile = fs.existsSync(path.join(directory, "package-lock.json"));
  const args = lockfile
    ? "ci --no-audit --no-fund"
    : "install --no-audit --no-fund --no-package-lock";
  const result = shell(`npm ${args}`, directory);
  if (result.code === 0) return result;
  return { ...result, message: result.message || `npm ${args.split(" ")[0]} failed` };
}

// A `binding.gyp` is what marks a dependency as node-gyp native. Scoped
// packages nest one level deeper, so look through both shapes.
function findNativeModules(directory) {
  const root = path.join(directory, "node_modules");
  if (!fs.existsSync(root)) return [];
  const found = [];
  const consider = (candidate) => {
    if (fs.existsSync(path.join(candidate, "binding.gyp"))) found.push(candidate);
  };
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const target = path.join(root, entry.name);
    if (entry.name.startsWith("@")) {
      for (const scoped of fs.readdirSync(target, { withFileTypes: true })) {
        if (scoped.isDirectory()) consider(path.join(target, scoped.name));
      }
    } else {
      consider(target);
    }
  }
  return found;
}

// The specs run inside the editor, so a package's own native dependency has to
// match Electron's ABI rather than Node's, and the install above either built it
// against Node or left it unbuilt. `--force` settles both: rebuild with the
// editor's own electron-rebuild, at the editor's Electron version — the same
// step the editor runs over its own tree. Without it a V8-facing addon fails to
// load with a NODE_MODULE_VERSION mismatch.
function rebuildNativeModules(directory, editorDirectory) {
  const native = findNativeModules(directory);
  if (native.length === 0) return { code: 0 };

  const manifest = JSON.parse(
    fs.readFileSync(path.join(editorDirectory, "package.json"), "utf8"),
  );
  const version = manifest.electronVersion;
  if (!version) return { code: 1, message: "the editor declares no electronVersion" };

  const binary = path.join(editorDirectory, "node_modules", ".bin", "electron-rebuild");
  if (!fs.existsSync(binary)) {
    return { code: 1, message: "the editor has no electron-rebuild to build against" };
  }

  const names = native.map((entry) => path.basename(entry)).join(", ");
  process.stdout.write(`Rebuilding for Electron ${version}: ${names}\n`);
  const result = shell(
    `${quote(binary)} --version ${quote(version)} --module-dir ${quote(directory)} --force`,
    directory,
  );
  if (result.code !== 0) {
    return { ...result, message: result.message || `electron-rebuild failed for ${names}` };
  }
  return { code: 0 };
}

// Specs may activate packages the editor no longer bundles; the package names
// them in a top-level `specPackages` manifest array, and the editor's own
// provisioning script clones each one into this run's private LUMINE_HOME. The
// names then travel to the test bootstrap through LUMINE_TEST_PACKAGES, which
// is what links them into the scratch config directory a spec run builds.
function specPackagesOf(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
  return manifest.specPackages || [];
}

function installSpecPackages(directory, editorDirectory, home) {
  const script = path.join(editorDirectory, "script", "install-spec-packages.js");
  if (!fs.existsSync(script)) {
    return { code: 1, message: "the editor has no install-spec-packages.js to provision with" };
  }
  // The script does its own clone and install retries, so no withRetries here.
  return run(process.execPath, [script, "--package", directory, "--home", home]);
}

function runSpecs(specDirectory, editorDirectory, options, environment) {
  const prefix = [];
  // macOS runners ship no GNU `timeout`; Homebrew's coreutils calls it
  // `gtimeout`. Without either, the job's own timeout is the backstop.
  if (has("timeout")) prefix.push("timeout", "--kill-after=30s", `${options.timeout}s`);
  else if (has("gtimeout")) prefix.push("gtimeout", "--kill-after=30s", `${options.timeout}s`);
  if (process.platform === "linux") prefix.push("xvfb-run", "--auto-servernum");
  const command = `${prefix.join(" ")} npm start -- --test ${quote(specDirectory)}`.trim();
  const result = shell(command, editorDirectory, environment);
  const { code } = result;
  if (result.message) return result;
  // `timeout` reports 124 when it had to fire, which is a hang rather than a
  // failing expectation and worth naming as one in the summary.
  if (code === 124 || code === 137) {
    return { code, message: `timed out after ${options.timeout}s` };
  }
  return code === 0 ? { code: 0 } : { code, message: `specs failed (exit ${code})` };
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const plan = JSON.parse(fs.readFileSync(options.plan, "utf8"));
  const editorDirectory = path.resolve(options.editor);
  const workspace = path.resolve(
    options.workspace || path.join(process.env.RUNNER_TEMP || os.tmpdir(), "lumine-specs"),
  );
  const entries = plan.packages.filter((entry) => entry.shard === options.shard);

  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });

  const results = [];
  for (const entry of entries) {
    const directory = path.join(workspace, "checkout", entry.name);
    // A private LUMINE_HOME per package: nothing one suite writes to the config
    // directory can reach the next one in the shard.
    const home = path.join(workspace, "home", entry.name);
    const startedAt = Date.now();
    const record = {
      name: entry.name,
      source: entry.source,
      ref: entry.ref,
      refType: entry.refType,
      sha: entry.sha,
      platform: PLATFORM,
      status: "passed",
      message: null,
    };

    group(`${entry.name} (${entry.refType} ${entry.ref})`, () => {
      remove(home);
      fs.mkdirSync(home, { recursive: true });

      const cloned = withRetries(`${entry.name} checkout`, 3, () => checkout(entry, directory));
      if (cloned.code !== 0) {
        record.status = "error";
        record.message = `checkout failed: ${cloned.message}`;
        return;
      }
      record.sha = capture("git", ["rev-parse", "HEAD"], directory) || entry.sha;

      const specDirectory = path.join(directory, "spec");
      if (!fs.existsSync(specDirectory)) {
        record.status = "skipped";
        record.message = "no spec directory";
        return;
      }

      const installed = withRetries(`${entry.name} install`, 3, () => install(directory));
      if (installed.code !== 0) {
        record.status = "error";
        record.message = `install failed: ${installed.message}`;
        return;
      }

      const rebuilt = rebuildNativeModules(directory, editorDirectory);
      if (rebuilt.code !== 0) {
        record.status = "error";
        record.message = `native rebuild failed: ${rebuilt.message}`;
        return;
      }

      const specPackages = specPackagesOf(directory);
      if (specPackages.length > 0) {
        const provisioned = installSpecPackages(directory, editorDirectory, home);
        if (provisioned.code !== 0) {
          record.status = "error";
          record.message = `spec packages failed: ${provisioned.message}`;
          return;
        }
      }

      const environment = {
        ...process.env,
        LUMINE_HOME: home,
        LUMINE_JASMINE_REPORTER: "list",
      };
      if (specPackages.length > 0) {
        environment.LUMINE_TEST_PACKAGES = specPackages.join(" ");
      }
      const specs = runSpecs(specDirectory, editorDirectory, options, environment);
      if (specs.code !== 0) {
        record.status = "failed";
        record.message = specs.message;
      }
    });

    record.durationMs = Date.now() - startedAt;
    results.push(record);
    if (record.status === "failed" || record.status === "error") {
      process.stdout.write(`::error title=${entry.name}::${record.message}\n`);
    }
    // Reclaim the disk before the next package: a shard's worth of package
    // trees with their dependencies would otherwise fill the runner.
    remove(directory);
    remove(home);
  }

  fs.writeFileSync(
    path.resolve(options.out),
    `${JSON.stringify({ shard: options.shard, platform: PLATFORM, results }, null, 2)}\n`,
  );

  const failed = results.filter(
    (result) => result.status === "failed" || result.status === "error",
  );
  process.stdout.write(
    `${PLATFORM} shard ${options.shard}: ${results.length} packages, ${failed.length} failing.\n`,
  );
  // The shard always writes its results and always exits zero; the summary job
  // is what turns the fleet's outcome into the run's outcome, so one broken
  // package cannot hide the ones that follow it in a later shard.
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}
