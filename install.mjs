#!/usr/bin/env node

/**
 * pi-renew installer.
 *
 * `pi install` already registers everything this repo ships — the extension, the skills tree and
 * the /renew-loop prompt — from the `pi` manifest in package.json. This wrapper exists for two things
 * `pi install` cannot do on its own: pick the right source automatically, and clean up the older
 * manual setup (inner-package entry plus hand-made symlinks) that predates the manifest.
 *
 *   ./install.mjs             install (this checkout if run from one, else the remote)
 *   ./install.mjs --local     install project-locally (.pi/settings.json)
 *   ./install.mjs --migrate   install, then remove the legacy manual setup
 *   ./install.mjs --remove    uninstall
 *   ./install.mjs --check     report what is installed and exit
 */

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const REMOTE_SOURCE = "git:github.com/viniciusps2/pi-renew";
const HERE = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const has = (...names) => names.some((n) => args.includes(n));

if (has("--help", "-h")) {
  console.log(`
pi-renew - session renewal for pi, plus the /renew-loop protocol and its skills

Usage:
  install.mjs              Install (uses this checkout if run from one, else the remote)
  install.mjs --local      Install project-locally (.pi/settings.json)
  install.mjs --migrate    Install, then remove the legacy symlink setup
  install.mjs --remove     Uninstall
  install.mjs --check      Report what is installed, change nothing

One install registers everything from the package manifest:
  extension  ->  renew_session, renew_from_handover, set_renewal_context, /pi-renew
  prompts    ->  /renew-loop
  skills     ->  subagent-brief, subagent-review, pi-subagent (+ pi-driver-common),
                 used only by /renew-loop's opt-in brief-and-review mode
`);
  process.exit(0);
}

const local = has("--local", "-l");
const scopeArgs = local ? ["-l"] : [];
const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");

function requirePi() {
  const probe = spawnSync("pi", ["--version"], { encoding: "utf-8" });
  if (probe.error || probe.status !== 0) {
    console.error("`pi` was not found on PATH. Install the agent first: https://pi.dev");
    process.exit(1);
  }
  return probe.stdout.trim();
}

/** A checkout has the manifest, the resource trees and git metadata; an npm cache dir does not. */
function isCheckout(dir) {
  if (!existsSync(join(dir, ".git"))) return false;
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    return pkg?.name === "pi-renew" && Boolean(pkg?.pi?.extensions);
  } catch {
    return false;
  }
}

function readSettings() {
  const path = local ? resolve(process.cwd(), ".pi", "settings.json") : join(agentDir, "settings.json");
  if (!existsSync(path)) return { path, dir: dirname(path), packages: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return { path, dir: dirname(path), packages: Array.isArray(parsed.packages) ? parsed.packages : [] };
  } catch {
    return { path, dir: dirname(path), packages: [] };
  }
}

/**
 * Is this settings entry one of ours? Local paths are stored relative to the settings file and the
 * directory can be named anything, so identify them by the package name rather than by the string —
 * a checkout in ~/src/scratch is still pi-renew.
 */
function isOurs(entry, settingsDir) {
  if (typeof entry !== "string") return false;
  if (entry.startsWith("npm:")) return /^npm:pi-renew(@|$)/.test(entry);
  if (/^(git:|https?:\/\/|ssh:\/\/|git@)/.test(entry)) return /pi-renew(\.git)?([@#].*)?$/.test(entry);
  try {
    const pkg = JSON.parse(readFileSync(join(resolve(settingsDir, entry), "package.json"), "utf-8"));
    return pkg?.name === "pi-renew";
  } catch {
    return false;
  }
}

function ourEntries() {
  const { path, dir, packages } = readSettings();
  const entries = packages.filter((e) => isOurs(e, dir));
  // `pi remove` matches the source it was given and resolves relative paths against the cwd, while
  // settings store them relative to the settings file — so hand it an absolute path for local entries.
  const removable = entries.map((e) => (/^(npm:|git:|https?:\/\/|ssh:\/\/|git@)/.test(e) ? e : resolve(dir, e)));
  return { settingsPath: path, entries, removable };
}

/** Symlinks and settings entries from the pre-manifest setup, which now double-register resources. */
function findLegacy() {
  const { path: settingsPath, dir: settingsDir, packages } = readSettings();
  const innerEntries = packages
    .filter((p) => typeof p === "string" && /pi-extensions[/\\]pi-renew\/?$/.test(p))
    .map((entry) => ({ entry, removable: resolve(settingsDir, entry) }));

  const links = [];
  // Both prompt names: `loop.md` is what the pre-rename instructions linked, `renew-loop.md` what a
  // link made since would be called.
  const candidates = [join(agentDir, "prompts", "loop.md"), join(agentDir, "prompts", "renew-loop.md")];
  const skillsDir = join(agentDir, "skills");
  if (existsSync(skillsDir)) {
    for (const name of listDir(skillsDir)) candidates.push(join(skillsDir, name));
  }
  for (const candidate of candidates) {
    let target;
    try {
      if (!lstatSync(candidate).isSymbolicLink()) continue;
      target = resolve(dirname(candidate), readlinkSync(candidate));
    } catch {
      continue;
    }
    if (ownedByPiRenew(target)) links.push({ link: candidate, target });
  }
  return { settingsPath, innerEntries, links };
}

/**
 * Does this symlink target sit inside a pi-renew package? Checks the package the resource belongs to
 * rather than the path text, so a checkout in a directory named anything else is still recognised —
 * and a link into someone else's skills/ tree is not.
 */
function ownedByPiRenew(target) {
  // The three shapes the old instructions produced: <root>/prompts/*.md, <root>/skills, and
  // <root>/skills/<one-skill>. Each names a candidate package root and the tree it sits in.
  const candidates = [
    { root: resolve(target, "..", ".."), tree: basename(dirname(target)) },
    { root: resolve(target, ".."), tree: basename(target) },
  ];
  for (const { root, tree } of candidates) {
    if (tree !== "prompts" && tree !== "skills") continue;
    try {
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
      if (pkg?.name === "pi-renew" && pkg?.pi) return true;
    } catch {
      /* not a package root — try the next shape */
    }
  }
  return false;
}

function listDir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function reportLegacy({ settingsPath, innerEntries, links }) {
  if (!innerEntries.length && !links.length) return false;
  console.log("\nLegacy manual setup detected — it registers the same resources a second time:");
  for (const { entry } of innerEntries) console.log(`  package entry  ${entry}   (in ${settingsPath})`);
  for (const { link, target } of links) console.log(`  symlink        ${link} -> ${target}`);
  return true;
}

function runPi(argv) {
  const result = spawnSync("pi", argv, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// --check: report only.
if (has("--check")) {
  console.log(`pi ${requirePi()}`);
  const { settingsPath, entries } = ourEntries();
  console.log(`\n${settingsPath}`);
  console.log(entries.length ? entries.map((e) => `  ${e}`).join("\n") : "  (no pi-renew package entry)");
  if (!reportLegacy(findLegacy())) console.log("\nNo legacy symlink setup found.");
  process.exit(0);
}

// --remove: uninstall whichever source is registered.
if (has("--remove", "-r")) {
  requirePi();
  const { entries, removable } = ourEntries();
  if (!entries.length) {
    console.log("pi-renew is not installed.");
    process.exit(0);
  }
  for (const entry of removable) runPi(["remove", entry, ...scopeArgs]);
  console.log("\npi-renew removed. Any symlinks you created by hand are left alone; --check lists them.");
  process.exit(0);
}

// Install.
requirePi();
const explicit = args.find((a) => !a.startsWith("-"));
const source = explicit ?? (isCheckout(HERE) ? HERE : REMOTE_SOURCE);

console.log(`Installing pi-renew from ${source}${local ? " (project-local)" : ""}...\n`);
runPi(["install", source, ...scopeArgs]);

const legacy = findLegacy();
if (has("--migrate")) {
  if (legacy.innerEntries.length || legacy.links.length) {
    console.log("\nRemoving the legacy manual setup:");
    for (const { removable } of legacy.innerEntries) runPi(["remove", removable, ...scopeArgs]);
    for (const { link } of legacy.links) {
      rmSync(link, { force: true });
      console.log(`  removed symlink ${link}`);
    }
  } else {
    console.log("\nNothing to migrate — no legacy setup found.");
  }
} else if (reportLegacy(legacy)) {
  console.log("\nRe-run with --migrate to remove it, or leave it and remove it by hand.");
}

console.log(`
pi-renew installed.

Next: turn on the automatic high-context renewal (off unless configured) in
${join(agentDir, "pi-renew.json")}
  { "highContextReminder": { "enabled": true, "thresholdFraction": 0.85 } }

Then, in a pi session:
  /renew-loop <what to do>   one turn per session, 10 turns unless you say otherwise
  /pi-renew <reason>         restart this session by hand

Optional companions the loop picks up when present, and does without when not:
  pi install npm:pi-subagents           child agents for brief-and-review mode
  npm install -g @fission-ai/openspec   spec-driven changes and \`openspec archive\`
`);
