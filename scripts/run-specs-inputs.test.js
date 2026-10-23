"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const vm = require("node:vm");

function fixture(t, { hasSpecs = true } = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-ci-inputs-"));
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const git = (directory, args) => {
    const result = spawnSync(
      "git",
      ["-c", "core.hooksPath=", "-c", "commit.gpgsign=false", ...args],
      {
        cwd: directory,
        encoding: "utf8",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const commit = (directory, message) => {
    git(directory, ["add", "."]);
    git(directory, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      message,
    ]);
    return git(directory, ["rev-parse", "HEAD"]);
  };
  const repository = path.join(temporary, "remote");
  const editor = path.join(temporary, "editor");
  for (const directory of [repository, editor]) {
    fs.mkdirSync(directory);
    git(directory, ["init", "--quiet", "--initial-branch=master", "--template="]);
    fs.writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({ name: "fixture-package", specPackages: [] }),
    );
  }
  if (hasSpecs) fs.mkdirSync(path.join(repository, "spec"));
  const content = path.join(repository, hasSpecs ? "spec/example.js" : "fixture.txt");
  fs.writeFileSync(content, "planned bytes");
  const plannedSha = commit(repository, "Planned package");
  fs.writeFileSync(content, "later branch bytes");
  const laterSha = commit(repository, "Advance master after planning");
  const editorSha = commit(editor, "Editor input");
  const planFile = path.join(temporary, "plan.json");
  const plan = {
    editorSha,
    packages: [
      {
        name: "fixture-package",
        source: "fixture/package",
        cloneUrl: repository,
        ref: "master",
        refType: "branch",
        sha: plannedSha,
        shard: 0,
      },
    ],
  };
  return {
    temporary,
    repository,
    editor,
    editorSha,
    plan,
    planFile,
    plannedSha,
    laterSha,
  };
}

function execute(f, options = {}) {
  fs.writeFileSync(
    f.planFile,
    options.invalidJson
      ? "{"
      : JSON.stringify({
          ...f.plan,
          editorSha: options.expectedEditorSha || f.editorSha,
        }),
  );
  const workspace = path.join(f.temporary, "workspace");
  const events = [];
  let launched = false;
  let stderr = "";
  const fakeProcess = {
    argv: [
      process.execPath,
      "run-specs.js",
      "--plan",
      f.planFile,
      "--editor",
      f.editor,
      "--workspace",
      workspace,
      "--package",
      "fixture-package",
    ],
    env: { RUNNER_OS: options.platform || "Windows" },
    platform: process.platform,
    execPath: process.execPath,
    stdout: { write() {} },
    stderr: {
      write(value) {
        stderr += value;
      },
    },
  };
  const fixtureFs = {
    ...fs,
    symlinkSync(...args) {
      if (options.setupThrows) throw new Error("synthetic alias setup failure");
      return fs.symlinkSync(...args);
    },
    unlinkSync(...args) {
      if (options.cleanupThrows) throw new Error("synthetic alias cleanup failure");
      return fs.unlinkSync(...args);
    },
    rmSync(target, flags) {
      assert.ok(
        path.resolve(target).startsWith(f.temporary + path.sep),
        "never remove outside the fresh fixture",
      );
      return fs.rmSync(target, flags);
    },
  };
  const childProcess = {
    spawnSync(command, args, settings = {}) {
      events.push({ command, args, cwd: settings.cwd });
      if (command === "git") {
        assert.ok(path.resolve(settings.cwd).startsWith(f.temporary + path.sep));
        if (args[0] === "clone") throw new Error("Never resolve a moving branch at execution time");
        if (
          args[0] === "rev-parse" &&
          launched &&
          options.changedAfterRun === (settings.cwd === f.editor ? "editor" : "package")
        ) {
          return { status: 0, stdout: "f".repeat(40) };
        }
        if (args[0] === "rev-parse" && settings.cwd !== f.editor && options.observedPackageSha) {
          return { status: 0, stdout: options.observedPackageSha };
        }
        return spawnSync(command, args, {
          ...settings,
          stdio: "pipe",
          encoding: "utf8",
        });
      }
      if (args[0] === "-c" && args[1] === "exit 0") return { status: 0 };
      if (args[0] === "-c" && args[1].startsWith("npm install"))
        return { status: options.installFails ? 1 : 0 };
      if (command === process.execPath && path.basename(args[0]) === "run-headless-specs.js") {
        const checkout = path.join(workspace, "checkout", "fixture-package");
        assert.equal(
          fs.readFileSync(path.join(checkout, "spec", "example.js"), "utf8"),
          "planned bytes",
        );
        launched = true;
        return { status: options.specsFail ? 1 : 0 };
      }
      throw new Error(`Unexpected process: ${command} ${JSON.stringify(args)}`);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "run-specs.js"), "utf8"), {
    require(name) {
      if (name === "fs") return fixtureFs;
      if (name === "path")
        return {
          ...path,
          resolve: (...args) => path.resolve(f.temporary, ...args),
        };
      return name === "child_process" ? childProcess : require(name);
    },
    __dirname,
    process: fakeProcess,
  });
  const output = path.join(
    f.temporary,
    "results",
    `package-${fakeProcess.env.RUNNER_OS.toLowerCase()}-fixture-package.json`,
  );
  assert.ok(fs.existsSync(output), "the actual default artifact path must exist even on failure");
  return {
    report: JSON.parse(fs.readFileSync(output, "utf8")),
    events,
    launched,
    stderr,
    exitCode: fakeProcess.exitCode || 0,
    output,
  };
}

test("a branch advancing after discovery still executes its planned immutable commit", (t) => {
  const f = fixture(t);
  assert.notEqual(f.plannedSha, f.laterSha);
  const r = execute(f);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.launched, true);
  assert.equal(r.report.status, "passed");
  assert.equal(r.report.editorSha, f.editorSha);
  assert.equal(r.report.results[0].sha, f.plannedSha);
  assert.equal(r.report.results[0].shaAfter, f.plannedSha);
  assert.equal(r.report.results[0].expectedSha, f.plannedSha);
  assert.equal(
    r.events.find((e) => e.command === "git" && e.args[0] === "fetch").args.at(-1),
    f.plannedSha,
  );
});

test("the real producer's no-spec skip survives the actual workflow fallback unchanged", (t) => {
  const f = fixture(t, { hasSpecs: false }),
    r = execute(f);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.launched, false);
  assert.equal(r.report.status, "passed");
  assert.equal(r.report.results[0].status, "skipped");
  assert.equal(r.report.results[0].shaAfter, undefined);
  assert.equal(r.report.results[0].editorShaAfter, undefined);
  const raw = fs.readFileSync(r.output, "utf8");
  const workflow = fs.readFileSync(path.join(__dirname, "../.github/workflows/specs.yml"), "utf8");
  const code = workflow
    .match(/node <<'NODE'\r?\n([\s\S]*?)\r?\n[ \t]+NODE/)[1]
    .split(/\r?\n/)
    .map((line) => line.slice(10))
    .join("\n");
  const localPath = (file) => path.resolve(f.temporary, file);
  const fixtureFs = {
    ...fs,
    ...Object.fromEntries(
      ["readFileSync", "existsSync", "mkdirSync", "writeFileSync"].map((method) => [
        method,
        (file, ...args) => fs[method](localPath(file), ...args),
      ]),
    ),
  };
  const fake = {
    env: {
      RUNNER_OS: "Windows",
      RUNNER_TEMP: f.temporary,
      SPEC_PACKAGE: "fixture-package",
      SPEC_EXPECTED_SHA: f.plannedSha,
      SPEC_EXPECTED_SOURCE: "fixture/package",
      SPEC_EXPECTED_EDITOR_SHA: f.editorSha,
      SPEC_RUNNER_OUTCOME: "success",
    },
    platform: process.platform,
    stderr: { write() {} },
  };
  vm.runInNewContext(code, {
    require(name) {
      if (name === "node:fs") return fixtureFs;
      if (name === "node:path")
        return { ...path, resolve: (...args) => path.resolve(f.temporary, ...args) };
      if (name === "node:child_process")
        return {
          spawnSync() {
            assert.fail("A retained skip needs no new process observation");
          },
        };
      return require(name);
    },
    process: fake,
  });
  assert.equal(fake.exitCode || 0, 0);
  assert.equal(fs.readFileSync(r.output, "utf8"), raw);
  assert.equal(fs.readdirSync(path.dirname(r.output)).length, 1);
});

test("an observed package mismatch prevents dependency installation and specs", (t) => {
  const f = fixture(t),
    r = execute(f, { observedPackageSha: f.laterSha });
  assert.equal(r.exitCode, 1);
  assert.equal(r.launched, false);
  assert.equal(r.report.results[0].status, "error");
  assert.equal(r.report.results[0].sha, f.laterSha);
  assert.match(r.report.results[0].message, /does not match planned/);
  assert.equal(
    r.events.some((e) => e.args[0] === "-c"),
    false,
  );
});

test("a tag selector also executes its resolved SHA rather than the tag name", (t) => {
  const f = fixture(t);
  f.plan.packages[0].ref = "v1";
  f.plan.packages[0].refType = "tag";
  const tag = spawnSync("git", ["tag", "v1", f.laterSha], {
    cwd: f.repository,
    encoding: "utf8",
  });
  assert.equal(tag.status, 0, tag.stderr);
  const r = execute(f);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.report.results[0].sha, f.plannedSha);
});

for (const changedAfterRun of ["package", "editor"]) {
  test(`a ${changedAfterRun} HEAD change during specs cannot be reported as passed`, (t) => {
    const f = fixture(t),
      r = execute(f, { changedAfterRun });
    assert.equal(r.exitCode, 1);
    assert.equal(r.report.results[0].status, "error");
    assert.match(r.report.results[0].message, /HEAD changed/);
  });
}

test("an editor mismatch is a durable error before package checkout", (t) => {
  const f = fixture(t),
    r = execute(f, { expectedEditorSha: "f".repeat(40) });
  assert.equal(r.exitCode, 1);
  assert.equal(r.report.status, "error");
  assert.equal(r.report.editorSha, f.editorSha);
  assert.equal(r.report.results[0].expectedSha, f.plannedSha);
  assert.equal(r.report.results[0].status, "error");
  assert.equal(
    r.events.some((e) => e.args[0] === "init"),
    false,
  );
});

for (const platform of ["Windows", "macOS", "Linux"]) {
  test(`${platform} uploads a durable result with actual commits when specs fail`, (t) => {
    const f = fixture(t),
      r = execute(f, { platform, specsFail: true });
    assert.equal(r.exitCode, 1);
    assert.equal(r.report.status, "failed");
    assert.equal(r.report.results[0].status, "failed");
    assert.equal(r.report.results[0].sha, f.plannedSha);
    assert.equal(r.report.results[0].editorSha, f.editorSha);
    assert.match(path.basename(r.output), /^package-.*\.json$/);
  });
}

for (const [label, options] of [
  ["install", { installFails: true }],
  ["unexpected setup", { setupThrows: true }],
  ["cleanup", { cleanupThrows: true }],
]) {
  test(`${label} errors retain the failed record and its immutable inputs`, (t) => {
    const f = fixture(t),
      r = execute(f, options);
    assert.equal(r.exitCode, 1);
    assert.equal(r.report.results[0].status, "error");
    assert.equal(r.report.results[0].sha, f.plannedSha);
    assert.equal(r.report.results[0].editorSha, f.editorSha);
    assert.equal(r.launched, Boolean(options.cleanupThrows));
  });
}

test("a malformed plan still emits a failed job artifact instead of a stale success", (t) => {
  const f = fixture(t),
    r = execute(f, { invalidJson: true });
  assert.equal(r.exitCode, 1);
  assert.equal(r.report.status, "error");
  assert.equal(r.report.package, "fixture-package");
  assert.equal(r.report.editorSha, f.editorSha);
  assert.deepEqual(r.report.results, []);
});

test("the shared workflow uploads each platform/package result even after a failed step", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "../.github/workflows/specs.yml"), "utf8");
  assert.match(
    workflow,
    /Upload the actual package and editor result\s+if: always\(\)\s+uses: actions\/upload-artifact@v7/,
  );
  assert.match(workflow, /name: spec-result-\$\{\{ runner\.os \}\}-\$\{\{ matrix\.package \}\}/);
  assert.match(workflow, /path: results\/package-\*\.json\s+if-no-files-found: error/);
  assert.match(workflow, /--editor-sha "\$\{\{ steps\.editor\.outputs\.sha \}\}"/);
  assert.equal((workflow.match(/steps: \*package-spec-steps/g) || []).length, 2);
});
