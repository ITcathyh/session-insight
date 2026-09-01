# Repository Guidelines

Guidance for AI agents working in this repository. `CLAUDE.md` points here; this file is the single source of truth.

## What this repository is

**Session Insight** — a local-only analyzer for Codex, Claude Code, and TraeX session logs. It ships a Go server and a React frontend that import or scan JSONL session files and render token pulses, traces, tool and skill usage, verification signals, sub-agents, idle gaps, and likely corrections.

Session Insight needs no database, no login, and no server-side account model — one binary plus one JSON index. Don't reintroduce that machinery: an issue tracker, workspaces, auth, PostgreSQL, or a background daemon are all out of scope here.

The entire codebase is ~12k lines across three Go packages and one React app. Read the whole of a file before changing it.

## Hard constraints

These are not style preferences. Each one is a property the tool is expected to hold, and a change that breaks one is a bug even if tests pass.

**This tool reads private transcripts.** Everything below follows from that.

- **Loopback only.** `cmd/session-insight` refuses to start on a non-loopback `--addr`. Never add a flag, default, or "convenience" path that binds a routable interface. There is no auth layer behind it.
- **The index never stores transcript bodies.** `index.json` holds run summaries plus one bounded title line per run. Event traces go to `runs/<run-id>/trace.json`, separately, so listing the library never reads transcripts.
- **Excerpts stay bounded.** Conversation turns cap at 8 KiB (`maxConversationExcerptBytes`), tool input/output/errors at 640 bytes (`maxTraceExcerptBytes`). Raising either grows every stored trace on disk — measure before you touch it.
- **Original session files are read-only.** Scanning aggregates; it never writes to, moves, or deletes a user's `~/.codex`, `~/.claude`, or `~/.trae` files. Uploads land in a temp dir that is deleted when the request ends.
- **No raw file paths in stored data.** The index records provider, project, and a source run key — not where on disk the file came from.
- **The Go module has zero third-party dependencies.** `go.sum` is absent and CI fails if it appears. Standard library only. A dependency in a tool that parses private logs widens the supply-chain surface for no proportionate gain; if you think you need one, raise it rather than adding it.
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
  src/app.tsx                   All five workspaces (large; read before editing)
  src/insights.tsx              Cross-session aggregate view
  src/trace-visualization.tsx   Tree, waterfall, synchronized tracks
  src/markdown.tsx              Safe Markdown → React elements
  src/transcript.ts             Unwraps runtime-injected shell tags

server/internal/sessioninsight/ Parser. Pure standard library, zero internal deps.
server/internal/sessionstore/ HTTP handlers + atomic JSON index store.
server/cmd/session-insight/    main: flag parsing, loopback guard, graceful shutdown.
```

Dependency direction is strictly one-way: `cmd → sessionstore → sessioninsight`. `sessioninsight` imports nothing from this repository; keep it that way, it is what makes the parser testable in isolation.

Frontend routes: `/` (Library), `/insights` (aggregate), `/sessions/:id` (Trace), `/compare`, `/report`.

## Commands

```bash
pnpm insight          # Build frontend, start server on 127.0.0.1:4788
make check             # typecheck + lint + unit tests, both languages
make test-go           # cd server && go test ./...
make test-ts           # vitest
make test-e2e          # Playwright — builds and boots a real server
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
- Don't add a UI framework. The frontend is hand-written CSS in `src/styles.css` with three runtime dependencies (`react`, `react-dom`, `react-router-dom`). Keep it that way.

## Testing

Tests sit next to the code they cover.

| What | Where | Runner |
|---|---|---|
| Parser behavior, provider detection | `server/internal/sessioninsight/*_test.go` | `go test` |
| Index store, HTTP handlers, stats | `server/internal/sessionstore/*_test.go` | `go test` |
| Loopback guard, shutdown | `server/cmd/session-insight/main_test.go` | `go test` |
| Components, Markdown, transcript unwrapping | `apps/session-insight/src/*.test.tsx` | vitest, jsdom |
| Full import → search → trace → compare flows | `apps/session-insight/e2e/` | Playwright |

Parser fixtures live in `server/internal/sessioninsight/testdata/` — real-shaped JSONL for all three providers, including the edge cases (Claude sub-agent files, `backups/` dirs that must be skipped, legacy TraeX paths). Add a fixture when you add a parsing rule.

Two fixtures carry scale, and both are generated by `apps/session-insight/e2e/fixtures.ts`:

- `testdata/codex-large/session.jsonl` — a checked-in ~1000-event Codex run. `TestLargeCodexSessionTraceReconciles` and `TestLargeCodexImport` use it to check the invariants that only show up at size: unique event IDs, no orphaned parents, token pulses reconciling with the aggregate, and wall = active + idle.
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
| `POST /import` | Upload JSONL files. Caps: 32 MB total, 20 files, 4 MB per line. |
| `POST /scan` | Scan local session dirs. Accepts `days`, `providers`. Caps at 512 MB / 10,000 files per scan. |
| `DELETE /runs/:id`, `DELETE /runs` | Clear the analysis index only — never the user's source files. |

`sourceSessionId` is the stable frontend field for the original session ID; `sessionId` is kept as a compatibility alias. Note that several sub-agent runs derived from one session share a session ID — identify runs by title, not ID.

Provider scan roots: `~/.codex/{sessions,archived_sessions}`, `~/.claude/projects` (recursive; `backups`/`history`/`sessions` subdirs skipped), `~/.trae/cli/sessions` and legacy `~/.trae/sessions`.

## Commits

Conventional format, atomic by intent: `feat(explorer)`, `fix(parser)`, `refactor`, `docs`, `test`, `chore`.

## Further reading

`docs/session-insight.md` (Chinese) is the user-facing behavior spec — what the five workspaces do, why events are denoised, how titles are derived, where data lands. Read it before changing UI behavior, and update it when behavior changes.
