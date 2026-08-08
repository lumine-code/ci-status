"use strict";

// Stamp `last.log` and commit it, so the sweep that follows has a commit of
// its own to report on.
//
// A check suite binds to the commit that triggered the run, and GitHub shows a
// repository's status as the aggregate of every suite on its HEAD — not the
// latest one. Where HEAD never moves, that aggregate only ever ratchets: one
// red sweep pins the badge red however many green ones follow it, and no push
// to this repository is coming to clear it, because nothing here changes
// between runs.
//
// So move HEAD deliberately. Each sweep is preceded by a stamp, runs against
// the commit that stamp created, and is the only suite attached to it. The
// badge then means the last sweep, which is what anyone reading it assumes.
//
// The order matters and is the whole point: stamping afterwards would leave
// the result on the previous commit and the new one with no status at all.
//
// The push below has to carry a credential of its own — `STAMP_TOKEN` in
// `.github/workflows/stamp.yml`. A push made with `GITHUB_TOKEN` triggers no
// workflow, and starting the sweep any other way does not stand in for it:
// GitHub shows only the suites a `push` raised, so a sweep begun by dispatch
// leaves the stamp it was made for displaying nothing.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const FILE = "last.log";
const AUTHOR_NAME = "github-actions[bot]";
const AUTHOR_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";

function parseArguments(argv) {
  const options = { root: process.cwd(), push: true, now: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value.`);
      index += 1;
      return value;
    };
    if (argument === "--root") options.root = next();
    else if (argument === "--now") options.now = next();
    else if (argument === "--no-push") options.push = false;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout).trim();
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
  return String(result.stdout).trim();
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const root = path.resolve(options.root);
  const target = path.join(root, FILE);

  // Seconds precision, and always UTC: the file exists to differ from its last
  // value, and a local timezone would make consecutive stamps read as though
  // they had gone backwards whenever the runner's zone changed.
  const stamp = (options.now ? new Date(options.now) : new Date()).toISOString().replace(/\.\d+Z$/, "Z");
  fs.writeFileSync(target, `${stamp}\n`);

  git(["config", "user.name", AUTHOR_NAME], root);
  git(["config", "user.email", AUTHOR_EMAIL], root);
  git(["add", FILE], root);

  // Nothing staged means the clock returned the same second as the last stamp,
  // which is only reachable by running this twice by hand. There is nothing to
  // commit and nothing wrong.
  const staged = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: root });
  if (staged.status === 0) {
    process.stdout.write(`${FILE} already reads ${stamp}; nothing to commit.\n`);
    return;
  }

  git(["commit", "-m", `Stamp ${FILE} for the sweep of ${stamp}`], root);
  if (options.push) git(["push", "origin", "HEAD:master"], root);

  const sha = git(["rev-parse", "HEAD"], root);
  process.stdout.write(`${FILE} = ${stamp} at ${sha}\n`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `sha=${sha}\nstamp=${stamp}\n`);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}
