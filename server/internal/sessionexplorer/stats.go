package sessionexplorer

import (
	"net/http"
	"sort"
)

// Stats aggregates every run matching the active filters, not just the current
// page. The library header used to sum whatever the browser had already fetched,
// which made a 50-run slice look like a total across all indexed sessions.
type Stats struct {
	RunCount        int           `json:"runCount"`
	Tokens          TokenBuckets  `json:"tokens"`
	TokenRunCount   int           `json:"tokenRunCount"`
	ToolCalls       int           `json:"toolCalls"`
	ToolFailures    int           `json:"toolFailures"`
	FailedRunCount  int           `json:"failedRunCount"`
	ContextRiskRuns int           `json:"contextRiskRuns"`
	CorrectionRuns  int           `json:"correctionRuns"`
	SubagentRuns    int           `json:"subagentRuns"`
	WallMS          int64         `json:"wallDurationMs"`
	ActiveMS        int64         `json:"activeDurationMs"`
	IdleMS          int64         `json:"idleDurationMs"`
	CacheHitRatio   *float64      `json:"cacheHitRatio,omitempty"`
	Providers       []NameCount   `json:"providers"`
	Models          []NameCount   `json:"models"`
	Projects        []ProjectStat `json:"projects"`
	Tools           []ToolStat    `json:"tools"`
	Daily           []DayStat     `json:"daily"`
}

type NameCount struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

type ProjectStat struct {
	Name       string `json:"name"`
	Runs       int    `json:"runs"`
	Tokens     int64  `json:"tokens"`
	DurationMS int64  `json:"durationMs"`
	Failures   int    `json:"failures"`
}

type ToolStat struct {
	Name     string `json:"name"`
	Calls    int    `json:"calls"`
	Failures int    `json:"failures"`
}

type DayStat struct {
	Date     string `json:"date"`
	Runs     int    `json:"runs"`
	Tokens   int64  `json:"tokens"`
	Failures int    `json:"failures"`
}

const (
	topProjects = 8
	topTools    = 10
	maxDays     = 90
)

func (e *Explorer) stats(filters runFilters) Stats {
	e.mu.Lock()
	defer e.mu.Unlock()

	if filters.q != "" {
		e.ensureSearchLocked()
	}
	out := Stats{}
	var input, cacheRead, cacheWrite, output, reasoning int64
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
		runTokens := aggregateTokens(a)
		if a.TokenObserved {
			out.TokenRunCount++
			input += deref(a.InputUncached)
			cacheRead += deref(a.CacheRead)
			cacheWrite += deref(a.CacheWrite)
			output += deref(a.Output)
			reasoning += deref(a.ReasoningOutput)
		}
		out.ToolCalls += a.ToolCallCount
		out.ToolFailures += a.ToolFailureCount
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
		project.Tokens += runTokens
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
			day.Tokens += runTokens
			day.Failures += a.ToolFailureCount
		}
	}

	out.Tokens = TokenBuckets{
		InputUncached: &input, CacheRead: &cacheRead, CacheWrite: &cacheWrite,
		Output: &output, Reasoning: &reasoning,
	}
	// Reasoning is a subset of output and is deliberately excluded from the total.
	total := input + cacheRead + cacheWrite + output
	out.Tokens.Total = &total
	if readable := input + cacheRead; readable > 0 {
		ratio := float64(cacheRead) / float64(readable)
		out.CacheHitRatio = &ratio
	}

	out.Providers = sortedCounts(providers)
	out.Models = sortedCounts(models)

	for _, project := range projects {
		out.Projects = append(out.Projects, *project)
	}
	sort.Slice(out.Projects, func(i, j int) bool {
		if out.Projects[i].Tokens != out.Projects[j].Tokens {
			return out.Projects[i].Tokens > out.Projects[j].Tokens
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

func (e *Explorer) statsHandler(w http.ResponseWriter, r *http.Request) {
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
