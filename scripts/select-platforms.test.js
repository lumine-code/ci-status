"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { DEFAULT_PLATFORMS, selectPlatforms } = require("./select-platforms");

test("the full default sweep selects each OS once with the ARM macOS runner", () => {
  assert.deepEqual(selectPlatforms(), {
    list: ["ubuntu-latest", "macos-latest", "windows-latest"],
    macos: ["macos-latest"],
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
    'list=["ubuntu-latest","macos-latest","windows-latest"]\nmacos=["macos-latest"]\n',
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

test("the actual CLI retains Intel macOS for an explicit manual diagnostic subset", (t) => {
  const { actual, output } = execute(t, "macos-26-intel");
  assert.equal(actual.status, 0, actual.stderr);
  assert.equal(
    fs.readFileSync(output, "utf8"),
    'list=["macos-26-intel"]\nmacos=["macos-26-intel"]\n',
  );
});

test("an ambiguous manual selection fails before publishing any matrix outputs", (t) => {
  const { actual, output } = execute(t, "macos-26-intel,macos-latest");
  assert.equal(actual.status, 1);
  assert.match(actual.stderr, /only one macOS runner/);
  assert.equal(fs.existsSync(output), false);
});

const workflow = fs
  .readFileSync(path.join(__dirname, "../.github/workflows/specs.yml"), "utf8")
  .replace(/\r\n/g, "\n");

function job(name) {
  const sections = workflow.split(`  ${name}:\n`);
  assert.equal(sections.length, 2, name);
  return sections[1].split(/^  [a-zA-Z0-9-]+:/m)[0];
}

test("each package matrix waits for its own editor build and uses its artifact", () => {
  assert(workflow.includes("default: " + DEFAULT_PLATFORMS.join(",")));
  assert(workflow.includes("run: node scripts/select-platforms.js"));
  assert(
    workflow.includes("macos-platforms: ${{ steps.platforms.outputs.macos }}"),
  );
  const editorLinux = job("editor-linux");
  assert(editorLinux.includes("steps: &editor-build-steps"));
  assert(editorLinux.includes("ref: ${{ needs.plan.outputs.editor-sha }}"));
  assert(editorLinux.includes("name: spec-plan"));
  assert(editorLinux.includes("name: lumine-editor-${{ matrix.os }}"));
  assert(job("editor-windows").includes("steps: *editor-build-steps"));
  assert(job("editor-macos").includes("steps: *editor-build-steps"));
  for (const [platform, runner] of [
    ["linux", "ubuntu-latest"],
    ["windows", "windows-latest"],
  ]) {
    const editor = job(`editor-${platform}`);
    const specs = job(`specs-${platform}`);
    assert.match(editor, /^    needs: plan$/m);
    assert(specs.includes(`needs: [plan, editor-${platform}]`));
    assert(editor.includes(`os: [${runner}]`));
    assert(specs.includes(`os: [${runner}]`));
  }
  const macosMatrix = "os: ${{ fromJSON(needs.plan.outputs.macos-platforms) }}";
  assert(job("editor-macos").includes(macosMatrix));
  for (let index = 1; index <= 4; index++) {
    const macos = job(`specs-macos-${index}`);
    assert(macos.includes("needs.plan.outputs.macos-platforms != ''"));
    assert(macos.includes("needs.plan.outputs.macos-platforms != '[]'"));
    assert(macos.includes(macosMatrix));
    assert(macos.includes("steps: *package-spec-steps"));
  }
  assert(job("specs-linux").includes("name: lumine-editor-${{ matrix.os }}"));
});

test("the editor builds and package jobs preserve platform and plan eligibility", () => {
  function enabled(jobName, selected, count = "2", cancelled = false) {
    const condition = job(jobName).match(/^    if: \$\{\{ (.*) \}\}$/m);
    assert(condition, jobName);
    return vm.runInNewContext(
      condition[1].replaceAll(
        "outputs.macos-platforms",
        'outputs["macos-platforms"]',
      ),
      {
        needs: {
          plan: {
            outputs: {
              count,
              platforms: selected ? JSON.stringify(selected) : "",
              "macos-platforms": selected
                ? JSON.stringify(
                    selected.filter((runner) => runner.startsWith("macos-")),
                  )
                : "",
            },
          },
        },
        fromJSON: JSON.parse,
        contains: (list, label) => list.includes(label),
        cancelled: () => cancelled,
      },
    );
  }

  for (const [platform, runners] of [
    ["linux", ["ubuntu-latest"]],
    ["macos", ["macos-latest", "macos-26-intel"]],
    ["windows", ["windows-latest"]],
  ]) {
    const jobs = [`editor-${platform}`];
    if (platform !== "macos") jobs.push(`specs-${platform}`);
    const otherRunners = DEFAULT_PLATFORMS.filter(
      (runner) => !runners.includes(runner),
    );
    for (const jobName of jobs) {
      for (const runner of runners)
        assert.equal(enabled(jobName, [runner]), true);
      assert.equal(enabled(jobName, DEFAULT_PLATFORMS), true);
      assert.equal(enabled(jobName, otherRunners), false);
      assert.equal(enabled(jobName, DEFAULT_PLATFORMS, "0"), false);
      assert.equal(enabled(jobName, null, ""), false);
      assert.equal(enabled(jobName, DEFAULT_PLATFORMS, "2", true), false);
    }
  }
});
