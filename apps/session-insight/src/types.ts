export type Provider = "codex" | "claude" | "traex" | string;
export type Evidence = "exact" | "derived" | "heuristic" | "unknown" | string;
export interface TokenBuckets { inputUncached?: number; cacheRead?: number; cacheWrite?: number; output?: number; reasoning?: number; total?: number }
export interface RunCounts { userTurns?: number; followUps?: number; corrections?: number; tools?: number; toolFailures?: number; verifications?: number; subagents?: number; compactions?: number }
export interface Quality { token?: Evidence; tools?: Evidence; correction?: Evidence; verification?: Evidence; timing?: Evidence; semantic?: Evidence; [key: string]: Evidence | undefined }
export interface SkillActivity { invoked?: Record<string, number>; attributed?: Record<string, number>; inferred?: Record<string, number> }
export interface ToolStats { calls?: number; failures?: number }
export interface CorrectionSignal { type: string; count?: number; quality?: Evidence; summary?: string }
export interface PhaseStep { phase: string; startOffsetMs?: number; durationMs?: number; eventCount?: number; toolCalls?: number; toolFailures?: number }
export interface TraceEvent { id?: string; spanId?: string; parentId?: string; turnId?: string; name?: string; type?: string; status?: string; start?: string; end?: string; startOffsetMs?: number; endOffsetMs?: number; durationMs?: number; timestamp?: string; input?: string; output?: string; error?: string; summary?: string; quality?: Evidence; tokens?: TokenBuckets; tokenDelta?: TokenBuckets; contextTokens?: number; contextWindow?: number; contextRatio?: number; tool?: string; skill?: string; retryOf?: string; attributes?: Record<string, unknown> }
export interface TraceSpan extends TraceEvent { children?: TraceSpan[]; eventIds?: string[] }
export interface ContextSample { offsetMs?: number; timestamp?: string; tokens?: number; ratio?: number; kind?: string; label?: string }
export interface TraceLink { from?: string; to?: string; type?: string; label?: string }
export interface TraceContext { peakTokens?: number; windowTokens?: number; peakRatio?: number; samples?: ContextSample[]; series?: ContextSample[]; compactions?: ContextSample[] }
export interface SessionRun { id: string; sessionRef?: string; sourceSessionId?: string; title?: string; snippet?: string; provider?: Provider; model?: string; project?: string; runKind?: string; startedAt?: string; endedAt?: string; durationMs?: number; wallDurationMs?: number; activeDurationMs?: number; idleDurationMs?: number; peakContextTokens?: number; contextWindowTokens?: number; tokens?: TokenBuckets; counts?: RunCounts; phaseSequence?: PhaseStep[]; phaseCounts?: Record<string, number>; toolCounts?: Record<string, ToolStats>; skillActivity?: SkillActivity; correctionSignals?: CorrectionSignal[]; verification?: { status?: string; summary?: string; evidenceCount?: number; quality?: Evidence }; quality?: Quality; origin?: string; importedAt?: string; parseWarnings?: string[]; source?: string; spans?: TraceSpan[]; events?: TraceEvent[]; trace?: TraceEvent[]; turns?: TraceEvent[]; links?: TraceLink[]; context?: TraceContext }
export interface RunListResponse { runs: SessionRun[]; nextCursor?: string | null; total: number }
export interface ImportResult { runs: SessionRun[]; count: number; imported: number; updated: number; filesScanned: number; filesSkipped: number; warnings?: string[] }
export interface RunFilters { sort?: string; q: string; provider: string; tool: string; skill: string; model?: string; from: string; to: string; error?: string; correction?: string; contextRisk?: string }
export interface NameCount { name: string; count: number }
export interface ProjectStat { name: string; runs: number; tokens?: number; tokenRunCount: number; durationMs: number; failures: number }
export interface ToolStat { name: string; calls: number; failures: number }
export interface DayStat { date: string; runs: number; tokens?: number; tokenRunCount: number; failures: number }
/** Aggregate over every run matching the active filters, not just the loaded page. */
export interface Stats { runCount: number; tokens: TokenBuckets; tokenRunCount: number; toolCalls: number; toolFailures: number; toolRunCount: number; toolOutcomeRunCount: number; failedRunCount: number; contextRiskRuns: number; correctionRuns: number; subagentRuns: number; wallDurationMs: number; activeDurationMs: number; idleDurationMs: number; cacheHitRatio?: number; providers: NameCount[]; models: NameCount[]; projects: ProjectStat[]; tools: ToolStat[]; daily: DayStat[] }
