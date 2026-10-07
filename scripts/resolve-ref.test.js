"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { lsRemote } = require("./resolve-ref");

const SHA = "0123456789abcdef0123456789abcdef01234567";

function gitResults(...results) {
  const calls = [];
  const delays = [];
  return {
    calls,
    delays,
    dependencies: {
      execFile: (command, args, options, callback) => {
        calls.push({ command, args, options });
        const next = results.shift();
        if (next instanceof Error)
          callback(next, "", `fatal: ${next.message}\n`);
        else callback(null, next, "");
      },
      sleep: async (delay) => delays.push(delay),
    },
  };
}

test("retries a dropped Git connection and resolves the requested branch", async () => {
  const stub = gitResults(
    new Error("Empty reply from server"),
    `${SHA}\trefs/heads/master\n`,
  );
  assert.equal(
    await lsRemote(
      "https://example.test/package.git",
      "master",
      stub.dependencies,
    ),
    SHA,
  );
  assert.deepEqual(stub.calls[1].args, [
    "ls-remote",
    "https://example.test/package.git",
    "refs/heads/master",
  ]);
  assert.deepEqual(stub.delays, [1000]);
});

test("a missing branch is reported without retrying", async () => {
  const stub = gitResults("");
  assert.equal(
    await lsRemote(
      "https://example.test/package.git",
      "missing",
      stub.dependencies,
    ),
    null,
  );
  assert.equal(stub.calls.length, 1);
  assert.deepEqual(stub.delays, []);
});

test("a persistent Git failure remains an error after bounded retries", async () => {
  const failure = new Error("Could not resolve host");
  const stub = gitResults(failure, failure, failure);
  await assert.rejects(
    lsRemote("https://example.test/package.git", "master", stub.dependencies),
    /fatal: Could not resolve host/,
  );
  assert.equal(stub.calls.length, 3);
  assert.deepEqual(stub.delays, [1000, 2000]);
});
