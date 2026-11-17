"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { partitionMacosPackages, WAVE_COUNT } = require("./partition-macos");

for (const count of [0, 1, 3, 245, 401])
  test(`partitions ${count} packages exactly once, in order, across balanced waves`, () => {
    const names = Array.from(
        { length: count },
        (_, index) => `package-${index}`,
      ),
      original = names.slice(),
      waves = partitionMacosPackages(names),
      sizes = waves.map((wave) => wave.length);
    assert.equal(waves.length, WAVE_COUNT);
    assert.deepEqual(waves.flat(), original);
    assert.equal(new Set(waves.flat()).size, count);
    assert(Math.max(...sizes) - Math.min(...sizes) <= 1);
    assert.deepEqual(names, original);
  });

test("invalid or duplicate plan names fail instead of losing or duplicating coverage", () => {
  for (const value of [
    null,
    {},
    "package",
    [""],
    ["package", "package"],
    ["package", null],
    ["package\nwave2=unsafe"],
    ["../package"],
    ["package with spaces"],
  ])
    assert.throws(() => partitionMacosPackages(value));
});

function execute(t, plan) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "lumine-ci-mac-waves-"),
  );
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, "plan.json"),
    output = path.join(directory, "outputs.txt"),
    env = { ...process.env, GITHUB_OUTPUT: output };
  for (const key of Object.keys(env))
    if (key.toUpperCase() === "CI") delete env[key];
  fs.writeFileSync(input, JSON.stringify(plan));
  const actual = spawnSync(
    process.execPath,
    [path.join(__dirname, "partition-macos.js"), "--plan", input],
    { env, encoding: "utf8", windowsHide: true },
  );
  return { actual, output };
}

test("the actual plan CLI emits all four output arrays without truncating package inputs", (t) => {
  const names = Array.from({ length: 245 }, (_, index) => `package-${index}`),
    { actual, output } = execute(t, {
      packages: names.map((name) => ({ name })),
    });
  assert.equal(actual.status, 0, actual.stderr);
  const values = fs
    .readFileSync(output, "utf8")
    .trim()
    .split("\n")
    .map((line, index) => {
      const [key, ...value] = line.split("=");
      assert.equal(key, `wave${index + 1}`);
      return JSON.parse(value.join("="));
    });
  assert.equal(values.length, 4);
  assert.deepEqual(values.flat(), names);
  assert.deepEqual(
    values.map((wave) => wave.length),
    [62, 61, 61, 61],
  );
  assert.deepEqual(JSON.parse(actual.stdout), { packages: 245, waves: values });
});

test("an invalid actual plan fails before any wave outputs are published", (t) => {
  for (const plan of [
    {},
    { packages: null },
    { packages: [null] },
    { packages: [{ name: "same" }, { name: "same" }] },
  ]) {
    const { actual, output } = execute(t, plan);
    assert.equal(actual.status, 1);
    assert.equal(fs.existsSync(output), false);
  }
});

const workflow = fs
  .readFileSync(path.join(__dirname, "../.github/workflows/specs.yml"), "utf8")
  .replace(/\r\n/g, "\n");
function waveBlock(index) {
  const sections = workflow.split(`  specs-macos-${index}:\n`);
  assert.equal(sections.length, 2, `actual workflow wave ${index}`);
  return sections[1].split(/^  [a-zA-Z0-9-]+:/m)[0];
}
function enabled(block, index, options = {}) {
  const line = block.match(/^    if: \$\{\{ ([^\n]+) \}\}$/m);
  assert(line, "evaluate the actual workflow condition");
  const expression = line[1].replace(
      /needs\.plan\.outputs\.([a-zA-Z0-9-]+)/g,
      (_, key) => `needs.plan.outputs[${JSON.stringify(key)}]`,
    ),
    needs = {
      plan: {
        outputs: {
          count: "245",
          "macos-platforms": options.macos ?? '["macos-26-intel"]',
          [`macos-wave-${index}`]: options.wave ?? '["package"]',
        },
      },
      editor: { result: "success" },
      [`specs-macos-${index - 1}`]: { result: options.previous ?? "success" },
    };
  return vm.runInNewContext(expression, {
    needs,
    cancelled: () => options.cancelled ?? false,
  });
}

test("four actual Mac matrices preserve the shared package steps and eligibility dependencies", () => {
  assert(
    workflow.includes("run: node scripts/partition-macos.js --plan plan.json"),
  );
  for (let index = 1; index <= 4; index++) {
    const block = waveBlock(index),
      expectedNeeds =
        index === 1
          ? "[plan, editor]"
          : `[plan, editor, specs-macos-${index - 1}]`;
    assert(block.includes("needs: " + expectedNeeds));
    assert(block.includes("name: ${{ matrix.package }} (macOS)"));
    assert(block.includes("timeout-minutes: 60"));
    assert(block.includes("fail-fast: false"));
    assert(block.includes("max-parallel: 5"));
    assert(
      block.includes(
        `package: \${{ fromJSON(needs.plan.outputs.macos-wave-${index}) }}`,
      ),
    );
    assert(
      block.includes("os: ${{ fromJSON(needs.plan.outputs.macos-platforms) }}"),
    );
    assert(block.includes("steps: *package-spec-steps"));
    assert(
      workflow.includes(
        `macos-wave-${index}: \${{ steps.macos_waves.outputs.wave${index} }}`,
      ),
    );
  }
});

test("a genuine preceding wave failure does not skip later non-cancelled coverage", () => {
  for (let index = 2; index <= 4; index++) {
    const block = waveBlock(index);
    assert(block.includes("!cancelled()"));
    assert.equal(enabled(block, index, { previous: "failure" }), true);
    assert.equal(enabled(block, index, { previous: "skipped" }), true);
    assert.equal(
      enabled(block, index, { previous: "failure", cancelled: true }),
      false,
    );
  }
});

test("empty waves and manual non-macOS subsets stop before expanding their matrices", () => {
  for (let index = 1; index <= 4; index++) {
    const block = waveBlock(index);
    assert.equal(enabled(block, index, { wave: "[]" }), false);
    assert.equal(enabled(block, index, { wave: "" }), false);
    assert.equal(enabled(block, index, { macos: "[]" }), false);
    assert.equal(enabled(block, index, { macos: "" }), false);
    assert.equal(enabled(block, index, { macos: '["macos-latest"]' }), true);
  }
});
