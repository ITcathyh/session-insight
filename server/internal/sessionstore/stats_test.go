package sessionstore

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/ITcathyh/session-insight/server/internal/sessioninsight"
)

func TestStatsPreservesMissingAndObservedTokenValues(t *testing.T) {
	e, _ := newTestStore(t)
	day := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	e.data.Runs = []storedRun{
		{Run: Run{Aggregate: SafeAggregate{Project: "missing", StartedAt: day}}},
		{Run: Run{Aggregate: SafeAggregate{Project: "zero", StartedAt: day.AddDate(0, 0, 1), TokenObserved: true, InputUncached: int64ptr(0)}}},
		{Run: Run{Aggregate: SafeAggregate{Project: "mixed", StartedAt: day.AddDate(0, 0, 2), TokenObserved: true, Output: int64ptr(7)}}},
		{Run: Run{Aggregate: SafeAggregate{Project: "mixed", StartedAt: day.AddDate(0, 0, 2)}}},
	}

	stats := e.stats(runFilters{})
	if stats.TokenRunCount != 2 || stats.Tokens.Total == nil || *stats.Tokens.Total != 7 {
		t.Fatalf("aggregate tokens = %#v with %d observed runs, want 7 across 2", stats.Tokens.Total, stats.TokenRunCount)
	}

	projects := map[string]ProjectStat{}
	for _, project := range stats.Projects {
		projects[project.Name] = project
	}
	if project := projects["missing"]; project.Tokens != nil || project.TokenRunCount != 0 || project.Runs != 1 {
		t.Fatalf("missing project = %#v, want unavailable tokens for one run", project)
	}
	if project := projects["zero"]; project.Tokens == nil || *project.Tokens != 0 || project.TokenRunCount != 1 {
		t.Fatalf("zero project = %#v, want observed zero", project)
	}
	if project := projects["mixed"]; project.Tokens == nil || *project.Tokens != 7 || project.TokenRunCount != 1 || project.Runs != 2 {
		t.Fatalf("mixed project = %#v, want 7 from 1 of 2 runs", project)
	}

	days := map[string]DayStat{}
	for _, stat := range stats.Daily {
		days[stat.Date] = stat
	}
	if stat := days[day.Local().Format("2006-01-02")]; stat.Tokens != nil || stat.TokenRunCount != 0 {
		t.Fatalf("missing day = %#v, want unavailable tokens", stat)
	}
	if stat := days[day.AddDate(0, 0, 1).Local().Format("2006-01-02")]; stat.Tokens == nil || *stat.Tokens != 0 || stat.TokenRunCount != 1 {
		t.Fatalf("zero day = %#v, want observed zero", stat)
	}
	if stat := days[day.AddDate(0, 0, 2).Local().Format("2006-01-02")]; stat.Tokens == nil || *stat.Tokens != 7 || stat.TokenRunCount != 1 || stat.Runs != 2 {
		t.Fatalf("mixed day = %#v, want 7 from 1 of 2 runs", stat)
	}
}

func TestStatsLeavesTokenBucketsUnavailableWithoutObservations(t *testing.T) {
	e, _ := newTestStore(t)
	e.data.Runs = []storedRun{{Run: Run{Aggregate: SafeAggregate{
		Project:   "missing",
		StartedAt: time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC),
	}}}}

	stats := e.stats(runFilters{})
	if stats.TokenRunCount != 0 || stats.Tokens.Total != nil || stats.Tokens.InputUncached != nil || stats.Tokens.CacheRead != nil || stats.Tokens.CacheWrite != nil || stats.Tokens.Output != nil || stats.Tokens.Reasoning != nil {
		t.Fatalf("missing token observations became values: %#v", stats)
	}

	encoded, err := json.Marshal(stats)
	if err != nil {
		t.Fatal(err)
	}
	var response struct {
		Tokens   map[string]any   `json:"tokens"`
		Projects []map[string]any `json:"projects"`
		Daily    []map[string]any `json:"daily"`
	}
	if err := json.Unmarshal(encoded, &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Tokens) != 0 {
		t.Fatalf("API tokens = %#v, want no fabricated zero buckets", response.Tokens)
	}
	for _, group := range append(response.Projects, response.Daily...) {
		if _, ok := group["tokens"]; ok {
			t.Fatalf("API group has fabricated zero tokens: %#v", group)
		}
	}
}

func TestStatsOnlyIncludesObservedTokenBuckets(t *testing.T) {
	e, _ := newTestStore(t)
	day := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	e.data.Runs = []storedRun{
		{Run: Run{Aggregate: SafeAggregate{Project: "output", StartedAt: day, TokenObserved: true, Output: int64ptr(8)}}},
		{Run: Run{Aggregate: SafeAggregate{Project: "reasoning", StartedAt: day.AddDate(0, 0, 1), TokenObserved: true, ReasoningOutput: int64ptr(4)}}},
	}

	stats := e.stats(runFilters{})
	if stats.TokenRunCount != 2 {
		t.Fatalf("token run count = %d, want 2", stats.TokenRunCount)
	}
	if stats.Tokens.InputUncached != nil || stats.Tokens.CacheRead != nil || stats.Tokens.CacheWrite != nil {
		t.Fatalf("unobserved buckets became zeroes: %#v", stats.Tokens)
	}
	if stats.Tokens.Output == nil || *stats.Tokens.Output != 8 || stats.Tokens.Reasoning == nil || *stats.Tokens.Reasoning != 4 || stats.Tokens.Total == nil || *stats.Tokens.Total != 8 {
		t.Fatalf("tracked buckets = %#v, want output 8, reasoning 4, total 8", stats.Tokens)
	}

	projects := map[string]ProjectStat{}
	for _, project := range stats.Projects {
		projects[project.Name] = project
	}
	if project := projects["reasoning"]; project.Tokens != nil || project.TokenRunCount != 1 {
		t.Fatalf("reasoning-only project = %#v, want unavailable tracked total", project)
	}
}

func TestStatsReasoningOnlyLeavesTrackedTotalUnavailable(t *testing.T) {
	e, _ := newTestStore(t)
	e.data.Runs = []storedRun{{Run: Run{Aggregate: SafeAggregate{
		TokenObserved:   true,
		ReasoningOutput: int64ptr(4),
	}}}}

	stats := e.stats(runFilters{})
	if stats.TokenRunCount != 1 || stats.Tokens.Reasoning == nil || *stats.Tokens.Reasoning != 4 || stats.Tokens.Total != nil {
		t.Fatalf("reasoning-only aggregate = %#v, want reasoning 4 without a tracked total", stats)
	}
}

func TestStatsTracksToolCoverageWithoutInventingOutcomes(t *testing.T) {
	e, _ := newTestStore(t)
	e.data.Runs = []storedRun{
		{Run: Run{Aggregate: SafeAggregate{Quality: map[string]sessioninsight.QualityLevel{"tools": sessioninsight.QualityUnknown}}}},
		{Run: Run{Aggregate: SafeAggregate{ToolCallCount: 45, Quality: map[string]sessioninsight.QualityLevel{"tools": sessioninsight.QualityUnknown}}}},
		{Run: Run{Aggregate: SafeAggregate{Quality: map[string]sessioninsight.QualityLevel{"tools": sessioninsight.QualityDerived}}}},
		{Run: Run{Aggregate: SafeAggregate{ToolCallCount: 3, ToolFailureCount: 2, Quality: map[string]sessioninsight.QualityLevel{"tools": sessioninsight.QualityUnknown}}}},
	}

	stats := e.stats(runFilters{})
	if stats.ToolCalls != 48 || stats.ToolFailures != 2 || stats.FailedRunCount != 1 {
		t.Fatalf("tool totals = calls %d, failures %d, failed runs %d", stats.ToolCalls, stats.ToolFailures, stats.FailedRunCount)
	}
	if stats.ToolRunCount != 3 || stats.ToolOutcomeRunCount != 1 {
		t.Fatalf("tool coverage = %d activity runs, %d outcome runs; want 3 and 1", stats.ToolRunCount, stats.ToolOutcomeRunCount)
	}
}
