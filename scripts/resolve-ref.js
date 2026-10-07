"use strict";

const { execFile } = require("node:child_process");
const { setTimeout: sleep } = require("node:timers/promises");

const ATTEMPTS = 3;

async function lsRemote(cloneUrl, ref, dependencies = {}) {
  const execute = dependencies.execFile || execFile;
  const pause = dependencies.sleep || sleep;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      return await new Promise((resolve, reject) => {
        execute(
          "git",
          ["ls-remote", cloneUrl, `refs/heads/${ref}`],
          { timeout: 60000, maxBuffer: 16 * 1024 * 1024 },
          (error, stdout, stderr) => {
            if (error) {
              reject(
                new Error(
                  String(stderr || error.message)
                    .trim()
                    .split(/\r?\n/)[0],
                ),
              );
              return;
            }
            const match = String(stdout).match(/^([0-9a-f]{40})\s/i);
            resolve(match ? match[1].toLowerCase() : null);
          },
        );
      });
    } catch (error) {
      if (attempt === ATTEMPTS) throw error;
      process.stderr.write(
        `Retrying ${cloneUrl} after ${error.message} (attempt ${attempt}).\n`,
      );
      await pause(1000 * 2 ** (attempt - 1));
    }
  }
}

module.exports = { lsRemote };
