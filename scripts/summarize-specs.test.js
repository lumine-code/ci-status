"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

function summarize(t, change = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-ci-summary-"));
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sha = "a".repeat(40),
    editorSha = "b".repeat(40);
  const plan = {
    editorSha,
    packages: [{ name: "fixture", source: "fixture/repository", sha }],
  };
  const shard = {
    platform: "Windows",
    status: "passed",
    expectedEditorSha: editorSha,
    editorSha,
    results: [
      {
        name: "fixture",
        source: "fixture/repository",
        platform: "Windows",
        status: "passed",
        sha,
        shaAfter: sha,
        expectedSha: sha,
        editorSha,
        editorShaAfter: editorSha,
        expectedEditorSha: editorSha,
      },
    ],
  };
  change(shard, plan);
  const results = path.join(root, "results"),
    planFile = path.join(root, "plan.json");
  fs.mkdirSync(results);
  fs.writeFileSync(planFile, JSON.stringify(plan));
  fs.writeFileSync(path.join(results, "result.json"), JSON.stringify(shard));
  let text = "";
  const fake = {
    argv: [process.execPath, "summarize-specs.js", "--results", results, "--plan", planFile],
    env: {},
    stdout: {
      write(s) {
        text += s;
      },
    },
    stderr: {
      write(s) {
        text += s;
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "summarize-specs.js"), "utf8"), {
    require,
    process: fake,
  });
  return { code: fake.exitCode || 0, text };
}

test("matching exact package and editor inputs remain green", (t) => {
  const r = summarize(t);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /1 passed/);
});

test("an exact skipped result remains skipped without claiming post-test observations", (t) => {
  const r = summarize(t, (s) => {
    s.results[0].status = "skipped";
    delete s.results[0].shaAfter;
    delete s.results[0].editorShaAfter;
  });
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /1 skipped/);
});
for (const key of ["sha", "expectedSha", "editorSha", "expectedEditorSha", "source"]) {
  test(`a mismatched ${key} cannot be summarized as success`, (t) => {
    const r = summarize(t, (s) => {
      s.results[0][key] = "wrong";
    });
    assert.equal(r.code, 1);
    assert.match(r.text, /do not match the plan/);
  });
}
test("duplicate platform results cannot hide an earlier outcome", (t) => {
  const r = summarize(t, (s) => {
    s.results.push({ ...s.results[0] });
  });
  assert.equal(r.code, 1);
  assert.match(r.text, /More than one result/);
});
test("an interrupted running record is not a terminal success", (t) => {
  const r = summarize(t, (s) => {
    s.results[0].status = "running";
  });
  assert.equal(r.code, 1);
  assert.match(r.text, /No terminal result/);
});
test("a failed artifact cannot hide behind already completed results", (t) => {
  const r = summarize(t, (s) => {
    s.status = "error";
    s.message = "write failed";
  });
  assert.equal(r.code, 1);
  assert.match(r.text, /Incomplete result artifacts/);
});
test("an empty failed shard still reports its missing packages", (t) => {
  const r = summarize(t, (s) => {
    s.results = [];
    s.status = "error";
  });
  assert.equal(r.code, 1);
  assert.match(r.text, /Not reported/);
});
test("a plan without an editor binding cannot accept results", (t) => {
  const r = summarize(t, (_s, p) => {
    delete p.editorSha;
  });
  assert.equal(r.code, 1);
  assert.match(r.text, /no full editor commit/);
});

for (const status of ["running", "failed", undefined]) {
  test(`a ${status ?? "missing"} artifact status cannot authenticate passed records`, (t) => {
    const r = summarize(t, (s) => {
      if (status === undefined) delete s.status;
      else s.status = status;
    });
    assert.equal(r.code, 1);
    assert.match(r.text, /Incomplete result artifacts/);
  });
}

for (const key of ["shaAfter", "editorShaAfter"]) {
  for (const missing of [false, true]) {
    test(`a passed result requires ${missing ? "present" : "matching"} ${key}`, (t) => {
      const r = summarize(t, (s) => {
        if (missing) delete s.results[0][key];
        else s.results[0][key] = "wrong";
      });
      assert.equal(r.code, 1);
      assert.match(r.text, /do not match the plan/);
    });
  }
}

test("the explicit unresolved-plan artifact remains a visible planning error", (t) => {
  const r = summarize(t, (s, p) => {
    delete s.platform;
    delete s.status;
    delete s.expectedEditorSha;
    delete s.editorSha;
    s.shard = "plan";
    s.results = [
      {
        name: "fixture",
        source: "fixture/repository",
        ref: null,
        sha: null,
        status: "error",
        message: "unresolved",
      },
    ];
    p.packages = [];
  });
  assert.equal(r.code, 1);
  assert.match(r.text, /Unresolved catalog entries/);
  assert.doesNotMatch(r.text, /Incomplete result artifacts/);
});

for (const key of ["editorSha", "expectedEditorSha"]) {
  test(`a passed artifact requires a matching top-level ${key}`, (t) => {
    const r = summarize(t, (s) => {
      s[key] = "wrong";
    });
    assert.equal(r.code, 1);
    assert.match(r.text, /artifact editor commits do not match/);
  });
}
