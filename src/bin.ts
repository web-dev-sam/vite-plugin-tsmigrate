#!/usr/bin/env node
import { run } from "./cli.ts";

/**
 * The `tsmigrate` bin. Process wiring only — `run` stays callable in-process
 * (and testable) with its own IO.
 *
 * `process.exitCode` rather than `process.exit`: a piped stdout write is
 * asynchronous, and exiting outright truncates the file list.
 */
process.exitCode = await run(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
