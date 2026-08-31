"use strict";

// Run the whole sweep locally: plan, every shard in turn, then summarize.
//
// CI gives every package and platform its own job. Locally there is one machine,
// so running those jobs one by one would repeat setup without adding isolation.
// This driver keeps the local shard mode, then summarizes every result at once.
//
// It shells out to the same scripts rather than importing them, so a local run
// exercises exactly what a runner exercises.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const HERE = __dirname;

function parseArguments(argv) {
  const options = {
    editor: null,
    only: [],
    shards: 1,
    ref: "master",
    plan: "plan.json",
    results: "results",
    keep: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value.`);
      index += 1;
      return value;
    };
    if (argument === "--editor") options.editor = next();
    else if (argument === "--only") options.only.push(next());
    else if (argument === "--shards") options.shards = Number(next());
    else if (argument === "--ref") options.ref = next();
    else if (argument === "--keep") options.keep = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isInteger(options.shards) || options.shards < 1) {
    throw new Error("--shards must be a positive integer.");
  }
  if (!options.help && !options.editor) throw new Error("--editor <path> is required.");
  return options;
}

const USAGE = `
Usage: npm run spec -- [options]

  --only <patterns>   Packages to sweep; globs allowed, repeatable.
                      Defaults to every package in the organization.
  --editor <path>     Editor checkout to run the specs inside (required).
  --shards <n>        Split the work over n shards, run one after another (1).
  --ref <branch>      The branch of each package to sweep (master).
  --keep              Keep plan.json and results/ from the previous run.

Examples:
  npm run spec -- --editor /path/to/lumine --only "minimap scrollmap"
  npm run spec -- --editor /path/to/lumine --only "language-*"
`.trim();

function step(scriptName, args) {
  const label = `node scripts/${scriptName} ${args.join(" ")}`;
  process.stdout.write(`\n[1m→ ${label}[0m\n`);
  const result = spawnSync(process.execPath, [path.join(HERE, scriptName), ...args], {
    stdio: "inherit",
    cwd: path.join(HERE, ".."),
  });
  if (result.error) throw result.error;
  return result.status === null ? 1 : result.status;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const root = path.join(HERE, "..");
  const editor = path.resolve(root, options.editor);
  if (!fs.existsSync(path.join(editor, "package.json"))) {
    throw new Error(
      `No editor checkout at ${editor}. Pass --editor <path> to point at one.`,
    );
  }

  // A stale plan or a stale result file is the one way this pipeline lies:
  // summarize would happily report a package the current run never touched.
  if (!options.keep) {
    fs.rmSync(path.join(root, options.plan), { force: true });
    fs.rmSync(path.join(root, options.results), {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  }

  const planArgs = ["--out", options.plan, "--shards", String(options.shards), "--ref", options.ref];
  for (const pattern of options.only) planArgs.push("--only", pattern);
  if (step("plan-specs.js", planArgs) !== 0) {
    throw new Error("Planning failed; nothing was swept.");
  }

  const plan = JSON.parse(fs.readFileSync(path.join(root, options.plan), "utf8"));
  if (plan.packages.length === 0) {
    process.stdout.write("\nNo packages matched; nothing to sweep.\n");
    return;
  }

  // Local shards never fail for an individual suite: each records everything it
  // got through, then the summary decides the overall outcome. A shard that dies
  // outright is caught too, as a package nothing reported on.
  for (let shard = 0; shard < plan.shards; shard += 1) {
    step("run-specs.js", [
      "--plan",
      options.plan,
      "--shard",
      String(shard),
      "--editor",
      editor,
    ]);
  }

  process.exitCode = step("summarize-specs.js", [
    "--results",
    options.results,
    "--plan",
    options.plan,
  ]);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
