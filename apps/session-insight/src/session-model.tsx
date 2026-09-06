import type { ContextSample, SessionRun, TraceEvent, TraceSpan } from "./types";
import { parseTurn } from "./transcript";

export const evidenceText: Record<string, string> = {
  exact: "观测",
  observed: "观测",
  derived: "推导",
  heuristic: "启发式",
  inferred: "推断",
  estimated: "估算",
  partial: "部分",
  unavailable: "不可用",
  unknown: "不可用",
};
/** The backend emits `unknown` or `observed`; neither belongs on screen. */
const verificationText: Record<string, string> = {
  unknown: "不可用",
  observed: "有验证活动",
};
export const verificationLabel = (status?: string) =>
  (status ? verificationText[status] : undefined) ?? status ?? "—";
export const qualityAvailable = (value?: string) =>
  Boolean(value && !/unknown|unavailable|不可用/i.test(value));
export function normalizeRunEvidence(run: SessionRun): SessionRun {
  if (qualityAvailable(run.quality?.tools)) return run;
  const events: TraceEvent[] = [
      ...(run.spans ?? []).flatMap((span) => [span, ...(span.children ?? [])]),
      ...(run.events ?? []),
      ...(run.trace ?? []),
    ],
    stats = Object.values(run.toolCounts ?? {}),
    hasToolEvent = events.some(
      (span) => kindOf(span.type) === "tool" || Boolean(span.tool),
    ),
    hasFailureEvent = events.some(
      (span) =>
        (kindOf(span.type) === "tool" || Boolean(span.tool)) &&
        (span.status === "error" || Boolean(span.error)),
    ),
    hasCalls =
      (run.counts?.tools ?? 0) > 0 ||
      stats.some((stat) => (stat.calls ?? 0) > 0) ||
      hasToolEvent,
    hasFailures =
      (run.counts?.toolFailures ?? 0) > 0 ||
      stats.some((stat) => (stat.failures ?? 0) > 0) ||
      hasFailureEvent;
  return {
    ...run,
    counts: run.counts
      ? {
          ...run.counts,
          tools: hasCalls ? run.counts.tools : undefined,
          toolFailures: hasFailures ? run.counts.toolFailures : undefined,
        }
      : run.counts,
    toolCounts: stats.length || hasToolEvent ? run.toolCounts : undefined,
  };
}

/** What a human calls this run. The server derives Title from the opening user
 *  prompt; sessions without one (empty runs, some subagents) fall back to
 *  project plus a short id rather than showing a bare uuid. */
export function runLabel(run: SessionRun): string {
  const title = run.title?.trim();
  if (title) return title;
  const id = run.sourceSessionId ?? run.sessionRef ?? run.id;
  if (run.project) return `${run.project} · ${id.slice(0, 8)}${run.runKind === "subagent" ? ` · ${run.id.slice(-8)}` : ""}`;
  return id;
}

export const ev = (value?: string) => (
  <span className={`evidence ${value ?? "unknown"}`}>
    {evidenceText[value?.toLowerCase() ?? "unknown"] ?? value ?? "不可用"}
  </span>
);
export const idOf = (span: TraceSpan, index = 0) =>
  span.id ?? span.spanId ?? `span-${index}`;
export const startOf = (span: TraceSpan) => span.startOffsetMs ?? 0;
export const lengthOf = (span: TraceSpan) =>
  Math.max(
    1,
    span.durationMs ?? ((span.endOffsetMs ?? 0) - startOf(span) || 1),
  );
export const nameOf = (span: TraceSpan) =>
  span.name ?? span.tool ?? span.skill ?? span.type ?? "未命名事件";
export const kindOf = (value?: string) =>
  /tool|shell|exec/i.test(value ?? "")
    ? "tool"
    : /model|reason|assistant|generation/i.test(value ?? "")
      ? "model"
      : /user|turn/i.test(value ?? "")
        ? "user"
        : /error|fail/i.test(value ?? "")
          ? "error"
          : /compact/i.test(value ?? "")
            ? "compact"
            : "other";
export const totalDuration = (run: SessionRun, spans: TraceSpan[]) =>
  run.wallDurationMs ??
  run.durationMs ??
  Math.max(1, ...spans.map((span) => startOf(span) + lengthOf(span)));
export const contextRatio = (run: SessionRun) =>
  run.context?.peakRatio ??
  (run.context?.peakTokens !== undefined && run.context?.windowTokens
    ? run.context.peakTokens / run.context.windowTokens
    : run.peakContextTokens !== undefined && run.contextWindowTokens
      ? run.peakContextTokens / run.contextWindowTokens
      : undefined);
export const skills = (
  run: SessionRun,
): Array<{ source: string; name: string; count: number }> =>
  Object.entries(run.skillActivity ?? {}).flatMap(([source, values]) =>
    Object.entries(values ?? {}).flatMap(([name, count]) =>
      typeof count === "number" ? [{ source, name, count }] : [],
    ),
  );
export const isConversationTurn = (span: TraceSpan) =>
  kindOf(span.type) === "user" ||
  (kindOf(span.type) === "model" && /agent response/i.test(span.name ?? ""));
export const conversationContent = (turn: TraceSpan) => {
  const text =
    turn.summary ??
    (kindOf(turn.type) === "user"
      ? (turn.input ?? turn.output)
      : (turn.output ?? turn.input));
  if (text?.trim()) return text;
  // A turn with no recorded text still happened. Say which kind of turn it was
  // and why the body is missing, instead of a dead-end placeholder.
  return kindOf(turn.type) === "user"
    ? "（这一轮没有记录文本内容，可能是图片、附件或被解析器跳过的载荷）"
    : "（这一轮没有记录文本输出，可能只包含工具调用）";
};

/** Fields worth showing beside a tool name, most identifying first. Tool inputs
 *  are recorded as JSON, so the useful part has to be pulled out of it. */
const hintKeys = [
  "command",
  "cmd",
  "code",
  "file_path",
  "path",
  "pattern",
  "query",
  "url",
  "notebook_path",
  "description",
  "prompt",
  "subagent_type",
] as const;
const maxHintChars = 96;

/** Short distinguishing text for a trace row: thirty rows all named "bash" are
 *  impossible to navigate on the tool name alone. */
export function spanHint(span: TraceSpan): string {
  const direct = span.summary?.trim();
  if (direct) return clipHint(direct);
  const raw = (span.input || span.output)?.trim();
  if (!raw) return "";
  // Conversation turns arrive wrapped in harness tags; showing
  // "<teammate-mes…" identifies nothing.
  if (raw.startsWith("<")) return clipHint(turnHint(raw));
  if (!raw.startsWith("{")) return clipHint(raw);
  const picked = pickHintKey(raw);
  return clipHint(picked || raw.replace(/^\{"?/, ""));
}

function pickHintKey(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const key of hintKeys) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim()) return value;
    }
    return "";
  } catch {
    // Excerpts are cut at a byte budget, so many tool inputs are truncated
    // mid-object and will never parse. Pull the field out textually rather
    // than printing the raw `{"replace_all":f…` fragment.
  }
  for (const key of hintKeys) {
    const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(
      raw,
    );
    if (!match) continue;
    try {
      return JSON.parse(`"${match[1]}"`) as string;
    } catch {
      return match[1];
    }
  }
  return "";
}

function turnHint(raw: string): string {
  const turn = parseTurn(raw);
  if (turn.subject) return turn.subject;
  const body = turn.blocks.find((block) => block.kind === "markdown");
  if (body) return body.text;
  const note = turn.blocks.find((block) => block.kind === "note");
  return note ? note.label : raw;
}

function clipHint(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > maxHintChars
    ? `${flat.slice(0, maxHintChars)}…`
    : flat;
}

/** A readable label for an event that has no summary, built from the fields we
 *  do have. "事件语义不可用" told the reader nothing they could act on. */
export function spanFallbackSummary(span: TraceSpan): string {
  const kind = kindOf(span.type);
  const failed = span.status === "error" || Boolean(span.error);
  if (span.tool)
    return failed ? `工具 ${span.tool} 调用失败` : `工具 ${span.tool} 调用`;
  if (span.skill) return `Skill ${span.skill}`;
  if (kind === "user") return "用户输入";
  if (kind === "model") return span.name ? `模型 ${span.name}` : "模型输出";
  if (span.error) return span.error.split("\n")[0].slice(0, 120);
  return span.name ? `${span.name}（无更多语义信息）` : "无语义信息的事件";
}

export function normalSpans(run: SessionRun): TraceSpan[] {
  const nested = (run.spans ?? []).flatMap((span) => [
    span,
    ...(span.children ?? []).map((child) => ({
      ...child,
      parentId: child.parentId ?? span.id ?? span.spanId,
    })),
  ]);
  if (nested.length) return nested;
  if (run.events?.length) return run.events.map((event) => ({ ...event }));
  if (run.trace?.length) {
    const epoch = run.startedAt
      ? new Date(run.startedAt).getTime()
      : Number.NaN;
    return run.trace.map((event: TraceEvent, index) => {
      const start =
        event.startOffsetMs ??
        (event.start && Number.isFinite(epoch)
          ? Math.max(0, new Date(event.start).getTime() - epoch)
          : 0);
      const end =
        event.endOffsetMs ??
        (event.end && Number.isFinite(epoch)
          ? Math.max(start, new Date(event.end).getTime() - epoch)
          : undefined);
      const contextRatio =
        event.contextRatio ??
        (event.contextTokens !== undefined && event.contextWindow
          ? event.contextTokens / event.contextWindow
          : undefined);
      return {
        ...event,
        id: event.id ?? `trace-${index}`,
        startOffsetMs: start,
        endOffsetMs: end,
        durationMs:
          event.durationMs ?? (end === undefined ? undefined : end - start),
        contextRatio,
      };
    });
  }
  return (run.phaseSequence ?? []).map((phase, index) => ({
    id: `phase-${index}`,
    name: phase.phase,
    type: phase.phase,
    startOffsetMs: phase.startOffsetMs,
    durationMs: phase.durationMs,
    status: phase.toolFailures ? "error" : "ok",
    summary: `${phase.eventCount ?? "—"} events · ${phase.toolCalls ?? "—"} tools`,
  }));
}
export function samples(run: SessionRun, spans: TraceSpan[]): ContextSample[] {
  return (
    run.context?.samples ??
    run.context?.series ??
    spans.flatMap((span) =>
      span.contextRatio === undefined && span.contextTokens === undefined
        ? []
        : [
            {
              offsetMs: startOf(span),
              ratio: span.contextRatio,
              tokens: span.contextTokens,
            },
          ],
    )
  );
}

/** Telemetry markers exist to drive the token and context tracks; they are not
 *  things that happened. Listing them buries the real work — a typical run holds
 *  38 token pulses and 37 empty reasoning markers against 23 tool calls. The
 *  charts keep reading the unfiltered spans, so no data is lost. */
export function isTelemetryOnly(span: TraceSpan): boolean {
  const name = (span.name ?? "").trim().toLowerCase();
  if (name === "token pulse") return true;
  if (name === "reasoning")
    return !span.output?.trim() && !span.summary?.trim() && !span.input?.trim();
  return false;
}
