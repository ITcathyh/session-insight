// Package sessioninsight produces privacy-preserving summaries of local agent sessions.
package sessioninsight

import (
	"bufio"
	"bytes"
	"container/heap"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

const ParserVersion = "v3"

const defaultMaxLineBytes = 4 << 20
const defaultMaxFiles = 10000
const defaultMaxTotalBytes int64 = 512 << 20

type QualityLevel string

const (
	QualityExact       QualityLevel = "exact"
	QualityDerived     QualityLevel = "derived"
	QualityEstimated   QualityLevel = "estimated"
	QualityInferred    QualityLevel = "inferred"
	QualityUnknown     QualityLevel = "unknown"
	QualityObserved    QualityLevel = "observed"
	QualityHeuristic   QualityLevel = "heuristic"
	QualityUnavailable QualityLevel = "unavailable"
)

type ToolStats struct {
	Calls    int `json:"calls"`
	Failures int `json:"failures"`
}

type SkillActivity struct {
	Invoked    map[string]int `json:"invoked"`
	Attributed map[string]int `json:"attributed"`
	Inferred   map[string]int `json:"inferred"`
}

type CorrectionSignal struct {
	Type    string       `json:"type"`
	Count   int          `json:"count"`
	Quality QualityLevel `json:"quality"`
}

type PhaseStep struct {
	Phase         string `json:"phase"`
	StartOffsetMS int64  `json:"startOffsetMs"`
	DurationMS    int64  `json:"durationMs"`
	EventCount    int    `json:"eventCount"`
	ToolCalls     int    `json:"toolCalls"`
	ToolFailures  int    `json:"toolFailures"`
	Truncated     bool   `json:"truncated,omitempty"`
}

// TokenUsage is deliberately split into tracked buckets. Reasoning is a subset
// of Output and must never be added to a tracked total a second time.
type TokenUsage struct {
	InputUncached *int64 `json:"inputUncached,omitempty"`
	CacheRead     *int64 `json:"cacheRead,omitempty"`
	CacheWrite    *int64 `json:"cacheWrite,omitempty"`
	Output        *int64 `json:"output,omitempty"`
	Reasoning     *int64 `json:"reasoning,omitempty"`
}

// TraceEvent is the normalized, local-session event contract used by the
// workbench. Input/output/error are bounded excerpts, never unbounded JSONL
// records, so a long transcript cannot make the local index unusable.
type TraceEvent struct {
	ID           string            `json:"id"`
	ParentID     string            `json:"parentId,omitempty"`
	TurnID       string            `json:"turnId,omitempty"`
	Start        time.Time         `json:"start"`
	End          time.Time         `json:"end"`
	DurationMS   int64             `json:"durationMs"`
	Type         string            `json:"type"`
	Name         string            `json:"name"`
	Status       string            `json:"status"`
	Model        string            `json:"model,omitempty"`
	Tool         string            `json:"tool,omitempty"`
	Skill        string            `json:"skill,omitempty"`
	Tokens       TokenUsage        `json:"tokens"`
	Context      *int64            `json:"contextTokens,omitempty"`
	ContextLimit *int64            `json:"contextWindow,omitempty"`
	Quality      QualityLevel      `json:"quality"`
	Input        string            `json:"input,omitempty"`
	Output       string            `json:"output,omitempty"`
	Error        string            `json:"error,omitempty"`
	Metadata     map[string]string `json:"metadata,omitempty"`
}

// Aggregate contains no prompt text, messages, command arguments, tool output, paths, or titles.
type Aggregate struct {
	Provider                 string                  `json:"provider"`
	Model                    string                  `json:"model,omitempty"`
	Project                  string                  `json:"project,omitempty"`
	SourceRunKey             string                  `json:"sourceRunKey"`
	SourceSessionID          string                  `json:"-"`
	RunKind                  string                  `json:"runKind"`
	RootFingerprint          string                  `json:"rootFingerprint"`
	StartedAt                time.Time               `json:"startedAt"`
	EndedAt                  time.Time               `json:"endedAt"`
	ActiveDurationMS         int64                   `json:"activeDurationMs"`
	IdleDurationMS           int64                   `json:"idleDurationMs"`
	InputUncached            *int64                  `json:"inputUncached,omitempty"`
	CacheRead                *int64                  `json:"cacheRead,omitempty"`
	CacheWrite               *int64                  `json:"cacheWrite,omitempty"`
	Output                   *int64                  `json:"output,omitempty"`
	ReasoningOutput          *int64                  `json:"reasoningOutput,omitempty"`
	TokenObserved            bool                    `json:"tokenObserved"`
	PeakContextTokens        *int64                  `json:"peakContextTokens,omitempty"`
	ContextWindowTokens      *int64                  `json:"contextWindowTokens,omitempty"`
	UserTurnCount            int                     `json:"userTurnCount"`
	FollowUpCount            int                     `json:"followUpCount"`
	CorrectionCandidateCount int                     `json:"correctionCandidateCount"`
	ToolCallCount            int                     `json:"toolCallCount"`
	ToolFailureCount         int                     `json:"toolFailureCount"`
	VerificationCount        int                     `json:"verificationCount"`
	SubagentCount            int                     `json:"subagentCount"`
	CompactionCount          int                     `json:"compactionCount"`
	ToolCounts               map[string]ToolStats    `json:"toolCounts"`
	SkillActivity            SkillActivity           `json:"skillActivity"`
	CorrectionSignals        []CorrectionSignal      `json:"correctionSignals"`
	PhaseCounts              map[string]int          `json:"phaseCounts"`
	PhaseSequence            []PhaseStep             `json:"phaseSequence"`
	Trace                    []TraceEvent            `json:"trace"`
	Quality                  map[string]QualityLevel `json:"quality"`
	ParseWarnings            []string                `json:"parseWarnings"`
	ParserVersion            string                  `json:"parserVersion"`
}

type ScanOptions struct {
	CodexRoot    string
	ClaudeRoot   string
	TraeRoot     string
	Days         int
	MaxLineBytes int
	// MaxFiles limits completed file scans. Values <= 0 use the safe default.
	MaxFiles      int
	MaxTotalBytes int64
	Providers     []string
	Now           time.Time
}

type ScanResult struct {
	Runs         []Aggregate `json:"runs"`
	Warnings     []string    `json:"warnings"`
	FilesScanned int         `json:"filesScanned"`
	FilesSkipped int         `json:"filesSkipped"`
}

var staticToolCall = regexp.MustCompile(`\btools\.([A-Za-z][A-Za-z0-9_]*)\s*\(`)
var correctionWords = regexp.MustCompile(`(?i)\b(abort|cancel|stop|rollback|revert|undo|instead|correction|wrong|mistake|change\s+course)\b|还是.{0,12}(?:太|不够|不行|不对|不是)|(?:不够|不行|不对|不是|不需要|不要|别再|改成|改为|重新|不局限于|不止这么点|至少得|肯定得|先看完).{0,24}`)
var skillFilePath = regexp.MustCompile(`(?i)(?:^|[/\\])([A-Za-z][A-Za-z0-9_-]{0,63})[/\\]SKILL\.md\b`)

// Scan streams supported local agent session files and returns safe aggregates.
func Scan(ctx context.Context, opts ScanOptions) (ScanResult, error) {
	if opts.MaxLineBytes <= 0 {
		opts.MaxLineBytes = defaultMaxLineBytes
	}
	if opts.MaxFiles <= 0 {
		opts.MaxFiles = defaultMaxFiles
	}
	if opts.MaxTotalBytes <= 0 {
		opts.MaxTotalBytes = defaultMaxTotalBytes
	}
	if opts.Now.IsZero() {
		opts.Now = time.Now()
	}
	useDefaultTraeRoot := opts.CodexRoot == "" && opts.ClaudeRoot == "" && opts.TraeRoot == ""
	if opts.CodexRoot == "" || opts.ClaudeRoot == "" || useDefaultTraeRoot {
		home, err := os.UserHomeDir()
		if err != nil {
			return ScanResult{}, fmt.Errorf("find home directory: %w", err)
		}
		if opts.CodexRoot == "" {
			opts.CodexRoot = filepath.Join(home, ".codex")
		}
		if opts.ClaudeRoot == "" {
			opts.ClaudeRoot = filepath.Join(home, ".claude")
		}
		if useDefaultTraeRoot {
			opts.TraeRoot = filepath.Join(home, ".trae")
		}
	}
	cutoff := time.Time{}
	if opts.Days > 0 {
		cutoff = opts.Now.AddDate(0, 0, -opts.Days)
	}

	var result ScanResult
	candidates, discovery, err := discoverCandidates(ctx, opts)
	if err != nil {
		return result, err
	}
	result.FilesSkipped, result.Warnings = discovery.skipped, discovery.warnings
	budget := &scanBudget{maxFiles: opts.MaxFiles, maxBytes: opts.MaxTotalBytes}
	for _, candidate := range candidates {
		if err := processCandidate(ctx, candidate, cutoff, opts, budget, &result); err != nil {
			return result, err
		}
	}
	linkSubagents(result.Runs)
	sort.Slice(result.Runs, func(i, j int) bool { return result.Runs[i].StartedAt.After(result.Runs[j].StartedAt) })
	return result, nil
}

type scanCandidate struct {
	path, provider, source, runKind string
	info                            os.FileInfo
}
type candidateHeap []scanCandidate

func (h candidateHeap) Len() int { return len(h) }
func (h candidateHeap) Less(i, j int) bool {
	if h[i].info.ModTime().Equal(h[j].info.ModTime()) {
		return h[i].path < h[j].path
	}
	return h[i].info.ModTime().Before(h[j].info.ModTime())
}
func (h candidateHeap) Swap(i, j int)   { h[i], h[j] = h[j], h[i] }
func (h *candidateHeap) Push(value any) { *h = append(*h, value.(scanCandidate)) }
func (h *candidateHeap) Pop() any {
	old := *h
	value := old[len(old)-1]
	*h = old[:len(old)-1]
	return value
}

type discoveryResult struct {
	skipped  int
	warnings []string
}

func discoverCandidates(ctx context.Context, opts ScanOptions) ([]scanCandidate, discoveryResult, error) {
	limit := candidatePoolLimit(opts.MaxFiles)
	queue := &candidateHeap{}
	heap.Init(queue)
	result := discoveryResult{}
	offer := func(candidate scanCandidate) {
		if queue.Len() < limit {
			heap.Push(queue, candidate)
			return
		}
		oldest := (*queue)[0]
		newer := candidate.info.ModTime().After(oldest.info.ModTime()) || (candidate.info.ModTime().Equal(oldest.info.ModTime()) && candidate.path > oldest.path)
		if newer {
			result.skipped++
			result.warnings = appendWarning(result.warnings, "scan_candidate_limit_reached")
			heap.Pop(queue)
			heap.Push(queue, candidate)
			return
		}
		result.skipped++
		result.warnings = appendWarning(result.warnings, "scan_candidate_limit_reached")
	}
	discover := func(root, provider, source, runKind string, skipClaudeIgnored bool) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if _, err := os.Stat(root); errors.Is(err, os.ErrNotExist) {
			return nil
		} else if err != nil {
			return err
		}
		return filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			if err != nil {
				result.skipped++
				result.warnings = appendWarning(result.warnings, "candidate_path_unreadable")
				return nil
			}
			if entry.IsDir() {
				if skipClaudeIgnored && path != root && ignoredClaudeDirectory(entry.Name()) {
					return filepath.SkipDir
				}
				return nil
			}
			if filepath.Ext(path) != ".jsonl" {
				return nil
			}
			info, err := entry.Info()
			if err != nil {
				result.skipped++
				result.warnings = appendWarning(result.warnings, "candidate_path_unreadable")
				return nil
			}
			kind := runKind
			if provider == "claude" && strings.Contains(filepath.ToSlash(path), "/subagents/") {
				kind = "subagent"
			}
			offer(scanCandidate{path: path, provider: provider, source: source, runKind: kind, info: info})
			return nil
		})
	}
	if providerEnabled(opts.Providers, "codex") {
		if err := discover(filepath.Join(opts.CodexRoot, "sessions"), "codex", "live", "main", false); err != nil {
			return nil, result, err
		}
		if err := discover(filepath.Join(opts.CodexRoot, "archived_sessions"), "codex", "archived", "main", false); err != nil {
			return nil, result, err
		}
	}
	if providerEnabled(opts.Providers, "claude") {
		if err := discover(filepath.Join(opts.ClaudeRoot, "projects"), "claude", "projects", "main", true); err != nil {
			return nil, result, err
		}
	}
	if opts.TraeRoot != "" && providerEnabled(opts.Providers, "traex") {
		if err := discover(filepath.Join(opts.TraeRoot, "cli", "sessions"), "traex", "sessions", "main", false); err != nil {
			return nil, result, err
		}
		if err := discover(filepath.Join(opts.TraeRoot, "sessions"), "traex", "legacy", "main", false); err != nil {
			return nil, result, err
		}
	}
	candidates := make([]scanCandidate, queue.Len())
	for index := len(candidates) - 1; index >= 0; index-- {
		candidates[index] = heap.Pop(queue).(scanCandidate)
	}
	return candidates, result, nil
}

func candidatePoolLimit(maxFiles int) int {
	if maxFiles > int(^uint(0)>>1)/4 {
		return maxFiles
	}
	if limit := maxFiles * 4; limit > 1024 {
		return limit
	}
	return 1024
}

func processCandidate(ctx context.Context, candidate scanCandidate, cutoff time.Time, opts ScanOptions, budget *scanBudget, result *ScanResult) error {
	if warning, ok := budget.allow(candidate.info); !ok {
		result.FilesSkipped++
		result.Warnings = appendWarning(result.Warnings, warning)
		return nil
	}
	builder := newBuilder(candidate.provider, candidate.runKind)
	consume := builder.codex
	if candidate.provider == "claude" {
		consume = builder.claude
	}
	if err := streamJSONL(ctx, candidate.path, opts.MaxLineBytes, consume, &builder.warnings); err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		result.FilesSkipped++
		result.Warnings = appendWarning(result.Warnings, candidate.provider+"_file_unreadable")
		return nil
	}
	result.FilesScanned++
	if aggregate, ok := builder.finish(candidate.source); ok && (cutoff.IsZero() || !aggregate.EndedAt.Before(cutoff)) {
		result.Runs = append(result.Runs, aggregate)
	}
	return nil
}

func linkSubagents(runs []Aggregate) {
	counts := make(map[string]int)
	for _, run := range runs {
		if run.Provider == "claude" && run.RunKind == "subagent" {
			counts[run.Provider+"\x00"+run.SourceSessionID]++
		}
	}
	for i := range runs {
		if runs[i].Provider == "claude" && runs[i].RunKind == "main" {
			runs[i].SubagentCount = counts[runs[i].Provider+"\x00"+runs[i].SourceSessionID]
		}
	}
}

type scanBudget struct {
	files    int
	bytes    int64
	maxFiles int
	maxBytes int64
}

func (b *scanBudget) allow(info os.FileInfo) (string, bool) {
	if b.bytes+info.Size() > b.maxBytes {
		return "scan_byte_limit_reached", false
	}
	if b.files >= b.maxFiles {
		return "scan_file_limit_reached", false
	}
	b.files++
	b.bytes += info.Size()
	return "", true
}
func providerEnabled(providers []string, provider string) bool {
	if len(providers) == 0 {
		return true
	}
	for _, value := range providers {
		if strings.EqualFold(value, provider) {
			return true
		}
	}
	return false
}

func scanCodex(ctx context.Context, root, source string, cutoff time.Time, opts ScanOptions, budget *scanBudget, result *ScanResult) error {
	return walkJSONL(root, func(path string) error {
		info, err := os.Stat(path)
		if err != nil {
			result.FilesSkipped++
			return nil
		}
		if warning, ok := budget.allow(info); !ok {
			result.FilesSkipped++
			result.Warnings = appendWarning(result.Warnings, warning)
			return nil
		}
		builder := newBuilder("codex", "main")
		if err := streamJSONL(ctx, path, opts.MaxLineBytes, func(line []byte) {
			builder.codex(line)
		}, &builder.warnings); err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return err
			}
			result.FilesSkipped++
			result.Warnings = append(result.Warnings, "codex_file_unreadable")
			return nil
		}
		result.FilesScanned++
		if aggregate, ok := builder.finish(source); ok && (cutoff.IsZero() || !aggregate.EndedAt.Before(cutoff)) {
			result.Runs = append(result.Runs, aggregate)
		}
		return nil
	})
}

func scanClaude(ctx context.Context, root string, cutoff time.Time, opts ScanOptions, budget *scanBudget, result *ScanResult) error {
	paths, err := jsonlPaths(root, true)
	if err != nil {
		return err
	}
	for _, path := range paths {
		if err := ctx.Err(); err != nil {
			return err
		}
		info, statErr := os.Stat(path)
		if statErr != nil {
			result.FilesSkipped++
			continue
		}
		if warning, ok := budget.allow(info); !ok {
			result.FilesSkipped++
			result.Warnings = appendWarning(result.Warnings, warning)
			continue
		}
		runKind := "main"
		if strings.Contains(filepath.ToSlash(path), "/subagents/") {
			runKind = "subagent"
		}
		builder := newBuilder("claude", runKind)
		if err := streamJSONL(ctx, path, opts.MaxLineBytes, func(line []byte) {
			builder.claude(line)
		}, &builder.warnings); err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return err
			}
			result.FilesSkipped++
			result.Warnings = append(result.Warnings, "claude_file_unreadable")
			continue
		}
		result.FilesScanned++
		if aggregate, ok := builder.finish("projects"); ok && (cutoff.IsZero() || !aggregate.EndedAt.Before(cutoff)) {
			result.Runs = append(result.Runs, aggregate)
		}
	}
	return nil
}

func walkJSONL(root string, visit func(path string) error) error {
	paths, err := jsonlPaths(root, false)
	if err != nil {
		return err
	}
	for _, path := range paths {
		if err := visit(path); err != nil {
			return err
		}
	}
	return nil
}

func jsonlPaths(root string, skipClaudeIgnored bool) ([]string, error) {
	if _, err := os.Stat(root); errors.Is(err, os.ErrNotExist) {
		return nil, nil
	} else if err != nil {
		return nil, err
	}
	paths := make([]string, 0)
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if entry.IsDir() {
			if skipClaudeIgnored && path != root && ignoredClaudeDirectory(entry.Name()) {
				return filepath.SkipDir
			}
			return nil
		}
		if filepath.Ext(path) == ".jsonl" {
			paths = append(paths, path)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(paths, func(i, j int) bool {
		left, leftErr := os.Stat(paths[i])
		right, rightErr := os.Stat(paths[j])
		if leftErr == nil && rightErr == nil && !left.ModTime().Equal(right.ModTime()) {
			return left.ModTime().After(right.ModTime())
		}
		return paths[i] > paths[j]
	})
	return paths, nil
}

func ignoredClaudeDirectory(name string) bool {
	switch strings.ToLower(name) {
	case "backups", "history", "sessions":
		return true
	default:
		return false
	}
}

func streamJSONL(ctx context.Context, path string, max int, consume func([]byte), warnings *[]string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	reader := bufio.NewReaderSize(file, 64*1024)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		line, err := readLine(reader, max)
		if errors.Is(err, errLineTooLong) {
			*warnings = appendWarning(*warnings, "line_too_long")
			continue
		}
		if len(bytes.TrimSpace(line)) > 0 {
			consume(line)
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

var errLineTooLong = errors.New("jsonl line too long")

func readLine(reader *bufio.Reader, max int) ([]byte, error) {
	var buffer bytes.Buffer
	for {
		fragment, err := reader.ReadSlice('\n')
		if buffer.Len()+len(fragment) > max {
			for err == bufio.ErrBufferFull {
				_, err = reader.ReadSlice('\n')
			}
			if err != nil && !errors.Is(err, io.EOF) {
				return nil, err
			}
			return nil, errLineTooLong
		}
		buffer.Write(fragment)
		if err == nil || errors.Is(err, io.EOF) {
			return buffer.Bytes(), err
		}
		if !errors.Is(err, bufio.ErrBufferFull) {
			return nil, err
		}
	}
}

type builder struct {
	provider, runKind                                                            string
	sessionID, agentID, rootPath                                                 string
	started, ended                                                               time.Time
	inputUncached, cacheRead, cacheWrite, output, reasoning                      *int64
	peakContext, contextWindow                                                   *int64
	userTurns, followUps, corrections, calls, failures, verifications, subagents int
	compactions                                                                  int
	compactionTimes                                                              []time.Time
	assistantSeen                                                                bool
	resolvedToolCalls                                                            int
	unknownToolOutcome                                                           bool
	tools                                                                        map[string]ToolStats
	skills                                                                       SkillActivity
	signals                                                                      map[string]CorrectionSignal
	phaseCounts                                                                  map[string]int
	phaseEvents                                                                  []phaseEvent
	warnings                                                                     []string
	seenMessages                                                                 map[string]bool
	seenClaudeBlocks                                                             map[string]bool
	claudeSnapshots                                                              map[string]map[string]int64
	claudeEventSequence                                                          int
	seenCalls                                                                    map[string]string
	seenOutputs                                                                  map[string]bool
	trace                                                                        []TraceEvent
	eventByID                                                                    map[string]int
	toolEventByCall                                                              map[string]int
	currentTurn                                                                  string
	currentTurnID                                                                string
	eventSequence                                                                int
	tokenSnapshot                                                                map[string]int64
	model                                                                        string
	canonicalMode                                                                bool
	seenTurns                                                                    map[string]bool
	turnAnchors                                                                  map[string]string
}

type phaseEvent struct {
	phase         string
	at            time.Time
	tool, failure bool
}

func newBuilder(provider, runKind string) *builder {
	return &builder{provider: provider, runKind: runKind, tools: map[string]ToolStats{}, skills: SkillActivity{Invoked: map[string]int{}, Attributed: map[string]int{}, Inferred: map[string]int{}}, signals: map[string]CorrectionSignal{}, phaseCounts: map[string]int{}, seenMessages: map[string]bool{}, seenClaudeBlocks: map[string]bool{}, claudeSnapshots: map[string]map[string]int64{}, seenCalls: map[string]string{}, seenOutputs: map[string]bool{}, eventByID: map[string]int{}, toolEventByCall: map[string]int{}, tokenSnapshot: map[string]int64{}, seenTurns: map[string]bool{}, turnAnchors: map[string]string{}}
}

const maxTraceExcerptBytes = 640

// Conversation turns are what a human actually reads back, so they get a much
// larger budget than tool payloads. Tool input/output stays tight because it is
// machine chatter that only needs to be recognisable, not readable in full.
const maxConversationExcerptBytes = 8 << 10

const idleGap = 5 * time.Minute

// isConversationExcerpt reports whether an event carries human-readable turn
// text (a user prompt or the agent's reply) rather than tool payload.
func isConversationExcerpt(eventType, name string) bool {
	return eventType == "user" || (eventType == "model" && name == "Agent response")
}

func (b *builder) nextEventID(prefix string) string {
	b.eventSequence++
	return fmt.Sprintf("%s-%d", prefix, b.eventSequence)
}

func (b *builder) addTrace(event TraceEvent) int {
	if event.ID == "" {
		event.ID = b.nextEventID(event.Type)
	}
	if event.Start.IsZero() {
		event.Start = b.ended
	}
	if event.End.IsZero() || event.End.Before(event.Start) {
		event.End = event.Start
	}
	event.DurationMS = event.End.Sub(event.Start).Milliseconds()
	if event.Status == "" {
		event.Status = "unknown"
	}
	if event.Quality == "" {
		event.Quality = QualityDerived
	}
	limit := maxTraceExcerptBytes
	if isConversationExcerpt(event.Type, event.Name) {
		limit = maxConversationExcerptBytes
	}
	event.Input = boundedExcerptTo(event.Input, limit)
	event.Output = boundedExcerptTo(event.Output, limit)
	event.Error = boundedExcerpt(event.Error)
	b.trace = append(b.trace, event)
	b.eventByID[event.ID] = len(b.trace) - 1
	return len(b.trace) - 1
}

func boundedExcerpt(value string) string {
	return boundedExcerptTo(value, maxTraceExcerptBytes)
}

func boundedExcerptTo(value string, limit int) string {
	value = strings.TrimSpace(value)
	if len(value) <= limit {
		return value
	}
	// Back off to a rune boundary so multi-byte text never ends mid-character.
	cut := limit
	for cut > 0 && !utf8.RuneStart(value[cut]) {
		cut--
	}
	return value[:cut] + "…"
}

func (b *builder) addTurn(at time.Time, turnID, eventID, content string) {
	if turnID == "" {
		turnID = b.nextEventID("turn")
	}
	if eventID == "" {
		eventID = b.nextEventID("user")
	}
	anchor := b.turnAnchors[turnID]
	parentID := ""
	if anchor == "" {
		anchor = eventID
		b.turnAnchors[turnID] = anchor
	} else {
		parentID = anchor
	}
	b.currentTurn = anchor
	b.currentTurnID = turnID
	b.addTrace(TraceEvent{ID: eventID, ParentID: parentID, TurnID: turnID, Start: at, End: at, Type: "user", Name: "User message", Status: "ok", Quality: QualityObserved, Input: content})
}

func (b *builder) parentForTurn(turnID string) string {
	if anchor := b.turnAnchors[turnID]; anchor != "" {
		return anchor
	}
	return b.currentTurn
}

func (b *builder) addTool(at time.Time, name, callID, input string, quality QualityLevel) {
	if callID == "" {
		callID = b.nextEventID("tool")
	}
	index := b.addTrace(TraceEvent{ID: "tool-" + callID, ParentID: b.currentTurn, TurnID: b.currentTurnID, Start: at, End: at, Type: traceToolType(name), Name: name, Tool: name, Status: "unknown", Quality: quality, Input: input})
	b.toolEventByCall[callID] = index
}

func traceToolType(name string) string {
	if name == "agent" {
		return "subagent"
	}
	if isSkillTool(name) {
		return "skill"
	}
	if classifyToolPhase(name) == "verification" {
		return "verification"
	}
	return "tool"
}

func (b *builder) resolveTool(at time.Time, callID string, failure, known bool, output string) {
	index, ok := b.toolEventByCall[callID]
	if !ok || index >= len(b.trace) {
		return
	}
	event := &b.trace[index]
	if at.Before(event.Start) {
		at = event.Start
	}
	event.End = at
	event.DurationMS = at.Sub(event.Start).Milliseconds()
	event.Output = boundedExcerpt(output)
	if known {
		if failure {
			event.Status = "error"
			event.Error = boundedExcerpt(output)
		} else {
			event.Status = "ok"
		}
	}
}

func (b *builder) addTokenEvent(at time.Time, usage TokenUsage, contextTokens, contextLimit *int64, quality QualityLevel) {
	if usage.InputUncached == nil && usage.CacheRead == nil && usage.CacheWrite == nil && usage.Output == nil && usage.Reasoning == nil && contextTokens == nil && contextLimit == nil {
		return
	}
	b.addTrace(TraceEvent{ParentID: b.currentTurn, TurnID: b.currentTurnID, Start: at, End: at, Type: "model", Name: "Token pulse", Status: "ok", Model: b.model, Tokens: usage, Context: contextTokens, ContextLimit: contextLimit, Quality: quality})
}

func (b *builder) addAgentResponse(at time.Time, turnID, eventID, output string, quality QualityLevel) {
	if strings.TrimSpace(output) == "" {
		return
	}
	if turnID == "" {
		turnID = b.currentTurnID
	}
	b.assistantSeen = true
	b.phase(at, "response", false, false)
	b.addTrace(TraceEvent{ID: eventID, ParentID: b.parentForTurn(turnID), TurnID: turnID, Start: at, End: at, Type: "model", Name: "Agent response", Status: "ok", Model: b.model, Quality: quality, Output: output})
}

func (b *builder) addReasoning(at time.Time, turnID, eventID string, quality QualityLevel) {
	if turnID == "" {
		turnID = b.currentTurnID
	}
	b.assistantSeen = true
	b.phase(at, "reasoning", false, false)
	b.addTrace(TraceEvent{ID: eventID, ParentID: b.parentForTurn(turnID), TurnID: turnID, Start: at, End: at, Type: "model", Name: "Reasoning", Status: "ok", Model: b.model, Quality: quality})
}

func (b *builder) beginCanonical() {
	if b.canonicalMode {
		return
	}
	b.canonicalMode = true
	b.started, b.ended = time.Time{}, time.Time{}
	b.inputUncached, b.cacheRead, b.cacheWrite, b.output, b.reasoning = nil, nil, nil, nil, nil
	b.peakContext, b.contextWindow = nil, nil
	b.userTurns, b.followUps, b.corrections, b.calls, b.failures, b.verifications, b.subagents, b.compactions = 0, 0, 0, 0, 0, 0, 0, 0
	b.assistantSeen, b.resolvedToolCalls, b.unknownToolOutcome = false, 0, false
	b.tools = map[string]ToolStats{}
	b.skills = SkillActivity{Invoked: map[string]int{}, Attributed: map[string]int{}, Inferred: map[string]int{}}
	b.signals, b.phaseCounts, b.compactionTimes = map[string]CorrectionSignal{}, map[string]int{}, nil
	b.phaseEvents, b.trace = nil, nil
	b.eventByID, b.toolEventByCall, b.tokenSnapshot = map[string]int{}, map[string]int{}, map[string]int64{}
	b.seenCalls, b.seenOutputs, b.seenMessages = map[string]string{}, map[string]bool{}, map[string]bool{}
	b.seenClaudeBlocks = map[string]bool{}
	b.seenTurns = map[string]bool{}
	b.turnAnchors = map[string]string{}
	b.currentTurn = ""
	b.currentTurnID = ""
}

func (b *builder) codex(line []byte) {
	var raw map[string]json.RawMessage
	if json.Unmarshal(line, &raw) != nil {
		b.warnings = appendWarning(b.warnings, "malformed_json")
		return
	}
	var kind string
	_ = json.Unmarshal(raw["type"], &kind)
	at, hasTime := rawTime(raw["timestamp"])
	if kind == "compacted" && hasTime {
		b.markCompaction(at)
		return
	}
	var payload map[string]json.RawMessage
	if json.Unmarshal(raw["payload"], &payload) != nil {
		b.warnings = appendWarning(b.warnings, "unknown_event")
		return
	}
	var typ string
	_ = json.Unmarshal(payload["type"], &typ)
	if b.model == "" {
		b.model = stringField(payload, "model")
	}
	if kind == "session_meta" {
		b.sessionID = stringField(payload, "id")
		b.setRootPath(stringField(payload, "cwd"))
		b.model = stringField(payload, "model")
		if b.provider == "traex" {
			var source map[string]json.RawMessage
			if json.Unmarshal(payload["source"], &source) == nil && source["subagent"] != nil {
				b.runKind = "subagent"
			}
		}
		return
	}
	if !hasTime {
		b.warnings = appendWarning(b.warnings, "unknown_timestamp")
		return
	}
	b.observeTime(at)
	if b.provider == "traex" && kind == "history_mutation" {
		b.traexHistoryMutation(at, payload)
		return
	}
	if b.provider == "traex" && kind == "inter_agent_communication" {
		b.traexInterAgentCommunication(at, payload)
		return
	}
	if typ == "item_completed" {
		b.beginCanonical()
		b.observeTime(at)
		b.codexCompleted(at, payload)
		return
	}
	if b.canonicalMode && (kind == "response_item" || typ == "user_message" || typ == "message" || typ == "reasoning" || typ == "function_call" || typ == "custom_tool_call" || typ == "function_call_output" || typ == "custom_tool_call_output" || typ == "task_started") {
		return
	}
	switch typ {
	case "context_compaction", "context_compacted", "compaction":
		b.markCompaction(at)
	case "branch_follow_up", "branch-follow-up":
		b.signal("branch_follow_up", QualityInferred)
	case "token_count":
		b.codexTokens(at, payload)
	case "user_message":
		b.userTurn(at, stringField(payload, "message"))
	case "message":
		role := stringField(payload, "role")
		if role == "user" {
			b.userTurn(at, contentText(payload["content"]))
		} else if role == "assistant" {
			b.addAgentResponse(at, stringField(payload, "turn_id"), "", contentText(payload["content"]), QualityDerived)
		}
	case "agent_message":
		b.addAgentResponse(at, stringField(payload, "turn_id"), "", firstString(payload, "message", "text"), QualityObserved)
	case "reasoning", "agent_reasoning_raw_content":
		b.addReasoning(at, stringField(payload, "turn_id"), "", QualityObserved)
	case "sub_agent_activity":
		if occurred, ok := unixMS(payload["occurred_at_ms"]); ok {
			at = occurred
			b.observeTime(at)
		}
		kind := stringField(payload, "kind")
		if kind == "started" {
			b.subagents++
		}
		status := "ok"
		if kind == "interrupted" {
			status = "error"
		}
		b.addTrace(TraceEvent{ID: stringField(payload, "event_id"), ParentID: b.currentTurn, TurnID: b.currentTurnID, Start: at, End: at, Type: "subagent", Name: "Subagent " + kind, Status: status, Quality: QualityObserved, Metadata: map[string]string{"activity": kind}})
	case "function_call", "custom_tool_call":
		b.assistantSeen = true
		name, callID := stringField(payload, "name"), stringField(payload, "call_id")
		if name == "" {
			name = stringField(payload, "type")
		}
		arguments := payload["arguments"]
		if typ == "custom_tool_call" {
			arguments = payload["input"]
		}
		if typ == "custom_tool_call" && isExecTool(name) && b.staticTools(at, arguments, callID) > 0 {
			b.inferSkillFile(arguments)
			return
		}
		b.callWithTrace(at, name, callID, rawText(arguments), QualityDerived)
		if isSkillTool(name) {
			b.skills.Invoked[skillName(payload["arguments"])]++
		}
		if isExecTool(name) {
			b.staticTools(at, arguments, callID)
			b.inferSkillFile(arguments)
		}
	case "function_call_output", "custom_tool_call_output":
		callID := stringField(payload, "call_id")
		b.outputEvent(at, callID, payload)
	case "exec_command_end", "patch_apply_end", "web_search_end":
		if completed, ok := unixMS(payload["completed_at_ms"]); ok {
			at = completed
			b.observeTime(at)
		}
		b.resolveObservedTool(at, stringField(payload, "call_id"), payload, firstText(payload["stderr"], payload["aggregated_output"], payload["formatted_output"], payload["stdout"], payload["output"]), true)
	case "task_started":
		// A task turn is not a child agent. Child agent lifecycle entries are
		// handled by canonical item_completed records when present.
	}
}

func (b *builder) traexHistoryMutation(at time.Time, payload map[string]json.RawMessage) {
	operation := stringField(payload, "operation")
	turnID := stringField(payload, "turn_id")
	switch operation {
	case "append":
		var items []map[string]json.RawMessage
		if json.Unmarshal(payload["items"], &items) != nil {
			return
		}
		for _, item := range items {
			switch stringField(item, "type") {
			case "function_call", "custom_tool_call":
				name := stringField(item, "name")
				callID := stringField(item, "call_id")
				arguments := item["arguments"]
				if arguments == nil {
					arguments = item["input"]
				}
				b.callWithTrace(at, name, callID, rawText(arguments), QualityObserved)
			case "function_call_output", "custom_tool_call_output":
				b.resolveObservedTool(at, stringField(item, "call_id"), item, rawText(item["output"]), true)
			}
		}
	case "replace":
		b.markCompaction(at)
		b.addTrace(TraceEvent{ParentID: b.parentForTurn(turnID), TurnID: turnID, Start: at, End: at, Type: "compaction", Name: "Context replacement", Status: "ok", Quality: QualityObserved})
	case "rollback":
		b.signal("rollback", QualityObserved)
		b.addTrace(TraceEvent{ParentID: b.parentForTurn(turnID), TurnID: turnID, Start: at, End: at, Type: "system", Name: "History rollback", Status: "ok", Quality: QualityObserved})
	}
}

func (b *builder) traexInterAgentCommunication(at time.Time, payload map[string]json.RawMessage) {
	kind := stringField(payload, "kind")
	if kind == "" {
		kind = "activity"
	}
	b.addTrace(TraceEvent{ParentID: b.currentTurn, TurnID: b.currentTurnID, Start: at, End: at, Type: "subagent", Name: "Subagent " + strings.ReplaceAll(kind, "_", " "), Status: "ok", Quality: QualityObserved, Metadata: map[string]string{"activity": kind}})
}

func (b *builder) codexTokens(at time.Time, payload map[string]json.RawMessage) {
	var info map[string]json.RawMessage
	if json.Unmarshal(payload["info"], &info) != nil {
		return
	}
	var usage map[string]json.RawMessage
	if json.Unmarshal(info["total_token_usage"], &usage) != nil {
		return
	}
	input, hasInput := rawNonNegativeInt64(usage["input_tokens"])
	cached, hasCached := rawNonNegativeInt64(usage["cached_input_tokens"])
	delta := TokenUsage{}
	if hasInput && hasCached {
		value := maxInt64(0, input-cached)
		delta.InputUncached = b.snapshotDelta("inputUncached", value)
		addObserved(&b.inputUncached, *delta.InputUncached)
	}
	if hasCached {
		delta.CacheRead = b.snapshotDelta("cacheRead", cached)
		addObserved(&b.cacheRead, *delta.CacheRead)
	}
	cacheWrite, hasCacheWrite := rawNonNegativeInt64(usage["cache_write_input_tokens"])
	if !hasCacheWrite {
		cacheWrite, hasCacheWrite = rawNonNegativeInt64(usage["cache_creation_input_tokens"])
	}
	if hasCacheWrite {
		delta.CacheWrite = b.snapshotDelta("cacheWrite", cacheWrite)
		addObserved(&b.cacheWrite, *delta.CacheWrite)
	}
	if output, ok := rawNonNegativeInt64(usage["output_tokens"]); ok {
		delta.Output = b.snapshotDelta("output", output)
		addObserved(&b.output, *delta.Output)
	}
	if reasoning, ok := rawNonNegativeInt64(usage["reasoning_output_tokens"]); ok {
		delta.Reasoning = b.snapshotDelta("reasoning", reasoning)
		addObserved(&b.reasoning, *delta.Reasoning)
	}
	var contextTokens *int64
	var last map[string]int64
	if json.Unmarshal(info["last_token_usage"], &last) == nil {
		if total := last["total_tokens"]; total > 0 {
			contextTokens = ptr(total)
			if b.peakContext == nil || total > *b.peakContext {
				b.peakContext = ptr(total)
			}
		}
	}
	var contextWindow int64
	if json.Unmarshal(info["model_context_window"], &contextWindow) == nil && contextWindow > 0 {
		b.contextWindow = ptr(contextWindow)
	}
	b.addTokenEvent(at, delta, contextTokens, b.contextWindow, QualityObserved)
}

func (b *builder) snapshotDelta(name string, value int64) *int64 {
	previous := b.tokenSnapshot[name]
	if value < previous {
		// Codex cumulative counters reset at compaction/turn boundaries. A new
		// segment contributes its complete value rather than a negative pulse.
		b.tokenSnapshot[name] = value
		return ptr(value)
	}
	b.tokenSnapshot[name] = value
	return ptr(value - previous)
}

func (b *builder) codexCompleted(at time.Time, payload map[string]json.RawMessage) {
	var item map[string]json.RawMessage
	if json.Unmarshal(payload["item"], &item) != nil {
		b.warnings = appendWarning(b.warnings, "item_completed_without_item")
		return
	}
	start, ok := unixMS(payload["started_at_ms"])
	if !ok {
		start = at
	}
	end, ok := unixMS(payload["completed_at_ms"])
	if !ok {
		end = at
	}
	turnID := stringField(payload, "turn_id")
	typ, id := stringField(item, "type"), stringField(item, "id")
	if b.model == "" {
		b.model = stringField(item, "model")
	}
	switch typ {
	case "UserMessage":
		content := contentText(item["content"])
		b.userTurnWithID(start, turnID, id, content)
	case "AgentMessage":
		b.assistantSeen = true
		b.phase(end, "response", false, false)
		b.addTrace(TraceEvent{ID: id, ParentID: b.parentForTurn(turnID), TurnID: turnID, Start: start, End: end, Type: "model", Name: "Agent response", Status: "ok", Model: b.model, Quality: QualityObserved, Output: contentText(item["content"])})
	case "Reasoning":
		b.assistantSeen = true
		b.phase(end, "reasoning", false, false)
		b.addTrace(TraceEvent{ID: id, ParentID: b.parentForTurn(turnID), TurnID: turnID, Start: start, End: end, Type: "model", Name: "Reasoning", Status: "ok", Model: b.model, Quality: QualityObserved, Output: rawText(item["summary_text"])})
	case "CommandExecution":
		name := "command_execution"
		failure, known, _ := toolOutcome(item)
		b.callWithTrace(start, name, id, rawText(item["command"]), QualityObserved)
		b.recordToolOutput(end, name, failure, known)
		b.resolveTool(end, id, failure, known, firstText(item["stderr"], item["aggregated_output"], item["formatted_output"], item["stdout"]))
		b.recordCanonicalSkill(item["command"], start, turnID)
	case "McpToolCall":
		server, tool := normalizeName(stringField(item, "server")), normalizeName(stringField(item, "tool"))
		name := server + "." + tool
		if server == "unknown" || tool == "unknown" {
			name = "mcp_tool"
		}
		failure, known, _ := toolOutcome(item)
		b.callWithTrace(start, name, id, rawText(item["arguments"]), QualityObserved)
		b.recordToolOutput(end, name, failure, known)
		b.resolveTool(end, id, failure, known, rawText(item["result"]))
	case "FileChange":
		b.callWithTrace(start, "file_change", id, rawText(item["changes"]), QualityObserved)
		failure, known, _ := toolOutcome(item)
		b.recordToolOutput(end, "file_change", failure, known)
		b.resolveTool(end, id, failure, known, firstText(item["stderr"], item["stdout"]))
	case "ContextCompaction":
		b.markCompaction(end)
		b.addTrace(TraceEvent{ID: id, ParentID: b.parentForTurn(turnID), TurnID: turnID, Start: start, End: end, Type: "compaction", Name: "Context compaction", Status: "ok", Quality: QualityObserved})
	case "SubAgentActivity":
		kind := stringField(item, "kind")
		if kind == "started" {
			b.subagents++
		}
		b.addTrace(TraceEvent{ID: id, ParentID: b.parentForTurn(turnID), TurnID: turnID, Start: start, End: end, Type: "subagent", Name: "Subagent " + kind, Status: "ok", Quality: QualityObserved, Metadata: map[string]string{"activity": kind}})
	default:
		b.addTrace(TraceEvent{ID: id, ParentID: b.parentForTurn(turnID), TurnID: turnID, Start: start, End: end, Type: "system", Name: typ, Status: "unknown", Quality: QualityObserved})
	}
}

func unixMS(raw json.RawMessage) (time.Time, bool) {
	value, ok := rawNonNegativeInt64(raw)
	// A zero epoch is how these logs spell "not recorded". Accepting it as a real
	// 1970 timestamp drags the session start back 56 years, which then
	// manufactures a multi-decade idle gap and poisons every duration aggregate.
	if !ok || value == 0 {
		return time.Time{}, false
	}
	return time.UnixMilli(value).UTC(), true
}

func contentText(raw json.RawMessage) string {
	var blocks []map[string]json.RawMessage
	if json.Unmarshal(raw, &blocks) != nil {
		return rawText(raw)
	}
	values := make([]string, 0, len(blocks))
	for _, block := range blocks {
		if text := stringField(block, "text"); text != "" {
			values = append(values, text)
		}
	}
	return strings.Join(values, "\n")
}

func firstString(raw map[string]json.RawMessage, keys ...string) string {
	for _, key := range keys {
		if value := stringField(raw, key); value != "" {
			return value
		}
	}
	return ""
}

func firstText(values ...json.RawMessage) string {
	for _, value := range values {
		if text := rawText(value); strings.TrimSpace(text) != "" && text != "null" {
			return text
		}
	}
	return ""
}

func (b *builder) claude(line []byte) {
	var raw map[string]json.RawMessage
	if json.Unmarshal(line, &raw) != nil {
		b.warnings = appendWarning(b.warnings, "malformed_json")
		return
	}
	at, ok := rawTime(raw["timestamp"])
	if !ok {
		b.warnings = appendWarning(b.warnings, "unknown_timestamp")
		return
	}
	b.observeTime(at)
	if b.sessionID == "" {
		b.sessionID = stringField(raw, "sessionId")
	}
	if b.agentID == "" {
		b.agentID = stringField(raw, "agentId")
	}
	b.setRootPath(stringField(raw, "cwd"))
	if stringField(raw, "type") == "system" && stringField(raw, "subtype") == "compact_boundary" {
		b.markCompaction(at)
	}
	if stringField(raw, "type") == "system" && isBranchFollowUp(stringField(raw, "subtype")) {
		b.signal("branch_follow_up", QualityInferred)
	}
	if boolField(raw, "isSidechain") {
		b.runKind = "subagent"
	}
	var message map[string]json.RawMessage
	if json.Unmarshal(raw["message"], &message) != nil {
		return
	}
	id := stringField(message, "id")
	role := stringField(message, "role")
	recordID := stringField(raw, "uuid")
	identity := id
	if identity == "" && role != "assistant" {
		identity = recordID
	}
	if identity == "" {
		b.claudeEventSequence++
		identity = fmt.Sprintf("event:%d", b.claudeEventSequence)
		if role == "assistant" {
			b.warnings = appendWarning(b.warnings, "claude_message_id_missing")
		}
	}
	messageKey := b.sessionID + "\x00" + b.agentID + "\x00" + identity
	if role != "assistant" {
		if b.seenMessages[messageKey] {
			return
		}
		b.seenMessages[messageKey] = true
	}
	if role == "user" {
		if !b.claudeToolResults(at, message["content"]) {
			b.userTurn(at, contentText(message["content"]))
		}
		return
	}
	if role != "assistant" {
		return
	}
	if b.model == "" {
		b.model = stringField(message, "model")
	}
	b.assistantSeen = true
	b.claudeUsage(at, messageKey, message["usage"])
	if !b.seenMessages[messageKey] {
		b.seenMessages[messageKey] = true
	}
	b.claudeAssistantBlocks(at, recordID, messageKey, message["content"])
	b.claudeToolUses(at, message["content"])
}

func (b *builder) claudeAssistantBlocks(at time.Time, recordID, messageKey string, raw json.RawMessage) {
	var blocks []map[string]json.RawMessage
	if json.Unmarshal(raw, &blocks) != nil {
		key := messageKey + "\x00scalar"
		if recordID != "" {
			key = recordID + "\x00scalar"
		}
		if !b.seenClaudeBlocks[key] {
			b.seenClaudeBlocks[key] = true
			b.addAgentResponse(at, b.currentTurnID, "", rawText(raw), QualityObserved)
		}
		return
	}
	for index, block := range blocks {
		typ := stringField(block, "type")
		key := fmt.Sprintf("%s\x00%s\x00%d", messageKey, typ, index)
		if recordID != "" {
			key = fmt.Sprintf("%s\x00%s\x00%d", recordID, typ, index)
		}
		if b.seenClaudeBlocks[key] {
			continue
		}
		switch typ {
		case "text":
			if text := stringField(block, "text"); text != "" {
				b.seenClaudeBlocks[key] = true
				b.addAgentResponse(at, b.currentTurnID, "", text, QualityObserved)
			}
		case "thinking", "redacted_thinking":
			b.seenClaudeBlocks[key] = true
			b.addReasoning(at, b.currentTurnID, "", QualityObserved)
		}
	}
}

func (b *builder) claudeUsage(at time.Time, messageKey string, raw json.RawMessage) {
	var usage map[string]json.RawMessage
	if json.Unmarshal(raw, &usage) != nil {
		return
	}
	if len(usage) == 0 {
		return
	}
	previous := b.claudeSnapshots[messageKey]
	if previous == nil {
		previous = map[string]int64{}
		b.claudeSnapshots[messageKey] = previous
	}
	delta := TokenUsage{}
	for _, item := range []struct {
		source string
		target **int64
		pulse  **int64
	}{{"input_tokens", &b.inputUncached, &delta.InputUncached}, {"cache_read_input_tokens", &b.cacheRead, &delta.CacheRead}, {"cache_creation_input_tokens", &b.cacheWrite, &delta.CacheWrite}, {"output_tokens", &b.output, &delta.Output}, {"reasoning_output_tokens", &b.reasoning, &delta.Reasoning}} {
		value, ok := rawNonNegativeInt64(usage[item.source])
		if !ok {
			continue
		}
		old, seen := previous[item.source]
		if !seen || value > old {
			increment := value
			if seen {
				increment = value - old
			}
			addObserved(item.target, increment)
			*item.pulse = ptr(increment)
			previous[item.source] = value
		}
	}
	b.addTokenEvent(at, delta, nil, nil, QualityDerived)
}

func (b *builder) claudeToolUses(at time.Time, raw json.RawMessage) {
	var blocks []map[string]json.RawMessage
	if json.Unmarshal(raw, &blocks) != nil {
		return
	}
	for _, block := range blocks {
		if stringField(block, "type") != "tool_use" {
			continue
		}
		b.callWithTrace(at, stringField(block, "name"), stringField(block, "id"), rawText(block["input"]), QualityDerived)
		if isSkillTool(stringField(block, "name")) {
			b.skills.Invoked[skillName(block["input"])]++
		}
	}
}

func (b *builder) claudeToolResults(at time.Time, raw json.RawMessage) bool {
	var blocks []map[string]json.RawMessage
	if json.Unmarshal(raw, &blocks) != nil || len(blocks) == 0 {
		return false
	}
	hadToolResult := false
	for _, block := range blocks {
		if stringField(block, "type") != "tool_result" {
			continue
		}
		hadToolResult = true
		id := stringField(block, "tool_use_id")
		if id == "" || b.seenOutputs[id] {
			continue
		}
		if name := b.seenCalls[id]; name != "" {
			b.seenOutputs[id] = true
			failure, _, interrupted := toolOutcome(block)
			known := true
			b.recordToolOutput(at, name, failure, known)
			b.resolveTool(at, id, failure, known, contentText(block["content"]))
			if interrupted {
				b.signal("interrupted", QualityInferred)
			}
		} else {
			b.warnings = appendWarning(b.warnings, "tool_result_without_call")
		}
	}
	return hadToolResult
}

func (b *builder) userTurn(at time.Time, content string) {
	b.userTurnWithID(at, "", "", content)
}

func (b *builder) userTurnWithID(at time.Time, turnID, eventID, content string) {
	newTurn := true
	if turnID != "" && b.canonicalMode {
		newTurn = !b.seenTurns[turnID]
		b.seenTurns[turnID] = true
	}
	b.addTurn(at, turnID, eventID, content)
	if newTurn {
		b.userTurns++
		if b.userTurns > 1 && b.assistantSeen {
			b.followUps++
		}
	}
	if b.userTurns > 1 && correctionWords.MatchString(content) {
		b.correction("user_correction", QualityInferred)
		b.addTrace(TraceEvent{ParentID: b.currentTurn, TurnID: b.currentTurnID, Start: at, End: at, Type: "correction", Name: "User correction candidate", Status: "ok", Quality: QualityHeuristic, Input: content, Metadata: map[string]string{"signal": "user_message_direction_change"}})
	}
	b.phase(at, "intake", false, false)
}

func (b *builder) call(at time.Time, name, id string) {
	b.callWithTrace(at, name, id, "", QualityDerived)
}

func (b *builder) callWithTrace(at time.Time, name, id, input string, quality QualityLevel) {
	name = normalizeName(name)
	if name == "" {
		name = "unknown"
	}
	if id != "" {
		if _, seen := b.seenCalls[id]; seen {
			return
		}
		b.seenCalls[id] = name
	}
	b.calls++
	stats := b.tools[name]
	stats.Calls++
	b.tools[name] = stats
	phase := classifyToolPhase(name)
	b.phase(at, phase, true, false)
	if phase == "verification" {
		b.verifications++
	}
	b.addTool(at, name, id, input, quality)
}

func (b *builder) outputEvent(at time.Time, id string, payload map[string]json.RawMessage) {
	if id == "" || b.seenOutputs[id] {
		return
	}
	name := b.seenCalls[id]
	if name == "" {
		return
	}
	b.seenOutputs[id] = true
	failure, known, interrupted := toolOutcome(payload)
	b.recordToolOutput(at, name, failure, known)
	b.resolveTool(at, id, failure, known, rawText(payload["output"]))
	if interrupted {
		b.signal("interrupted", QualityInferred)
	}
}

func (b *builder) resolveObservedTool(at time.Time, id string, payload map[string]json.RawMessage, output string, defaultKnown bool) {
	if id == "" || b.seenOutputs[id] {
		return
	}
	name := b.seenCalls[id]
	if name == "" {
		return
	}
	b.seenOutputs[id] = true
	failure, known, interrupted := toolOutcome(payload)
	if defaultKnown && !known {
		known = true
	}
	b.recordToolOutput(at, name, failure, known)
	b.resolveTool(at, id, failure, known, output)
	if interrupted {
		b.signal("interrupted", QualityInferred)
	}
}

func (b *builder) recordToolOutput(at time.Time, name string, failure, known bool) {
	if known {
		b.resolvedToolCalls++
	} else {
		b.unknownToolOutcome = true
	}
	if failure {
		b.failures++
		stats := b.tools[name]
		stats.Failures++
		b.tools[name] = stats
	}
	b.phase(at, classifyToolPhase(name), false, failure)
}

func toolOutcome(raw map[string]json.RawMessage) (failure, known, interrupted bool) {
	if exitCode, present := int64Field(raw, "exit_code"); present {
		return exitCode != 0, true, false
	}
	if isError, present := boolFieldPresent(raw, "is_error"); present {
		return isError, true, false
	}
	if success, present := boolFieldPresent(raw, "success"); present {
		return !success, true, false
	}
	if status, present := stringFieldPresent(raw, "status"); present {
		return statusOutcome(status)
	}
	var output map[string]json.RawMessage
	if json.Unmarshal(raw["output"], &output) == nil && output != nil {
		return toolOutcome(output)
	}
	var encodedOutput string
	if json.Unmarshal(raw["output"], &encodedOutput) == nil && json.Unmarshal([]byte(encodedOutput), &output) == nil && output != nil {
		return toolOutcome(output)
	}
	return false, false, false
}

func statusOutcome(status string) (failure, known, interrupted bool) {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "failed", "failure", "error":
		return true, true, false
	case "succeeded", "success", "completed", "ok":
		return false, true, false
	case "interrupted", "cancelled", "canceled", "aborted":
		return false, true, true
	default:
		return false, false, false
	}
}

func isBranchFollowUp(value string) bool {
	return value == "branch_follow_up" || value == "branch-follow-up"
}

func (b *builder) staticTools(at time.Time, arguments json.RawMessage, parentID string) int {
	matches := staticToolCall.FindAllStringSubmatch(rawText(arguments), -1)
	for index, match := range matches {
		b.call(at, normalizeName(match[1]), fmt.Sprintf("%s\x00nested:%d", parentID, index))
	}
	return len(matches)
}

func (b *builder) inferSkillFile(arguments json.RawMessage) string {
	names := b.inferSkillFiles(arguments)
	if len(names) > 0 {
		return names[0]
	}
	return ""
}

func (b *builder) inferSkillFiles(arguments json.RawMessage) []string {
	matches := skillFilePath.FindAllStringSubmatch(rawText(arguments), -1)
	names := make([]string, 0, len(matches))
	for _, match := range matches {
		if len(match) != 2 {
			continue
		}
		name := normalizeName(match[1])
		if name == "unknown" {
			continue
		}
		b.skills.Inferred[name]++
		names = append(names, name)
	}
	return names
}

func (b *builder) recordCanonicalSkill(arguments json.RawMessage, at time.Time, turnID string) {
	for _, name := range b.inferSkillFiles(arguments) {
		b.addTrace(TraceEvent{ParentID: b.parentForTurn(turnID), TurnID: turnID, Start: at, End: at, Type: "skill", Name: name, Skill: name, Status: "ok", Quality: QualityHeuristic, Metadata: map[string]string{"source": "command_path"}})
	}
}

func (b *builder) signal(kind string, quality QualityLevel) {
	value := b.signals[kind]
	value.Type, value.Quality = kind, quality
	value.Count++
	b.signals[kind] = value
}

func (b *builder) correction(kind string, quality QualityLevel) {
	b.signal(kind, quality)
	b.corrections++
}

func (b *builder) markCompaction(at time.Time) {
	for _, previous := range b.compactionTimes {
		if absDuration(at.Sub(previous)) <= 2*time.Minute {
			return
		}
	}
	b.compactionTimes = append(b.compactionTimes, at)
	b.compactions++
}

func absDuration(value time.Duration) time.Duration {
	if value < 0 {
		return -value
	}
	return value
}

func (b *builder) observeTime(at time.Time) {
	if b.started.IsZero() || at.Before(b.started) {
		b.started = at
	}
	if at.After(b.ended) {
		b.ended = at
	}
}

func (b *builder) setRootPath(root string) {
	if b.rootPath == "" && root != "" {
		b.rootPath = root
	}
}

func (b *builder) phase(at time.Time, name string, tool, failure bool) {
	b.phaseCounts[name]++
	b.phaseEvents = append(b.phaseEvents, phaseEvent{name, at, tool, failure})
}

func (b *builder) finish(source string) (Aggregate, bool) {
	if b.started.IsZero() || b.sessionID == "" {
		return Aggregate{}, false
	}
	root := fingerprintRoot(b.rootPath)
	reasoning := b.reasoning
	warnings := append([]string(nil), b.warnings...)
	reasoningInvalid := b.output != nil && reasoning != nil && *reasoning > *b.output
	if reasoningInvalid {
		reasoning = nil
		warnings = appendWarning(warnings, "reasoning_output_exceeds_output")
	}
	trace, activeMS, idleMS := b.finalTrace()
	aggregate := Aggregate{Provider: b.provider, Model: b.model, Project: projectName(b.rootPath), SourceRunKey: fingerprint(b.provider, b.runKind, b.sessionID, b.agentID), SourceSessionID: b.sessionID, RunKind: b.runKind, RootFingerprint: root, StartedAt: b.started, EndedAt: b.ended, ActiveDurationMS: activeMS, IdleDurationMS: idleMS, InputUncached: b.inputUncached, CacheRead: b.cacheRead, CacheWrite: b.cacheWrite, Output: b.output, ReasoningOutput: reasoning, TokenObserved: b.inputUncached != nil || b.cacheRead != nil || b.cacheWrite != nil || b.output != nil || b.reasoning != nil, PeakContextTokens: b.peakContext, ContextWindowTokens: b.contextWindow, UserTurnCount: b.userTurns, FollowUpCount: b.followUps, CorrectionCandidateCount: b.corrections, ToolCallCount: b.calls, ToolFailureCount: b.failures, VerificationCount: b.verifications, SubagentCount: b.subagents, CompactionCount: b.compactions, ToolCounts: b.tools, SkillActivity: b.skills, CorrectionSignals: b.sortedSignals(), PhaseCounts: b.phaseCounts, PhaseSequence: b.phaseSequence(), Trace: trace, Quality: b.quality(reasoningInvalid), ParseWarnings: warnings, ParserVersion: ParserVersion}
	_ = source // source is intentionally never returned; it exists only to make scan origin explicit.
	return aggregate, true
}

func projectName(root string) string {
	if root == "" {
		return ""
	}
	name := filepath.Base(filepath.Clean(root))
	if name == "." || name == string(filepath.Separator) {
		return ""
	}
	return name
}

func (b *builder) finalTrace() ([]TraceEvent, int64, int64) {
	trace := append([]TraceEvent(nil), b.trace...)
	sort.SliceStable(trace, func(i, j int) bool { return trace[i].Start.Before(trace[j].Start) })
	if len(trace) == 0 {
		return trace, b.ended.Sub(b.started).Milliseconds(), 0
	}
	withIdle := make([]TraceEvent, 0, len(trace)+8)
	previous := b.started
	var idleMS int64
	for _, event := range trace {
		if event.Start.Sub(previous) > idleGap {
			idle := TraceEvent{ID: b.nextEventID("idle"), Start: previous, End: event.Start, DurationMS: event.Start.Sub(previous).Milliseconds(), Type: "idle", Name: "No observed activity", Status: "unknown", Quality: QualityDerived}
			withIdle = append(withIdle, idle)
			idleMS += idle.DurationMS
		}
		withIdle = append(withIdle, event)
		if event.End.After(previous) {
			previous = event.End
		}
	}
	wall := maxInt64(0, b.ended.Sub(b.started).Milliseconds())
	return withIdle, maxInt64(0, wall-idleMS), idleMS
}

func (b *builder) sortedSignals() []CorrectionSignal {
	result := make([]CorrectionSignal, 0, len(b.signals))
	for _, signal := range b.signals {
		result = append(result, signal)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Type < result[j].Type })
	return result
}

func (b *builder) quality(reasoningInvalid bool) map[string]QualityLevel {
	quality := map[string]QualityLevel{"tokens": QualityUnknown, "inputTokens": QualityUnknown, "outputTokens": QualityUnknown, "context": QualityUnknown, "trajectory": QualityInferred, "corrections": QualityInferred, "tools": QualityDerived, "skills": QualityInferred}
	quality["reasoningTokens"] = QualityUnknown
	if b.reasoning != nil && !reasoningInvalid {
		quality["reasoningTokens"] = QualityDerived
	}
	quality["projectMapping"] = QualityUnknown
	if b.rootPath != "" {
		quality["projectMapping"] = QualityDerived
	}
	if b.calls > 0 && (!b.unknownToolOutcome && b.resolvedToolCalls == b.calls) {
		quality["tools"] = QualityDerived
	} else {
		quality["tools"] = QualityUnknown
	}
	if b.inputUncached != nil || b.cacheRead != nil || b.cacheWrite != nil || b.output != nil || b.reasoning != nil {
		quality["tokens"], quality["inputTokens"] = QualityDerived, QualityDerived
	}
	if (b.provider == "codex" || b.provider == "traex") && b.output != nil {
		quality["outputTokens"] = QualityExact
		quality["context"] = QualityExact
	}
	if b.provider == "claude" && b.output != nil {
		quality["outputTokens"] = QualityEstimated
		quality["context"] = QualityUnknown
	}
	return quality
}

func (b *builder) phaseSequence() []PhaseStep {
	if len(b.phaseEvents) == 0 {
		return []PhaseStep{}
	}
	result := make([]PhaseStep, 0, 20)
	var truncatedAt time.Time
	for _, event := range b.phaseEvents {
		if len(result) > 0 && result[len(result)-1].Phase == event.phase {
			step := &result[len(result)-1]
			step.EventCount++
			if event.tool {
				step.ToolCalls++
			}
			if event.failure {
				step.ToolFailures++
			}
			continue
		}
		if len(result) == cap(result) {
			result[len(result)-1].Truncated = true
			truncatedAt = event.at
			break
		}
		step := PhaseStep{Phase: event.phase, StartOffsetMS: event.at.Sub(b.started).Milliseconds(), EventCount: 1}
		if event.tool {
			step.ToolCalls++
		}
		if event.failure {
			step.ToolFailures++
		}
		result = append(result, step)
	}
	for i := range result {
		end := b.ended
		if i == len(result)-1 && !truncatedAt.IsZero() {
			end = truncatedAt
		}
		if i+1 < len(result) {
			end = b.started.Add(time.Duration(result[i+1].StartOffsetMS) * time.Millisecond)
		}
		result[i].DurationMS = maxInt64(0, end.Sub(b.started).Milliseconds()-result[i].StartOffsetMS)
	}
	return result
}

func rawTime(raw json.RawMessage) (time.Time, bool) {
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return time.Time{}, false
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	return parsed, err == nil
}
func stringField(raw map[string]json.RawMessage, key string) string {
	var value string
	_ = json.Unmarshal(raw[key], &value)
	return value
}
func stringFieldPresent(raw map[string]json.RawMessage, key string) (string, bool) {
	value, ok := raw[key]
	if !ok {
		return "", false
	}
	var result string
	if json.Unmarshal(value, &result) != nil {
		return "", false
	}
	return result, true
}
func boolField(raw map[string]json.RawMessage, key string) bool {
	var value bool
	_ = json.Unmarshal(raw[key], &value)
	return value
}
func boolFieldPresent(raw map[string]json.RawMessage, key string) (bool, bool) {
	value, ok := raw[key]
	if !ok {
		return false, false
	}
	var result bool
	if json.Unmarshal(value, &result) != nil {
		return false, false
	}
	return result, true
}
func int64Field(raw map[string]json.RawMessage, key string) (int64, bool) {
	value, ok := raw[key]
	if !ok {
		return 0, false
	}
	var result int64
	if json.Unmarshal(value, &result) != nil {
		return 0, false
	}
	return result, true
}
func rawNonNegativeInt64(raw json.RawMessage) (int64, bool) {
	var value int64
	if len(raw) == 0 || json.Unmarshal(raw, &value) != nil || value < 0 {
		return 0, false
	}
	return value, true
}
func observeMax(target **int64, value int64) {
	if *target == nil || value > **target {
		*target = ptr(value)
	}
}
func addObserved(target **int64, value int64) {
	if *target == nil {
		*target = ptr(value)
		return
	}
	**target += value
}
func rawText(raw json.RawMessage) string {
	var value string
	if json.Unmarshal(raw, &value) == nil {
		return value
	}
	return string(raw)
}
func ptr(value int64) *int64 { return &value }
func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}
func fingerprint(parts ...string) string {
	var material strings.Builder
	for _, part := range parts {
		fmt.Fprintf(&material, "%d:%s", len(part), part)
	}
	sum := sha256.Sum256([]byte(material.String()))
	return hex.EncodeToString(sum[:])
}

// fingerprintRoot intentionally mirrors service.fingerprintPath without retaining the root path.
func fingerprintRoot(root string) string {
	if root == "" {
		return ""
	}
	normalized := strings.ToLower(strings.TrimRight(root, "/"))
	sum := sha256.Sum256([]byte(normalized))
	return hex.EncodeToString(sum[:])
}
func normalizeName(name string) string {
	name = strings.ToLower(strings.TrimSpace(name))
	if len(name) == 0 || len(name) > 80 {
		return "unknown"
	}
	for i, char := range name {
		if !(char >= 'a' && char <= 'z' || char >= '0' && char <= '9' || strings.ContainsRune("_.:-", char)) || (i == 0 && !(char >= 'a' && char <= 'z' || char >= '0' && char <= '9')) {
			return "unknown"
		}
	}
	return name
}
func isExecTool(name string) bool {
	name = strings.ToLower(name)
	return strings.Contains(name, "exec") || strings.Contains(name, "command") || name == "shell"
}
func isSkillTool(name string) bool {
	name = strings.ToLower(name)
	return name == "skill" || name == "use_skill" || name == "load_skill"
}
func skillName(raw json.RawMessage) string {
	var input map[string]json.RawMessage
	if json.Unmarshal(raw, &input) == nil {
		for _, key := range []string{"skill", "name", "id"} {
			if name := stringField(input, key); name != "" {
				return normalizeName(name)
			}
		}
	}
	return "unknown"
}
func classifyToolPhase(name string) string {
	name = strings.ToLower(name)
	switch {
	case strings.Contains(name, "test"), strings.Contains(name, "lint"), strings.Contains(name, "verify"), strings.Contains(name, "check"):
		return "verification"
	case strings.Contains(name, "read"), strings.Contains(name, "search"), strings.Contains(name, "find"), strings.Contains(name, "list"), strings.Contains(name, "rg"):
		return "exploration"
	default:
		return "execution"
	}
}
func appendWarning(warnings []string, value string) []string {
	for _, warning := range warnings {
		if warning == value {
			return warnings
		}
	}
	return append(warnings, value)
}
