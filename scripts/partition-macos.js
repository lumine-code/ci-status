"use strict";

const fs = require("node:fs");

const WAVE_COUNT = 4;

function partitionMacosPackages(names) {
  if (
    !Array.isArray(names) ||
    names.some(
      (name) =>
        typeof name !== "string" ||
        !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name),
    )
  )
    throw new Error("Package names must be an array of valid names.");
  if (new Set(names).size !== names.length)
    throw new Error("Duplicate package names cannot be partitioned.");
  const size = Math.floor(names.length / WAVE_COUNT),
    extra = names.length % WAVE_COUNT;
  let offset = 0;
  return Array.from({ length: WAVE_COUNT }, (_, index) => {
    const count = size + (index < extra ? 1 : 0),
      wave = names.slice(offset, offset + count);
    offset += count;
    return wave;
  });
}

function main() {
  if (process.argv.length !== 4 || process.argv[2] !== "--plan")
    throw new Error("Usage: node partition-macos.js --plan <plan.json>");
  const plan = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
  if (!Array.isArray(plan.packages))
    throw new Error("The plan must contain a package array.");
  const waves = partitionMacosPackages(plan.packages.map((item) => item?.name));
  if (process.env.GITHUB_OUTPUT)
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      waves
        .map((wave, index) => `wave${index + 1}=${JSON.stringify(wave)}\n`)
        .join(""),
    );
  console.log(JSON.stringify({ packages: plan.packages.length, waves }));
}

module.exports = { WAVE_COUNT, partitionMacosPackages };
if (require.main === module)
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
