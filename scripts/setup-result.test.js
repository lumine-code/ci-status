"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const workflow = fs.readFileSync(path.join(__dirname, "../.github/workflows/specs.yml"), "utf8");
const match = workflow.match(/node <<'NODE'\r?\n([\s\S]*?)\r?\n[ \t]+NODE/);
assert.ok(match, "execute the actual always-run workflow fallback, not a rewritten model");
const fallbackSource = match[1]
  .split(/\r?\n/)
  .map((line) => line.slice(10))
  .join("\n");

function execute(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-ci-setup-result-"));
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const name = "fixture",
    sha = "a".repeat(40),
    editorSha = "b".repeat(40),
    source = "fixture/repository";
  const output = path.join(root, "results/package-windows-fixture.json");
  const initial =
    options.raw ??
    (options.existing
      ? JSON.stringify(
          {
            package: name,
            status: options.existing,
            expectedEditorSha: editorSha,
            editorSha,
            results: [
              {
                name,
                source,
                status: options.existing,
                expectedSha: sha,
                sha,
                shaAfter: options.badAfter ? "wrong" : sha,
                expectedEditorSha: editorSha,
                editorSha,
                editorShaAfter: editorSha,
              },
            ],
          },
          null,
          2,
        ) + "\n"
      : null);
  if (initial !== null) {
    fs.mkdirSync(path.dirname(output));
    fs.writeFileSync(output, initial);
  }
  if (options.observed) {
    fs.mkdirSync(path.join(root, "lumine/.git"), { recursive: true });
    fs.mkdirSync(path.join(root, "lumine-specs/checkout/fixture/.git"), { recursive: true });
  }
  const calls = [];
  const localPath = (file) => (path.isAbsolute(file) ? file : path.join(root, file));
  const fixtureFs = {
    ...fs,
    readFileSync(file, ...args) {
      return fs.readFileSync(localPath(file), ...args);
    },
    existsSync(file) {
      return fs.existsSync(localPath(file));
    },
    mkdirSync(file, ...args) {
      return fs.mkdirSync(localPath(file), ...args);
    },
    writeFileSync(file, ...args) {
      const target = localPath(file);
      assert.ok(target.startsWith(root + path.sep));
      return fs.writeFileSync(target, ...args);
    },
  };
  const fake = {
    env: {
      RUNNER_OS: "Windows",
      RUNNER_TEMP: root,
      SPEC_PACKAGE: name,
      SPEC_EXPECTED_SHA: sha,
      SPEC_EXPECTED_SOURCE: source,
      SPEC_EXPECTED_EDITOR_SHA: editorSha,
      SPEC_RUNNER_OUTCOME: options.outcome || "skipped",
    },
    platform: process.platform,
    stderr: { write() {} },
  };
  vm.runInNewContext(fallbackSource, {
    require(module) {
      if (module === "node:fs") return fixtureFs;
      if (module === "node:path")
        return { ...path, resolve: (...args) => path.resolve(root, ...args) };
      if (module === "node:child_process")
        return {
          spawnSync(command, args, settings) {
            assert.equal(command, "git");
            assert.deepEqual(Array.from(args), ["rev-parse", "--verify", "HEAD"]);
            calls.push(settings.cwd);
            return {
              status: 0,
              stdout: settings.cwd === path.join(root, "lumine") ? editorSha : sha,
            };
          },
        };
      return require(module);
    },
    process: fake,
  });
  const files = fs.readdirSync(path.join(root, "results"));
  const fallback = path.join(
    root,
    "results",
    files.find((file) => file.endsWith(".setup-error.json")) || path.basename(output),
  );
  return {
    code: fake.exitCode || 0,
    output,
    initial,
    raw: fs.readFileSync(output, "utf8"),
    files,
    receipt: JSON.parse(fs.readFileSync(fallback, "utf8")),
    sha,
    editorSha,
    source,
    calls,
  };
}

for (const outcome of ["skipped", "failure", "success"]) {
  test(`setup/runner outcome ${outcome} without a receipt emits an error with planned inputs and null observations`, (t) => {
    const r = execute(t, { outcome });
    assert.equal(r.code, 1);
    assert.equal(r.receipt.status, "error");
    assert.equal(r.receipt.testExecution, "not-attested");
    assert.equal(r.receipt.results[0].expectedSha, r.sha);
    assert.equal(r.receipt.expectedEditorSha, r.editorSha);
    assert.equal(r.receipt.results[0].source, r.source);
    assert.equal(r.receipt.results[0].sha, null);
    assert.equal(r.receipt.editorSha, null);
    assert.deepEqual(r.calls, []);
  });
}
test("fallback metadata reads report observed commits without claiming test execution", (t) => {
  const r = execute(t, { observed: true });
  assert.equal(r.code, 1);
  assert.equal(r.receipt.results[0].sha, r.sha);
  assert.equal(r.receipt.editorSha, r.editorSha);
  assert.equal(r.receipt.testExecution, "not-attested");
  assert.equal(r.calls.length, 2);
});
for (const existing of ["failed", "error"]) {
  test(`a terminal ${existing} receipt is preserved byte-for-byte and remains a failed job`, (t) => {
    const r = execute(t, { existing, outcome: "failure" });
    assert.equal(r.code, 1);
    assert.equal(r.raw, r.initial);
    assert.equal(r.files.length, 1);
  });
}
test("a verified passed runner receipt remains unchanged", (t) => {
  const r = execute(t, { existing: "passed", outcome: "success" });
  assert.equal(r.code, 0);
  assert.equal(r.raw, r.initial);
  assert.equal(r.files.length, 1);
});
for (const options of [
  { existing: "running" },
  { raw: "{" },
  { existing: "passed", outcome: "failure" },
  { existing: "passed", outcome: "success", badAfter: true },
]) {
  test(`an incomplete/contradictory receipt is preserved alongside an explicit error (${JSON.stringify(options)})`, (t) => {
    const r = execute(t, options);
    assert.equal(r.code, 1);
    assert.equal(r.raw, r.initial);
    assert.equal(r.files.length, 2);
    assert.equal(r.receipt.status, "error");
    assert.equal(r.receipt.testExecution, "not-attested");
  });
}
test("the always fallback receives immutable expected inputs independently of unpacking the plan", () => {
  assert.match(workflow, /package-inputs: \$\{\{ steps\.plan\.outputs\.package-inputs \}\}/);
  assert.match(workflow, /Retain an error receipt[^\n]+\r?\n\s+if: always\(\)/);
  assert.match(
    workflow,
    /SPEC_EXPECTED_SHA: \$\{\{ fromJSON\(needs\.plan\.outputs\.package-inputs\)\[matrix\.package\]\.sha \}\}/,
  );
  assert.match(
    workflow,
    /SPEC_EXPECTED_SOURCE: \$\{\{ fromJSON\(needs\.plan\.outputs\.package-inputs\)\[matrix\.package\]\.source \}\}/,
  );
  assert.match(workflow, /id: package_specs/);
});
