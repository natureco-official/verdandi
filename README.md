# Verðandi — Context Compiler for AI Coding Agents

[![CI](https://github.com/natureco-official/verdandi/actions/workflows/ci.yml/badge.svg)](https://github.com/natureco-official/verdandi/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-blue)]()
[![Tests](https://img.shields.io/badge/tests-111%20passing-brightgreen)]()

> Your agent doesn't spend most of its budget solving the problem.
> It spends it **looking for the problem**.

**Verðandi** (pronounced *ver-THAN-dee*) reads your codebase so your agent doesn't have to. It indexes the project with the TypeScript compiler, works out which symbols the task actually touches, and hands the agent a small, bounded capsule of exactly that. The agent skips the hunt and starts on the work.

Named after the Norse Norn of the present — the one who sees what *is*, not what was or will be.

---

## The problem, in one picture

```
WITHOUT VERÐANDI                          WITH VERÐANDI
─────────────────────────────────         ─────────────────────────────────
 Task: "fix the auth retry bug"            Task: "fix the auth retry bug"
        │                                         │
        ▼                                         ▼
 ┌──────────────────────┐                  ┌──────────────────────┐
 │ agent: ls, grep, cat │  ← tokens        │ Verðandi indexes the │  ← no model
 │ reads a file… wrong  │  ← tokens        │ repo with the TS AST │     tokens
 │ reads another…       │  ← tokens        └──────────┬───────────┘
 │ searches again…      │  ← tokens                   │
 │ finally finds it     │  ← tokens                   ▼
 └──────────┬───────────┘                  ┌──────────────────────┐
            │                              │ capsule: 3 symbols,  │
            ▼                              │ 2 files, ~250 tokens │
      starts working                       └──────────┬───────────┘
                                                      │
                                                      ▼
                                                starts working
```

That search is invisible on your bill. It just looks like "the task was expensive".

---

## What it actually saves

Ten real tasks, taken from commit pairs in [`modelcontextprotocol/typescript-sdk`](https://github.com/modelcontextprotocol/typescript-sdk). Same model, same settings — baseline agent vs. the same agent with Verðandi:

| Task group | Input tokens | Wall time |
|---|---:|---:|
| T01–T04 | **−36.9%** | −22.4% |
| T01–T03 | **−52.7%** | — |
| T05–T06 | **−55.3%** | −11.0% |
| T07–T08 | **−74.2%** | −45.3% |
| T09–T10 | **−79.8%** | −55.1% |

Every run was independently tested, linted, typechecked and read by hand. **The model's own "I verified it" was not accepted as evidence.**

The spread is the honest part: savings scale with how much *searching* a task needs. A one-line import-order fix saves nothing and can even cost more. A bug spread across four files is where 70–80% shows up.

### Not proven yet

- **Quality equivalence.** Task tests pass on both sides, but a third-party blind comparison score is still pending. "No quality loss" is the goal, not a finished measurement.
- **Generality.** Ten tasks, one repository, TypeScript only. T11–T40 and a second independent labeller remain open.

Published because a benchmark that only reports its wins is not a benchmark.

---

## How it works

```
  your task ──▶ ┌─────────────────────────────────────────────┐
                │ 1. INDEX     TypeScript compiler API:       │
                │              symbols, imports, call graph   │
                ├─────────────────────────────────────────────┤
                │ 2. SELECT    direct matches, plus 1-hop     │
                │              neighbours in the call graph   │
                ├─────────────────────────────────────────────┤
                │ 3. BUDGET    200–300 tokens normally;       │
                │              wider when confidence is low   │
                ├─────────────────────────────────────────────┤
                │ 4. SERVE     capsule over MCP, or injected  │
                │              straight into the prompt       │
                └──────────────────┬──────────────────────────┘
                                   ▼
                            agent does the work
                                   │
                ┌──────────────────▼──────────────────────────┐
                │ 5. PATCH     content-hash preconditions,    │
                │              atomic multi-file, rollback    │
                └─────────────────────────────────────────────┘
```

When retrieval confidence falls below `0.72`, Verðandi silently escalates to a wider budget instead of handing over a thin capsule and hoping. After three attempts it stops and hands the task to a human rather than spending more budget on guesses.

---

## Quick start

```bash
npm install
npm run build
npm test
```

Then choose how to use it.

### As an MCP server

```bash
node bin/verdandi-context-compiler setup codex   # prints the registration command
node bin/verdandi-context-compiler status
```

Supported: `codex`, `claude`, `opencode`, `natureco`, `hermes`, `openclaw`, `kimi`, `glm`, `antigravity`.

### Injected into the prompt

```bash
./run_with_capsule.sh <agent> <project-root> "Your task"
```

Auto-inject supports `natureco`, `hermes`, `codex`, `claude`, `opencode`, `openclaw`, `kimi`, `glm`. `antigravity` works as an MCP server but has no auto-inject entry yet.

### As a standalone agent

```bash
verdandi-agent "Fix the import order" --project ./project --model gpt-4o --api-key "$VERDANDI_API_KEY"
```

Environment: `VERDANDI_API_KEY`, `VERDANDI_MODEL`, `VERDANDI_BASE_URL`, `VERDANDI_REQUEST_TIMEOUT_MS`, `VERDANDI_CODEX_MODEL`. Legacy `URDR_*` names still work.

---

## The five tools

| Tool | What it does | Why it is safe |
|---|---|---|
| `context_capsule` | Picks the symbols and files for a task | Read-only, budget-bounded |
| `read_symbol` | Returns a symbol's source and hashes | Read-only, project-scoped |
| `apply_structured_patch` | Applies an edit | Refuses if the file changed since the snapshot |
| `rollback_patch` | Undoes a patch | Only inside the project, only if untouched since |
| `validate_delta` | Runs project scripts | Only with explicit `commandProfile: "package-scripts"` |

---

## Safety

This tool reads your source, writes patches and can run your package scripts. That deserves more than a promise, so every guarantee has a test behind it:

| Guarantee | How it is enforced |
|---|---|
| No patch against a stale index | Source snapshot plus per-file and per-symbol content hashes |
| No half-applied multi-file edit | One atomic patch; any failure rolls the whole set back |
| No escape from the project | Paths resolved and rejected outside the root — **including through symlinks** |
| No overwriting your work | Rollback skips files you changed after the patch |
| No surprise command execution | `validate_delta` refuses unless the caller opts in explicitly |
| Only approved scripts run | `test`, `lint`, `typecheck`, `build` — nothing else |

The adversarial suite is written deliberately *against* the implementation: symlink escapes, stale caches, crash-safe journal manipulation, MCP boundary abuse.

> **Windows:** the two symlink tests need Developer Mode. Without it they are **skipped with a stated reason** rather than failed — but the symlink protections are then unverified on that machine. Enable at *Settings → System → For developers → Developer Mode*.

---

## Development

```bash
npm run typecheck
npm run lint
npm test                                   # 111 tests
node smoke_test.mjs                        # all five tools, live
node benchmark_runs/setup_worktrees.mjs    # prepare benchmark worktrees
CAPSULE_WORKTREE_BASE="<printed path>" npm run benchmark:retrieval
```

CI runs the same gates on **Linux, macOS and Windows** across Node 20, 22 and 24, with action versions pinned to immutable commit SHAs.

Windows joined the matrix on 2026-07-28. Until then only Linux and macOS ran, and three Windows-only defects had gone unnoticed: `validate_delta` never worked at all, the benchmark runner reported every command as "not found", and four tests failed for environment reasons. **A test that does not run on a platform is a test that does not exist there.**

---

## Retrieval quality

Measured against the SDK repository. Most recent independent run (2026-07-28, base `cc4b416`):

| Metric | Result | Threshold |
|---|---:|---:|
| Primary file `hit@1` | 90.00% | ≥ 90% |
| Required file-group recall | 95.45% | ≥ 90% |
| Acceptable file precision | 50.91% | ≥ 50% |
| Symbol-group recall | 53.33% | ≥ 85% |

Symbol recall sits below its threshold, and the cause is not a retrieval regression: four expected symbols (`signalProcessGroup`, `stopProcessGroup`, `trimHeaderOws`, `serializeProtocolDocument`) no longer exist upstream. The files are still there; the symbols were renamed.

An earlier run reported 100% for `hit@1` and symbol recall, but those numbers **cannot be reproduced** — the commits they were pinned to were never recorded anywhere. That is why the oracle now writes `baseCommit` and `measuredAt` into every result. Details in [`benchmark_runs/RETRIEVAL-QUALITY-2026-07-28.md`](benchmark_runs/RETRIEVAL-QUALITY-2026-07-28.md).

---

## Nature.co ecosystem

| Project | What it does |
|---|---|
| [Urðr](https://github.com/natureco-official/urdr) | Tree-structured persistent memory for agents |
| **Verðandi** | Task context — this repository |
| [CodeDNA](https://github.com/natureco-official/codedna) | Measures AI authorship and understanding debt |
| [NatureCo CLI](https://github.com/natureco-official/natureco-cli) | Terminal client for the platform |
| [NatureCo SDK](https://github.com/natureco-official/natureco-sdk) | JavaScript SDK |
| [Cupertino Terminal](https://github.com/natureco-official/cupertino-terminal) | Native terminal with an encrypted P2P remote shell |

Urðr remembers across sessions. Verðandi decides what matters *right now*. They stay separate on purpose: Verðandi keeps no session history and stores no large code fragments.

Architecture notes and per-agent commands live in [`UNIVERSAL.md`](UNIVERSAL.md) and [`integrations/`](integrations/).

## License

MIT — see [LICENSE](LICENSE).
