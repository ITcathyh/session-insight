package sessionstore

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ITcathyh/session-insight/server/internal/sessioninsight"
)

func int64ptr(value int64) *int64 { return &value }

func TestPublicRunTrackedTotalExcludesReasoningOutput(t *testing.T) {
	run := Run{Aggregate: SafeAggregate{
		TokenObserved:   true,
		InputUncached:   int64ptr(723115),
		CacheRead:       int64ptr(11444224),
		CacheWrite:      int64ptr(0),
		Output:          int64ptr(77128),
		ReasoningOutput: int64ptr(36392),
		Quality:         map[string]sessioninsight.QualityLevel{},
	}}
	view := publicRun(run)
	if view.Tokens.Total == nil || *view.Tokens.Total != 12244467 {
		t.Fatalf("tracked total = %v, want 12244467 (reasoning output is already part of output)", view.Tokens.Total)
	}
}

func TestPublicRunPreservesContextQuality(t *testing.T) {
	for _, quality := range []sessioninsight.QualityLevel{
		sessioninsight.QualityExact,
		sessioninsight.QualityDerived,
		sessioninsight.QualityUnavailable,
	} {
		run := Run{Aggregate: SafeAggregate{Quality: map[string]sessioninsight.QualityLevel{"context": quality}}}
		if got := publicRun(run).Quality["context"]; got != quality {
			t.Errorf("context quality = %q, want %q", got, quality)
		}
	}
}

func TestContextQualitySurvivesImportListAndDetail(t *testing.T) {
	e, _ := newTestStore(t)
	response := httptest.NewRecorder()
	e.Handler().ServeHTTP(response, importRequest(t, fixture(t, "codex", "sessions", "2026", "08", "30", "modern.jsonl")))
	if response.Code != http.StatusOK {
		t.Fatalf("import: %d %s", response.Code, response.Body.String())
	}
	imported := decode(t, response)["runs"].([]any)[0].(map[string]any)
	if got := imported["quality"].(map[string]any)["context"]; got != string(sessioninsight.QualityExact) {
		t.Fatalf("import context quality = %q, want exact", got)
	}
	id := imported["id"].(string)

	list := httptest.NewRecorder()
	e.Handler().ServeHTTP(list, httptest.NewRequest(http.MethodGet, "/api/session-insights/runs", nil))
	if list.Code != http.StatusOK {
		t.Fatalf("list: %d %s", list.Code, list.Body.String())
	}
	listed := decode(t, list)["runs"].([]any)[0].(map[string]any)
	if got := listed["quality"].(map[string]any)["context"]; got != string(sessioninsight.QualityExact) {
		t.Fatalf("list context quality = %q, want exact", got)
	}

	detail := httptest.NewRecorder()
	e.Handler().ServeHTTP(detail, httptest.NewRequest(http.MethodGet, "/api/session-insights/runs/"+id, nil))
	if detail.Code != http.StatusOK {
		t.Fatalf("detail: %d %s", detail.Code, detail.Body.String())
	}
	if got := decode(t, detail)["quality"].(map[string]any)["context"]; got != string(sessioninsight.QualityExact) {
		t.Fatalf("detail context quality = %q, want exact", got)
	}
}

func fixture(t *testing.T, parts ...string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(append([]string{"..", "sessioninsight", "testdata"}, parts...)...))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func newTestStore(t *testing.T) (*Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "index.json")
	e, err := New(Config{DataFile: path, Now: func() time.Time { return time.Date(2026, 8, 31, 0, 0, 0, 0, time.UTC) }})
	if err != nil {
		t.Fatal(err)
	}
	return e, path
}

func importRequest(t *testing.T, bodies ...[]byte) *http.Request {
	t.Helper()
	files := make([]importFile, len(bodies))
	for i, body := range bodies {
		files[i] = importFile{name: "session-" + string(rune('a'+i)) + ".jsonl", body: body}
	}
	return importFilesRequest(t, files...)
}

type importFile struct {
	name, relativePath string
	body               []byte
}

func importFilesRequest(t *testing.T, files ...importFile) *http.Request {
	t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	for _, file := range files {
		if file.relativePath != "" {
			if err := w.WriteField("relativePath", file.relativePath); err != nil {
				t.Fatal(err)
			}
		}
		p, err := w.CreateFormFile("files", file.name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := p.Write(file.body); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:4788/api/session-insights/import", &body)
	r.Header.Set("Content-Type", w.FormDataContentType())
	r.Host = "127.0.0.1:4788"
	return r
}

func TestClaudeDirectoryImportPreservesKindsAndUpsertsByRunIdentity(t *testing.T) {
	e, _ := newTestStore(t)
	files := []importFile{
		{name: "main.jsonl", relativePath: "main.jsonl", body: fixture(t, "claude", "projects", "demo", "main.jsonl")},
		{name: "worker.jsonl", relativePath: "subagents/worker.jsonl", body: fixture(t, "claude", "projects", "demo", "subagents", "worker.jsonl")},
		{name: "ignored.jsonl", relativePath: "backups/ignored.jsonl", body: fixture(t, "claude", "projects", "demo", "backups", "ignored.jsonl")},
	}
	response := httptest.NewRecorder()
	e.Handler().ServeHTTP(response, importFilesRequest(t, files...))
	if response.Code != http.StatusOK {
		t.Fatalf("import: %d %s", response.Code, response.Body.String())
	}
	result := decode(t, response)
	if result["count"].(float64) != 2 || result["imported"].(float64) != 2 || result["updated"].(float64) != 0 || result["filesScanned"].(float64) != 2 {
		t.Fatalf("first import = %s", response.Body.String())
	}
	response = httptest.NewRecorder()
	e.Handler().ServeHTTP(response, importFilesRequest(t, files...))
	if response.Code != http.StatusOK {
		t.Fatalf("repeat import: %d %s", response.Code, response.Body.String())
	}
	result = decode(t, response)
	if result["count"].(float64) != 2 || result["imported"].(float64) != 0 || result["updated"].(float64) != 2 {
		t.Fatalf("repeat import = %s", response.Body.String())
	}
	list := httptest.NewRecorder()
	e.Handler().ServeHTTP(list, httptest.NewRequest(http.MethodGet, "/api/session-insights/runs?provider=claude", nil))
	runs := decode(t, list)["runs"].([]any)
	if len(runs) != 2 {
		t.Fatalf("claude runs = %s", list.Body.String())
	}
	ids, kinds := map[string]bool{}, map[string]bool{}
	for _, item := range runs {
		run := item.(map[string]any)
		ids[run["id"].(string)] = true
		kinds[run["runKind"].(string)] = true
	}
	if len(ids) != 2 || !kinds["main"] || !kinds["subagent"] {
		t.Fatalf("expected distinct main/subagent public runs: %s", list.Body.String())
	}
	// Refreshing only the main file must retain the already-indexed child link.
	response = httptest.NewRecorder()
	e.Handler().ServeHTTP(response, importFilesRequest(t, files[0]))
	if response.Code != http.StatusOK {
		t.Fatalf("main refresh: %d %s", response.Code, response.Body.String())
	}
	list = httptest.NewRecorder()
	e.Handler().ServeHTTP(list, httptest.NewRequest(http.MethodGet, "/api/session-insights/runs?provider=claude", nil))
	for _, item := range decode(t, list)["runs"].([]any) {
		run := item.(map[string]any)
		if run["runKind"] == "main" && run["counts"].(map[string]any)["subagents"].(float64) != 1 {
			t.Fatalf("main refresh lost child relation: %s", list.Body.String())
		}
	}
}

func TestTraeXImportNormalizesProviderAndUsesTraeStagingRoot(t *testing.T) {
	e, _ := newTestStore(t)
	for _, modelProvider := range []string{"trae", "traex"} {
		content := []byte(fmt.Sprintf("%s\n%s\n%s\n",
			fmt.Sprintf(`{"timestamp":"2026-08-30T10:00:00Z","type":"session_meta","payload":{"id":"%s-session","cwd":"/tmp/project","model_provider":%q}}`, modelProvider, modelProvider),
			`{"timestamp":"2026-08-30T10:00:01Z","type":"event_msg","payload":{"type":"user_message","message":"request"}}`,
			`{"timestamp":"2026-08-30T10:00:02Z","type":"event_msg","payload":{"type":"agent_message","message":"answer"}}`,
		))
		response := httptest.NewRecorder()
		e.Handler().ServeHTTP(response, importRequest(t, content))
		if response.Code != http.StatusOK {
			t.Fatalf("import model_provider=%q: %d %s", modelProvider, response.Code, response.Body.String())
		}
		run := decode(t, response)["runs"].([]any)[0].(map[string]any)
		if run["provider"] != "traex" {
			t.Fatalf("model_provider=%q provider=%v, want traex", modelProvider, run["provider"])
		}
	}

	list := httptest.NewRecorder()
	e.Handler().ServeHTTP(list, httptest.NewRequest(http.MethodGet, "/api/session-insights/runs?provider=traex", nil))
	if list.Code != http.StatusOK || len(decode(t, list)["runs"].([]any)) != 2 {
		t.Fatalf("traex provider list: %d %s", list.Code, list.Body.String())
	}
}

func TestDetectProviderParsesTraeXSessionMetadata(t *testing.T) {
	for _, modelProvider := range []string{"trae", "traex"} {
		path := filepath.Join(t.TempDir(), modelProvider+".jsonl")
		content := []byte(fmt.Sprintf(`{ "type": "session_meta", "payload": { "model_provider": %q } }%s`, modelProvider, "\n"))
		if err := os.WriteFile(path, content, 0600); err != nil {
			t.Fatal(err)
		}
		provider, err := detectProvider(path)
		if err != nil || provider != "traex" {
			t.Fatalf("model_provider=%q: provider=%q err=%v", modelProvider, provider, err)
		}
	}
}

func TestImportRejectsUnsafeRelativePaths(t *testing.T) {
	e, _ := newTestStore(t)
	content := fixture(t, "codex", "sessions", "2026", "08", "30", "modern.jsonl")
	for _, path := range []string{"../../escape.jsonl", "/absolute.jsonl"} {
		response := httptest.NewRecorder()
		e.Handler().ServeHTTP(response, importFilesRequest(t, importFile{name: "session.jsonl", relativePath: path, body: content}))
		if response.Code != http.StatusBadRequest {
			t.Fatalf("path %q status=%d body=%s", path, response.Code, response.Body.String())
		}
	}
}

func decode(t *testing.T, response *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var result map[string]any
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestImportSearchPrivacyAndPersistence(t *testing.T) {
	e, index := newTestStore(t)
	request := importRequest(t,
		fixture(t, "codex", "sessions", "2026", "08", "30", "modern.jsonl"),
		fixture(t, "claude", "projects", "demo", "main.jsonl"),
	)
	response := httptest.NewRecorder()
	e.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("import: %d %s", response.Code, response.Body.String())
	}
	result := decode(t, response)
	if result["count"].(float64) != 2 {
		t.Fatalf("count=%v", result["count"])
	}
	// A repeated import is an upsert, not a duplicate.
	response = httptest.NewRecorder()
	e.Handler().ServeHTTP(response, importRequest(t, fixture(t, "codex", "sessions", "2026", "08", "30", "modern.jsonl")))
	if response.Code != http.StatusOK {
		t.Fatalf("repeat: %d", response.Code)
	}
	list := httptest.NewRecorder()
	e.Handler().ServeHTTP(list, httptest.NewRequest(http.MethodGet, "/api/session-insights/runs?provider=codex", nil))
	if list.Code != 200 || len(decode(t, list)["runs"].([]any)) != 1 {
		t.Fatalf("provider list: %d %s", list.Code, list.Body.String())
	}
	// Exact local session IDs are returned and indexed for local search. The list
	// response intentionally omits the much larger event trace; detail returns it.
	search := httptest.NewRecorder()
	e.Handler().ServeHTTP(search, httptest.NewRequest(http.MethodGet, "/api/session-insights/runs?q=codex-modern-root", nil))
	searchBody := search.Body.String()
	if search.Code != 200 || len(decode(t, search)["runs"].([]any)) != 1 {
		t.Fatalf("raw id search: %d %s", search.Code, search.Body.String())
	}
	if !strings.Contains(searchBody, "codex-modern-root") || strings.Contains(searchBody, "PRIVATE_PROMPT_SENTINEL") {
		t.Fatalf("unexpected list contract: %s", searchBody)
	}
	b, err := os.ReadFile(index)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), "codex-modern-root") || strings.Contains(string(b), "PRIVATE_PROMPT_SENTINEL") {
		t.Fatalf("summary index should not embed trace payload")
	}
	entries, err := os.ReadDir(filepath.Join(filepath.Dir(index), "runs"))
	if err != nil || len(entries) == 0 {
		t.Fatalf("trace files were not written: %v", err)
	}
	stat, err := os.Stat(index)
	if err != nil {
		t.Fatal(err)
	}
	if stat.Mode().Perm() != 0600 {
		t.Fatalf("mode %o", stat.Mode().Perm())
	}
	restarted, err := New(Config{DataFile: index})
	if err != nil {
		t.Fatal(err)
	}
	persisted := httptest.NewRecorder()
	restarted.Handler().ServeHTTP(persisted, httptest.NewRequest(http.MethodGet, "/api/session-insights/runs", nil))
	if len(decode(t, persisted)["runs"].([]any)) != 2 {
		t.Fatal("data did not survive restart")
	}
}

func TestImportRejectsBadInput(t *testing.T) {
	e, _ := newTestStore(t)
	bad := importRequest(t, []byte("{not json}\n"))
	response := httptest.NewRecorder()
	e.Handler().ServeHTTP(response, bad)
	if response.Code != 400 {
		t.Fatalf("bad JSONL: %d", response.Code)
	}
}

func TestImportEnforcesFileLimit(t *testing.T) {
	e, _ := newTestStore(t)
	content := fixture(t, "codex", "sessions", "2026", "08", "30", "modern.jsonl")
	files := make([][]byte, maxImportFiles+1)
	for i := range files {
		files[i] = content
	}
	response := httptest.NewRecorder()
	e.Handler().ServeHTTP(response, importRequest(t, files...))
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("file limit: %d %s", response.Code, response.Body.String())
	}
}

func TestPaginationDeleteAndHeaders(t *testing.T) {
	e, _ := newTestStore(t)
	fixtureData := fixture(t, "codex", "sessions", "2026", "08", "30", "modern.jsonl")
	response := httptest.NewRecorder()
	e.Handler().ServeHTTP(response, importRequest(t, fixtureData))
	if response.Code != 200 {
		t.Fatal(response.Code)
	}
	list := httptest.NewRecorder()
	e.Handler().ServeHTTP(list, httptest.NewRequest(http.MethodGet, "/api/session-insights/runs?limit=1", nil))
	if list.Header().Get("Content-Security-Policy") == "" || list.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("security headers missing")
	}
	data := decode(t, list)
	id := data["runs"].([]any)[0].(map[string]any)["id"].(string)
	deleteReq := httptest.NewRequest(http.MethodDelete, "/api/session-insights/runs/"+id, nil)
	deleteReq.Host = "127.0.0.1:4788"
	deleted := httptest.NewRecorder()
	e.Handler().ServeHTTP(deleted, deleteReq)
	if deleted.Code != 204 {
		t.Fatalf("delete: %d", deleted.Code)
	}
	clearReq := httptest.NewRequest(http.MethodDelete, "/api/session-insights/runs", nil)
	clearReq.Host = "127.0.0.1:4788"
	cleared := httptest.NewRecorder()
	e.Handler().ServeHTTP(cleared, clearReq)
	if cleared.Code != http.StatusNoContent {
		t.Fatalf("clear: %d", cleared.Code)
	}
}

func TestListFiltersBeforePagination(t *testing.T) {
	e, _ := newTestStore(t)
	started := time.Date(2026, 8, 30, 9, 0, 0, 0, time.UTC)
	for i := 0; i < 51; i++ {
		id := fmt.Sprintf("run-%d", i)
		e.data.Runs = append(e.data.Runs, storedRun{Run: Run{
			ID:        id,
			Aggregate: SafeAggregate{Provider: "codex", SourceSessionID: id, StartedAt: started.Add(time.Duration(i) * time.Minute), EndedAt: started.Add(time.Duration(i+1) * time.Minute)},
		}})
	}
	response := httptest.NewRecorder()
	e.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/session-insights/runs?provider=codex&limit=1", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("list: %d %s", response.Code, response.Body.String())
	}
	data := decode(t, response)
	if data["total"] != float64(51) || len(data["runs"].([]any)) != 1 {
		t.Fatalf("filters must run before pagination: %s", response.Body.String())
	}
}

// Exercises the whole import path at realistic scale: a 300 KB session with
// ~1000 trace events, indexed, read back through the detail endpoint, and
// filtered. The fixture lives in testdata so this runs in CI; it previously
// read a contributor's private session from an absolute path and was skipped
// everywhere else.
func TestLargeCodexImport(t *testing.T) {
	path := filepath.Join("..", "sessioninsight", "testdata", "codex-large", "session.jsonl")
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	e, index := newTestStore(t)
	started := time.Now()
	response := httptest.NewRecorder()
	e.Handler().ServeHTTP(response, importFilesRequest(t, importFile{name: "reference.jsonl", body: body}))
	if response.Code != http.StatusOK {
		t.Fatalf("reference import: %d %s", response.Code, response.Body.String())
	}
	result := decode(t, response)
	runs := result["runs"].([]any)
	if len(runs) != 1 {
		t.Fatalf("reference import count: %s", response.Body.String())
	}
	id := runs[0].(map[string]any)["id"].(string)
	detail := httptest.NewRecorder()
	e.Handler().ServeHTTP(detail, httptest.NewRequest(http.MethodGet, "/api/session-insights/runs/"+id, nil))
	if detail.Code != http.StatusOK {
		t.Fatalf("reference detail: %d", detail.Code)
	}
	var view RunView
	if err := json.NewDecoder(detail.Body).Decode(&view); err != nil {
		t.Fatal(err)
	}
	if view.SessionID != "e2e-codex-flagship" || view.SourceSessionID != view.SessionID || view.Model != "codex-e2e-large" || view.Counts.ToolFailures != 3 || view.Counts.Subagents != 1 || view.Tokens.Total == nil || *view.Tokens.Total != 24_044_000 || len(view.Trace) < 900 {
		t.Fatalf("large import detail contract: %+v", view)
	}
	filtered := httptest.NewRecorder()
	e.Handler().ServeHTTP(filtered, httptest.NewRequest(http.MethodGet, "/api/session-insights/runs?error=true&contextRisk=true&sort=tokens", nil))
	if filtered.Code != http.StatusOK || len(decode(t, filtered)["runs"].([]any)) != 1 {
		t.Fatalf("reference filters: %d %s", filtered.Code, filtered.Body.String())
	}
	info, err := os.Stat(index)
	if err != nil {
		t.Fatal(err)
	}
	traceInfo, err := os.Stat(filepath.Join(filepath.Dir(index), "runs", id, "trace.json"))
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("large import elapsed=%s indexBytes=%d traceBytes=%d events=%d wall=%d active=%d idle=%d", time.Since(started).Round(time.Millisecond), info.Size(), traceInfo.Size(), len(view.Trace), view.DurationMS, view.ActiveDurationMS, view.IdleDurationMS)
}

func TestStaticFallback(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<main>Session Insight</main>"), 0600); err != nil {
		t.Fatal(err)
	}
	e, err := New(Config{DataFile: filepath.Join(t.TempDir(), "index.json"), WebDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	e.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/runs/anything", nil))
	b, _ := io.ReadAll(response.Body)
	if response.Code != 200 || !strings.Contains(string(b), "Session Insight") {
		t.Fatalf("fallback: %d %q", response.Code, b)
	}
}
