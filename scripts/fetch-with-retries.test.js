"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { fetchWithRetries } = require("./fetch-with-retries");

function requests(...responses) {
  const calls = [];
  const delays = [];
  return {
    calls,
    delays,
    dependencies: {
      fetch: async (...args) => {
        calls.push(args);
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return next;
      },
      sleep: async (delay) => delays.push(delay),
      now: () => Date.parse("2026-10-07T10:00:00Z"),
    },
  };
}

test("retries a throttled manifest and honors Retry-After", async () => {
  const success = new Response('{"engines":{"lumine":"^1.0.0"}}');
  const stub = requests(
    new Response("throttled", { status: 429, headers: { "retry-after": "2" } }),
    success,
  );
  const response = await fetchWithRetries(
    "https://example.test/package.json",
    {},
    stub.dependencies,
  );
  assert.equal(response, success);
  assert.deepEqual(await response.json(), { engines: { lumine: "^1.0.0" } });
  assert.deepEqual(stub.delays, [2000]);
});

test("returns a missing manifest without retrying", async () => {
  const missing = new Response("missing", { status: 404 });
  const stub = requests(missing);
  assert.equal(
    await fetchWithRetries(
      "https://example.test/package.json",
      {},
      stub.dependencies,
    ),
    missing,
  );
  assert.equal(stub.calls.length, 1);
  assert.deepEqual(stub.delays, []);
});

test("retries a transient response even when its body has already failed", async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.error(new Error("response body failed"));
    },
  });
  const success = new Response("[]");
  const stub = requests(new Response(body, { status: 503 }), success);
  assert.equal(
    await fetchWithRetries("https://example.test/repos", {}, stub.dependencies),
    success,
  );
  assert.equal(stub.calls.length, 2);
});

test("leaves persistent service errors visible after three attempts", async () => {
  const final = new Response("unavailable", { status: 503 });
  const stub = requests(
    new Response("unavailable", { status: 503 }),
    new Response("unavailable", { status: 503 }),
    final,
  );
  assert.equal(
    await fetchWithRetries("https://example.test/repos", {}, stub.dependencies),
    final,
  );
  assert.equal(await final.text(), "unavailable");
  assert.equal(stub.calls.length, 3);
  assert.deepEqual(stub.delays, [1000, 2000]);
});

test("retries network errors and preserves request headers", async () => {
  const success = new Response("[]");
  const stub = requests(new TypeError("fetch failed"), success);
  const options = { headers: { Accept: "application/vnd.github+json" } };
  assert.equal(
    await fetchWithRetries(
      "https://example.test/repos",
      options,
      stub.dependencies,
    ),
    success,
  );
  assert.deepEqual(stub.calls[1][1].headers, options.headers);
  assert.deepEqual(stub.delays, [1000]);
});

test("throws the final network failure", async () => {
  const failure = new TypeError("fetch failed");
  const stub = requests(failure, failure, failure);
  await assert.rejects(
    fetchWithRetries("https://example.test/repos", {}, stub.dependencies),
    (error) => error === failure,
  );
  assert.equal(stub.calls.length, 3);
});

test("bounds date-based Retry-After delays", async () => {
  const stub = requests(
    new Response("throttled", {
      status: 429,
      headers: { "retry-after": "Wed, 07 Oct 2026 10:05:00 GMT" },
    }),
    new Response("[]"),
  );
  await fetchWithRetries("https://example.test/repos", {}, stub.dependencies);
  assert.deepEqual(stub.delays, [30000]);
});
