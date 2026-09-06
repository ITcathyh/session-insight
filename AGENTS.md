# Repository Guidelines

Guidance for AI agents working in this repository. `CLAUDE.md` points here; this file is the single source of truth.

## What this repository is

**Session Insight** — a self-hosted analyzer for Codex, Claude Code, and TraeX session logs. It ships a loopback-bound Go server and a React frontend that import or scan JSONL session files and render token pulses, traces, tool and skill usage, verification signals, sub-agents, idle gaps, and likely corrections. Remote deployments are accessed through SSH tunnels; a Node.js client syncs local logs through the existing import API.

Session Insight needs no database, no login, and no server-side account model — one binary plus one JSON index. Don't reintroduce that machinery: an issue tracker, workspaces, auth, PostgreSQL, or a background daemon are all out of scope here.

The codebase contains three Go packages and one React app. Read the whole of a file before changing it.

## Hard constraints

These are not style preferences. Each one is a property the tool is expected to hold, and a change that breaks one is a bug even if tests pass.

**This tool reads private transcripts.** Everything below follows from that.

- **Loopback only.** `cmd/session-insight` refuses to start on a non-loopback `--addr`. Never add a flag, default, or "convenience" path that binds a routable interface. There is no auth layer behind it.
- **The index never stores transcript bodies.** `index.json` holds run summaries plus one bounded title line per run. Event traces go to `runs/<run-id>/trace.json`, separately. Listing without a keyword query uses summaries; content search lazily reads traces into an in-memory cache that must never be persisted.
- **Excerpts stay bounded.** Conversation input/output uses an 8 KiB budget (`maxConversationExcerptBytes`); tool input/output and all errors use 640 bytes (`maxTraceExcerptBytes`). Truncation appends `…` after that budget. Raising either increases newly written traces on disk — measure before you touch it.
- **Original session files are read-only.** Scanning aggregates; it never writes to, moves, or deletes a user's `~/.codex`, `~/.claude`, or `~/.trae` files. Uploads land in a temp dir that is deleted when the request ends.
- **No source file locations in the index.** Persist the privacy-safe aggregate and hashed lookup keys, never the parser's raw source path or `SourceRunKey`. Transcript excerpts may contain paths mentioned in the conversation; this rule concerns source-file metadata.
- **The Go module has zero third-party dependencies.** Keep `go.mod` standard-library-only and `go.sum` absent; CI rejects a non-empty `go.sum`. A dependency in a tool that parses private logs widens the supply-chain surface for no proportionate gain; if you think you need one, raise it rather than adding it.
- **Markdown rendering emits React elements, never HTML strings.** Session content is untrusted input. `dangerouslySetInnerHTML` on transcript text is prohibited. Only `http(s)` links become clickable.
- **Security headers stay on.** CSP `default-src 'self'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, set in `securityHeaders`.

## Honest-numbers rule

The UI's whole purpose is telling a user what actually happened in a run. Fabricated precision defeats it.

- **Missing is not zero.** Render `—`, not `0`, when a field is absent. A run with no observed token counts did not use zero tokens.
- **Keep the quality labels.** `sessioninsight` tags values `exact` / `derived` / `estimated` / `inferred` / `observed` / `heuristic` / `unknown` / `unavailable`. These flow to the UI to bound how far a number can be read. Don't drop them to simplify a component.
- **Corrections are candidates, not verdicts.** Anything derived from heuristics is labeled as such in the UI. Preserve that hedging.
- **`Tracked tokens` sums input, cache read, cache write, and output only.** Reasoning is a subset of output — adding it double-counts.
- **Never silently truncate.** If a scan hits its byte ceiling, the skipped count surfaces to the user.

## Architecture

```
apps/session-insight/          React 19 + Vite + react-router-dom
  src/app.tsx                   Routes, Trace state, Compare, Report
  src/library.tsx               Library, import/scan controls, header
  src/session-model.tsx         Shared event normalization and evidence helpers
  src/session-analysis.tsx      Single-session overview and Token analysis
  src/tool-chain.tsx            Chronological tool calls and result excerpts
  src/insights.tsx              Cross-session aggregate view
  src/trace-visualization.tsx   Virtual event tree and execution timeline
  src/markdown.tsx              Safe Markdown → React elements
  src/transcript.ts             Unwraps runtime-injected shell tags
  src/api.ts, src/types.ts      API client and frontend data contracts

server/internal/sessioninsight/ Parser. Pure standard library, zero internal deps.
server/internal/sessionstore/ store.go: atomic index and separate trace storage
                              http.go: import, scan, list, detail, delete
                              stats.go: filtered aggregates; digest.go: titles/search
server/cmd/session-insight/    main: flag parsing, loopback guard, graceful shutdown.
scripts/                      Startup wrapper and one-shot Node.js sync client/tests
```

Dependency direction is strictly one-way: `cmd → sessionstore → sessioninsight`. `sessioninsight` imports nothing from this repository; keep it that way, it is what makes the parser testable in isolation.

Frontend routes: `/` (Library), `/insights` (aggregate), `/sessions/:id` (Trace), `/compare`, `/report`.

## Commands

Run commands from the repository root unless shown otherwise. Use Node.js 22.x (at least 22.13 for the locked test dependencies; CI uses Node 22), pnpm 10.28.2 (`package.json`), and Go 1.26.1 (`server/go.mod`). Shared frontend versions live in `pnpm-workspace.yaml`; install with the checked-in `pnpm-lock.yaml`.

```bash
pnpm install --frozen-lockfile
pnpm insight          # Build frontend, start server on 127.0.0.1:4788
pnpm insight:sync --url http://127.0.0.1:4789  # Sync through an existing SSH tunnel
make build            # Frontend bundle and Go build
make check            # TypeScript checks, ESLint, Go/Vitest tests, sync integration
make test-go          # Go tests in server/ with GOTOOLCHAIN=auto
make test-ts          # Vitest unit tests
make test-sync         # Node.js sync client against a real Go server
pnpm --filter @session-insight/app exec playwright install chromium  # First e2e setup
make test-e2e          # Playwright — builds and boots a real server
```

`make check` does not run builds, explicit `go vet`, or Playwright. CI also builds both languages and runs `go vet ./...` from `server/`; Playwright is a separate local check.

For frontend hot reload, run these in separate terminals from the root. Vite proxies `/api` to `http://localhost:8080`, so the backend needs that port:

```bash
GOTOOLCHAIN=auto go -C server run ./cmd/session-insight --addr localhost:8080 --data "$PWD/.session-insight/dev/index.json"
pnpm dev
```

Override the address or index location:

```bash
SESSION_INSIGHT_ADDR=127.0.0.1:5799 pnpm insight
SESSION_INSIGHT_DATA="$PWD/.session-insight/index.json" pnpm insight
```

## Coding rules

- Comments in code are **English only**. The user-facing UI is Chinese — don't "fix" that.
- Go follows gofmt and `go vet`; CI runs vet.
- TypeScript is strict. No `any` on parsed session data.
- Match the surrounding style. Don't refactor code you weren't asked to touch.
- No compatibility shims, fallback paths, or legacy adapters unless asked. This tool has no installed-app fleet to stay compatible with — the server and frontend ship together from one build.
- Don't add a UI framework. The frontend is hand-written CSS in `src/styles.css` and view-specific stylesheets with three runtime dependencies (`react`, `react-dom`, `react-router-dom`). Keep it that way.

## Testing

Tests sit next to the code they cover.

| What | Where | Runner |
|---|---|---|
| Parser behavior, provider detection | `server/internal/sessioninsight/*_test.go` | `go test` |
| Index store, HTTP handlers, stats | `server/internal/sessionstore/*_test.go` | `go test` |
| Loopback guard, shutdown | `server/cmd/session-insight/main_test.go` | `go test` |
| Components, Markdown, transcript unwrapping | `apps/session-insight/src/*.test.tsx` | vitest, jsdom |
| Full import → search → trace → compare flows | `apps/session-insight/e2e/` | Playwright |
| Remote sync, incremental updates, retries, source privacy | `scripts/sync-session-insight.test.mjs` | Node.js test runner + real Go server |

Parser fixtures live in `server/internal/sessioninsight/testdata/` — real-shaped JSONL for all three providers, including the edge cases (Claude sub-agent files, `backups/` dirs that must be skipped, legacy TraeX paths). Add a fixture when you add a parsing rule.

Two fixtures carry scale, and both are generated by `apps/session-insight/e2e/fixtures.ts`:

- `server/internal/sessioninsight/testdata/codex-large/session.jsonl` — the checked-in large Codex run. `TestLargeCodexSessionTraceReconciles` and `TestLargeCodexImport` use it to check the invariants that only show up at size: unique event IDs, no orphaned parents, token pulses reconciling with the aggregate, and wall = active + idle.
- The same generator produces the e2e upload at runtime, and **exports every number the spec asserts on** (`CODEX_TRACE_EVENTS`, `CODEX_TRACKED_TOKENS_LABEL`, …) so a fixture change can't silently invalidate an assertion.

If you change the generator, regenerate the checked-in file and re-run both suites. Never point a test at a path under a developer's home directory — the whole suite must run on a fresh clone.

Fixture prompts contain `PRIVATE_*_SENTINEL` markers on purpose: they prove excerpt redaction works. Don't "clean them up."

## Local API

All under `/api/session-insights/`, plus `GET /api/health`.

| Endpoint | Purpose |
|---|---|
| `GET /runs` | Paginated list. Filters: `q`, `provider`, `model`, `tool`, `skill`, `error`, `correction`, `contextRisk`, `from`, `to`, `sort`. |
| `GET /stats` | Aggregate over **all** matching runs, same filters. Drives the Library header and Insights page. |
| `GET /runs/:id` | One run including its full event trace. |
| `GET /summary` | Index-level summary. |
| `POST /import` | Upload JSONL files. Caps: 32 MiB of file content total, 20 files, 4 MiB per line. |
| `POST /scan` | Scan local session dirs. Accepts `days`, `providers`. Defaults: 512 MiB / 10,000 files per scan. |
| `DELETE /runs/:id`, `DELETE /runs` | Clear the analysis index only — never the user's source files. |

`sourceSessionId` is the stable frontend field for the original session ID; `sessionId` is kept as a compatibility alias. Several sub-agent runs derived from one session share a session ID: use the unique run `id` for selection, routes, and API operations, and the title for human-readable labels.

Provider scan roots: `~/.codex/{sessions,archived_sessions}`, `~/.claude/projects` (recursive; `backups`/`history`/`sessions` subdirs skipped), `~/.trae/cli/sessions` and legacy `~/.trae/sessions`.

## Commits

Use a conventional subject under 70 characters, atomic by intent: `feat:`, `fix:`, `chore:`, `docs:`, or `refactor:`; scopes such as `feat(analysis):` and `fix(parser):` are supported. Create a new commit rather than amending a pushed commit. Omit generated-by and AI co-author attribution from commits and PR descriptions.

## Further reading

`docs/session-insight.md` (Chinese) is the user-facing behavior spec — what the five workspaces do, why events are denoised, how titles are derived, where data lands. Read it before changing UI behavior, and update it when behavior changes.
