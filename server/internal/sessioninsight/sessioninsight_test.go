package sessioninsight

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestScanAggregatesCanonicalSourcesWithoutContent(t *testing.T) {
	root := filepath.Join("testdata")
	result, err := Scan(context.Background(), ScanOptions{
		CodexRoot:  filepath.Join(root, "codex"),
		ClaudeRoot: filepath.Join(root, "claude"),
		TraeRoot:   filepath.Join(root, "traex"),
		Days:       7,
		Now:        time.Date(2026, 8, 30, 13, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.FilesScanned != 6 {
		t.Fatalf("FilesScanned = %d, want 6", result.FilesScanned)
	}
	if len(result.Runs) != 6 {
		t.Fatalf("runs = %d, want 6", len(result.Runs))
	}

	modern := findRun(t, result.Runs, "codex", "codex-modern-root")
	if value(modern.InputUncached) != 230 || value(modern.CacheRead) != 70 || value(modern.CacheWrite) != 3 || value(modern.Output) != 30 || value(modern.ReasoningOutput) != 12 {
		t.Fatalf("codex cumulative tokens = %+v", modern)
	}
	if modern.ContextWindowTokens == nil || *modern.ContextWindowTokens != 200 {
		t.Fatalf("context window = %v", modern.ContextWindowTokens)
	}
	if modern.PeakContextTokens == nil || *modern.PeakContextTokens != 228 {
		t.Fatalf("peak context = %v, want last_token_usage peak", modern.PeakContextTokens)
	}
	if modern.RootFingerprint != "c13e33cbddbb6410c5e95897e67842dff9c30a0803ead8a7fbcd14f6368b9c80" {
		t.Fatalf("cross-platform root fingerprint = %q", modern.RootFingerprint)
	}
	if modern.CompactionCount != 1 {
		t.Fatalf("codex compactions = %d", modern.CompactionCount)
	}
	if modern.ToolCallCount != 2 || modern.ToolFailureCount != 0 || modern.ToolCounts["imagegen"].Calls != 1 {
		t.Fatalf("codex tools = %+v skills = %+v", modern.ToolCounts, modern.SkillActivity)
	}
	if modern.CorrectionCandidateCount != 1 || modern.FollowUpCount != 1 {
		t.Fatalf("codex corrections = %+v", modern.CorrectionSignals)
	}
	if modern.Quality["outputTokens"] != QualityExact {
		t.Fatalf("codex output quality = %q", modern.Quality["outputTokens"])
	}

	claude := findRun(t, result.Runs, "claude", "claude-root", "main")
	if claude.RunKind != "main" || value(claude.InputUncached) != 100 || value(claude.CacheRead) != 20 || value(claude.CacheWrite) != 5 || value(claude.Output) != 40 {
		t.Fatalf("claude tokens = %+v", claude)
	}
	if claude.ToolCallCount != 2 || claude.ToolFailureCount != 1 || claude.SkillActivity.Invoked["pdf"] != 1 {
		t.Fatalf("claude tools = %+v skills = %+v", claude.ToolCounts, claude.SkillActivity)
	}
	if claude.UserTurnCount != 1 || claude.FollowUpCount != 0 || claude.CorrectionCandidateCount != 0 {
		t.Fatalf("tool result was counted as user correction: %+v", claude)
	}
	if claude.Quality["outputTokens"] != QualityEstimated {
		t.Fatalf("claude output quality = %q", claude.Quality["outputTokens"])
	}
	if claude.SubagentCount != 1 {
		t.Fatalf("claude subagent count = %d, want 1", claude.SubagentCount)
	}
	if claude.RootFingerprint != "287cbd68180349b87872d72b7aecfef298c61e9767cce35df08cc33e8e3c2c64" || claude.CompactionCount != 1 {
		t.Fatalf("claude root/compactions = %q/%d", claude.RootFingerprint, claude.CompactionCount)
	}
	if len(claude.ParseWarnings) == 0 {
		t.Fatal("expected malformed input warning")
	}

	subagent := findRun(t, result.Runs, "claude", "claude-root", "subagent")
	if subagent.RunKind != "subagent" || subagent.SourceRunKey == claude.SourceRunKey || subagent.RootFingerprint != claude.RootFingerprint {
		t.Fatalf("subagent identity = %+v", subagent)
	}
	legacy := findRun(t, result.Runs, "codex", "codex-legacy-root")
	if legacy.RootFingerprint != "" || legacy.Quality["projectMapping"] != QualityUnknown {
		t.Fatalf("missing root handling = %+v", legacy)
	}

	traex := findRun(t, result.Runs, "traex", "traex-modern-root")
	if traex.Model != "traex-test" || traex.UserTurnCount != 1 || traex.ToolCallCount != 1 || traex.SubagentCount != 1 || traex.CompactionCount != 1 {
		t.Fatalf("traex modern aggregate = %+v", traex)
	}
	if value(traex.CacheWrite) != 7 || traex.CorrectionSignals[0].Type != "rollback" {
		t.Fatalf("traex tokens/rollback = %+v", traex)
	}
	assertTraceNames(t, traex.Trace, "User message", "Agent response", "Reasoning", "exec_command", "Subagent started", "Subagent final answer", "Context replacement", "History rollback")
	traexLegacy := findRun(t, result.Runs, "traex", "traex-legacy-root")
	if traexLegacy.ToolCallCount != 1 || traexLegacy.UserTurnCount != 1 {
		t.Fatalf("traex legacy aggregate = %+v", traexLegacy)
	}
	assertTraceNames(t, traexLegacy.Trace, "User message", "Agent response", "read")

	// Trace records deliberately retain bounded local excerpts for the event
	// drawer, but never an unbounded transcript or the original working path.
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"C:/Work/Repo", "/Users/Example/Project"} {
		if strings.Contains(string(encoded), path) {
			t.Fatalf("trace leaked project path %q", path)
		}
	}
	for _, run := range result.Runs {
		for _, event := range run.Trace {
			for _, excerpt := range []string{event.Input, event.Output, event.Error} {
				if len(excerpt) > maxTraceExcerptBytes+len("…") {
					t.Fatalf("unbounded trace excerpt: %d", len(excerpt))
				}
			}
		}
	}
}

func TestFollowUpsAreNotCorrectionCandidates(t *testing.T) {
	b := newBuilder("codex", "main")
	first := time.Date(2026, 8, 30, 10, 0, 0, 0, time.UTC)
	b.userTurn(first, "please explain")
	b.assistantSeen = true
	b.userTurn(first.Add(time.Second), "please explain that again")
	if b.followUps != 1 || b.corrections != 0 || len(b.signals) != 0 {
		t.Fatalf("ordinary follow-up became a correction: followups=%d corrections=%d signals=%v", b.followUps, b.corrections, b.signals)
	}
	b.userTurn(first.Add(2*time.Second), "instead, rollback the last change")
	if b.followUps != 2 || b.corrections != 1 || b.signals["user_correction"].Count != 1 {
		t.Fatalf("explicit correction was not preserved: followups=%d corrections=%d signals=%v", b.followUps, b.corrections, b.signals)
	}
}

func TestStructuredBranchFollowUpIsCorrectionCandidate(t *testing.T) {
	b := newBuilder("codex", "main")
	b.codex([]byte(`{"timestamp":"2026-08-30T10:00:00Z","type":"session_meta","payload":{"id":"session"}}`))
	b.codex([]byte(`{"timestamp":"2026-08-30T10:00:01Z","type":"event_msg","payload":{"type":"branch_follow_up"}}`))
	if b.corrections != 0 || b.signals["branch_follow_up"].Count != 1 {
		t.Fatalf("structured branch follow-up became a correction candidate: %+v", b.signals)
	}
}

func TestToolFailureRequiresStructuredOutcome(t *testing.T) {
	textOnly := map[string]json.RawMessage{"output": json.RawMessage(`"0 failed"`)}
	if failure, known, interrupted := toolOutcome(textOnly); failure || known || interrupted {
		t.Fatalf("text output was treated as structured failure: failure=%t known=%t interrupted=%t", failure, known, interrupted)
	}
	failed := map[string]json.RawMessage{"status": json.RawMessage(`"failed"`)}
	if failure, known, interrupted := toolOutcome(failed); !failure || !known || interrupted {
		t.Fatalf("failed status was not recognized: failure=%t known=%t interrupted=%t", failure, known, interrupted)
	}
	interruptedResult := map[string]json.RawMessage{"output": json.RawMessage(`{"status":"interrupted"}`)}
	if failure, known, interrupted := toolOutcome(interruptedResult); failure || !known || !interrupted {
		t.Fatalf("interrupted status was not recognized: failure=%t known=%t interrupted=%t", failure, known, interrupted)
	}
	unsuccessful := map[string]json.RawMessage{"success": json.RawMessage(`false`)}
	if failure, known, interrupted := toolOutcome(unsuccessful); !failure || !known || interrupted {
		t.Fatalf("false success flag was not recognized: failure=%t known=%t interrupted=%t", failure, known, interrupted)
	}
}

func TestToolResultBeforeCallTimestampDoesNotProduceNegativeSpan(t *testing.T) {
	b := newBuilder("traex", "main")
	start := time.Date(2026, 8, 30, 10, 0, 1, 0, time.UTC)
	b.callWithTrace(start, "read", "call", "", QualityObserved)
	b.resolveTool(start.Add(-time.Second), "call", false, true, "done")
	event := b.trace[b.toolEventByCall["call"]]
	if event.End.Before(event.Start) || event.DurationMS != 0 {
		t.Fatalf("negative tool span = %+v", event)
	}
}

func TestCanonicalMissingStatusStaysUnknownAndUserEventsHaveUniqueIDs(t *testing.T) {
	b := newBuilder("codex", "main")
	b.codex([]byte(`{"timestamp":"2026-08-30T10:00:00Z","type":"session_meta","payload":{"id":"session"}}`))
	b.codex([]byte(`{"timestamp":"2026-08-30T10:00:01Z","type":"event_msg","payload":{"type":"item_completed","turn_id":"turn","item":{"type":"UserMessage","id":"user-one","content":[{"text":"first"}]},"started_at_ms":1788084001000,"completed_at_ms":1788084001000}}`))
	b.codex([]byte(`{"timestamp":"2026-08-30T10:00:02Z","type":"event_msg","payload":{"type":"item_completed","turn_id":"turn","item":{"type":"UserMessage","id":"user-two","content":[{"text":"second"}]},"started_at_ms":1788084002000,"completed_at_ms":1788084002000}}`))
	b.codex([]byte(`{"timestamp":"2026-08-30T10:00:03Z","type":"event_msg","payload":{"type":"item_completed","turn_id":"turn","item":{"type":"CommandExecution","id":"command","command":["echo","x"]},"started_at_ms":1788084003000,"completed_at_ms":1788084003000}}`))
	run, ok := b.finish("test")
	if !ok || run.UserTurnCount != 1 {
		t.Fatalf("canonical turn count = %+v", run)
	}
	ids := map[string]bool{}
	unknown := false
	secondParent, commandParent := "", ""
	for _, event := range run.Trace {
		if ids[event.ID] {
			t.Fatalf("duplicate ID %q", event.ID)
		}
		ids[event.ID] = true
		unknown = unknown || (event.Tool == "command_execution" && event.Status == "unknown")
		if event.ID == "user-two" {
			secondParent = event.ParentID
		}
		if event.Tool == "command_execution" {
			commandParent = event.ParentID
		}
	}
	for _, event := range run.Trace {
		if event.ParentID != "" && !ids[event.ParentID] {
			t.Fatalf("orphan parent %q for event %q", event.ParentID, event.ID)
		}
		if event.ParentID == event.ID {
			t.Fatalf("self-referential parent %q", event.ID)
		}
	}
	if !unknown || secondParent != "user-one" || commandParent != "user-one" {
		t.Fatalf("missing canonical status became success: %+v", run.Trace)
	}
}

func TestSourceRunKeySeparatesKindsWithoutAgentID(t *testing.T) {
	main := fingerprint("codex", "main", "same-session", "")
	subagent := fingerprint("codex", "subagent", "same-session", "")
	if main == subagent {
		t.Fatal("main and subagent source keys collided without agent ID")
	}
}

func TestClaudeProgressiveSnapshotsUseMaximumUsageAndNewTools(t *testing.T) {
	b := newBuilder("claude", "main")
	b.claude([]byte(`{"timestamp":"2026-08-30T10:00:00Z","sessionId":"root","agentId":"agent","message":{"id":"message","role":"assistant","usage":{"input_tokens":10,"output_tokens":2},"content":[{"type":"tool_use","id":"one","name":"Read","input":{}}]}}`))
	b.claude([]byte(`{"timestamp":"2026-08-30T10:00:01Z","sessionId":"root","agentId":"agent","message":{"id":"message","role":"assistant","usage":{"input_tokens":25,"output_tokens":7},"content":[{"type":"tool_use","id":"one","name":"Read","input":{}},{"type":"tool_use","id":"two","name":"Bash","input":{}}]}}`))
	run, ok := b.finish("test")
	if !ok || value(run.InputUncached) != 25 || value(run.Output) != 7 || run.ToolCallCount != 2 {
		t.Fatalf("progressive snapshot aggregate = %+v", run)
	}
}

func TestClaudeMessagesWithoutIDDoNotShareSnapshotState(t *testing.T) {
	b := newBuilder("claude", "main")
	b.claude([]byte(`{"timestamp":"2026-08-30T10:00:00Z","sessionId":"root","agentId":"agent","message":{"role":"assistant","usage":{"output_tokens":10},"content":[]}}`))
	b.claude([]byte(`{"timestamp":"2026-08-30T10:00:01Z","sessionId":"root","agentId":"agent","message":{"role":"assistant","usage":{"output_tokens":20},"content":[]}}`))
	run, ok := b.finish("test")
	if !ok || value(run.Output) != 30 || !contains(run.ParseWarnings, "claude_message_id_missing") {
		t.Fatalf("missing-id snapshots were merged: %+v", run)
	}
}

func TestClaudeMultimodalUserMessageKeepsOnlyText(t *testing.T) {
	b := newBuilder("claude", "main")
	b.claude([]byte(`{"timestamp":"2026-08-30T10:00:00Z","sessionId":"root","agentId":"agent","message":{"id":"user","role":"user","content":[{"type":"text","text":"redesign this page"},{"type":"image","source":{"type":"base64","data":"PRIVATE_IMAGE_DATA"}}]}}`))
	run, ok := b.finish("test")
	if !ok || len(run.Trace) != 1 || run.Trace[0].Input != "redesign this page" {
		t.Fatalf("multimodal user content = %+v", run.Trace)
	}
}

func TestClaudeAssistantBlocksBecomeConversationTrace(t *testing.T) {
	b := newBuilder("claude", "main")
	b.claude([]byte(`{"uuid":"user-record","timestamp":"2026-08-30T10:00:00Z","sessionId":"root","agentId":"agent","message":{"role":"user","content":"request"}}`))
	b.claude([]byte(`{"uuid":"thinking-record","timestamp":"2026-08-30T10:00:01Z","sessionId":"root","agentId":"agent","message":{"id":"assistant","role":"assistant","model":"claude-test","content":[{"type":"thinking","thinking":"PRIVATE_REASONING"}]}}`))
	b.claude([]byte(`{"uuid":"text-record","timestamp":"2026-08-30T10:00:02Z","sessionId":"root","agentId":"agent","message":{"id":"assistant","role":"assistant","model":"claude-test","content":[{"type":"text","text":"answer"}]}}`))
	b.claude([]byte(`{"uuid":"text-record","timestamp":"2026-08-30T10:00:02Z","sessionId":"root","agentId":"agent","message":{"id":"assistant","role":"assistant","model":"claude-test","content":[{"type":"text","text":"answer"}]}}`))
	run, ok := b.finish("test")
	if !ok || run.Model != "claude-test" || contains(run.ParseWarnings, "claude_message_id_missing") {
		t.Fatalf("claude assistant identity = %+v", run)
	}
	var user, reasoning, response *TraceEvent
	for index := range run.Trace {
		event := &run.Trace[index]
		switch event.Name {
		case "User message":
			user = event
		case "Reasoning":
			if reasoning != nil {
				t.Fatal("duplicate reasoning trace")
			}
			reasoning = event
		case "Agent response":
			if response != nil {
				t.Fatal("duplicate agent response trace")
			}
			response = event
		}
	}
	if user == nil || reasoning == nil || response == nil || response.Output != "answer" {
		t.Fatalf("claude conversation trace = %+v", run.Trace)
	}
	if reasoning.Output != "" || reasoning.ParentID != user.ID || response.ParentID != user.ID {
		t.Fatalf("claude trace relation/redaction = user=%+v reasoning=%+v response=%+v", user, reasoning, response)
	}
}

func TestTraeXEventsUseCodexTraceContract(t *testing.T) {
	b := newBuilder("traex", "main")
	b.codex([]byte(`{"timestamp":"2026-08-30T10:00:00Z","type":"session_meta","payload":{"id":"trae-session","cwd":"/tmp/project","model_provider":"trae","source":{"subagent":{"thread_spawn":{"parent_thread_id":"parent"}}}}}`))
	b.codex([]byte(`{"timestamp":"2026-08-30T10:00:01Z","type":"event_msg","payload":{"type":"user_message","message":"request"}}`))
	b.codex([]byte(`{"timestamp":"2026-08-30T10:00:02Z","type":"event_msg","payload":{"type":"agent_reasoning_raw_content","text":"PRIVATE_REASONING"}}`))
	b.codex([]byte(`{"timestamp":"2026-08-30T10:00:03Z","type":"event_msg","payload":{"type":"agent_message","message":"answer"}}`))
	b.codex([]byte(`{"timestamp":"2026-08-30T10:00:04Z","type":"history_mutation","payload":{"operation":"append","turn_id":"turn","items":[{"type":"function_call","name":"read","call_id":"call","arguments":"{}"}]}}`))
	b.codex([]byte(`{"timestamp":"2026-08-30T10:00:05Z","type":"history_mutation","payload":{"operation":"append","turn_id":"turn","items":[{"type":"function_call_output","call_id":"call","output":"done"}]}}`))
	b.codex([]byte(`{"timestamp":"2026-08-30T10:00:06Z","type":"event_msg","payload":{"type":"sub_agent_activity","event_id":"subagent","kind":"started"}}`))
	b.codex([]byte(`{"timestamp":"2026-08-30T10:00:07Z","type":"inter_agent_communication","payload":{"kind":"final_answer"}}`))
	run, ok := b.finish("test")
	if !ok || run.Provider != "traex" || run.RunKind != "subagent" || run.UserTurnCount != 1 || run.ToolCallCount != 1 || run.SubagentCount != 1 {
		t.Fatalf("traex aggregate = %+v", run)
	}
	names := map[string]*TraceEvent{}
	for index := range run.Trace {
		names[run.Trace[index].Name] = &run.Trace[index]
	}
	if names["Agent response"] == nil || names["Agent response"].Output != "answer" || names["Reasoning"] == nil || names["Reasoning"].Output != "" {
		t.Fatalf("traex agent trace = %+v", run.Trace)
	}
	if names["read"] == nil || names["read"].Status != "ok" || names["Subagent started"] == nil || names["Subagent final answer"] == nil {
		t.Fatalf("traex tool/subagent trace = %+v", run.Trace)
	}
}

func assertTraceNames(t *testing.T, trace []TraceEvent, expected ...string) {
	t.Helper()
	names := map[string]bool{}
	for _, event := range trace {
		names[event.Name] = true
	}
	for _, name := range expected {
		if !names[name] {
			t.Fatalf("missing trace %q in %+v", name, trace)
		}
	}
}

func TestCodexCustomExecReadsInputAndNormalizesNames(t *testing.T) {
	b := newBuilder("codex", "main")
	b.codex([]byte(`{"timestamp":"2026-08-30T10:00:00Z","type":"session_meta","payload":{"id":"session"}}`))
	b.codex([]byte(`{"timestamp":"2026-08-30T10:00:01Z","type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"call","input":"tools.valid_tool(\u0029; tools.verylongtoolname(\u0029"}}`))
	if b.tools["valid_tool"].Calls != 1 || b.tools["exec"].Calls != 0 || b.calls != 2 || b.skills.Attributed["valid_tool"] != 0 {
		t.Fatalf("custom exec static analysis = tools=%+v skills=%+v", b.tools, b.skills)
	}
	if normalizeName("bad name") != "unknown" || normalizeName(strings.Repeat("x", 81)) != "unknown" {
		t.Fatal("unsafe names were not normalized")
	}
}

func TestCodexCompactionFormsAreDeduplicated(t *testing.T) {
	b := newBuilder("codex", "main")
	b.codex([]byte(`{"timestamp":"2026-08-30T10:00:00Z","type":"compacted"}`))
	b.codex([]byte(`{"timestamp":"2026-08-30T10:00:00Z","type":"event_msg","payload":{"type":"compaction"}}`))
	if b.compactions != 1 {
		t.Fatalf("compaction forms were double counted: %d", b.compactions)
	}
}

func TestReasoningOutputCannotExceedOutput(t *testing.T) {
	for _, provider := range []string{"codex", "claude"} {
		b := newBuilder(provider, "main")
		b.sessionID = provider + "-session"
		b.started = time.Date(2026, 8, 30, 10, 0, 0, 0, time.UTC)
		b.ended = b.started
		b.output, b.reasoning = ptr(10), ptr(100)
		run, ok := b.finish("test")
		if !ok || value(run.Output) != 10 || run.ReasoningOutput != nil || run.Quality["reasoningTokens"] != QualityUnknown || !contains(run.ParseWarnings, "reasoning_output_exceeds_output") {
			t.Fatalf("%s contradictory reasoning was accepted: %+v", provider, run)
		}
	}
}

func TestReasoningOutputWithinOutputIsPreserved(t *testing.T) {
	b := newBuilder("codex", "main")
	b.sessionID = "normal"
	b.started = time.Date(2026, 8, 30, 10, 0, 0, 0, time.UTC)
	b.ended = b.started
	b.output, b.reasoning = ptr(100), ptr(100)
	run, _ := b.finish("test")
	if value(run.ReasoningOutput) != 100 || run.Quality["reasoningTokens"] == QualityUnknown {
		t.Fatalf("equal reasoning was dropped: %+v", run)
	}
	b.reasoning = ptr(10)
	run, _ = b.finish("test")
	if value(run.ReasoningOutput) != 10 {
		t.Fatalf("smaller reasoning was dropped: %+v", run)
	}
}

// The large fixture stands in for a real multi-hour Codex run. It is checked
// into testdata so this runs everywhere; it used to read one contributor's
// private session from an absolute path, which meant CI always skipped it.
const largeCodexFixtureEvents = 1015

func TestLargeCodexSessionTraceReconciles(t *testing.T) {
	path := filepath.Join("testdata", "codex-large", "session.jsonl")
	b := newBuilder("codex", "main")
	if err := streamJSONL(context.Background(), path, defaultMaxLineBytes, b.codex, &b.warnings); err != nil {
		t.Fatal(err)
	}
	run, ok := b.finish("reference")
	if !ok {
		t.Fatal("reference session did not parse")
	}
	tracked := value(run.InputUncached) + value(run.CacheRead) + value(run.CacheWrite) + value(run.Output)
	var pulseTracked int64
	ids := map[string]bool{}
	unknownTools := 0
	skillCalls := 0
	pulses, contextPulses := 0, 0
	for _, event := range run.Trace {
		if ids[event.ID] {
			t.Fatalf("duplicate trace event id %q", event.ID)
		}
		ids[event.ID] = true
		pulseTracked += tokenValue(event.Tokens.InputUncached) + tokenValue(event.Tokens.CacheRead) + tokenValue(event.Tokens.CacheWrite) + tokenValue(event.Tokens.Output)
		if event.Name == "Token pulse" {
			pulses++
			if event.Context != nil && event.ContextLimit != nil {
				contextPulses++
			}
		}
		if (event.Type == "tool" || event.Type == "verification") && event.Status == "unknown" {
			unknownTools++
		}
	}
	for _, event := range run.Trace {
		if event.ParentID != "" && !ids[event.ParentID] {
			t.Fatalf("orphan parent %q for event %q", event.ParentID, event.ID)
		}
		if event.ParentID == event.ID {
			t.Fatalf("self-referential parent %q", event.ID)
		}
	}
	for _, count := range run.SkillActivity.Inferred {
		skillCalls += count
	}
	t.Logf("events=%d uniqueIDs=%d wall=%s active=%s idle=%s tracked=%d failures=%d unknownTools=%d tools=%d skills=%d/%d pulses=%d contextPulses=%d compactions=%d corrections=%d subagents=%d", len(run.Trace), len(ids), run.EndedAt.Sub(run.StartedAt), time.Duration(run.ActiveDurationMS)*time.Millisecond, time.Duration(run.IdleDurationMS)*time.Millisecond, tracked, run.ToolFailureCount, unknownTools, run.ToolCallCount, skillCalls, len(run.SkillActivity.Inferred), pulses, contextPulses, run.CompactionCount, run.CorrectionCandidateCount, run.SubagentCount)
	if len(run.Trace) != largeCodexFixtureEvents {
		t.Fatalf("trace event count = %d, want %d", len(run.Trace), largeCodexFixtureEvents)
	}
	if run.UserTurnCount != 24 || run.ToolCallCount != 385 || run.ToolFailureCount != 3 || run.SubagentCount != 1 || run.CorrectionCandidateCount == 0 {
		t.Fatalf("activity counts = turns=%d tools=%d failures=%d corrections=%d subagents=%d", run.UserTurnCount, run.ToolCallCount, run.ToolFailureCount, run.CorrectionCandidateCount, run.SubagentCount)
	}
	if pulses != 270 || contextPulses != pulses {
		t.Fatalf("pulse coverage = pulses=%d context=%d", pulses, contextPulses)
	}
	if unknownTools != 0 {
		t.Fatalf("every tool call in the fixture reports an outcome, got %d unknown", unknownTools)
	}
	// tracked = (input − cached) + cached + cacheWrite + output, so the cached
	// component cancels and only input + cacheWrite + output set the total.
	if tracked != 24_044_000 {
		t.Fatalf("token total = %d", tracked)
	}
	if pulseTracked != tracked {
		t.Fatalf("token pulses do not reconcile: pulses=%d aggregate=%d", pulseTracked, tracked)
	}
	if run.IdleDurationMS <= 0 || run.ActiveDurationMS+run.IdleDurationMS != run.EndedAt.Sub(run.StartedAt).Milliseconds() {
		t.Fatalf("wall/active/idle do not reconcile: %+v", run)
	}
	if value(run.PeakContextTokens) != 360_000 || value(run.ContextWindowTokens) != 400_000 {
		t.Fatalf("context = %d/%d", value(run.PeakContextTokens), value(run.ContextWindowTokens))
	}
}

func TestTraceContractCoversToolOutcomesTokensContextIdleAndCorrection(t *testing.T) {
	result, err := Scan(context.Background(), ScanOptions{CodexRoot: filepath.Join("testdata", "codex"), ClaudeRoot: filepath.Join("testdata", "claude"), Now: time.Date(2026, 8, 30, 13, 0, 0, 0, time.UTC)})
	if err != nil {
		t.Fatal(err)
	}
	codex := findRun(t, result.Runs, "codex", "codex-modern-root")
	var pulseTotal, pulseReasoning int64
	hasCorrection, hasIdle := false, false
	for _, event := range codex.Trace {
		pulseTotal += tokenValue(event.Tokens.InputUncached) + tokenValue(event.Tokens.CacheRead) + tokenValue(event.Tokens.CacheWrite) + tokenValue(event.Tokens.Output)
		pulseReasoning += tokenValue(event.Tokens.Reasoning)
		hasCorrection = hasCorrection || event.Type == "correction"
		hasIdle = hasIdle || event.Type == "idle"
	}
	if pulseTotal != value(codex.InputUncached)+value(codex.CacheRead)+value(codex.CacheWrite)+value(codex.Output) || pulseReasoning != value(codex.ReasoningOutput) {
		t.Fatalf("token pulse does not reconcile: total=%d reasoning=%d aggregate=%+v", pulseTotal, pulseReasoning, codex)
	}
	if !hasCorrection || !hasIdle || codex.IdleDurationMS == 0 || value(codex.PeakContextTokens) != 228 || value(codex.ContextWindowTokens) != 200 {
		t.Fatalf("missing correction/idle/context trace: %+v", codex)
	}
	claude := findRun(t, result.Runs, "claude", "claude-root", "main")
	status := map[string]string{}
	for _, event := range claude.Trace {
		if event.Type == "tool" || event.Type == "skill" {
			status[event.Tool] = event.Status
		}
	}
	if status["bash"] != "error" || status["skill"] != "unknown" {
		t.Fatalf("tool outcomes = %+v", status)
	}
}

func TestScanStreamsLegalLargeLinesAndSkipsOverLimit(t *testing.T) {
	dir := t.TempDir()
	codex := filepath.Join(dir, "codex", "sessions")
	if err := os.MkdirAll(codex, 0o755); err != nil {
		t.Fatal(err)
	}
	large := strings.Repeat("x", 70*1024)
	content := "{\"timestamp\":\"2026-08-30T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"large\"}}\n" +
		"{\"timestamp\":\"2026-08-30T10:00:00Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"small\"}}\n" +
		"{\"timestamp\":\"2026-08-30T10:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"" + large + "\"}}\n"
	if err := os.WriteFile(filepath.Join(codex, "large.jsonl"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := Scan(context.Background(), ScanOptions{CodexRoot: filepath.Join(dir, "codex"), ClaudeRoot: filepath.Join(dir, "claude"), Days: 7, Now: time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC), MaxLineBytes: 128 * 1024})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Runs) != 1 || result.Runs[0].UserTurnCount != 2 {
		t.Fatalf("large legal line was not parsed: %+v", result)
	}
	result, err = Scan(context.Background(), ScanOptions{CodexRoot: filepath.Join(dir, "codex"), ClaudeRoot: filepath.Join(dir, "claude"), Days: 7, Now: time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC), MaxLineBytes: 64 * 1024})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Runs) != 1 || !contains(result.Runs[0].ParseWarnings, "line_too_long") {
		t.Fatalf("oversize warning = %+v", result)
	}
}

func TestScanPrioritizesRecentFilesBeforeApplyingLimit(t *testing.T) {
	dir := t.TempDir()
	sessions := filepath.Join(dir, "codex", "sessions")
	if err := os.MkdirAll(sessions, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(name, id string) string {
		path := filepath.Join(sessions, name)
		line := `{"timestamp":"2026-08-30T11:00:00Z","type":"session_meta","payload":{"id":"` + id + `"}}` + "\n" + `{"timestamp":"2026-08-30T11:00:01Z","type":"event_msg","payload":{"type":"user_message","message":"x"}}` + "\n"
		if err := os.WriteFile(path, []byte(line), 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	old := write("000-old.jsonl", "old")
	_ = write("999-recent.jsonl", "recent")
	if err := os.Chtimes(old, time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC), time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
	result, err := Scan(context.Background(), ScanOptions{CodexRoot: filepath.Join(dir, "codex"), ClaudeRoot: filepath.Join(dir, "claude"), Days: 7, MaxFiles: 1, Now: time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Runs) != 1 || result.Runs[0].SourceSessionID != "recent" || result.FilesScanned != 1 || result.FilesSkipped != 1 {
		t.Fatalf("recent candidate was starved by old files: %+v", result)
	}
}

func TestScanSharesRecentCandidateBudgetAcrossRootsAndProviders(t *testing.T) {
	dir := t.TempDir()
	write := func(path, line string, modified time.Time) {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(line), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, modified, modified); err != nil {
			t.Fatal(err)
		}
	}
	old := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	middle := old.Add(24 * time.Hour)
	recent := middle.Add(24 * time.Hour)
	write(filepath.Join(dir, "codex", "sessions", "old.jsonl"), "{\"timestamp\":\"2026-08-30T11:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"live\"}}\n{\"timestamp\":\"2026-08-30T11:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"x\"}}\n", old)
	write(filepath.Join(dir, "codex", "archived_sessions", "middle.jsonl"), "{\"timestamp\":\"2026-08-30T11:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"archived\"}}\n{\"timestamp\":\"2026-08-30T11:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"x\"}}\n", middle)
	write(filepath.Join(dir, "claude", "projects", "recent.jsonl"), "{\"timestamp\":\"2026-08-30T11:00:00Z\",\"sessionId\":\"claude-recent\",\"agentId\":\"a\",\"message\":{\"id\":\"m\",\"role\":\"user\",\"content\":\"x\"}}\n", recent)
	result, err := Scan(context.Background(), ScanOptions{CodexRoot: filepath.Join(dir, "codex"), ClaudeRoot: filepath.Join(dir, "claude"), MaxFiles: 1, Now: time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Runs) != 1 || result.Runs[0].Provider != "claude" || result.Runs[0].SourceSessionID != "claude-recent" {
		t.Fatalf("global candidate ordering failed: %+v", result)
	}
}

func TestCandidateDiscoveryHonorsCanceledContextForEmptyRoot(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, _, err := discoverCandidates(ctx, ScanOptions{CodexRoot: t.TempDir(), ClaudeRoot: t.TempDir(), MaxFiles: 1})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("discovery error = %v, want context cancellation", err)
	}
}

func TestByteBudgetSkipsLargeRecentCandidatesAndFindsOlderSmallFile(t *testing.T) {
	dir := t.TempDir()
	sessions := filepath.Join(dir, "codex", "sessions")
	if err := os.MkdirAll(sessions, 0o755); err != nil {
		t.Fatal(err)
	}
	base := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	for index := 0; index < 4; index++ {
		path := filepath.Join(sessions, "large-"+string(rune('a'+index))+".jsonl")
		content := `{"timestamp":"2026-08-30T11:00:00Z","type":"session_meta","payload":{"id":"large"}}` + "\n" + `{"timestamp":"2026-08-30T11:00:01Z","type":"event_msg","payload":{"type":"user_message","message":"` + strings.Repeat("x", 300) + `"}}` + "\n"
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, base.Add(time.Duration(4-index)*time.Second), base.Add(time.Duration(4-index)*time.Second)); err != nil {
			t.Fatal(err)
		}
	}
	small := filepath.Join(sessions, "small.jsonl")
	if err := os.WriteFile(small, []byte("{\"timestamp\":\"2026-08-30T11:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"small\"}}\n{\"timestamp\":\"2026-08-30T11:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"x\"}}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(small, base, base); err != nil {
		t.Fatal(err)
	}
	result, err := Scan(context.Background(), ScanOptions{CodexRoot: filepath.Join(dir, "codex"), ClaudeRoot: filepath.Join(dir, "claude"), MaxFiles: 1, MaxTotalBytes: 256, Now: base})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Runs) != 1 || result.Runs[0].SourceSessionID != "small" || result.FilesScanned != 1 || !contains(result.Warnings, "scan_byte_limit_reached") {
		t.Fatalf("byte budget starved small file: %+v", result)
	}
}

func TestCandidatePoolLimitUsesDistinctWarning(t *testing.T) {
	dir := t.TempDir()
	root := filepath.Join(dir, "codex", "sessions")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	for index := 0; index < candidatePoolLimit(1)+1; index++ {
		path := filepath.Join(root, "candidate-"+fmt.Sprintf("%04d", index)+".jsonl")
		if err := os.WriteFile(path, []byte("{}\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	_, discovery, err := discoverCandidates(context.Background(), ScanOptions{CodexRoot: filepath.Join(dir, "codex"), ClaudeRoot: filepath.Join(dir, "claude"), MaxFiles: 1, Providers: []string{"codex"}})
	if err != nil {
		t.Fatal(err)
	}
	if !contains(discovery.warnings, "scan_candidate_limit_reached") || contains(discovery.warnings, "scan_file_limit_reached") {
		t.Fatalf("candidate cap warning = %+v", discovery.warnings)
	}
}

func findRun(t *testing.T, runs []Aggregate, provider, sessionID string, kind ...string) Aggregate {
	t.Helper()
	for _, run := range runs {
		if run.Provider == provider && run.SourceSessionID == sessionID && (len(kind) == 0 || run.RunKind == kind[0]) {
			return run
		}
	}
	t.Fatalf("run provider=%s session=%s kind=%v not found", provider, sessionID, kind)
	return Aggregate{}
}

// A real TraeX log carried completed_at_ms:0 for one tool call. Treated as a
// literal 1970 timestamp it pulled the session start back 56 years, produced a
// 496455-hour idle gap, and made cross-session duration totals meaningless.
func TestZeroEpochMillisecondsIsTreatedAsMissingNotAs1970(t *testing.T) {
	dir := t.TempDir()
	sessions := filepath.Join(dir, "traex", "cli", "sessions")
	if err := os.MkdirAll(sessions, 0o755); err != nil {
		t.Fatal(err)
	}
	content := `{"timestamp":"2026-08-30T10:00:00Z","type":"session_meta","payload":{"id":"zero-epoch","cwd":"/tmp/p","model_provider":"trae"}}` + "\n" +
		`{"timestamp":"2026-08-30T10:00:01Z","type":"event_msg","payload":{"type":"user_message","message":"run it"}}` + "\n" +
		`{"timestamp":"2026-08-30T10:00:02Z","type":"history_mutation","payload":{"operation":"append","commit_id":"c1","turn_id":"t1","items":[{"type":"function_call","name":"exec_command","arguments":"{}","call_id":"call-1"}]}}` + "\n" +
		`{"timestamp":"2026-08-30T10:00:03Z","type":"event_msg","payload":{"type":"exec_command_end","call_id":"call-1","exit_code":0,"status":"completed","stdout":"ok","completed_at_ms":0,"turn_id":"t1"}}` + "\n"
	if err := os.WriteFile(filepath.Join(sessions, "zero.jsonl"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := Scan(context.Background(), ScanOptions{
		TraeRoot:   filepath.Join(dir, "traex"),
		CodexRoot:  filepath.Join(dir, "codex"),
		ClaudeRoot: filepath.Join(dir, "claude"),
		Now:        time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Runs) != 1 {
		t.Fatalf("runs = %d, want 1", len(result.Runs))
	}
	run := result.Runs[0]
	if got := run.StartedAt.Year(); got != 2026 {
		t.Fatalf("StartedAt year = %d, want 2026 (got %s)", got, run.StartedAt.Format(time.RFC3339))
	}
	if wall := run.EndedAt.Sub(run.StartedAt); wall > time.Minute {
		t.Fatalf("wall clock = %s, want a few seconds", wall)
	}
	if run.IdleDurationMS != 0 {
		t.Fatalf("IdleDurationMS = %d, want 0 — a zero epoch must not invent an idle gap", run.IdleDurationMS)
	}
	for _, event := range run.Trace {
		if event.Type == "idle" {
			t.Fatalf("unexpected idle event spanning %d ms", event.DurationMS)
		}
		if event.Start.Year() != 2026 {
			t.Fatalf("event %s/%s starts at %s", event.Type, event.Name, event.Start.Format(time.RFC3339))
		}
	}
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
func value(number *int64) int64 {
	if number == nil {
		return -1
	}
	return *number
}
func tokenValue(number *int64) int64 {
	if number == nil {
		return 0
	}
	return *number
}
