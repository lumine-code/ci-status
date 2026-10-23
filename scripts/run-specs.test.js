"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const scenarios = [[], ["neighbor-package"]].flatMap((neighbors) =>
  [false, true].map((removeAlias) => ({ neighbors, removeAlias })),
);
for (const { neighbors, removeAlias } of scenarios) {
  test(`the spec launch exposes the target's assets with ${neighbors.length} spec neighbors (${removeAlias ? "suite removes alias" : "alias retained"})`, (t) => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-ci-package-assets-"));
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const editor = path.join(temporary, "editor");
    const workspace = path.join(temporary, "workspace");
    const plan = path.join(temporary, "plan.json");
    const output = path.join(temporary, "result.json");
    const manifest = {
      name: "asset-package",
      engines: { lumine: "^1.0.0" },
      specPackages: neighbors,
    };
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>';
    const sha = "0123456789abcdef0123456789abcdef01234567";
    fs.mkdirSync(path.join(editor, "script"), { recursive: true });
    fs.writeFileSync(path.join(editor, "script", "install-spec-packages.js"), "");
    fs.writeFileSync(
      plan,
      JSON.stringify({
        editorSha: sha,
        packages: [
          {
            name: "checkout-name",
            source: "example/package",
            ref: "master",
            refType: "branch",
            cloneUrl: "https://example.invalid/package.git",
            sha,
            shard: 0,
          },
        ],
      }),
    );
    let launched = false;
    let stderr = "";
    const fixtureFs = {
      ...fs,
      rmSync(target, options) {
        if (launched && target === path.join(workspace, "checkout", "checkout-name")) {
          assert.equal(
            fs.lstatSync(path.join(workspace, "home", "checkout-name", "packages", manifest.name), {
              throwIfNoEntry: false,
            }),
            undefined,
            "detach the package alias before deleting its checkout",
          );
        }
        return fs.rmSync(target, options);
      },
    };
    const fakeProcess = {
      argv: [
        process.execPath,
        "run-specs.js",
        "--plan",
        plan,
        "--editor",
        editor,
        "--workspace",
        workspace,
        "--out",
        output,
      ],
      env: {},
      platform: process.platform,
      execPath: process.execPath,
      stdout: { write() {} },
      stderr: {
        write(value) {
          stderr += value;
        },
      },
    };
    const childProcess = {
      spawnSync(command, args, options = {}) {
        if (command === "git" && ["init", "remote", "fetch"].includes(args[0])) {
          return { status: 0 };
        }
        if (command === "git" && args[0] === "checkout") {
          const checkout = options.cwd;
          fs.mkdirSync(path.join(checkout, "spec"), { recursive: true });
          fs.mkdirSync(path.join(checkout, "img"), { recursive: true });
          fs.writeFileSync(path.join(checkout, "package.json"), JSON.stringify(manifest));
          fs.writeFileSync(path.join(checkout, "img", "logo.svg"), svg);
          return { status: 0 };
        }
        if (command === "git" && args[0] === "rev-parse") return { status: 0, stdout: sha };
        if (args[0] === "-c" && (args[1] === "exit 0" || args[1].startsWith("npm install")))
          return { status: 0 };
        if (
          command === process.execPath &&
          args[0] === path.join(editor, "script", "install-spec-packages.js")
        ) {
          const home = args[args.indexOf("--home") + 1];
          fs.mkdirSync(path.join(home, "packages", "neighbor-package"), {
            recursive: true,
          });
          fs.writeFileSync(path.join(home, "packages", "neighbor-package", "keep.txt"), "neighbor");
          return { status: 0 };
        }
        if (command === process.execPath && path.basename(args[0]) === "run-headless-specs.js") {
          const home = options.env.LUMINE_HOME;
          const installed = path.join(home, "packages", manifest.name);
          assert.equal(fs.readFileSync(path.join(installed, "img", "logo.svg"), "utf8"), svg);
          assert.equal(
            fs.realpathSync(installed),
            fs.realpathSync(path.join(workspace, "checkout", "checkout-name")),
          );
          assert.equal(
            fs.readFileSync(path.join(installed, "package.json"), "utf8"),
            JSON.stringify(manifest),
          );
          if (neighbors.length) {
            assert.equal(
              fs.readFileSync(path.join(home, "packages", "neighbor-package", "keep.txt"), "utf8"),
              "neighbor",
            );
            assert.equal(options.env.LUMINE_TEST_PACKAGES, neighbors.join(" "));
          }
          launched = true;
          if (removeAlias) fs.unlinkSync(installed);
          return { status: 0 };
        }
        throw new Error(`Unexpected process: ${command} ${JSON.stringify(args)}`);
      },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "run-specs.js"), "utf8"), {
      require: (name) =>
        name === "child_process" ? childProcess : name === "fs" ? fixtureFs : require(name),
      __dirname,
      process: fakeProcess,
    });
    assert.equal(fakeProcess.exitCode || 0, 0, stderr);
    assert.equal(launched, true);
    assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).results[0].status, "passed");
  });
}
