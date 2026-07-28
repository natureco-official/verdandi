# Benchmark validation hardening — 2026-07-28

## T04

- Both original retry tests failed when selected alone, proving the earlier 222/222 combined result was order-dependent.
- Root cause: transport construction captured `fetch` before the test installed its spy; earlier tests happened to leave a working mock behind.
- Both worktrees now inject a dedicated fetch implementation.
- Validator gate: three isolated `refresh.*retr` runs, combined Auth/Streamable HTTP tests, lint, typecheck.
- Standard and Capsule: 6/6 checks pass.

## T02–T03

- Target Cloudflare Workers tests and integration lint pass in all four worktrees when run with the required local-listen permission.
- Integration-wide typecheck remains non-zero because of common benchmark-base diagnostics.
- The validator does not broadly ignore these errors. It hashes normalized `file:line:column:error-code` tuples and accepts only the exact commit-specific signature:
  - T02: 47 diagnostics.
  - T03: 44 diagnostics.
- Any added, removed, moved, or recoded diagnostic makes validation fail.

## T08

- Middleware-wide runtime tests were removed from the declaration-task gate because network and SSE timing failures were unrelated to the changed build configuration.
- New gate: four-package build, declaration oracle, four-package lint, four-package typecheck.
- Oracle rejects empty/oversized declarations, workspace source-graph paths, private `@modelcontextprotocol/core` imports, and public imports absent from package dependencies/peerDependencies.
- It found a real Capsule defect: Node's public declaration imported the private core package. Types now flow through the publishable server surface.
- Standard and corrected Capsule: 4/4 checks pass; declaration totals remain about 20 KiB.

## Framework regression suite

The Verðandi repository now has 105 passing tests, including validator policy, T04 repetition, official MCP-client compatibility, and retrieval test-symbol regression coverage. CI runs the suite, lint/typecheck, live MCP smoke, and synthetic token guard on Ubuntu/macOS with Node 20/22/24.
