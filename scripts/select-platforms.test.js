"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { DEFAULT_PLATFORMS, selectPlatforms } = require("./select-platforms");

test("the full default sweep selects each OS once with the standard Intel macOS runner", () => {
  assert.deepEqual(selectPlatforms(), {
    list: ["ubuntu-latest", "macos-26-intel", "windows-latest"],
    macos: ["macos-26-intel"],
  });
});

test("manual sweeps retain the ARM macos-latest option and requested order", () => {
  assert.deepEqual(
    selectPlatforms("windows-latest,macos-latest,ubuntu-latest"),
    {
      list: ["windows-latest", "macos-latest", "ubuntu-latest"],
      macos: ["macos-latest"],
    },
  );
});

test("duplicate labels and surrounding whitespace cannot duplicate macOS artifacts", () => {
  assert.deepEqual(
    selectPlatforms(" macos-26-intel, macos-26-intel,ubuntu-latest, "),
    {
      list: ["macos-26-intel", "ubuntu-latest"],
      macos: ["macos-26-intel"],
    },
  );
});

test("a manual non-macOS subset leaves no macOS job to expand", () => {
  assert.deepEqual(selectPlatforms("ubuntu-latest,windows-latest"), {
    list: ["ubuntu-latest", "windows-latest"],
    macos: [],
  });
});

test("Intel and ARM cannot create duplicate logical macOS checks or result artifacts", () => {
  for (const input of [
    "macos-latest,macos-26-intel",
    "macos-26-intel,macos-latest",
  ])
    assert.throws(() => selectPlatforms(input), /only one macOS runner/);
});

test("unknown, paid and untrusted runner labels are rejected", () => {
  for (const input of [
    "",
    " , ",
    "macos-26-intel-large",
    "macos-latest-large",
    "macos-26",
    "self-hosted",
    "ubuntu-latest\nmacos-latest",
    "ubuntu-latest,macos-26-intel; echo unsafe",
    null,
    ["ubuntu-latest"],
  ])
    assert.throws(() => selectPlatforms(input));
});

function execute(t, input) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "lumine-ci-platforms-"),
  );
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, "outputs.txt"),
    env = { ...process.env, GITHUB_OUTPUT: output };
  for (const key of Object.keys(env))
    if (key.toUpperCase() === "CI") delete env[key];
  if (input === undefined) delete env.PLATFORMS;
  else env.PLATFORMS = input;
  const actual = spawnSync(
    process.execPath,
    [path.join(__dirname, "select-platforms.js")],
    {
      env,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  return { actual, output };
}

test("the actual CLI emits the default editor matrix and matching single-Mac matrix", (t) => {
  const { actual, output } = execute(t);
  assert.equal(actual.status, 0, actual.stderr);
  assert.deepEqual(JSON.parse(actual.stdout), selectPlatforms());
  assert.equal(
    fs.readFileSync(output, "utf8"),
    'list=["ubuntu-latest","macos-26-intel","windows-latest"]\nmacos=["macos-26-intel"]\n',
  );
});

test("the actual CLI preserves an explicit ARM-only manual selection", (t) => {
  const { actual, output } = execute(t, "macos-latest");
  assert.equal(actual.status, 0, actual.stderr);
  assert.equal(
    fs.readFileSync(output, "utf8"),
    'list=["macos-latest"]\nmacos=["macos-latest"]\n',
  );
});

test("an ambiguous manual selection fails before publishing any matrix outputs", (t) => {
  const { actual, output } = execute(t, "macos-26-intel,macos-latest");
  assert.equal(actual.status, 1);
  assert.match(actual.stderr, /only one macOS runner/);
  assert.equal(fs.existsSync(output), false);
});

test("the actual workflow uses matching selected runner labels for editor and package artifacts", () => {
  const workflow = fs
    .readFileSync(
      path.join(__dirname, "../.github/workflows/specs.yml"),
      "utf8",
    )
    .replace(/\r\n/g, "\n");
  assert(workflow.includes("default: " + DEFAULT_PLATFORMS.join(",")));
  assert(workflow.includes("run: node scripts/select-platforms.js"));
  assert(
    workflow.includes("macos-platforms: ${{ steps.platforms.outputs.macos }}"),
  );
  assert(
    workflow.includes("os: ${{ fromJSON(needs.plan.outputs.platforms) }}"),
  );
  const sections = workflow.split("  specs-macos:\n");
  assert.equal(sections.length, 2);
  const macos = sections[1].split("  specs-windows:")[0];
  assert(macos.includes("needs: [plan, editor]"));
  assert(macos.includes("needs.plan.outputs.macos-platforms != ''"));
  assert(macos.includes("needs.plan.outputs.macos-platforms != '[]'"));
  assert(
    macos.includes("os: ${{ fromJSON(needs.plan.outputs.macos-platforms) }}"),
  );
  assert(macos.includes("steps: *package-spec-steps"));
  const editor = workflow.split("  editor:\n")[1].split("  specs-linux:\n")[0];
  const packageSteps = workflow
    .split("steps: &package-spec-steps\n")[1]
    .split("  specs-macos:\n")[0];
  assert(editor.includes("name: lumine-editor-${{ matrix.os }}"));
  assert(packageSteps.includes("name: lumine-editor-${{ matrix.os }}"));
});
