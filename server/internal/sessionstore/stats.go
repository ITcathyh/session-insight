package sessionstore

import (
	"net/http"
	"sort"

	"github.com/ITcathyh/session-insight/server/internal/sessioninsight"
)

// Stats aggregates every run matching the active filters, not just the current
// page. The library header used to sum whatever the browser had already fetched,
// which made a 50-run slice look like a total across all indexed sessions.
type Stats struct {
	RunCount            int           `json:"runCount"`
	Tokens              TokenBuckets  `json:"tokens"`
	TokenRunCount       int           `json:"tokenRunCount"`
	ToolCalls           int           `json:"toolCalls"`
	ToolFailures        int           `json:"toolFailures"`
	ToolRunCount        int           `json:"toolRunCount"`
	ToolOutcomeRunCount int           `json:"toolOutcomeRunCount"`
	FailedRunCount      int           `json:"failedRunCount"`
	ContextRiskRuns     int           `json:"contextRiskRuns"`
	CorrectionRuns      int           `json:"correctionRuns"`
	SubagentRuns        int           `json:"subagentRuns"`
	WallMS              int64         `json:"wallDurationMs"`
	ActiveMS            int64         `json:"activeDurationMs"`
	IdleMS              int64         `json:"idleDurationMs"`
	CacheHitRatio       *float64      `json:"cacheHitRatio,omitempty"`
	Providers           []NameCount   `json:"providers"`
	Models              []NameCount   `json:"models"`
	Projects            []ProjectStat `json:"projects"`
	Tools               []ToolStat    `json:"tools"`
	Daily               []DayStat     `json:"daily"`
}

type NameCount struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

type ProjectStat struct {
	Name          string `json:"name"`
	Runs          int    `json:"runs"`
	Tokens        *int64 `json:"tokens,omitempty"`
	TokenRunCount int    `json:"tokenRunCount"`
	DurationMS    int64  `json:"durationMs"`
	Failures      int    `json:"failures"`
}

type ToolStat struct {
	Name     string `json:"name"`
	Calls    int    `json:"calls"`
	Failures int    `json:"failures"`
}

type DayStat struct {
	Date          string `json:"date"`
	Runs          int    `json:"runs"`
	Tokens        *int64 `json:"tokens,omitempty"`
	TokenRunCount int    `json:"tokenRunCount"`
	Failures      int    `json:"failures"`
}

const (
	topProjects = 8
	topTools    = 10
	maxDays     = 90
)

func (e *Store) stats(filters runFilters) Stats {
	e.mu.Lock()
	defer e.mu.Unlock()

	if filters.q != "" {
		e.ensureSearchLocked()
	}
	out := Stats{}
	var input, cacheRead, cacheWrite, output, reasoning int64
	var inputObserved, cacheReadObserved, cacheWriteObserved, outputObserved, reasoningObserved bool
	projects := map[string]*ProjectStat{}
	tools := map[string]*ToolStat{}
	days := map[string]*DayStat{}
	providers := map[string]int{}
	models := map[string]int{}

	for _, run := range e.data.Runs {
		if !filters.matches(run, e.sessionLookup, e.searchTextLocked(run.ID)) {
			continue
		}
		a := run.Aggregate
		out.RunCount++
		if a.TokenObserved {
			out.TokenRunCount++
		}
		if a.InputUncached != nil {
			inputObserved = true
			input += *a.InputUncached
		}
		if a.CacheRead != nil {
			cacheReadObserved = true
			cacheRead += *a.CacheRead
		}
		if a.CacheWrite != nil {
			cacheWriteObserved = true
			cacheWrite += *a.CacheWrite
		}
		if a.Output != nil {
			outputObserved = true
			output += *a.Output
		}
		if a.ReasoningOutput != nil {
			reasoningObserved = true
			reasoning += *a.ReasoningOutput
		}
		out.ToolCalls += a.ToolCallCount
		out.ToolFailures += a.ToolFailureCount
		if a.ToolCallCount > 0 || hasKnownToolOutcome(a) {
			out.ToolRunCount++
		}
		if hasKnownToolOutcome(a) {
			out.ToolOutcomeRunCount++
		}
		if a.ToolFailureCount > 0 {
			out.FailedRunCount++
		}
		if contextRatio(a) >= 0.8 {
			out.ContextRiskRuns++
		}
		if a.CorrectionCandidateCount > 0 {
			out.CorrectionRuns++
		}
		if a.SubagentCount > 0 {
			out.SubagentRuns++
		}
		wall := a.EndedAt.Sub(a.StartedAt).Milliseconds()
		if wall > 0 {
			out.WallMS += wall
		}
		out.ActiveMS += a.ActiveDurationMS
		out.IdleMS += a.IdleDurationMS

		if a.Provider != "" {
			providers[a.Provider]++
		}
		if a.Model != "" {
			models[a.Model]++
		}
		name := a.Project
		if name == "" {
			name = "未知项目"
		}
		project := projects[name]
		if project == nil {
			project = &ProjectStat{Name: name}
			projects[name] = project
		}
		project.Runs++
		if a.TokenObserved {
			project.TokenRunCount++
		}
		if tokens, observed := trackedTokens(a); observed {
			addObservedTokens(&project.Tokens, tokens)
		}
		project.Failures += a.ToolFailureCount
		if wall > 0 {
			project.DurationMS += wall
		}
		for toolName, stat := range a.ToolCounts {
			entry := tools[toolName]
			if entry == nil {
				entry = &ToolStat{Name: toolName}
				tools[toolName] = entry
			}
			entry.Calls += stat.Calls
			entry.Failures += stat.Failures
		}
		if !a.StartedAt.IsZero() {
			key := a.StartedAt.Local().Format("2006-01-02")
			day := days[key]
			if day == nil {
				day = &DayStat{Date: key}
				days[key] = day
			}
			day.Runs++
			if a.TokenObserved {
				day.TokenRunCount++
			}
			if tokens, observed := trackedTokens(a); observed {
				addObservedTokens(&day.Tokens, tokens)
			}
			day.Failures += a.ToolFailureCount
		}
	}

	if inputObserved || cacheReadObserved || cacheWriteObserved || outputObserved || reasoningObserved {
		if inputObserved {
			out.Tokens.InputUncached = &input
		}
		if cacheReadObserved {
			out.Tokens.CacheRead = &cacheRead
		}
		if cacheWriteObserved {
			out.Tokens.CacheWrite = &cacheWrite
		}
		if outputObserved {
			out.Tokens.Output = &output
		}
		if reasoningObserved {
			out.Tokens.Reasoning = &reasoning
		}
		if inputObserved || cacheReadObserved || cacheWriteObserved || outputObserved {
			// Reasoning is a subset of output and is deliberately excluded from the total.
			total := input + cacheRead + cacheWrite + output
			out.Tokens.Total = &total
		}
		if (inputObserved || cacheReadObserved) && input+cacheRead > 0 {
			ratio := float64(cacheRead) / float64(input+cacheRead)
			out.CacheHitRatio = &ratio
		}
	}

	out.Providers = sortedCounts(providers)
	out.Models = sortedCounts(models)

	for _, project := range projects {
		out.Projects = append(out.Projects, *project)
	}
	sort.Slice(out.Projects, func(i, j int) bool {
		left, right := out.Projects[i].Tokens, out.Projects[j].Tokens
		if left == nil {
			if right == nil {
				return out.Projects[i].Name < out.Projects[j].Name
			}
			return false
		}
		if right == nil {
			return true
		}
		if *left != *right {
			return *left > *right
		}
		return out.Projects[i].Name < out.Projects[j].Name
	})
	if len(out.Projects) > topProjects {
		out.Projects = out.Projects[:topProjects]
	}

	for _, tool := range tools {
		out.Tools = append(out.Tools, *tool)
	}
	sort.Slice(out.Tools, func(i, j int) bool {
		if out.Tools[i].Failures != out.Tools[j].Failures {
			return out.Tools[i].Failures > out.Tools[j].Failures
		}
		if out.Tools[i].Calls != out.Tools[j].Calls {
			return out.Tools[i].Calls > out.Tools[j].Calls
		}
		return out.Tools[i].Name < out.Tools[j].Name
	})
	if len(out.Tools) > topTools {
		out.Tools = out.Tools[:topTools]
	}

	for _, day := range days {
		out.Daily = append(out.Daily, *day)
	}
	sort.Slice(out.Daily, func(i, j int) bool { return out.Daily[i].Date < out.Daily[j].Date })
	if len(out.Daily) > maxDays {
		out.Daily = out.Daily[len(out.Daily)-maxDays:]
	}

	if out.Providers == nil {
		out.Providers = []NameCount{}
	}
	if out.Models == nil {
		out.Models = []NameCount{}
	}
	if out.Projects == nil {
		out.Projects = []ProjectStat{}
	}
	if out.Tools == nil {
		out.Tools = []ToolStat{}
	}
	if out.Daily == nil {
		out.Daily = []DayStat{}
	}
	return out
}

func addObservedTokens(total **int64, value int64) {
	if *total == nil {
		*total = new(int64)
	}
	**total += value
}

func trackedTokens(a SafeAggregate) (int64, bool) {
	return aggregateTokens(a), a.InputUncached != nil || a.CacheRead != nil || a.CacheWrite != nil || a.Output != nil
}

func hasKnownToolOutcome(a SafeAggregate) bool {
	switch a.Quality["tools"] {
	case sessioninsight.QualityExact, sessioninsight.QualityDerived, sessioninsight.QualityObserved:
		return true
	default:
		return false
	}
}

func sortedCounts(values map[string]int) []NameCount {
	out := make([]NameCount, 0, len(values))
	for name, count := range values {
		out = append(out, NameCount{Name: name, Count: count})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Name < out[j].Name
	})
	return out
}

func (e *Store) statsHandler(w http.ResponseWriter, r *http.Request) {
	filters, ok := parseRunFilters(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, e.stats(filters))
}

// parseRunFilters reads the shared filter query string used by both the run list
// and the stats endpoint, so a filtered library header always matches its rows.
func parseRunFilters(w http.ResponseWriter, r *http.Request) (runFilters, bool) {
	q := r.URL.Query()
	filters := runFilters{
		q: q.Get("q"), provider: q.Get("provider"), model: q.Get("model"),
		tool: q.Get("tool"), skill: q.Get("skill"),
		errorOnly: q.Get("error") == "true", correctionOnly: q.Get("correction") == "true",
		contextRisk: q.Get("contextRisk") == "true",
		sort:        q.Get("sort"), cursor: q.Get("cursor"),
	}
	var err error
	if from := q.Get("from"); from != "" {
		filters.from, err = parseFilterDate(from, false)
		if err != nil {
			apiError(w, http.StatusBadRequest, "invalid from")
			return runFilters{}, false
		}
	}
	if to := q.Get("to"); to != "" {
		filters.to, err = parseFilterDate(to, true)
		if err != nil {
			apiError(w, http.StatusBadRequest, "invalid to")
			return runFilters{}, false
		}
	}
	return filters, true
}
