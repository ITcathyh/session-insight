// Package sessionstore provides a small, local-only session analysis API.
package sessionstore

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ITcathyh/session-insight/server/internal/sessioninsight"
)

const (
	maxImportBytes     int64 = 32 << 20
	maxImportFiles           = 20
	maxImportLineBytes       = 4 << 20
)

// Config configures a Store. DataFile is an atomic JSON index, never a raw session store.
type Config struct {
	DataFile string
	WebDir   string
	Now      func() time.Time
}

// Store owns a local JSON index and an HTTP handler. It is safe for concurrent requests.
type Store struct {
	mu       sync.Mutex
	data     diskData
	path     string
	traceDir string
	webDir   string
	now      func() time.Time
	// search holds per-run conversation text for content search. It is built
	// lazily from trace files and never persisted: the on-disk summary index
	// stays free of transcript bodies.
	search      map[string]string
	searchReady bool
}

type diskData struct {
	Version int    `json:"version"`
	Secret  string `json:"secret"`
	// DigestVersion tracks which revision of deriveDigest produced the stored
	// titles, so a backfill runs once per upgrade rather than on every start.
	DigestVersion int         `json:"digestVersion,omitempty"`
	Runs          []storedRun `json:"runs"`
}

// digestVersion must be bumped whenever deriveDigest changes shape.
const digestVersion = 1

// Run is deliberately the complete public data contract. Apart from Title — one
// bounded line lifted from the opening user prompt so a human can tell runs
// apart — it contains no session transcript data.
type Run struct {
	ID         string        `json:"id"`
	SessionRef string        `json:"sessionRef"`
	Origin     string        `json:"origin"`
	ImportedAt time.Time     `json:"importedAt"`
	Title      string        `json:"title,omitempty"`
	Aggregate  SafeAggregate `json:"aggregate"`
}

type storedRun struct {
	Run
	SourceLookup  string `json:"sourceLookup"`
	SessionLookup string `json:"sessionLookup"`
}

// RunView is the stable, privacy-safe API response. The on-disk Run keeps its
// aggregate nested so storage can evolve independently of the browser contract.
type RunView struct {
	ID                  string                                 `json:"id"`
	SessionRef          string                                 `json:"sessionRef"`
	SessionID           string                                 `json:"sessionId"`
	SourceSessionID     string                                 `json:"sourceSessionId"`
	Origin              string                                 `json:"origin"`
	ImportedAt          time.Time                              `json:"importedAt"`
	Title               string                                 `json:"title,omitempty"`
	Snippet             string                                 `json:"snippet,omitempty"`
	Provider            string                                 `json:"provider"`
	Model               string                                 `json:"model,omitempty"`
	Project             string                                 `json:"project,omitempty"`
	RunKind             string                                 `json:"runKind"`
	StartedAt           time.Time                              `json:"startedAt"`
	EndedAt             time.Time                              `json:"endedAt"`
	DurationMS          int64                                  `json:"durationMs"`
	ActiveDurationMS    int64                                  `json:"activeDurationMs"`
	IdleDurationMS      int64                                  `json:"idleDurationMs"`
	Tokens              TokenBuckets                           `json:"tokens"`
	Counts              RunCounts                              `json:"counts"`
	ToolCounts          map[string]sessioninsight.ToolStats    `json:"toolCounts"`
	SkillActivity       sessioninsight.SkillActivity           `json:"skillActivity"`
	CorrectionSignals   []sessioninsight.CorrectionSignal      `json:"correctionSignals"`
	PhaseCounts         map[string]int                         `json:"phaseCounts"`
	PhaseSequence       []sessioninsight.PhaseStep             `json:"phaseSequence"`
	Verification        Verification                           `json:"verification"`
	Quality             map[string]sessioninsight.QualityLevel `json:"quality"`
	PeakContextTokens   *int64                                 `json:"peakContextTokens,omitempty"`
	ContextWindowTokens *int64                                 `json:"contextWindowTokens,omitempty"`
	ParseWarnings       []string                               `json:"parseWarnings,omitempty"`
	Trace               []sessioninsight.TraceEvent            `json:"trace,omitempty"`
}

type TokenBuckets struct {
	InputUncached *int64 `json:"inputUncached,omitempty"`
	CacheRead     *int64 `json:"cacheRead,omitempty"`
	CacheWrite    *int64 `json:"cacheWrite,omitempty"`
	Output        *int64 `json:"output,omitempty"`
	Reasoning     *int64 `json:"reasoning,omitempty"`
	Total         *int64 `json:"total,omitempty"`
}

type RunCounts struct {
	UserTurns     int `json:"userTurns"`
	FollowUps     int `json:"followUps"`
	Corrections   int `json:"corrections"`
	Tools         int `json:"tools"`
	ToolFailures  int `json:"toolFailures"`
	Verifications int `json:"verifications"`
	Subagents     int `json:"subagents"`
	Compactions   int `json:"compactions"`
}

type Verification struct {
	Status        string `json:"status"`
	Summary       string `json:"summary"`
	EvidenceCount int    `json:"evidenceCount"`
}

func publicRun(run Run) RunView {
	a := run.Aggregate
	var total *int64
	if a.InputUncached != nil || a.CacheRead != nil || a.CacheWrite != nil || a.Output != nil {
		// Reasoning is a subset of output tokens, not an additional bucket.
		value := deref(a.InputUncached) + deref(a.CacheRead) + deref(a.CacheWrite) + deref(a.Output)
		total = &value
	}
	verification := Verification{Status: "unknown", Summary: "未识别到可验证证据"}
	if a.VerificationCount > 0 {
		verification = Verification{Status: "observed", Summary: "识别到验证相关工具活动", EvidenceCount: a.VerificationCount}
	}
	quality := map[string]sessioninsight.QualityLevel{
		"token":           a.Quality["tokens"],
		"inputTokens":     a.Quality["inputTokens"],
		"outputTokens":    a.Quality["outputTokens"],
		"reasoningTokens": a.Quality["reasoningTokens"],
		"context":         a.Quality["context"],
		"tools":           a.Quality["tools"],
		"trajectory":      a.Quality["trajectory"],
		"skills":          a.Quality["skills"],
		"correction":      a.Quality["corrections"],
		"verification":    sessioninsight.QualityUnknown,
	}
	for key, value := range quality {
		if value == "" {
			quality[key] = sessioninsight.QualityUnknown
		}
	}
	return RunView{
		ID: run.ID, SessionRef: run.SessionRef, SessionID: a.SourceSessionID, SourceSessionID: a.SourceSessionID, Origin: run.Origin, ImportedAt: run.ImportedAt, Title: run.Title,
		Provider: a.Provider, Model: a.Model, Project: a.Project, RunKind: a.RunKind, StartedAt: a.StartedAt, EndedAt: a.EndedAt,
		DurationMS: a.EndedAt.Sub(a.StartedAt).Milliseconds(), ActiveDurationMS: a.ActiveDurationMS, IdleDurationMS: a.IdleDurationMS,
		Tokens:     TokenBuckets{InputUncached: a.InputUncached, CacheRead: a.CacheRead, CacheWrite: a.CacheWrite, Output: a.Output, Reasoning: a.ReasoningOutput, Total: total},
		Counts:     RunCounts{UserTurns: a.UserTurnCount, FollowUps: a.FollowUpCount, Corrections: a.CorrectionCandidateCount, Tools: a.ToolCallCount, ToolFailures: a.ToolFailureCount, Verifications: a.VerificationCount, Subagents: a.SubagentCount, Compactions: a.CompactionCount},
		ToolCounts: a.ToolCounts, SkillActivity: a.SkillActivity, CorrectionSignals: a.CorrectionSignals,
		PhaseCounts: a.PhaseCounts, PhaseSequence: a.PhaseSequence, Verification: verification, Quality: quality, PeakContextTokens: a.PeakContextTokens, ContextWindowTokens: a.ContextWindowTokens, ParseWarnings: a.ParseWarnings, Trace: a.Trace,
	}
}

func deref(value *int64) int64 {
	if value == nil {
		return 0
	}
	return *value
}

type upsertResult struct {
	Runs     []Run
	Imported int
	Updated  int
}

// SafeAggregate is the parser's aggregate with private source identifiers removed.
type SafeAggregate struct {
	Provider                 string                                 `json:"provider"`
	Model                    string                                 `json:"model,omitempty"`
	Project                  string                                 `json:"project,omitempty"`
	SourceSessionID          string                                 `json:"sourceSessionId"`
	RunKind                  string                                 `json:"runKind"`
	StartedAt                time.Time                              `json:"startedAt"`
	EndedAt                  time.Time                              `json:"endedAt"`
	ActiveDurationMS         int64                                  `json:"activeDurationMs"`
	IdleDurationMS           int64                                  `json:"idleDurationMs"`
	InputUncached            *int64                                 `json:"inputUncached,omitempty"`
	CacheRead                *int64                                 `json:"cacheRead,omitempty"`
	CacheWrite               *int64                                 `json:"cacheWrite,omitempty"`
	Output                   *int64                                 `json:"output,omitempty"`
	ReasoningOutput          *int64                                 `json:"reasoningOutput,omitempty"`
	TokenObserved            bool                                   `json:"tokenObserved"`
	PeakContextTokens        *int64                                 `json:"peakContextTokens,omitempty"`
	ContextWindowTokens      *int64                                 `json:"contextWindowTokens,omitempty"`
	UserTurnCount            int                                    `json:"userTurnCount"`
	FollowUpCount            int                                    `json:"followUpCount"`
	CorrectionCandidateCount int                                    `json:"correctionCandidateCount"`
	ToolCallCount            int                                    `json:"toolCallCount"`
	ToolFailureCount         int                                    `json:"toolFailureCount"`
	VerificationCount        int                                    `json:"verificationCount"`
	SubagentCount            int                                    `json:"subagentCount"`
	CompactionCount          int                                    `json:"compactionCount"`
	ToolCounts               map[string]sessioninsight.ToolStats    `json:"toolCounts"`
	SkillActivity            sessioninsight.SkillActivity           `json:"skillActivity"`
	CorrectionSignals        []sessioninsight.CorrectionSignal      `json:"correctionSignals"`
	PhaseCounts              map[string]int                         `json:"phaseCounts"`
	PhaseSequence            []sessioninsight.PhaseStep             `json:"phaseSequence"`
	Trace                    []sessioninsight.TraceEvent            `json:"trace,omitempty"`
	Quality                  map[string]sessioninsight.QualityLevel `json:"quality"`
	ParseWarnings            []string                               `json:"parseWarnings"`
	ParserVersion            string                                 `json:"parserVersion"`
}

func safeAggregate(a sessioninsight.Aggregate) SafeAggregate {
	return SafeAggregate{a.Provider, a.Model, a.Project, a.SourceSessionID, a.RunKind, a.StartedAt, a.EndedAt, a.ActiveDurationMS, a.IdleDurationMS, a.InputUncached, a.CacheRead, a.CacheWrite, a.Output, a.ReasoningOutput, a.TokenObserved, a.PeakContextTokens, a.ContextWindowTokens, a.UserTurnCount, a.FollowUpCount, a.CorrectionCandidateCount, a.ToolCallCount, a.ToolFailureCount, a.VerificationCount, a.SubagentCount, a.CompactionCount, a.ToolCounts, a.SkillActivity, a.CorrectionSignals, a.PhaseCounts, a.PhaseSequence, a.Trace, a.Quality, a.ParseWarnings, a.ParserVersion}
}

func New(config Config) (*Store, error) {
	if config.DataFile == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			return nil, fmt.Errorf("user config directory: %w", err)
		}
		config.DataFile = filepath.Join(base, "session-insight", "index.json")
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	e := &Store{path: config.DataFile, traceDir: filepath.Join(filepath.Dir(config.DataFile), "runs"), webDir: config.WebDir, now: config.Now}
	if err := e.load(); err != nil {
		return nil, err
	}
	return e, nil
}

func (e *Store) load() error {
	b, err := os.ReadFile(e.path)
	if errors.Is(err, os.ErrNotExist) {
		secret, err := randomHex(32)
		if err != nil {
			return err
		}
		e.data = diskData{Version: 3, Secret: secret}
		return e.persistLocked()
	}
	if err != nil {
		return fmt.Errorf("read local index: %w", err)
	}
	if err := json.Unmarshal(b, &e.data); err != nil {
		return fmt.Errorf("read local index: %w", err)
	}
	if e.data.Version != 3 || e.data.Secret == "" {
		secret, err := randomHex(32)
		if err != nil {
			return err
		}
		// Trace data is not backward compatible with older aggregate-only
		// index. Recreate it; the user can rescan their local folders.
		e.data = diskData{Version: 3, Secret: secret}
		if err := os.RemoveAll(e.traceDir); err != nil {
			return err
		}
		return e.persistLocked()
	}
	return e.backfillDigestsLocked()
}

// setSearchTextLocked records a run's conversation haystack in memory only.
func (e *Store) setSearchTextLocked(id, text string) {
	if e.search == nil {
		e.search = map[string]string{}
	}
	if text == "" {
		delete(e.search, id)
		return
	}
	e.search[strings.ToLower(id)] = text
}

// ensureSearchLocked builds the content-search cache on first use. Reading every
// trace costs a beat, so it is deferred until a query actually needs it rather
// than paid on every start.
func (e *Store) ensureSearchLocked() {
	if e.searchReady {
		return
	}
	if e.search == nil {
		e.search = make(map[string]string, len(e.data.Runs))
	}
	for _, run := range e.data.Runs {
		if _, cached := e.search[strings.ToLower(run.ID)]; cached {
			continue
		}
		trace, err := e.readTraceLocked(run.ID)
		if err != nil {
			continue
		}
		if _, text := deriveDigest(trace); text != "" {
			e.search[strings.ToLower(run.ID)] = text
		}
	}
	e.searchReady = true
}

func (e *Store) searchTextLocked(id string) string { return e.search[strings.ToLower(id)] }

// Snippets returns, for each run, the matched phrase in context. Empty when the
// query is absent or matched only structured fields such as provider or model.
func (e *Store) Snippets(ids []string, query string) map[string]string {
	if query == "" {
		return nil
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make(map[string]string, len(ids))
	for _, id := range ids {
		if snippet := snippetAround(e.searchTextLocked(id), query, snippetContextRunes); snippet != "" {
			out[id] = snippet
		}
	}
	return out
}

// backfillDigestsLocked derives titles and search text for runs indexed before
// those fields existed. Traces are already on disk, so no source session file is
// re-read. Runs whose trace is missing or has no user turn stay blank; the UI
// falls back to project plus short id for those.
func (e *Store) backfillDigestsLocked() error {
	if e.data.DigestVersion >= digestVersion {
		return nil
	}
	for i := range e.data.Runs {
		trace, err := e.readTraceLocked(e.data.Runs[i].ID)
		if err != nil {
			// A single unreadable trace must not block startup.
			continue
		}
		title, searchText := deriveDigest(trace)
		e.data.Runs[i].Title = title
		e.setSearchTextLocked(e.data.Runs[i].ID, searchText)
	}
	// Every trace was just read, so the search cache is complete.
	e.searchReady = true
	e.data.DigestVersion = digestVersion
	return e.persistLocked()
}

func (e *Store) persistLocked() error {
	if err := os.MkdirAll(filepath.Dir(e.path), 0700); err != nil {
		return err
	}
	b, err := json.Marshal(e.data)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(e.path), ".index-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, e.path); err != nil {
		return err
	}
	if dir, err := os.Open(filepath.Dir(e.path)); err == nil {
		defer dir.Close()
		_ = dir.Sync()
	}
	return os.Chmod(e.path, 0600)
}

func (e *Store) tracePath(id string) string {
	return filepath.Join(e.traceDir, id, "trace.json")
}

func (e *Store) writeTraceLocked(id string, trace []sessioninsight.TraceEvent) error {
	dir := filepath.Dir(e.tracePath(id))
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	b, err := json.Marshal(trace)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".trace-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, e.tracePath(id))
}

func (e *Store) readTraceLocked(id string) ([]sessioninsight.TraceEvent, error) {
	b, err := os.ReadFile(e.tracePath(id))
	if errors.Is(err, os.ErrNotExist) {
		return []sessioninsight.TraceEvent{}, nil
	}
	if err != nil {
		return nil, err
	}
	var trace []sessioninsight.TraceEvent
	if err := json.Unmarshal(b, &trace); err != nil {
		return nil, err
	}
	return trace, nil
}

func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func (e *Store) lookup(namespace, value string) string {
	m := hmac.New(sha256.New, []byte(e.data.Secret))
	_, _ = io.WriteString(m, namespace+"\x00"+value)
	return hex.EncodeToString(m.Sum(nil))
}

func (e *Store) sourceLookup(sourceRunKey string) string { return e.lookup("run", sourceRunKey) }
func (e *Store) sessionLookup(sessionID string) string   { return e.lookup("session", sessionID) }

func (e *Store) upsert(aggregates []sessioninsight.Aggregate, origin string) (upsertResult, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	result := upsertResult{Runs: make([]Run, 0, len(aggregates))}
	for _, aggregate := range aggregates {
		if aggregate.SourceSessionID == "" {
			continue
		}
		if aggregate.SourceRunKey == "" {
			continue
		}
		key := e.sourceLookup(aggregate.SourceRunKey)
		index := -1
		for i := range e.data.Runs {
			if hmac.Equal([]byte(e.data.Runs[i].SourceLookup), []byte(key)) {
				index = i
				break
			}
		}
		title, searchText := deriveDigest(aggregate.Trace)
		if index >= 0 {
			if err := e.writeTraceLocked(e.data.Runs[index].ID, aggregate.Trace); err != nil {
				return upsertResult{}, err
			}
			safe := safeAggregate(aggregate)
			safe.Trace = nil
			e.data.Runs[index].Aggregate = safe
			e.data.Runs[index].Origin = origin
			e.data.Runs[index].ImportedAt = e.now().UTC()
			e.data.Runs[index].Title = title
			e.setSearchTextLocked(e.data.Runs[index].ID, searchText)
			result.Runs = append(result.Runs, e.data.Runs[index].Run)
			result.Updated++
			continue
		}
		id, err := randomHex(16)
		if err != nil {
			return upsertResult{}, err
		}
		ref, err := randomHex(4)
		if err != nil {
			return upsertResult{}, err
		}
		if err := e.writeTraceLocked(id, aggregate.Trace); err != nil {
			return upsertResult{}, err
		}
		safe := safeAggregate(aggregate)
		safe.Trace = nil
		run := storedRun{Run: Run{ID: id, SessionRef: aggregate.Provider + "-" + ref, Origin: origin, ImportedAt: e.now().UTC(), Title: title, Aggregate: safe}, SourceLookup: key, SessionLookup: e.sessionLookup(aggregate.SourceSessionID)}
		e.setSearchTextLocked(id, searchText)
		e.data.Runs = append(e.data.Runs, run)
		result.Runs = append(result.Runs, run.Run)
		result.Imported++
	}
	e.linkStoredSubagentsLocked()
	if err := e.persistLocked(); err != nil {
		return upsertResult{}, err
	}
	return result, nil
}

func (e *Store) linkStoredSubagentsLocked() {
	counts := map[string]int{}
	for _, run := range e.data.Runs {
		if run.Aggregate.Provider == "claude" && run.Aggregate.RunKind == "subagent" {
			counts[run.Aggregate.SourceSessionID]++
		}
	}
	for i := range e.data.Runs {
		run := &e.data.Runs[i]
		if run.Aggregate.Provider == "claude" && run.Aggregate.RunKind == "main" {
			run.Aggregate.SubagentCount = counts[run.Aggregate.SourceSessionID]
		}
	}
}

func (e *Store) list(filters runFilters) ([]Run, string, int) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if filters.q != "" {
		e.ensureSearchLocked()
	}
	runs := make([]storedRun, 0, len(e.data.Runs))
	for _, run := range e.data.Runs {
		if filters.matches(run, e.sessionLookup, e.searchTextLocked(run.ID)) {
			runs = append(runs, run)
		}
	}
	sort.Slice(runs, func(i, j int) bool {
		left, right := runs[i].Aggregate, runs[j].Aggregate
		switch filters.sort {
		case "duration":
			return left.EndedAt.Sub(left.StartedAt) > right.EndedAt.Sub(right.StartedAt)
		case "tokens":
			return aggregateTokens(left) > aggregateTokens(right)
		case "tools":
			return left.ToolCallCount > right.ToolCallCount
		case "context":
			return contextRatio(left) > contextRatio(right)
		case "startedAsc":
			return left.StartedAt.Before(right.StartedAt)
		default:
			return left.StartedAt.After(right.StartedAt)
		}
	})
	start := 0
	if filters.cursor != "" {
		if v, err := decodeCursor(filters.cursor); err == nil && v >= 0 {
			start = v
		}
	}
	if start > len(runs) {
		start = len(runs)
	}
	end := start + filters.limit
	if end > len(runs) {
		end = len(runs)
	}
	public := make([]Run, end-start)
	for i := start; i < end; i++ {
		public[i-start] = runs[i].Run
	}
	next := ""
	if end < len(runs) {
		next = encodeCursor(end)
	}
	return public, next, len(runs)
}

func encodeCursor(v int) string { return base64.RawURLEncoding.EncodeToString([]byte(strconv.Itoa(v))) }
func decodeCursor(s string) (int, error) {
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(string(b))
}

type runFilters struct {
	q, provider, model, tool, skill, sort, cursor string
	errorOnly, correctionOnly, contextRisk        bool
	from, to                                      time.Time
	limit                                         int
}

func (f runFilters) matches(r storedRun, sessionLookup func(string) string, searchText string) bool {
	a := r.Aggregate
	if f.provider != "" && !strings.EqualFold(f.provider, a.Provider) {
		return false
	}
	if f.model != "" && !strings.EqualFold(f.model, a.Model) {
		return false
	}
	if f.errorOnly && a.ToolFailureCount == 0 {
		return false
	}
	if f.correctionOnly && a.CorrectionCandidateCount == 0 {
		return false
	}
	if f.contextRisk && (a.PeakContextTokens == nil || a.ContextWindowTokens == nil || *a.ContextWindowTokens == 0 || float64(*a.PeakContextTokens)/float64(*a.ContextWindowTokens) < 0.8) {
		return false
	}
	if f.tool != "" {
		if !hasTool(a.ToolCounts, f.tool) {
			return false
		}
	}
	if f.skill != "" && !hasSkill(a.SkillActivity, f.skill) {
		return false
	}
	if !f.from.IsZero() && a.EndedAt.Before(f.from) {
		return false
	}
	if !f.to.IsZero() && a.StartedAt.After(f.to) {
		return false
	}
	if f.q == "" {
		return true
	}
	q := strings.ToLower(f.q)
	if strings.Contains(strings.ToLower(r.SessionRef), q) || strings.Contains(strings.ToLower(a.SourceSessionID), q) || strings.Contains(strings.ToLower(a.Provider), q) || strings.Contains(strings.ToLower(a.Model), q) || strings.Contains(strings.ToLower(a.Project), q) || strings.Contains(strings.ToLower(a.RunKind), q) {
		return true
	}
	// Content search: people recall what they asked, not the run's uuid.
	if strings.Contains(strings.ToLower(r.Title), q) || strings.Contains(strings.ToLower(searchText), q) {
		return true
	}
	for name := range a.ToolCounts {
		if strings.Contains(strings.ToLower(name), q) {
			return true
		}
	}
	for _, names := range []map[string]int{a.SkillActivity.Invoked, a.SkillActivity.Attributed, a.SkillActivity.Inferred} {
		for name := range names {
			if strings.Contains(strings.ToLower(name), q) {
				return true
			}
		}
	}
	return hmac.Equal([]byte(r.SessionLookup), []byte(sessionLookup(f.q)))
}

func aggregateTokens(a SafeAggregate) int64 {
	return deref(a.InputUncached) + deref(a.CacheRead) + deref(a.CacheWrite) + deref(a.Output)
}

func contextRatio(a SafeAggregate) float64 {
	if a.PeakContextTokens == nil || a.ContextWindowTokens == nil || *a.ContextWindowTokens == 0 {
		return -1
	}
	return float64(*a.PeakContextTokens) / float64(*a.ContextWindowTokens)
}
func hasSkill(s sessioninsight.SkillActivity, name string) bool {
	for _, values := range []map[string]int{s.Invoked, s.Attributed, s.Inferred} {
		for value := range values {
			if strings.EqualFold(value, name) {
				return true
			}
		}
	}
	return false
}

func hasTool(values map[string]sessioninsight.ToolStats, name string) bool {
	for value := range values {
		if strings.EqualFold(value, name) {
			return true
		}
	}
	return false
}

// Handler returns the Store HTTP handler. The listener is loopback-bound by main.
func (e *Store) Handler() http.Handler { return securityHeaders(http.HandlerFunc(e.serveHTTP)) }
func (e *Store) serveHTTP(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/health":
			writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
		case r.Method == http.MethodPost && r.URL.Path == "/api/session-insights/import":
			e.importFiles(w, r)
		case r.Method == http.MethodPost && r.URL.Path == "/api/session-insights/scan":
			e.scan(w, r)
		case r.Method == http.MethodGet && r.URL.Path == "/api/session-insights/runs":
			e.listRuns(w, r)
		case r.Method == http.MethodDelete && r.URL.Path == "/api/session-insights/runs":
			e.deleteAll(w)
		case r.Method == http.MethodGet && r.URL.Path == "/api/session-insights/summary":
			e.summary(w)
		case r.Method == http.MethodGet && r.URL.Path == "/api/session-insights/stats":
			e.statsHandler(w, r)
		case strings.HasPrefix(r.URL.Path, "/api/session-insights/runs/"):
			e.oneRun(w, r)
		default:
			http.NotFound(w, r)
		}
		return
	}
	e.serveStatic(w, r)
}
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", "default-src 'self'; base-uri 'none'; frame-ancestors 'none'")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}
func (e *Store) serveStatic(w http.ResponseWriter, r *http.Request) {
	if e.webDir == "" {
		http.NotFound(w, r)
		return
	}
	name := strings.TrimPrefix(filepath.Clean(r.URL.Path), string(filepath.Separator))
	if name == "." || strings.Contains(name, "..") {
		name = "index.html"
	}
	path := filepath.Join(e.webDir, name)
	if info, err := os.Stat(path); err != nil || info.IsDir() {
		path = filepath.Join(e.webDir, "index.html")
	}
	http.ServeFile(w, r, path)
}
