"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

async function plan(t, editorSha, packageAtPin = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-ci-plan-"));
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sha = "c".repeat(40),
    output = path.join(root, "plan.json"),
    calls = [];
  let stderr = "";
  const fake = {
    argv: [
      process.execPath,
      "plan-specs.js",
      "--org",
      "fixture",
      "--out",
      output,
      "--editor-sha",
      editorSha,
    ],
    env: {},
    stdout: { write() {} },
    stderr: {
      write(s) {
        stderr += s;
      },
    },
  };
  await vm.runInNewContext(fs.readFileSync(path.join(__dirname, "plan-specs.js"), "utf8"), {
    require(name) {
      if (name === "./resolve-ref")
        return {
          async lsRemote() {
            calls.push("resolve");
            return sha;
          },
        };
      if (name === "./fetch-with-retries")
        return {
          async fetchWithRetries(url) {
            calls.push(url);
            if (url.startsWith("https://api.github.com/orgs/fixture/"))
              return {
                ok: true,
                async json() {
                  return [{ name: "package" }];
                },
              };
            assert.ok(
              [
                "https://raw.githubusercontent.com/fixture/package/master/package.json",
                `https://raw.githubusercontent.com/fixture/package/${sha}/package.json`,
              ].includes(url),
            );
            return {
              ok: true,
              status: 200,
              async text() {
                return JSON.stringify(
                  packageAtPin || url.includes("/master/") ? { engines: { lumine: "^1.0.0" } } : {},
                );
              },
            };
          },
        };
      return require(name);
    },
    process: fake,
  });
  return {
    calls,
    sha,
    stderr,
    code: fake.exitCode || 0,
    plan: fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, "utf8")) : null,
  };
}

test("discovery classifies the manifest at the resolved immutable package SHA", async (t) => {
  const editorSha = "d".repeat(40),
    r = await plan(t, editorSha);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.plan.editorSha, editorSha);
  assert.equal(r.plan.packages[0].sha, r.sha);
  assert.equal(r.plan.packages[0].ref, "master");
  assert.equal(r.calls[2], "resolve");
  assert.ok(r.calls[3].includes(`/${r.sha}/package.json`));
});

test("a manifest that is no longer a package at the resolved commit is not swept", async (t) => {
  const r = await plan(t, "d".repeat(40), false);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.plan.packages, []);
  assert.deepEqual(r.plan.unresolved, []);
});
test("an invalid editor SHA is rejected before any discovery network request", async (t) => {
  const r = await plan(t, "master");
  assert.equal(r.code, 1);
  assert.deepEqual(r.calls, []);
  assert.match(r.stderr, /full commit SHA/);
});
