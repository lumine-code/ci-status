"use strict";

// Merge a local sweep's per-shard result files into one platform matrix and
// decide its outcome. CI gives every package its own native check; this reporter
// remains for `npm run spec`, where shards avoid repeating setup on one machine.

const fs = require("fs");
const path = require("path");

const ICONS = { passed: "✅", failed: "❌", error: "💥", skipped: "⏭️" };
const RANK = { error: 0, failed: 1, skipped: 2, passed: 3 };

function parseArguments(argv) {
  const options = {
    directory: "results",
    plan: null,
    summary: process.env.GITHUB_STEP_SUMMARY,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value.`);
      index += 1;
      return value;
    };
    if (argument === "--results") options.directory = next();
    else if (argument === "--plan") options.plan = next();
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

// Walk nested directories too, so results collected from more than one local
// platform can still be summarized together.
function readShards(directory) {
  const shards = [];
  const walk = (current) => {
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, item.name);
      if (item.isDirectory()) walk(target);
      else if (item.name.endsWith(".json")) {
        shards.push(JSON.parse(fs.readFileSync(target, "utf8")));
      }
    }
  };
  if (fs.existsSync(directory)) walk(directory);
  return shards;
}

function duration(milliseconds) {
  if (!milliseconds) return "—";
  const seconds = Math.round(milliseconds / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function row(cells) {
  return `| ${cells.join(" | ")} |`;
}

function isUnresolvedPlanArtifact(shard) {
  return (
    shard.shard === "plan" &&
    Object.keys(shard).every((key) => ["shard", "results"].includes(key)) &&
    Array.isArray(shard.results) &&
    shard.results.length > 0 &&
    shard.results.every(
      (result) =>
        result.status === "error" &&
        result.platform == null &&
        result.ref === null &&
        result.sha === null &&
        typeof result.source === "string" &&
        typeof result.message === "string",
    )
  );
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const shards = readShards(options.directory);
  const artifactErrors = shards.filter(
    (shard) => !isUnresolvedPlanArtifact(shard) && shard.status !== "passed",
  );
  const reported = shards.flatMap((shard) =>
    (shard.results || []).map((result) => ({
      ...result,
      platform: result.platform || shard.platform,
      ...(!isUnresolvedPlanArtifact(shard) && !["passed", "failed", "error"].includes(shard.status)
        ? { status: "error", message: "No terminal artifact status was reported." }
        : {}),
    })),
  );
  // The plan job reports an entry whose ref never resolved in the same shape,
  // but it belongs to no platform — it never reached one.
  const unresolved = reported.filter((result) => !result.platform);
  const results = reported.filter((result) => result.platform);
  for (const result of results) {
    if (!["passed", "failed", "error", "skipped"].includes(result.status)) {
      result.status = "error";
      result.message = "No terminal result was reported for this package.";
    }
  }
  const plan = options.plan ? JSON.parse(fs.readFileSync(options.plan, "utf8")) : null;
  if (plan) {
    if (!/^[a-f0-9]{40}$/i.test(plan.editorSha || ""))
      throw new Error("The plan contains no full editor commit SHA.");
    for (const shard of shards.filter((shard) => !isUnresolvedPlanArtifact(shard))) {
      if (
        shard.expectedEditorSha !== plan.editorSha ||
        (shard.status === "passed" && shard.editorSha !== plan.editorSha)
      ) {
        if (!artifactErrors.includes(shard)) artifactErrors.push(shard);
        shard.message = `${shard.message ? shard.message + "; " : ""}The artifact editor commits do not match the plan.`;
      }
    }
    const expected = new Map((plan.packages || []).map((entry) => [entry.name, entry]));
    for (const result of results) {
      const entry = expected.get(result.name);
      if (
        !entry ||
        result.source !== entry.source ||
        result.sha !== entry.sha ||
        result.expectedSha !== entry.sha ||
        result.editorSha !== plan.editorSha ||
        result.expectedEditorSha !== plan.editorSha ||
        (result.status === "passed" &&
          (result.shaAfter !== entry.sha || result.editorShaAfter !== plan.editorSha))
      ) {
        result.status = "error";
        result.message = `${result.message ? result.message + "; " : ""}The reported package/editor commits do not match the plan.`;
      }
    }
  }

  const platforms = [
    ...new Set([
      ...results.map((result) => result.platform),
      ...shards.map((shard) => shard.platform).filter(Boolean),
    ]),
  ].sort();
  const packages = new Map();
  for (const result of results) {
    if (!packages.has(result.name)) packages.set(result.name, { ref: result.ref, byPlatform: {} });
    const entry = packages.get(result.name);
    entry.ref = entry.ref || result.ref;
    if (entry.byPlatform[result.platform]) {
      result.status = "error";
      result.message = "More than one result was reported for this package and platform.";
    }
    entry.byPlatform[result.platform || "—"] = result;
  }

  // A package the plan listed but no shard reported on means a local run died or
  // was cancelled. Silence there would read as success, so name it.
  const missing = [];
  if (plan) {
    for (const entry of plan.packages || []) {
      const reported = packages.get(entry.name);
      for (const platform of platforms.length ? platforms : ["unknown"]) {
        if (!reported || !reported.byPlatform[platform]) {
          missing.push({ name: entry.name, platform });
        }
      }
    }
  }

  const counts = { passed: 0, failed: 0, error: 0, skipped: 0 };
  for (const result of results) counts[result.status] = (counts[result.status] || 0) + 1;

  const names = [...packages.keys()].sort();
  const lines = [
    "## Package specs",
    "",
    `${counts.passed} passed · ${counts.failed} failed · ${counts.error} errored · ` +
      `${counts.skipped} skipped · ${names.length} packages on ${platforms.length} platform(s)`,
    "",
    row(["Package", "Ref", ...platforms]),
    row(["---", "---", ...platforms.map(() => "---")]),
    ...names.map((name) => {
      const entry = packages.get(name);
      return row([
        name,
        entry.ref ? `\`${entry.ref}\`` : "—",
        ...platforms.map((platform) => {
          const result = entry.byPlatform[platform];
          if (!result) return "·";
          return `${ICONS[result.status] || result.status} ${duration(result.durationMs)}`;
        }),
      ]);
    }),
    "",
  ];

  const broken = results
    .filter((result) => result.status === "failed" || result.status === "error")
    .sort(
      (left, right) =>
        RANK[left.status] - RANK[right.status] || left.name.localeCompare(right.name),
    );
  if (broken.length > 0) {
    lines.push(
      "### Failures",
      "",
      ...broken.map(
        (result) =>
          `- **${result.name}** (${result.platform}) at ` +
          `\`${result.ref || "?"}\` — ${result.message}`,
      ),
      "",
    );
  }
  if (missing.length > 0) {
    lines.push(
      "### Not reported",
      "",
      ...missing.map((entry) => `- **${entry.name}** (${entry.platform})`),
      "",
    );
  }
  if (unresolved.length > 0) {
    lines.push(
      "### Unresolved catalog entries",
      "",
      ...unresolved.map((entry) => `- \`${entry.source}\` — ${entry.message}`),
      "",
    );
  }
  if (artifactErrors.length > 0) {
    lines.push(
      "### Incomplete result artifacts",
      "",
      ...artifactErrors.map(
        (shard) => `- ${shard.package || shard.shard}: ${shard.message || "artifact failed"}`,
      ),
      "",
    );
  }

  const report = `${lines.join("\n")}\n`;
  process.stdout.write(report);
  if (options.summary) fs.appendFileSync(options.summary, report);

  for (const result of broken) {
    process.stdout.write(`::error title=${result.name} (${result.platform})::${result.message}\n`);
  }
  for (const entry of missing) {
    process.stdout.write(`::error title=${entry.name} (${entry.platform})::no result reported\n`);
  }
  for (const entry of unresolved) {
    process.stdout.write(`::error title=${entry.name}::${entry.message}\n`);
  }
  if (broken.length > 0 || missing.length > 0 || unresolved.length > 0 || artifactErrors.length > 0)
    process.exitCode = 1;
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}
