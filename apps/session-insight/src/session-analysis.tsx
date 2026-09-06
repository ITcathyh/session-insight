import { useMemo, useState } from "react";
import { duration, number, tokens, trackedTokenTotal, timelineDuration } from "./format";
import type { Evidence, SessionRun, TokenBuckets, TraceSpan } from "./types";
import { evidenceText, idOf, spanHint } from "./session-model";
import "./session-analysis.css";

type SpanOpener = (span: TraceSpan) => void;

export interface SessionOverviewProps {
  run: SessionRun;
  spans: TraceSpan[];
  openSpan: SpanOpener;
  openTool: (name: string) => void;
  openTokens: () => void;
}

export interface SessionTokensProps {
  run: SessionRun;
  spans: TraceSpan[];
  openSpan: SpanOpener;
}

const INITIAL_ITEMS = 6;
const INITIAL_TOOLS = 8;
const INITIAL_PULSES = 8;

function hasNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function spanName(span: TraceSpan): string {
  return span.name ?? span.tool ?? span.skill ?? span.type ?? "未命名事件";
}

function isFailure(span: TraceSpan): boolean {
  return /^(error|failed)$/i.test(span.status ?? "");
}

function EvidenceTag({ value }: { value?: Evidence }) {
  return <span className="analysis-evidence">{evidenceText[value ?? "unknown"] ?? value}</span>;
}

function observedRatio(numerator?: number, denominator?: number): number | undefined {
  if (!hasNumber(numerator) || numerator < 0 || !hasNumber(denominator) || denominator <= 0) return undefined;
  const result = numerator / denominator;
  return Number.isFinite(result) ? result : undefined;
}

function efficiencyValue(value: number | undefined, unit: string): string {
  if (value === undefined) return "—";
  const formatted = value > 0 && value < 0.01 ? "<0.01"
    : unit === "%" && value > 99.99 && value < 100 ? ">99.99"
      : new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
  return `${formatted}${unit === "%" ? "" : " "}${unit}`;
}

function efficiencyEvidence(value: number | undefined, sources: (Evidence | undefined)[], heuristic = false): Evidence {
  if (value === undefined) return "unavailable";
  const qualities = sources.map((source) => source || "unknown");
  const weaker = ["unavailable", "unknown", "partial", "heuristic", "inferred", "estimated"].find((quality) => qualities.includes(quality));
  if (weaker) return weaker;
  return qualities.every((quality) => ["exact", "observed", "derived"].includes(quality))
    ? heuristic ? "heuristic" : "derived" : "unknown";
}

function TokenEfficiency({ run, detailed = false }: { run: SessionRun; detailed?: boolean }) {
  const buckets = run.tokens;
  const output = buckets?.output;
  const wall = run.wallDurationMs ?? run.durationMs;
  const active = run.activeDurationMs;
  const activeRate = hasNumber(active) && (!hasNumber(wall) || active <= wall)
    ? observedRatio(output, active / 1000) : undefined;
  const wallRate = hasNumber(wall) ? observedRatio(output, wall / 1000) : undefined;
  const readableInput = hasNumber(buckets?.inputUncached) && buckets.inputUncached >= 0 && hasNumber(buckets?.cacheRead)
    ? buckets.inputUncached + buckets.cacheRead : undefined;
  const cacheRate = observedRatio(buckets?.cacheRead, readableInput);
  const perTurn = observedRatio(output, run.counts?.userTurns);
  const reasoningRatio = hasNumber(buckets?.reasoning) && hasNumber(output) && buckets.reasoning <= output
    ? observedRatio(buckets.reasoning, output) : undefined;
  const tracked = trackedTokenTotal(buckets);
  const allBucketsObserved = [buckets?.inputUncached, buckets?.cacheRead, buckets?.cacheWrite, output]
    .every((value) => hasNumber(value) && value >= 0);
  const outputShare = allBucketsObserved && hasNumber(output) && hasNumber(tracked) && output <= tracked
    ? observedRatio(output, tracked) : undefined;
  const outputQuality = run.quality?.outputTokens;
  const metrics = [
    {
      label: "活跃期输出速率", value: efficiencyValue(activeRate, "tokens/s"),
      quality: efficiencyEvidence(activeRate, [outputQuality], true),
      detail: `Output ÷ 活跃时长（${duration(active)}）。活跃时长扣除超过 5 分钟的观察空档，仍包含工具执行和短时等待。`,
    },
    {
      label: "全程输出速率", value: efficiencyValue(wallRate, "tokens/s"),
      quality: efficiencyEvidence(wallRate, [outputQuality]),
      detail: `Output ÷ 墙钟时长（${duration(wall)}），包括用户等待、工具执行和空档。`,
    },
    {
      label: "缓存读取率", value: efficiencyValue(cacheRate === undefined ? undefined : cacheRate * 100, "%"),
      quality: efficiencyEvidence(cacheRate, [run.quality?.inputTokens]),
      detail: "Cache read ÷（未缓存输入 + Cache read）。不含 Cache write；两个输入字段都需要有记录。",
    },
    {
      label: "每轮平均输出", value: efficiencyValue(perTurn, "tokens/轮"),
      quality: efficiencyEvidence(perTurn, [outputQuality]),
      detail: `Output ÷ 用户轮次（${number(run.counts?.userTurns)} 轮）。描述整段会话的平均值。`,
    },
    {
      label: "推理占输出", value: efficiencyValue(reasoningRatio === undefined ? undefined : reasoningRatio * 100, "%"),
      quality: efficiencyEvidence(reasoningRatio, [outputQuality, run.quality?.reasoningTokens]),
      detail: "Reasoning ÷ Output。Reasoning 是输出子集，只在两者都有记录时计算。",
    },
    {
      label: "输出占已追踪 Token", value: efficiencyValue(outputShare === undefined ? undefined : outputShare * 100, "%"),
      quality: efficiencyEvidence(outputShare, [outputQuality, run.quality?.inputTokens]),
      detail: "Output ÷（Input + Cache read + Cache write + Output）。四个分桶都需要有记录；该比例不衡量回答质量。",
    },
  ];

  return <section className="analysis-panel token-efficiency" aria-labelledby="token-efficiency-title">
    <header><div><p>OUTPUT & CACHE</p><h2 id="token-efficiency-title">输出与缓存效率</h2></div></header>
    <p className="analysis-pulse-note">速率按会话时间计算，日志未提供独立的模型生成时长，不能读作模型解码速度。缺少字段或分母为 0 时显示 —。</p>
    {run.parseWarnings?.includes("unknown_timestamp") && <p className="analysis-coverage">部分事件缺少时间戳，会话时长可能不完整；输出速率仅供参考。</p>}
    <dl>{(detailed ? metrics : metrics.slice(0, 3)).map((metric) => <div key={metric.label}>
      <dt>{metric.label}<EvidenceTag value={metric.quality} /></dt>
      <dd>{metric.value}</dd>
      <small>{metric.detail}</small>
    </div>)}</dl>
  </section>;
}

function peakContext(run: SessionRun, spans: TraceSpan[]): number | undefined {
  const fromRun = run.context?.peakRatio ??
    (hasNumber(run.context?.peakTokens) && hasNumber(run.context?.windowTokens) && run.context.windowTokens > 0
      ? run.context.peakTokens / run.context.windowTokens
      : hasNumber(run.peakContextTokens) && hasNumber(run.contextWindowTokens) && run.contextWindowTokens > 0
        ? run.peakContextTokens / run.contextWindowTokens
        : undefined);
  if (fromRun !== undefined) return fromRun;
  const values = spans
    .map((span) => span.contextRatio ??
      (hasNumber(span.contextTokens) && hasNumber(span.contextWindow) && span.contextWindow > 0
        ? span.contextTokens / span.contextWindow
        : undefined))
    .filter(hasNumber);
  return values.length ? Math.max(...values) : undefined;
}

function contextLevel(ratio: number): string {
  if (ratio >= 0.8) return "高水位";
  if (ratio >= 0.6) return "接近上限";
  return "已观测峰值";
}

function toolName(span: TraceSpan): string | undefined {
  if (span.tool) return span.tool;
  if (/tool|shell|exec/i.test(span.type ?? "") && span.name) return span.name;
  return undefined;
}

function excerpt(span: TraceSpan): string {
  const value = span.error ?? span.output ?? span.summary ?? span.input;
  if (!value?.trim()) return "事件未提供错误摘录";
  return value.trim().split("\n")[0].slice(0, 180);
}

function parentContext(span: TraceSpan, spans: TraceSpan[]): string | undefined {
  const parent = span.parentId
    ? spans.find((candidate) => candidate.id === span.parentId || candidate.spanId === span.parentId)
    : undefined;
  if (parent) return `父事件：${spanName(parent)}`;
  if (span.turnId) return `关联 turn：${span.turnId}`;
  return undefined;
}

type Finding = {
  id: string;
  level: "danger" | "warning" | "neutral";
  title: string;
  detail: string;
  quality?: Evidence;
  span?: TraceSpan;
};

function findingsFor(run: SessionRun, spans: TraceSpan[]): Finding[] {
  const failures = spans.filter(isFailure);
  const peak = peakContext(run, spans);
  const correctionCount = run.counts?.corrections;
  const correctionSpan = spans.find((span) => /correction|纠偏/i.test(`${span.type ?? ""} ${span.name ?? ""}`));
  const idleSpans = spans.filter((span) => /idle[ _-]?gap|idle|空档/i.test(`${span.type ?? ""} ${span.name ?? ""}`) && hasNumber(span.durationMs));
  const longestIdle = idleSpans.sort((left, right) => (right.durationMs ?? 0) - (left.durationMs ?? 0))[0];
  const slowTool = spans
    .filter((span) => toolName(span) && hasNumber(span.durationMs) && span.durationMs > 0)
    .sort((left, right) => (right.durationMs ?? 0) - (left.durationMs ?? 0))[0];
  const result: Finding[] = [];

  for (const [index, failure] of failures.entries()) {
    result.push({
      id: `failure-${failure.id ?? failure.spanId ?? index}`,
      level: "danger",
      title: `失败 · ${spanName(failure)}`,
      detail: excerpt(failure),
      quality: failure.quality ?? run.quality?.tools ?? "observed",
      span: failure,
    });
  }
  if (hasNumber(run.counts?.toolFailures) && run.counts.toolFailures > failures.length) {
    result.push({
      id: "unanchored-failures",
      level: "danger",
      title: "结构化失败计数",
      detail: `${number(run.counts.toolFailures)} 个失败，其中 ${number(run.counts.toolFailures - failures.length)} 个没有事件级摘录。`,
      quality: run.quality?.tools,
    });
  }
  if (peak !== undefined) {
    const span = spans.find((candidate) => candidate.contextRatio === peak);
    result.push({
      id: "context",
      level: peak >= 0.8 ? "danger" : peak >= 0.6 ? "warning" : "neutral",
      title: `上下文 · ${contextLevel(peak)}`,
      detail: `峰值 ${Math.round(peak * 100)}%，只描述已观测上下文占用。`,
      quality: run.quality?.context,
      span,
    });
  }
  if (hasNumber(correctionCount) && correctionCount > 0) {
    result.push({
      id: "corrections",
      level: "warning",
      title: "纠偏候选",
      detail: `${number(correctionCount)} 个候选，启发式信号不代表已确认的用户纠偏。`,
      quality: run.quality?.correction,
      span: correctionSpan,
    });
  }
  if (longestIdle) {
    result.push({
      id: "idle-gap",
      level: "neutral",
      title: "最长观察空档",
      detail: duration(longestIdle.durationMs),
      quality: longestIdle.quality ?? run.quality?.timing,
      span: longestIdle,
    });
  } else if (hasNumber(run.idleDurationMs) && run.idleDurationMs > 0) {
    result.push({
      id: "idle-total",
      level: "neutral",
      title: "观察到的空档总时长",
      detail: `${duration(run.idleDurationMs)}；未提供最长空档事件。`,
      quality: run.quality?.timing,
    });
  }
  if (slowTool) {
    result.push({
      id: `slow-tool-${slowTool.id ?? slowTool.spanId ?? spanName(slowTool)}`,
      level: "neutral",
      title: `最慢工具调用 · ${toolName(slowTool)}`,
      detail: timelineDuration(slowTool.durationMs!),
      quality: slowTool.quality ?? run.quality?.timing,
      span: slowTool,
    });
  }
  return result;
}

type ToolRow = {
  name: string;
  calls?: number;
  failures?: number;
  observedDuration?: number;
  observedDurationCount: number;
  unknownResults: number;
  summaryCalls?: boolean;
  summaryFailures?: boolean;
};

function resultIsUnknown(span: TraceSpan): boolean {
  return !span.status || /^(unknown|unavailable)$/i.test(span.status);
}

function toolsFor(run: SessionRun, spans: TraceSpan[]): ToolRow[] {
  const rows = new Map<string, ToolRow>();
  for (const [name, stat] of Object.entries(run.toolCounts ?? {}))
    rows.set(name, {
      name,
      calls: stat.calls,
      failures: stat.failures,
      observedDurationCount: 0,
      unknownResults: 0,
      summaryCalls: stat.calls !== undefined,
      summaryFailures: stat.failures !== undefined,
    });
  for (const span of spans) {
    const name = toolName(span);
    if (!name) continue;
    const current = rows.get(name) ?? { name, observedDurationCount: 0, unknownResults: 0 };
    if (!current.summaryCalls) current.calls = (current.calls ?? 0) + 1;
    if (!current.summaryFailures)
      current.failures = (current.failures ?? 0) + Number(isFailure(span));
    if (resultIsUnknown(span)) current.unknownResults += 1;
    if (hasNumber(span.durationMs) && span.durationMs >= 0) {
      current.observedDuration = (current.observedDuration ?? 0) + span.durationMs;
      current.observedDurationCount += 1;
    }
    rows.set(name, current);
  }
  return [...rows.values()].sort((left, right) =>
    (right.failures ?? -1) - (left.failures ?? -1) ||
    (right.calls ?? -1) - (left.calls ?? -1) ||
    left.name.localeCompare(right.name),
  );
}

function toolResultCoverage(spans: TraceSpan[]): { total: number; unknown: number } {
  const toolSpans = spans.filter((span) => toolName(span));
  return {
    total: toolSpans.length,
    unknown: toolSpans.filter(resultIsUnknown).length,
  };
}

function ExpandButton({ shown, total, onClick }: { shown: number; total: number; onClick: () => void }) {
  if (total <= shown) return null;
  return <button className="analysis-expand" type="button" onClick={onClick}>展开其余 {total - shown} 项</button>;
}

export function SessionOverview({ run, spans, openSpan, openTool, openTokens }: SessionOverviewProps) {
  const findings = useMemo(() => findingsFor(run, spans), [run, spans]);
  const toolRows = useMemo(() => toolsFor(run, spans), [run, spans]);
  const [showAllFindings, setShowAllFindings] = useState(false);
  const [showAllTools, setShowAllTools] = useState(false);
  const visibleFindings = showAllFindings ? findings : findings.slice(0, INITIAL_ITEMS);
  const visibleTools = showAllTools ? toolRows : toolRows.slice(0, INITIAL_TOOLS);
  const resultCoverage = toolResultCoverage(spans);
  const explicitFailures = spans.filter(isFailure).length;
  const failuresUnavailable = run.quality?.tools === "unknown" && explicitFailures === 0;
  const durationUnavailable = toolRows.length > 0 && !toolRows.some((tool) => tool.observedDurationCount > 0);
  const riskCount =
    Number(spans.some(isFailure) || (run.counts?.toolFailures ?? 0) > 0) +
    Number((peakContext(run, spans) ?? 0) >= 0.8) +
    Number((run.counts?.corrections ?? 0) > 0);
  const tracked = trackedTokenTotal(run.tokens);
  const peak = peakContext(run, spans);

  return (
    <section className="session-analysis" aria-label="单会话分析">
      <header className={`analysis-brief${riskCount ? " has-risk" : ""}`}>
        <div>
          <p>SESSION ANALYSIS</p>
          <h2>{riskCount ? `${riskCount} 类信号需要检查` : "未发现可定位的高优先级信号"}</h2>
          <span>{riskCount ? "可定位的信号提供 Trace 跳转；无事件级锚点会明确标出。" : "缺失字段不视作运行稳定；可继续检查完整 Trace。"}</span>
        </div>
        <dl>
          <div><dt>可追踪 Token</dt><dd>{tokens(tracked)}</dd></div>
          <div><dt>上下文峰值</dt><dd>{peak === undefined ? "—" : `${Math.round(peak * 100)}%`}</dd></div>
          <div><dt>工具失败</dt><dd>{failuresUnavailable ? "—" : explicitFailures ? number(explicitFailures) : hasNumber(run.counts?.toolFailures) ? number(run.counts.toolFailures) : "—"}</dd></div>
        </dl>
      </header>

      <TokenEfficiency run={run} />

      <div className="analysis-layout">
        <section className="analysis-panel analysis-findings" aria-labelledby="analysis-findings-title">
          <header><div><p>TRACE EVIDENCE</p><h2 id="analysis-findings-title">需要检查</h2></div><span>{findings.length ? `${findings.length} 项可观察信号` : "没有可定位信号"}</span></header>
          {visibleFindings.length ? <ol>
            {visibleFindings.map((finding) => <li className={finding.level} key={finding.id}>
              <div><strong>{finding.title}</strong><p title={finding.detail}>{finding.detail}</p></div>
              <EvidenceTag value={finding.quality} />
              {finding.span ? <button type="button" onClick={() => openSpan(finding.span!)}>定位 Trace</button> : <small>无事件级锚点</small>}
            </li>)}
          </ol> : <p className="analysis-empty">未观察到失败、上下文或纠偏候选。字段缺失时不会据此判断运行正常。</p>}
          {!showAllFindings && <ExpandButton shown={INITIAL_ITEMS} total={findings.length} onClick={() => setShowAllFindings(true)} />}
        </section>

        <aside className="analysis-panel analysis-token-preview" aria-labelledby="analysis-token-title">
          <header><div><p>TOKEN EVIDENCE</p><h2 id="analysis-token-title">Token 构成</h2></div><EvidenceTag value={run.quality?.token} /></header>
          <dl>
            <div><dt>输入</dt><dd>{tokens(run.tokens?.inputUncached)}</dd></div>
            <div><dt>Cache read</dt><dd>{tokens(run.tokens?.cacheRead)}</dd></div>
            <div><dt>Cache write</dt><dd>{tokens(run.tokens?.cacheWrite)}</dd></div>
            <div><dt>输出</dt><dd>{tokens(run.tokens?.output)}</dd></div>
          </dl>
          <p>Reasoning 是输出的子集，不会重复计入可追踪 Token。</p>
          <button type="button" onClick={openTokens}>查看 Token 脉冲与构成</button>
        </aside>
      </div>

      <section className="analysis-panel analysis-tools" aria-labelledby="analysis-tools-title">
        <header><div><p>TOOL CHAIN</p><h2 id="analysis-tools-title">工具调用链</h2></div><span>{toolRows.length ? `${toolRows.length} 种工具` : "不可用"}</span></header>
        {resultCoverage.unknown ? <p className="analysis-coverage">{number(resultCoverage.unknown)} 次结果未判定{resultCoverage.total ? `（共 ${number(resultCoverage.total)} 个可观察调用）` : ""}，不能据此判断成功或失败。</p> : run.quality?.tools === "unknown" ? <p className="analysis-coverage">工具结果质量不可用，不能据此判断成功或失败。</p> : null}
        {durationUnavailable && <p className="analysis-duration-limit">工具调用时长不可用，不能据此比较慢调用。</p>}
        {visibleTools.length ? <div className="analysis-table-wrap"><table><thead><tr><th>工具</th><th>调用</th><th>失败</th><th>可观测时长</th><th><span className="visually-hidden">打开</span></th></tr></thead><tbody>
          {visibleTools.map((tool) => <tr key={tool.name}><td>{tool.name}</td><td>{hasNumber(tool.calls) ? number(tool.calls) : "—"}</td><td className={tool.failures && !failuresUnavailable ? "analysis-danger" : ""}>{failuresUnavailable || (tool.unknownResults > 0 && (tool.failures ?? 0) === 0) ? "—" : hasNumber(tool.failures) ? number(tool.failures) : "—"}</td><td>{tool.observedDurationCount ? `${timelineDuration(tool.observedDuration!)} / ${number(tool.observedDurationCount)} 次` : "—"}</td><td><button type="button" onClick={() => openTool(tool.name)}>查看链路</button></td></tr>)}
        </tbody></table></div> : <p className="analysis-empty">没有可观察的工具统计。</p>}
        {!showAllTools && <ExpandButton shown={INITIAL_TOOLS} total={toolRows.length} onClick={() => setShowAllTools(true)} />}
      </section>
    </section>
  );
}

function TokenBucket({ label, value, detail }: { label: string; value?: number; detail?: string }) {
  return <div className="token-bucket"><dt>{label}</dt><dd title={value === undefined ? "未观测" : new Intl.NumberFormat("zh-CN").format(value)}>{tokens(value)}</dd>{value !== undefined && <span className="token-exact">{new Intl.NumberFormat("zh-CN").format(value)}</span>}{detail && <small>{detail}</small>}</div>;
}

export function SessionTokens({ run, spans, openSpan }: SessionTokensProps) {
  const [showAll, setShowAll] = useState(false);
  const pulses = useMemo(() => spans
    .map((span) => ({ span, total: trackedTokenTotal(span.tokenDelta ?? span.tokens) }))
    .filter((item): item is { span: TraceSpan; total: number } => item.total !== undefined)
    .sort((left, right) => right.total - left.total), [spans]);
  const visiblePulses = showAll ? pulses : pulses.slice(0, INITIAL_PULSES);
  const [showTurns, setShowTurns] = useState(false);
  const turnTotals = useMemo(() => {
    const byId = new Map(spans.map((span) => [idOf(span), span]));
    const totals = new Map<string, { span: TraceSpan; total: number; pulses: number }>();
    for (const pulse of pulses) {
      let parent = byId.get(pulse.span.parentId ?? "") ?? byId.get(pulse.span.turnId ?? "");
      const visited = new Set<string>();
      while (parent && !/user|turn/i.test(parent.type ?? "")) {
        const id = idOf(parent);
        if (visited.has(id)) { parent = undefined; break; }
        visited.add(id);
        parent = byId.get(parent.parentId ?? "");
      }
      if (!parent) continue;
      const id = idOf(parent);
      const current = totals.get(id) ?? { span: parent, total: 0, pulses: 0 };
      current.total += pulse.total;
      current.pulses++;
      totals.set(id, current);
    }
    return [...totals.values()].sort((left, right) => right.total - left.total);
  }, [pulses, spans]);
  const buckets: TokenBuckets | undefined = run.tokens;

  return <section className="session-analysis analysis-tokens-page" aria-label="Token 分析">
    <header className="analysis-brief">
      <div><p>TOKEN ANALYSIS</p><h2>可追踪 Token 构成</h2><span>仅汇总 input、cache read、cache write 与 output；Reasoning 属于 output。</span></div>
      <dl><div><dt>可追踪总量</dt><dd>{tokens(trackedTokenTotal(buckets))}</dd></div><div><dt>数据质量</dt><dd><EvidenceTag value={run.quality?.token} /></dd></div></dl>
    </header>
    <TokenEfficiency run={run} detailed />
    <section className="analysis-panel token-breakdown" aria-labelledby="token-breakdown-title">
      <header><div><p>BUCKETS</p><h2 id="token-breakdown-title">构成与缓存</h2></div></header>
      {(trackedTokenTotal(buckets) ?? 0) > 0 && <div className="token-composition" role="img" aria-label="Token 构成：输入、缓存读取、缓存写入与输出">
        {([['inputUncached', 'input'], ['cacheRead', 'cache-read'], ['cacheWrite', 'cache-write'], ['output', 'output']] as const).map(([key, className]) => <i key={key} className={className} title={`${key}: ${buckets?.[key] ?? '未观测'}`} style={{ width: `${(buckets?.[key] ?? 0) / trackedTokenTotal(buckets)! * 100}%` }} />)}
      </div>}
      <dl><TokenBucket label="Input" value={buckets?.inputUncached} /><TokenBucket label="Cache read" value={buckets?.cacheRead} detail="复用此前已缓存的输入 Token" /><TokenBucket label="Cache write" value={buckets?.cacheWrite} /><TokenBucket label="Output" value={buckets?.output} detail={hasNumber(buckets?.reasoning) ? `其中 Reasoning ${tokens(buckets.reasoning)}（输出子集）` : "Reasoning 为输出子集"} /></dl>
    </section>
    {turnTotals.length > 0 && <section className="analysis-panel token-turns" aria-labelledby="token-turns-title">
      <header><div><p>TURN BREAKDOWN</p><h2 id="token-turns-title">哪些轮次关联了更多 Token</h2></div><span>{turnTotals.length} 个轮次</span></header>
      <p className="analysis-pulse-note">按日志中的父级关系汇总脉冲，帮助回到当时的任务；没有轮次归属的脉冲不计入此表。</p>
      <ol>{(showTurns ? turnTotals : turnTotals.slice(0, 8)).map((turn) => <li key={idOf(turn.span)}>
        <div><strong>{spanHint(turn.span) || spanName(turn.span)}</strong><small>{turn.pulses} 个已记录脉冲 · +{timelineDuration(turn.span.startOffsetMs ?? 0)}</small></div>
        <span title={new Intl.NumberFormat("zh-CN").format(turn.total)}>{tokens(turn.total)}</span>
        <button onClick={() => openSpan(turn.span)}>定位轮次</button>
      </li>)}</ol>
      {!showTurns && <ExpandButton shown={8} total={turnTotals.length} onClick={() => setShowTurns(true)} />}
    </section>}
    <section className="analysis-panel token-pulses" aria-labelledby="token-pulses-title">
      <header><div><p>SAMPLED PULSES</p><h2 id="token-pulses-title">最大消耗事件</h2></div><span>{pulses.length ? `${pulses.length} 个采样脉冲` : "不可用"}</span></header>
      <p className="analysis-pulse-note">这是 Token 采样脉冲，不能归因到具体工具；父事件或 turn 仅作为关联上下文。</p>
      {visiblePulses.length ? <ol>{visiblePulses.map(({ span, total }, index) => <li key={span.id ?? span.spanId ?? index}><div><strong>{tokens(total)}</strong><span>{spanName(span)} · +{timelineDuration(span.startOffsetMs ?? 0)}</span><small>{parentContext(span, spans) ?? "未提供父事件或 turn 归属"}</small></div><EvidenceTag value={span.quality ?? run.quality?.token} /><button type="button" onClick={() => openSpan(span)}>定位 Trace</button></li>)}</ol> : <p className="analysis-empty">没有带 Token 增量的采样脉冲。</p>}
      {!showAll && <ExpandButton shown={INITIAL_PULSES} total={pulses.length} onClick={() => setShowAll(true)} />}
    </section>
  </section>;
}
