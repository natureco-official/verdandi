# T01–T03 Capsule Token Optimization — 2026-07-28

## Root cause

The context payload itself was not the dominant cost. Each unnecessary MCP/terminal call created another model turn that replayed the accumulated context.

- T01 returned an irrelevant second symbol, forced both symbols through `read_symbol`, attempted an inapplicable root `validate_delta`, and later emitted ESLint JSON twice (about 103 KB each in an intermediate diagnostic run).
- T02 low-confidence escalation returned 15 symbols across five files even though the target symbols were concentrated in one test file.
- T03 read broad symbol evidence and repeatedly emitted full-file/package typecheck output. It used 15 terminal commands and four MCP calls.
- Test paths were always penalized by `pathPrior`, even when the task explicitly concerned tests. Turkish suffixes such as `testinin` were not recognized as test intent.
- Automatic adapters unconditionally read up to 6–8 returned symbols.

## Fixes

- Mechanical import/lint tasks now force the smallest retrieval budget: one symbol and one probable file.
- Retrieval budgets changed from `3/6/10/16` direct symbols to `1/3/6/8`; neighbor limits were reduced too.
- Test-intent queries now favor test files. Turkish `test*`, `entegrasyon*`, and `regresyon*` forms receive concept expansion.
- Capsules identify the nearest package working directory and provide bounded validation guidance.
- Automatic capsule/injection adapters read at most three symbols with smaller token limits and no call-graph neighbors by default.
- The integrated agent reads at most four probable files, two symbols per file, and 50 import lines.
- The benchmark prompt limits terminal calls, forbids repeated commands and ESLint JSON/dry-run output, bounds diagnostics, and requires the primary package's complete lint/Prettier gate.
- MCP tool descriptions now tell models not to read every symbol and to keep `read_symbol`/validation bounded.

## Results

All runs used `gpt-5.6-sol`, medium effort, and the same pinned task commits. Baseline is the unchanged control from the immediately preceding run.

| Task | Baseline input | Old capsule input | Optimized capsule input | Old → new | Baseline → new |
|---|---:|---:|---:|---:|---:|
| T01 | 123,662 | 250,688 | 150,152 | -40.1% | +21.4% |
| T02 | 2,197,039 | 806,868 | 569,752 | -29.4% | -74.1% |
| T03 | 660,577 | 1,117,905 | 308,988 | -72.4% | -53.2% |
| **Total** | **2,981,278** | **2,175,461** | **1,028,892** | **-52.7%** | **-65.5%** |

| Aggregate | Baseline | Old capsule | Optimized capsule | Old → new | Baseline → new |
|---|---:|---:|---:|---:|---:|
| Duration | 932.8 s | 790.7 s | 651.7 s | -17.6% | -30.1% |
| Uncached input | 205,470 | 196,325 | 135,196 | -31.1% | -34.2% |
| Output tokens | 26,467 | 25,264 | 17,513 | -30.7% | -33.8% |

Tool/command reductions:

| Task | Old events / commands / MCP | New events / commands / MCP |
|---|---:|---:|
| T01 | 28 / 5 / 4 | 22 / 6 / 1 |
| T02 | 58 / 13 / 9 | 41 / 7 / 2 |
| T03 | 65 / 15 / 4 | 30 / 7 / 1 |

## Quality validation

- Capsule project: lint, build, and 81/81 tests pass.
- T01: targeted test, full package lint, and typecheck pass; change remains the same two-line import reorder.
- T02: real Cloudflare Workers test and full package lint/Prettier pass; workspace `packages/server/dist` remains absent. Integration-wide typecheck still has the known common benchmark-base failures.
- T03: targeted test and full package lint pass; three extra consecutive stress runs pass and no `workerd`, Miniflare, or Wrangler process remains. Integration-wide typecheck still has the known common benchmark-base failures.

One earlier optimized T02 attempt reached 322,133 input tokens but failed Prettier, so it was rejected rather than reported as the final result. Its artifacts are retained in the archive.

## Artifacts

- Current raw/validation results: `benchmark_runs/raw` and `benchmark_runs/validation`
- Original pre-fix results and patches: `/private/tmp/capsule-t01-t03-before-token-fix-20260728`
