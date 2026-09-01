package sessionstore

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/ITcathyh/session-insight/server/internal/sessioninsight"
)

func TestTitleFromPromptShapes(t *testing.T) {
	cases := []struct {
		name, input, want string
	}{
		{"plain", "深度审查、更新、优化一下知识库", "深度审查、更新、优化一下知识库"},
		{"leading blank lines", "\n\n  修复登录跳转  \n后续细节", "修复登录跳转"},
		{"teammate envelope", `<teammate-message teammate_id="team-lead" summary="调研 OKX 头部带单员">`, "调研 OKX 头部带单员"},
		{"envelope then body", "<teammate-message id=\"x\">\n实际任务在这里", "实际任务在这里"},
		{"slash command only", "<command-name>/model</command-name>", "/model"},
		{"markdown heading", "# 周度告警分析与运维建议", "周度告警分析与运维建议"},
		{"collapses whitespace", "查一下    这个   问题", "查一下 这个 问题"},
		{"empty", "   \n  ", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := titleFromPrompt(tc.input); got != tc.want {
				t.Fatalf("titleFromPrompt(%q) = %q, want %q", tc.input, got, tc.want)
			}
		})
	}
}

func TestTitleClipsOnRuneBoundary(t *testing.T) {
	long := strings.Repeat("中", maxTitleRunes+40)
	got := titleFromPrompt(long)
	if !strings.HasSuffix(got, "…") {
		t.Fatalf("expected ellipsis, got %q", got)
	}
	trimmed := strings.TrimSuffix(got, "…")
	if count := len([]rune(trimmed)); count != maxTitleRunes {
		t.Fatalf("clipped to %d runes, want %d", count, maxTitleRunes)
	}
	if strings.Contains(trimmed, "�") {
		t.Fatalf("clip broke a multi-byte rune: %q", trimmed)
	}
}

func TestDeriveDigestPrefersPromptsInSearchText(t *testing.T) {
	trace := []sessioninsight.TraceEvent{
		{Type: "user", Name: "User message", Input: "第一个问题"},
		{Type: "model", Name: "Agent response", Output: "答复内容"},
		{Type: "tool", Name: "command_execution", Input: "ls -la", Output: "工具输出不该进搜索"},
		{Type: "user", Name: "User message", Input: "第二个问题"},
	}
	title, search := deriveDigest(trace)
	if title != "第一个问题" {
		t.Fatalf("title = %q", title)
	}
	if !strings.Contains(search, "第一个问题") || !strings.Contains(search, "第二个问题") {
		t.Fatalf("search text missing prompts: %q", search)
	}
	if !strings.Contains(search, "答复内容") {
		t.Fatalf("search text missing agent reply: %q", search)
	}
	if strings.Contains(search, "工具输出不该进搜索") {
		t.Fatalf("tool payload leaked into search text: %q", search)
	}
	if strings.Index(search, "第二个问题") > strings.Index(search, "答复内容") {
		t.Fatalf("prompts should precede replies: %q", search)
	}
}

func TestDeriveDigestHandlesTraceWithoutUserTurn(t *testing.T) {
	title, search := deriveDigest([]sessioninsight.TraceEvent{{Type: "model", Name: "Token pulse"}})
	if title != "" || search != "" {
		t.Fatalf("expected empty digest, got %q / %q", title, search)
	}
}

// Content search is what makes a 655-run library navigable: users recall what
// they asked, not the run uuid.
func TestSearchMatchesConversationContent(t *testing.T) {
	e, _ := newTestStore(t)
	response := httptest.NewRecorder()
	e.Handler().ServeHTTP(response, importRequest(t, fixture(t, "codex", "sessions", "2026", "08", "30", "modern.jsonl")))
	if response.Code != 200 {
		t.Fatalf("import: %d %s", response.Code, response.Body.String())
	}

	// The title is the session's opening user turn, which in this fixture is the
	// earlier of its two prompts.
	hit := httptest.NewRecorder()
	e.Handler().ServeHTTP(hit, httptest.NewRequest(http.MethodGet, "/api/session-insights/runs?q=old+event", nil))
	runs := decode(t, hit)["runs"].([]any)
	if len(runs) != 1 {
		t.Fatalf("title search found %d runs: %s", len(runs), hit.Body.String())
	}
	if title, _ := runs[0].(map[string]any)["title"].(string); title != "old event outside the configured window" {
		t.Fatalf("unexpected title %q", title)
	}

	// Phrases that appear only in later turns must still match, proving search
	// reaches past the title line into the conversation body.
	for _, query := range []string{"modern+session", "rollback+the+previous+plan"} {
		deep := httptest.NewRecorder()
		e.Handler().ServeHTTP(deep, httptest.NewRequest(http.MethodGet, "/api/session-insights/runs?q="+query, nil))
		if got := len(decode(t, deep)["runs"].([]any)); got != 1 {
			t.Fatalf("body search %q found %d runs: %s", query, got, deep.Body.String())
		}
	}

	miss := httptest.NewRecorder()
	e.Handler().ServeHTTP(miss, httptest.NewRequest(http.MethodGet, "/api/session-insights/runs?q=nothing-matches-this", nil))
	if got := len(decode(t, miss)["runs"].([]any)); got != 0 {
		t.Fatalf("expected no matches, got %d", got)
	}
}

// Titles must survive a restart for an index written before the field existed,
// without re-reading any original session file.
func TestBackfillDerivesTitlesForLegacyIndex(t *testing.T) {
	e, path := newTestStore(t)
	response := httptest.NewRecorder()
	e.Handler().ServeHTTP(response, importRequest(t, fixture(t, "codex", "sessions", "2026", "08", "30", "modern.jsonl")))
	if response.Code != 200 {
		t.Fatalf("import: %d", response.Code)
	}

	// Rewrite the index the way an older build left it: no titles, no digest version.
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var raw diskData
	if err := json.Unmarshal(b, &raw); err != nil {
		t.Fatal(err)
	}
	raw.DigestVersion = 0
	for i := range raw.Runs {
		raw.Runs[i].Title = ""
	}
	rewritten, err := json.Marshal(raw)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, rewritten, 0600); err != nil {
		t.Fatal(err)
	}

	restarted, err := New(Config{DataFile: path})
	if err != nil {
		t.Fatal(err)
	}
	list := httptest.NewRecorder()
	restarted.Handler().ServeHTTP(list, httptest.NewRequest(http.MethodGet, "/api/session-insights/runs", nil))
	runs := decode(t, list)["runs"].([]any)
	if len(runs) == 0 {
		t.Fatal("no runs after restart")
	}
	if title, _ := runs[0].(map[string]any)["title"].(string); title != "old event outside the configured window" {
		t.Fatalf("backfilled title = %q", title)
	}

	// The backfill must persist, so a second start does no work.
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(after), "old event outside the configured window") {
		t.Fatal("backfilled title was not persisted")
	}
	if strings.Contains(string(after), "PRIVATE_PROMPT_SENTINEL") {
		t.Fatal("backfill leaked prompt body into the summary index")
	}
}

func TestStatsAggregatesEveryMatchingRunNotJustAPage(t *testing.T) {
	e, _ := newTestStore(t)
	response := httptest.NewRecorder()
	e.Handler().ServeHTTP(response, importRequest(t,
		fixture(t, "codex", "sessions", "2026", "08", "30", "modern.jsonl"),
		fixture(t, "claude", "projects", "demo", "main.jsonl"),
	))
	if response.Code != 200 {
		t.Fatalf("import: %d %s", response.Code, response.Body.String())
	}

	list := httptest.NewRecorder()
	e.Handler().ServeHTTP(list, httptest.NewRequest(http.MethodGet, "/api/session-insights/runs?limit=1", nil))
	listed := decode(t, list)
	total := int(listed["total"].(float64))
	if page := len(listed["runs"].([]any)); page >= total {
		t.Skipf("fixture set too small to prove the difference: page=%d total=%d", page, total)
	}

	stats := httptest.NewRecorder()
	e.Handler().ServeHTTP(stats, httptest.NewRequest(http.MethodGet, "/api/session-insights/stats", nil))
	if stats.Code != 200 {
		t.Fatalf("stats: %d %s", stats.Code, stats.Body.String())
	}
	body := decode(t, stats)
	if got := int(body["runCount"].(float64)); got != total {
		t.Fatalf("stats counted %d runs, list total was %d", got, total)
	}
	if _, ok := body["tokens"].(map[string]any); !ok {
		t.Fatalf("stats missing token buckets: %s", stats.Body.String())
	}
	if strings.Contains(stats.Body.String(), "PRIVATE_PROMPT_SENTINEL") {
		t.Fatalf("stats leaked prompt body")
	}
}

func TestStatsHonoursFilters(t *testing.T) {
	e, _ := newTestStore(t)
	response := httptest.NewRecorder()
	e.Handler().ServeHTTP(response, importRequest(t,
		fixture(t, "codex", "sessions", "2026", "08", "30", "modern.jsonl"),
		fixture(t, "claude", "projects", "demo", "main.jsonl"),
	))
	if response.Code != 200 {
		t.Fatalf("import: %d", response.Code)
	}

	all := httptest.NewRecorder()
	e.Handler().ServeHTTP(all, httptest.NewRequest(http.MethodGet, "/api/session-insights/stats", nil))
	unfiltered := int(decode(t, all)["runCount"].(float64))

	filtered := httptest.NewRecorder()
	e.Handler().ServeHTTP(filtered, httptest.NewRequest(http.MethodGet, "/api/session-insights/stats?provider=codex", nil))
	scoped := decode(t, filtered)
	count := int(scoped["runCount"].(float64))
	if count == 0 || count >= unfiltered {
		t.Fatalf("provider filter had no effect: %d of %d", count, unfiltered)
	}
	for _, entry := range scoped["providers"].([]any) {
		if name := entry.(map[string]any)["name"].(string); name != "codex" {
			t.Fatalf("filtered stats leaked provider %q", name)
		}
	}
}
