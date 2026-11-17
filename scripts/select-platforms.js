"use strict";

const fs = require("node:fs");

const DEFAULT_PLATFORMS = Object.freeze([
  "ubuntu-latest",
  "macos-latest",
  "windows-latest",
]);
const ALLOWED_PLATFORMS = Object.freeze([
  ...DEFAULT_PLATFORMS,
  "macos-26-intel",
]);

function selectPlatforms(input = DEFAULT_PLATFORMS.join(",")) {
  if (typeof input !== "string") throw new Error("Platforms must be a string.");
  const list = [
    ...new Set(
      input
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  if (
    list.length === 0 ||
    list.some((value) => !ALLOWED_PLATFORMS.includes(value))
  )
    throw new Error(
      `Platforms must be a non-empty subset of ${ALLOWED_PLATFORMS.join(", ")}.`,
    );
  const macos = list.filter(
    (value) => value === "macos-26-intel" || value === "macos-latest",
  );
  if (macos.length > 1)
    throw new Error("Select only one macOS runner per sweep.");
  return { list, macos };
}

function main() {
  if (process.argv.length !== 2) throw new Error("No arguments are accepted.");
  const selected = selectPlatforms(
    process.env.PLATFORMS || DEFAULT_PLATFORMS.join(","),
  );
  if (process.env.GITHUB_OUTPUT)
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(selected)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}\n`)
        .join(""),
    );
  console.log(JSON.stringify(selected));
}

module.exports = { DEFAULT_PLATFORMS, ALLOWED_PLATFORMS, selectPlatforms };
if (require.main === module)
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
