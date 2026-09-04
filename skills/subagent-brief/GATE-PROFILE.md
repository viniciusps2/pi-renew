# Gate profile

Fill this in **once per project** and reuse it. Both skills read it: `subagent-brief` pastes the
commands and floors into the brief, `subagent-review` re-runs them.

Keep it next to the project's own baseline notes, or inline in this file if the project has none.
Re-measure the baselines whenever they move — a stale floor is worse than no floor, because the
sub-agent will report a discrepancy that does not exist and you will spend a cycle on it.

A polyglot repository gets **one profile per gate**, not one per repository: a Java service and a
TypeScript client in the same tree have different commands, different floors and different traps.
Name which one a brief is using.

---

## 1. The gate — every command, verbatim

Copy-pasteable, including where logs are written and how they are normalised before grepping.

```bash
# <suite 1 — unit>
<command>                         > <log path> 2>&1; echo "$?"
# <suite 2 — integration/e2e>
<command>                         > <log path> 2>&1; echo "$?"
# <type-check — one line per config; list ALL of them>
<command>                         > <log path> 2>&1
# <lint>
<command>                         > <log path> 2>&1

# normalise before grepping (strip control characters / colour codes if the tools emit them)
<normalisation command>
# surface failures
<grep command>
```

> List **every** type-check config, not the obvious ones. A project that grew configs over time
> routinely ends up with source directories whose test files are transpiled but never type-checked
> — a type error there is invisible to the whole gate.

### Starting points per ecosystem

Copy the row that matches, then replace it with what the project actually runs — CI config is the
better source than the README.

| Ecosystem | Tests | Types / compile | Lint | Coverage |
|---|---|---|---|---|
| TypeScript / JS | `npx vitest run` · `npx jest --ci` | `tsc --noEmit -p <each config>` | `npx eslint .` | `vitest run --coverage` · `jest --coverage` |
| Java (Maven) | `mvn -q verify` | the build; `-Werror` where configured | `mvn -q checkstyle:check spotbugs:check` | JaCoCo via `mvn -q verify` |
| Java (Gradle) | `./gradlew test --rerun-tasks` | `./gradlew compileJava compileTestJava` | `./gradlew checkstyleMain spotbugsMain spotlessCheck` | `./gradlew jacocoTestReport` |
| Python | `pytest -q` | `mypy <pkg>` · `pyright` | `ruff check` · `flake8` | `pytest --cov=<pkg> --cov-branch --cov-report=term-missing` |
| Shell | `bats test/` · `shunit2` | `bash -n <script>` | `shellcheck -S style <scripts>` | usually none — say so |

**Record the "prove it ran" command next to each suite**, not just the run command: Surefire's
`Tests run:` line, Gradle's task outcome (`UP-TO-DATE` means nothing ran), pytest's `collected N
items`, the test-file count from Vitest/Jest. That line is what the numeric floor is measured
against.

## 2. Baselines — number **and** the command that prints it

A number without its command is ambiguous. Ambiguity here is a guaranteed false discrepancy
report, because an aggregate command and a scoped command answer different questions and both
answers are correct.

| Measurement | Value | Exact command that prints it |
|---|---|---|
| <suite 1> passing / files | | |
| <suite 2> passing / files / skipped / todo | | |
| <suite N> passing / files | | |
| type-check | clean | <one row per config> |
| lint errors | 0 | |
| lint warnings, **scoped to the project that will change** | | |
| coverage of the area that will change, if wired | | <the command, and where it writes the uncovered lines> |
| a single-test invocation that works here | — | <the exact form, e.g. `-Dtest='FooTest#bar'`> |

**Say explicitly whether a warning count is per-project or the aggregate across all projects.**
This single ambiguity is the most reliable source of wasted review time.

## 3. What a legitimate change to these numbers looks like

- **Test counts** should rise by roughly the number of tests the task adds. A fall, or a rise in
  *skipped*, means the suite did not really run.
- **Lint warnings**: the check is not "did the number rise" but **"is the rise entirely the
  documented house-style exception, in test code?"** A new rule appearing, or any warning in
  non-test source, is the real signal.

  Measure the delta rather than deriving it:

  ```bash
  <stash including untracked>  →  <lint command>  →  <restore>
  # and per-rule, on the changed files only:
  <lint one file> | <extract rule names> | sort | uniq -c
  ```

## 4. Known trap signatures — infrastructure, not your change

Failures that mimic a real defect convincingly. The brief must list these **and** say *"if you see
this, report it rather than fixing it"*.

Fill in the project's own. These five are ecosystem-generic and worth carrying into every profile —
each one is a **green run that executed nothing**, or a red run that has nothing to do with the diff.

| Signature | What it actually is | What to do |
|---|---|---|
| Gradle prints `UP-TO-DATE` or `FROM-CACHE` for `test` | the task was cached; **no test ran** | re-run with `--rerun-tasks` or `cleanTest test`; never baseline off a cached run |
| pytest exits **5** with `collected 0 items` | nothing was collected — a bad path, a `-k`/`-m` filter, a missing `conftest.py` | treat as a failure, not a pass; fix collection before reading anything else |
| Maven's build succeeds with no `Tests run:` line | `-DskipTests` / `-Dmaven.test.skip`, or the module is outside the reactor | re-run the module explicitly |
| A suite's *passing* count fell while nothing was deleted | a focus marker (`.only`, `fdescribe`, `@Disabled`, `pytest.mark.skip`) is live in a changed file | grep the changed test files for focus/skip markers |
| A process is `Killed`, or fails with no assertion output | the OOM reaper, or infrastructure | reproduce on a clean tree **before** attributing it to the diff |
| <project-specific signature> | <what it actually is> | <what to do> |

**The general rule worth stating in every brief: a failure with no assertion output is
infrastructure until proven otherwise.** Reproduce it against a clean tree before spending time on
the diff.

## 5. House style that would otherwise look like a mistake

Conventions a reviewer or sub-agent would "fix" if not told they are deliberate — and, for each,
whether it is enforced or merely conventional.

| Convention | Where it applies | Why |
|---|---|---|
| <e.g. a lint rule deliberately warned-on in test code> | <test files> | <the reason, and that the warnings are expected and counted> |
| <comment density in a particular class of file> | <those files> | <what the neighbouring files do> |

## 6. Ownership

| Thing | Owner |
|---|---|
| git history and index | the caller — the sub-agent never commits |
| plan / task / tracking documents | the caller, after review |
| generated code, contracts, snapshots, fixtures | frozen unless the task is explicitly about them |
