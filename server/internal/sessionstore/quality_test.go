package sessionstore

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ITcathyh/session-insight/server/internal/sessioninsight"
)

func TestPublicRunPreservesMetricQuality(t *testing.T) {
	view := publicRun(Run{Aggregate: SafeAggregate{Quality: map[string]sessioninsight.QualityLevel{
		"inputTokens":     sessioninsight.QualityDerived,
		"outputTokens":    sessioninsight.QualityEstimated,
		"reasoningTokens": sessioninsight.QualityDerived,
		"trajectory":      sessioninsight.QualityInferred,
		"skills":          sessioninsight.QualityHeuristic,
	}}})

	if got := view.Quality["inputTokens"]; got != sessioninsight.QualityDerived {
		t.Errorf("input token quality = %q, want %q", got, sessioninsight.QualityDerived)
	}
	if got := view.Quality["outputTokens"]; got != sessioninsight.QualityEstimated {
		t.Errorf("output token quality = %q, want %q", got, sessioninsight.QualityEstimated)
	}
	if got := view.Quality["reasoningTokens"]; got != sessioninsight.QualityDerived {
		t.Errorf("reasoning token quality = %q, want %q", got, sessioninsight.QualityDerived)
	}
	if got := view.Quality["trajectory"]; got != sessioninsight.QualityInferred {
		t.Errorf("trajectory quality = %q, want %q", got, sessioninsight.QualityInferred)
	}
	if got := view.Quality["skills"]; got != sessioninsight.QualityHeuristic {
		t.Errorf("skill quality = %q, want %q", got, sessioninsight.QualityHeuristic)
	}
	if _, ok := view.Quality["timing"]; ok {
		t.Error("public run fabricated timing quality")
	}
	if _, ok := view.Quality["semantic"]; ok {
		t.Error("public run fabricated semantic quality")
	}
}

func TestRunDetailPreservesEstimatedOutputTokenQuality(t *testing.T) {
	store, _ := newTestStore(t)
	store.data.Runs = []storedRun{{Run: Run{ID: "token-quality", Aggregate: SafeAggregate{SourceSessionID: "session", Quality: map[string]sessioninsight.QualityLevel{
		"outputTokens": sessioninsight.QualityEstimated,
	}}}}}
	response := httptest.NewRecorder()
	store.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/session-insights/runs/token-quality", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("detail status = %d: %s", response.Code, response.Body.String())
	}
	quality := decode(t, response)["quality"].(map[string]any)
	if got := quality["outputTokens"]; got != string(sessioninsight.QualityEstimated) {
		t.Fatalf("detail output token quality = %v, want %q", got, sessioninsight.QualityEstimated)
	}
}

func TestRunDetailNormalizesMissingTokenQuality(t *testing.T) {
	store, _ := newTestStore(t)
	store.data.Runs = []storedRun{{Run: Run{ID: "legacy-quality", Aggregate: SafeAggregate{SourceSessionID: "session", Quality: map[string]sessioninsight.QualityLevel{
		"trajectory": sessioninsight.QualityInferred,
	}}}}}
	response := httptest.NewRecorder()
	store.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/session-insights/runs/legacy-quality", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("detail status = %d: %s", response.Code, response.Body.String())
	}
	quality := decode(t, response)["quality"].(map[string]any)
	for _, key := range []string{"inputTokens", "outputTokens", "reasoningTokens"} {
		if got := quality[key]; got != string(sessioninsight.QualityUnknown) {
			t.Errorf("detail %s quality = %v, want %q", key, got, sessioninsight.QualityUnknown)
		}
	}
}

func TestReasoningOnlyRunOmitsTrackedTotal(t *testing.T) {
	reasoning := int64ptr(9)
	run := Run{ID: "reasoning-only", Aggregate: SafeAggregate{
		SourceSessionID: "session",
		TokenObserved:   true,
		ReasoningOutput: reasoning,
	}}
	view := publicRun(run)
	if view.Tokens.Total != nil {
		t.Fatalf("reasoning-only tracked total = %d, want omitted", *view.Tokens.Total)
	}
	if view.Tokens.Reasoning != reasoning {
		t.Fatalf("reasoning tokens = %v, want %v", view.Tokens.Reasoning, reasoning)
	}

	store, _ := newTestStore(t)
	store.data.Runs = []storedRun{{Run: run}}
	response := httptest.NewRecorder()
	store.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/session-insights/runs/reasoning-only", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("detail status = %d: %s", response.Code, response.Body.String())
	}
	tokens := decode(t, response)["tokens"].(map[string]any)
	if _, ok := tokens["total"]; ok {
		t.Fatalf("reasoning-only API total = %v, want omitted", tokens["total"])
	}
	if got := tokens["reasoning"]; got != float64(9) {
		t.Fatalf("reasoning-only API reasoning = %v, want 9", got)
	}
}
