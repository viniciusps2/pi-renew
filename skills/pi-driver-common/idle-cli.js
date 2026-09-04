#!/usr/bin/env node
//
// idle-cli — the shared idle-seconds formula (computeIdleSeconds), exposed as a tiny CLI.
//
// Why this exists: the spec's *Shared operational discipline* requirement says all driver
// skills, INCLUDING the existing one-shot driver, share ONE implementation of the idle
// watchdog's formula. The one-shot driver (skills/pi-subagent/pi-agent.sh) is bash, so the
// only two options were "shell out to this shared function" or "reimplement the formula in
// bash" — and the second is exactly the drift skills/pi-driver-common exists to prevent. This
// file is the seam: it does nothing but parse three flags, call computeIdleSeconds unchanged,
// and print the result.
//
// Usage:
//   idle-cli.js --prompt-bytes <n> --surface-bytes <n> [--explicit-idle <n>]
//
// Prints the computed idle-seconds integer to stdout and nothing else, exits 0. On a bad
// argument (unrecognised flag, missing value, non-numeric value), prints a message to stderr
// and exits with the shared usage code, imported from ./exit-codes.js rather than written as a
// literal here — this file lives IN the shared library, and a hand-copied 2 is exactly the drift
// that module exists to prevent.
//
// --explicit-idle mirrors computeIdleSeconds's own contract: when given (including "0"), it
// is returned verbatim and the formula is not consulted.

import { EXIT_USAGE } from './exit-codes.js';
import { computeIdleSeconds } from './idle.js';

const KNOWN_FLAGS = ['--prompt-bytes', '--surface-bytes', '--explicit-idle'];

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!KNOWN_FLAGS.includes(arg)) {
      throw new Error(`unrecognised argument: ${arg} (expected ${KNOWN_FLAGS.join(', ')})`);
    }
    i += 1;
    const raw = argv[i];
    if (raw === undefined) throw new Error(`${arg} requires a numeric value`);
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`${arg} must be a number, got "${raw}"`);
    values[arg.slice(2)] = n;
  }
  return values;
}

function main() {
  try {
    const values = parseArgs(process.argv.slice(2));
    const seconds = computeIdleSeconds({
      promptBytes: values['prompt-bytes'] ?? 0,
      surfaceBytes: values['surface-bytes'] ?? 0,
      explicitIdle: values['explicit-idle'],
    });
    process.stdout.write(`${seconds}\n`);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`idle-cli: ${err.message}\n`);
    process.exit(EXIT_USAGE);
  }
}

main();
