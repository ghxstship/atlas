#!/usr/bin/env node
/** Entry point of the `xos` binary. */
import { run } from "./cli.ts";
import { readAll } from "./io.ts";

const code = await run(
  {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    readStdin: () => readAll(process.stdin),
    env: process.env,
    isTTY: process.stdout.isTTY === true,
  },
  process.argv.slice(2),
);
process.exitCode = code;
