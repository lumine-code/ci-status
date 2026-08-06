"use strict";

// Resolve every lumine-code package to the commit its spec suite should run
// against and write a plan the sweep consumes.
//
// The fleet is discovered from the organization rather than from a list: a
// repository is a package when its manifest declares an `engines.lumine`
// range, which is the same test the editor itself applies to decide what it
// has bundled. Nothing here needs editing when a package is added or retired,
// and a package that no catalog lists and no editor pins is still swept.
//
// Every package is taken at `master`, so this answers "does the fleet work as
// it stands today" — deliberately a different question from the one the
// install catalog answers, which is "does the ref a user would install work".

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

// Listing the organization costs a couple of API calls; everything after that
// is raw file fetches and ls-remote, neither of which touches the API quota.
// The fleet is ~150 repositories, so resolve a few at a time rather than
// serially.
const CONCURRENCY = 8;
const LS_REMOTE_TIMEOUT_MS = 60000;
const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";

function parseArguments(argv) {
  const options = {
    org: "lumine-code",
    ref: "master",
    out: "plan.json",
    resultsOut: "results/unresolved.json",
    shards: 12,
    only: [],
    summary: process.env.GITHUB_STEP_SUMMARY || null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value.`);
      index += 1;
      return value;
    };
    if (argument === "--org") options.org = next();
    else if (argument === "--ref") options.ref = next();
    else if (argument === "--out") options.out = next();
    else if (argument === "--results-out") options.resultsOut = next();
    else if (argument === "--shards") options.shards = Number(next());
    else if (argument === "--only") options.only.push(...splitPatterns(next()));
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isInteger(options.shards) || options.shards < 1) {
    throw new Error("--shards must be a positive integer.");
  }
  return options;
}

function splitPatterns(value) {
  return String(value)
    .split(/[\s,]+/)
    .map((pattern) => pattern.trim())
    .filter(Boolean);
}

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesAny(patterns, name) {
  return patterns.some((pattern) => globToRegExp(pattern).test(name));
}

function apiHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "lumine-code-ci-status",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

// Archived repositories are listed but never swept — they are retired on
// purpose. Forks are *not* skipped: most of this organization's packages are
// maintained forks of their Atom or Pulsar originals, so filtering on the fork
// flag would quietly drop the majority of the fleet. What makes a repository a
// package is its manifest, checked below, never its provenance.
async function listRepositories(org) {
  const repositories = [];
  for (let page = 1; ; page += 1) {
    const response = await fetch(`${API}/orgs/${org}/repos?per_page=100&page=${page}`, {
      headers: apiHeaders(),
    });
    if (!response.ok) {
      throw new Error(`Listing ${org} failed: ${response.status} ${response.statusText}`);
    }
    const batch = await response.json();
    if (batch.length === 0) break;
    for (const repository of batch) {
      if (repository.archived || repository.disabled) continue;
      repositories.push(repository.name);
    }
    if (batch.length < 100) break;
  }
  return repositories.sort((left, right) => left.localeCompare(right));
}

// A package is whatever declares an engines.lumine range, exactly as the
// editor's own bundled-package scan decides it. A repository with no manifest
// at this ref is not a package and is not an error.
async function readManifest(org, name, ref) {
  const response = await fetch(`${RAW}/${org}/${name}/${ref}/package.json`, {
    headers: { "User-Agent": "lumine-code-ci-status" },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Reading the manifest failed: ${response.status} ${response.statusText}`);
  }
  try {
    return JSON.parse(await response.text());
  } catch (error) {
    throw new Error(`The manifest is not valid JSON: ${error.message}`);
  }
}

function lsRemote(cloneUrl, ref) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["ls-remote", cloneUrl, `refs/heads/${ref}`],
      { timeout: LS_REMOTE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr || error.message).trim().split(/\r?\n/)[0]));
          return;
        }
        const match = String(stdout).match(/^([0-9a-f]{40})\s/i);
        resolve(match ? match[1].toLowerCase() : null);
      },
    );
  });
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function writeOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function writeSummary(summaryPath, lines) {
  if (!summaryPath) return;
  fs.appendFileSync(summaryPath, `${lines.join("\n")}\n`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const org = options.org;
  const ref = options.ref;

  const candidates = (await listRepositories(org)).filter(
    (name) => options.only.length === 0 || matchesAny(options.only, name),
  );
  process.stdout.write(`${candidates.length} repositories to inspect in ${org}.\n`);

  const inspected = await mapWithConcurrency(candidates, CONCURRENCY, async (name) => {
    const cloneUrl = `https://github.com/${org}/${name}.git`;
    const entry = { source: `${org}/${name}`, repository: `${org}/${name}`, name, cloneUrl };
    try {
      const manifest = await readManifest(org, name, ref);
      // Not a package: no manifest at all, or one that claims no editor.
      if (!manifest || !manifest.engines || !manifest.engines.lumine) return null;
      const sha = await lsRemote(cloneUrl, ref);
      if (!sha) throw new Error(`The repository has no \`${ref}\` branch.`);
      process.stdout.write(`${name} → ${ref} ${sha.slice(0, 12)}\n`);
      return { ...entry, ref, refType: "branch", sha };
    } catch (error) {
      process.stderr.write(`${name}: ${error.message}\n`);
      return { ...entry, error: error.message };
    }
  });

  const resolutions = inspected.filter(Boolean);
  const packages = resolutions.filter((entry) => !entry.error);
  const unresolved = resolutions.filter((entry) => entry.error);
  packages.sort((left, right) => left.name.localeCompare(right.name));

  // Round-robin rather than contiguous slices: adjacent names are
  // alphabetical, so a family of heavy suites would otherwise land in one
  // shard.
  const shards = Math.min(options.shards, Math.max(packages.length, 1));
  packages.forEach((entry, index) => {
    entry.shard = index % shards;
  });

  const plan = { org, ref, shards, packages, unresolved };
  fs.writeFileSync(options.out, `${JSON.stringify(plan, null, 2)}\n`);

  // A repository that looks like a package but cannot be resolved is reported
  // in the same shape a shard reports a failing suite, so the summary job
  // fails the run without the rest going untested.
  if (unresolved.length > 0) {
    fs.mkdirSync(path.dirname(path.resolve(options.resultsOut)), { recursive: true });
    fs.writeFileSync(
      path.resolve(options.resultsOut),
      `${JSON.stringify(
        {
          shard: "plan",
          results: unresolved.map((entry) => ({
            name: entry.name,
            source: entry.source,
            ref: null,
            sha: null,
            status: "error",
            message: `unresolved: ${entry.error}`,
          })),
        },
        null,
        2,
      )}\n`,
    );
  }

  writeOutput("count", packages.length);
  writeOutput("shards", JSON.stringify(Array.from({ length: shards }, (unused, index) => index)));
  writeSummary(options.summary, [
    `## Fleet at \`${ref}\``,
    "",
    `${packages.length} packages in ${org}, swept at \`${ref}\`.`,
    "",
    ...(unresolved.length > 0
      ? ["### Unresolved", "", ...unresolved.map((e) => `- \`${e.source}\` — ${e.error}`), ""]
      : []),
  ]);

  process.stdout.write(`Planned ${packages.length} packages across ${shards} shards.\n`);
  for (const entry of unresolved) {
    process.stdout.write(`::error title=${entry.name}::${entry.error}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
