.PHONY: help explorer build test test-go test-ts test-e2e typecheck lint check clean
.DEFAULT_GOAL := help

# The Go module has zero third-party dependencies, so `go` needs no network
# access here. GOTOOLCHAIN=auto lets it fetch the toolchain pinned in go.mod
# when the installed one is older.
GO := GOTOOLCHAIN=auto go

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

explorer: ## Build the frontend and start Session Explorer on 127.0.0.1:4788
	pnpm explorer

build: ## Build the frontend bundle and the Go binary
	pnpm build
	cd server && $(GO) build ./...

typecheck: ## TypeScript type check
	pnpm typecheck

lint: ## ESLint
	pnpm lint

test-go: ## Go tests (parser + explorer + server)
	cd server && $(GO) test ./...

test-ts: ## Vitest unit tests
	pnpm test

test-e2e: ## Playwright end-to-end tests (builds and boots a real server)
	pnpm test:e2e

test: test-go test-ts ## Unit tests, both languages

check: typecheck lint test ## Everything CI runs except e2e

clean: ## Remove build outputs and node_modules
	pnpm clean
