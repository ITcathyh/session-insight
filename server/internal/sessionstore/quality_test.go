package sessionstore

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ITcathyh/session-insight/server/internal/sessioninsight"
)

func TestPublicRunPreservesTrajectoryAndSkillQuality(t *testing.T) {
	view := publicRun(Run{Aggregate: SafeAggregate{Quality: map[string]sessioninsight.QualityLevel{
		"trajectory": sessioninsight.QualityInferred,
		"skills":     sessioninsight.QualityHeuristic,
	}}})

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
