import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Link,
  Route,
  Routes,
  useParams,
  useLocation,
  useSearchParams,
} from "react-router-dom";
import { getRun, listRuns } from "./api";
import { dateTime, duration, number, titleCase, tokens, trackedTokenTotal, timelineDuration } from "./format";
import type { SessionRun, TraceSpan } from "./types";
import { Header, Library, initialFilters } from "./library";
import {
  contextRatio, conversationContent, ev, evidenceText, idOf, isConversationTurn,
  isTelemetryOnly, kindOf, lengthOf, nameOf, normalSpans, normalizeRunEvidence,
  runLabel, samples, skills, spanFallbackSummary, spanHint, startOf, totalDuration,
  verificationLabel,
} from "./session-model";
import { EvidenceTimeline, VirtualTraceTree } from "./trace-visualization";
import { SessionTools } from "./tool-chain";
import { SessionOverview, SessionTokens } from "./session-analysis";
import { Insights } from "./insights";
import { Markdown } from "./markdown";
import { parseTurn, type TurnBlock } from "./transcript";

function Metric({
  label,
  value,
  note,
  tone = "neutral",
}: {
  label: string;
  value: string;
  note?: string;
  tone?: "neutral" | "accent" | "warning" | "danger";
}) {
  return (
    <div className={`metric metric-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}
type TimeMapper = {
  at: (time: number) => number;
  from: (position: number) => number;
  ticks: Array<{ time: number; position: number }>;
  compressedGaps: number;
};
export function timeMapper(
  range: [number, number],
  spans: TraceSpan[],
  compress: boolean,
): TimeMapper {
  const [from, to] = range,
    length = Math.max(1, to - from);
  const isIdle = (span: TraceSpan) =>
    /idle[ _-]?gap|idle|空档/i.test(`${span.type ?? ""} ${span.name ?? ""}`) &&
    lengthOf(span) > 300_000;
  const explicitGaps = spans
    .filter(isIdle)
    .map(
      (span) =>
        [
          Math.max(from, startOf(span)),
          Math.min(to, startOf(span) + lengthOf(span)),
        ] as [number, number],
    )
    .filter(([start, end]) => end > start);
  const ordered = spans
    .filter((span) => !isIdle(span))
    .map(
      (span) =>
        [
          Math.max(from, startOf(span)),
          Math.min(to, startOf(span) + lengthOf(span)),
        ] as const,
    )
    .filter(([start, end]) => end >= from && start <= to)
    .sort((left, right) => left[0] - right[0]);
  const candidateGaps: Array<[number, number]> = [...explicitGaps];
  let occupiedUntil = from;
  for (const [start, end] of ordered) {
    if (start - occupiedUntil > 300_000)
      candidateGaps.push([occupiedUntil, start]);
    occupiedUntil = Math.max(occupiedUntil, end);
  }
  if (to - occupiedUntil > 300_000) candidateGaps.push([occupiedUntil, to]);
  const gaps = candidateGaps
    .sort((left, right) => left[0] - right[0])
    .reduce<Array<[number, number]>>((merged, gap) => {
      const previous = merged.at(-1);
      if (previous && gap[0] <= previous[1])
        previous[1] = Math.max(previous[1], gap[1]);
      else merged.push([...gap]);
      return merged;
    }, []);
  if (!compress || !gaps.length) {
    const at = (time: number) =>
      Math.max(0, Math.min(1, (time - from) / length));
    return {
      at,
      from: (position) => from + Math.max(0, Math.min(1, position)) * length,
      ticks: Array.from({ length: 6 }, (_, index) => ({
        time: from + (length * index) / 5,
        position: index / 5,
      })),
      compressedGaps: 0,
    };
  }
  const cuts = Array.from(new Set([from, to, ...gaps.flat()])).sort(
    (a, b) => a - b,
  );
  let shownAt = 0;
  const placed = cuts.slice(0, -1).map((rawStart, index) => {
    const rawEnd = cuts[index + 1],
      isGap = gaps.some(([start, end]) => start === rawStart && end === rawEnd),
      shown = isGap
        ? Math.min(90_000, Math.max(15_000, (rawEnd - rawStart) * 0.04))
        : rawEnd - rawStart;
    const result = {
      rawStart,
      rawEnd,
      shown,
      shownStart: shownAt,
      shownEnd: shownAt + shown,
    };
    shownAt += shown;
    return result;
  });
  const shownTotal = Math.max(1, shownAt);
  const at = (time: number) => {
    const value = Math.max(from, Math.min(to, time)),
      segment = placed.find((item) => value <= item.rawEnd) ?? placed.at(-1)!;
    return (
      (segment.shownStart +
        ((value - segment.rawStart) /
          Math.max(1, segment.rawEnd - segment.rawStart)) *
          segment.shown) /
      shownTotal
    );
  };
  const invert = (position: number) => {
    const shown = Math.max(0, Math.min(1, position)) * shownTotal,
      segment = placed.find((item) => shown <= item.shownEnd) ?? placed.at(-1)!;
    return (
      segment.rawStart +
      ((shown - segment.shownStart) / Math.max(1, segment.shown)) *
        (segment.rawEnd - segment.rawStart)
    );
  };
  return {
    at,
    from: invert,
    ticks: Array.from({ length: 6 }, (_, index) => ({
      time: invert(index / 5),
      position: index / 5,
    })),
    compressedGaps: gaps.length,
  };
}
function CursorLine({ position }: { position: number }) {
  return (
    <i
      className="timeline-cursor"
      data-testid="timeline-cursor"
      style={{ left: `${Math.max(0, Math.min(1, position)) * 100}%` }}
    />
  );
}
function boundedSpans(
  spans: TraceSpan[],
  limit: number,
  preserve: (span: TraceSpan) => boolean = () => false,
): TraceSpan[] {
  if (spans.length <= limit) return spans;
  const required = new Set(spans.filter(preserve));
  const remaining = spans.filter((span) => !required.has(span));
  const budget = Math.max(0, limit - required.size);
  for (let index = 0; index < budget; index++) required.add(remaining[Math.floor(index * remaining.length / budget)]);
  return spans.filter((span) => required.has(span));
}

function Minimap({
  spans,
  full,
  range,
  compressed,
  setRange,
}: {
  spans: TraceSpan[];
  full: number;
  range: [number, number];
  compressed: boolean;
  setRange: (range: [number, number]) => void;
}) {
  const mapper = timeMapper([0, full], spans, compressed),
    stride = Math.max(1, Math.ceil(spans.length / 240)),
    size = Math.max(1, range[1] - range[0]),
    left = mapper.at(range[0]) * 100,
    width = Math.max(1, (mapper.at(range[1]) - mapper.at(range[0])) * 100);
  const centerAt = (center: number) => {
    const start = Math.max(0, Math.min(full - size, center - size / 2));
    setRange([start, Math.min(full, start + size)]);
  };
  return (
    <div
      className="minimap"
      role="slider"
      aria-label="时间轴可见范围"
      aria-valuemin={0}
      aria-valuemax={Math.round(full)}
      aria-valuenow={Math.round(range[0])}
      tabIndex={0}
      data-testid="timeline-minimap"
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft")
          centerAt((range[0] + range[1]) / 2 - size * 0.15);
        if (event.key === "ArrowRight")
          centerAt((range[0] + range[1]) / 2 + size * 0.15);
      }}
      onClick={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        centerAt(
          mapper.from((event.clientX - box.left) / Math.max(1, box.width)),
        );
      }}
    >
      <span className="minimap-label">全局概览</span>
      <div className="minimap-track">
        {spans
          .filter((_, index) => index % stride === 0)
          .map((span, index) => (
            <i
              aria-hidden="true"
              key={idOf(span, index)}
              className={kindOf(span.type)}
              style={{ left: `${mapper.at(startOf(span)) * 100}%` }}
            />
          ))}
        <b
          aria-hidden="true"
          style={{ left: `${left}%`, width: `${width}%` }}
        />
      </div>
    </div>
  );
}


type TraceSection = "tools" | "tokens" | "overview" | "timeline" | "conversation" | "quality";
type TraceDensity = "summary" | "standard" | "full";

const traceSections: Array<{ id: TraceSection; label: string }> = [
  { id: "overview", label: "概览" },
  { id: "tokens", label: "Token 分析" },
  { id: "tools", label: "调用链" },
  { id: "timeline", label: "时间轴" },
  { id: "conversation", label: "对话" },
  { id: "quality", label: "质量" },
];

function spansAtDensity(
  spans: TraceSpan[],
  density: TraceDensity,
  selected?: TraceSpan,
): TraceSpan[] {
  if (density === "full") return spans;
  const selectedId = selected && idOf(selected);
  const preserve = (span: TraceSpan) => {
    const text = `${span.type ?? ""} ${span.name ?? ""}`;
    return (
      idOf(span) === selectedId ||
      span.status === "error" ||
      Boolean(span.error) ||
      kindOf(span.type) === "user" ||
      /correction|纠偏|compact/i.test(text)
    );
  };
  if (density === "standard") return boundedSpans(spans, 420, preserve);
  const ranked = spans
    .map((span, index) => ({
      span,
      index,
      score:
        lengthOf(span) +
        (trackedTokenTotal(span.tokenDelta ?? span.tokens) ?? 0) * 40,
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 32)
    .map(({ span }) => span);
  const keep = new Set([...spans.filter(preserve), ...ranked]);
  return spans.filter((span) => keep.has(span));
}

function TelemetryPanel({
  run,
  spans,
  mapper,
}: {
  run: SessionRun;
  spans: TraceSpan[];
  mapper: TimeMapper;
}) {
  const inRange = spans.filter((span) => startOf(span) >= mapper.from(0) && startOf(span) <= mapper.from(1));
  const tokenSource = inRange.filter((span) => trackedTokenTotal(span.tokenDelta ?? span.tokens) !== undefined);
  const peakTokens = Math.max(0, ...tokenSource.map((span) => trackedTokenTotal(span.tokenDelta ?? span.tokens) ?? 0));
  const tokenSpans = boundedSpans(tokenSource, 140, (span) => trackedTokenTotal(span.tokenDelta ?? span.tokens) === peakTokens);
  const tokenMaximum = Math.max(
    1,
    ...tokenSpans.map(
      (span) => trackedTokenTotal(span.tokenDelta ?? span.tokens) ?? 0,
    ),
  );
  const tokenPath = tokenSpans
    .map((span) => {
      const x = mapper.at(startOf(span)) * 100;
      const height = Math.max(
        2,
        ((trackedTokenTotal(span.tokenDelta ?? span.tokens) ?? 0) /
          tokenMaximum) *
          32,
      );
      return `M${x.toFixed(3)} 36V${(36 - height).toFixed(3)}`;
    })
    .join("");
  const context = samples(run, inRange).filter((sample) => sample.ratio !== undefined && (sample.offsetMs ?? 0) >= mapper.from(0) && (sample.offsetMs ?? 0) <= mapper.from(1));
  const contextStride = Math.max(1, Math.ceil(context.length / 180));
  const shownContext = context.filter(
    (_, index) => index % contextStride === 0,
  );
  const contextPath = shownContext
    .map(
      (sample, index) =>
        `${index ? "L" : "M"}${(mapper.at(sample.offsetMs ?? 0) * 100).toFixed(3)} ${(38 - (sample.ratio ?? 0) * 34).toFixed(3)}`,
    )
    .join("");
  const peak = contextRatio(run);
  return (
    <section className="telemetry-panel" aria-label="Token 与上下文证据">
      <div>
        <header>
          <strong>Token 变化</strong>
          <span>
            {tokenSpans.length ? `${tokenSpans.length} / ${tokenSource.length} 个可见变化` : "不可用"}
          </span>
        </header>
        <svg
          role="img"
          aria-label={`Token 变化分布，${tokenSpans.length} 个采样`}
          viewBox="0 0 100 40"
          preserveAspectRatio="none"
        >
          <path d={tokenPath} />
        </svg>
      </div>
      <div>
        <header>
          <strong>上下文压力</strong>
          <span>
            {peak === undefined ? "不可用" : `峰值 ${Math.round(peak * 100)}%`}
          </span>
        </header>
        <svg
          role="img"
          aria-label={
            peak === undefined
              ? "上下文压力不可用"
              : `上下文压力曲线，峰值 ${Math.round(peak * 100)}%`
          }
          viewBox="0 0 100 40"
          preserveAspectRatio="none"
        >
          <path d={contextPath} />
          <line x1="0" x2="100" y1="10.8" y2="10.8" />
        </svg>
      </div>
    </section>
  );
}

function renderEvidenceValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "不可用";
  if (typeof value === "string") {
    // Tool payloads are recorded as one-line JSON; indenting them is the
    // difference between scannable and unreadable.
    const trimmed = value.trim();
    if (/^[[{]/.test(trimmed)) {
      try {
        return JSON.stringify(JSON.parse(trimmed), null, 2);
      } catch {
        return value;
      }
    }
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function EvidenceInspector({
  run,
  span,
  spans,
  navSpans,
  choose,
  close,
}: {
  run: SessionRun;
  span?: TraceSpan;
  /** Every event, used to resolve parents and children that the current
   *  filter may have hidden. */
  spans: TraceSpan[];
  /** The events actually listed right now — prev/next must walk what the
   *  reader can see, otherwise "1 / 119" contradicts "显示 35 / 54". */
  navSpans: TraceSpan[];
  choose: (span: TraceSpan) => void;
  close: () => void;
}) {
  const tabs = [
    { id: "summary", label: "摘要" },
    { id: "evidence", label: "证据" },
    { id: "token", label: "Token" },
    { id: "relations", label: "关联" },
  ] as const;
  const [tab, setTab] = useState<(typeof tabs)[number]["id"]>("summary");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = span
    ? navSpans.findIndex(
        (candidate, index) => idOf(candidate, index) === idOf(span),
      )
    : -1;
  const parent = span?.parentId
    ? spans.find((candidate, index) => idOf(candidate, index) === span.parentId)
    : undefined;
  const children = span
    ? spans.filter((candidate) => candidate.parentId === idOf(span))
    : [];
  const adjacent = (offset: number) => {
    const next = navSpans[selectedIndex + offset];
    if (next) choose(next);
  };
  const onTabKey = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next =
      (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
      tabs.length;
    setTab(tabs[next].id);
    tabRefs.current[next]?.focus();
  };
  return (
    <aside
      className="evidence-inspector"
      data-testid="trace-inspector"
      data-workbench-region
      tabIndex={-1}
      aria-labelledby="inspector-title"
    >
      <header>
        <div>
          <span>INSPECTOR</span>
          <strong id="inspector-title">
            {span ? nameOf(span) : "事件详情"}
          </strong>
        </div>
        <button
          className="icon-button"
          aria-label="隐藏检查器"
          title="隐藏检查器"
          onClick={close}
        >
          ×
        </button>
      </header>
      {!span ? (
        <div className="inspector-empty">
          <span aria-hidden="true">⌖</span>
          <p>从时间轴或事件结构中选择证据。</p>
        </div>
      ) : (
        <>
          <div className="inspector-nav">
            <button onClick={() => adjacent(-1)} disabled={selectedIndex <= 0}>
              上一条
            </button>
            <span>
              {selectedIndex < 0 ? "未列出" : selectedIndex + 1} /{" "}
              {navSpans.length}
            </span>
            <button
              onClick={() => adjacent(1)}
              disabled={
                selectedIndex < 0 || selectedIndex >= navSpans.length - 1
              }
            >
              下一条
            </button>
          </div>
          <div className="inspector-tabs" role="tablist" aria-label="事件详情">
            {tabs.map((item, index) => (
              <button
                ref={(element) => {
                  tabRefs.current[index] = element;
                }}
                id={`inspector-tab-${item.id}`}
                aria-controls={`inspector-panel-${item.id}`}
                role="tab"
                tabIndex={tab === item.id ? 0 : -1}
                aria-selected={tab === item.id}
                key={item.id}
                onClick={() => setTab(item.id)}
                onKeyDown={(event) => onTabKey(event, index)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div
            className="inspector-content"
            id={`inspector-panel-${tab}`}
            role="tabpanel"
            aria-labelledby={`inspector-tab-${tab}`}
            tabIndex={0}
          >
            {tab === "summary" && (
              <>
                <div className="inspector-heading">
                  <span
                    className={`event-symbol ${kindOf(span.type)}`}
                    aria-hidden="true"
                  />
                  <div>
                    <h3>{nameOf(span)}</h3>
                    <p>
                      {span.summary?.trim() ||
                        spanHint(span) ||
                        spanFallbackSummary(span)}
                    </p>
                  </div>
                </div>
                <dl>
                  <dt>类型</dt>
                  <dd>{span.type ?? "—"}</dd>
                  <dt>时刻</dt>
                  <dd>{timelineDuration(startOf(span))}</dd>
                  <dt>时长</dt>
                  <dd>
                    {span.durationMs === undefined ? "未记录时长" : timelineDuration(span.durationMs)}
                  </dd>
                  <dt>状态</dt>
                  <dd
                    className={
                      span.status === "error" || span.error ? "danger" : ""
                    }
                  >
                    {span.status ?? (span.error ? "error" : "—")}
                  </dd>
                  <dt>证据质量</dt>
                  <dd>{ev(span.quality ?? run.quality?.trajectory)}</dd>
                </dl>
                {span.error && (
                  <pre className="error-block">
                    {renderEvidenceValue(span.error)}
                  </pre>
                )}
              </>
            )}
            {tab === "evidence" &&
              (() => {
                // Printing three "不可用" blocks for an event that recorded
                // nothing is worse than saying so once.
                const parts = (
                  [
                    ["Input", span.input],
                    ["Output", span.output],
                    ["Error", span.error],
                  ] as const
                ).filter(([, value]) => Boolean(value));
                if (!parts.length)
                  return (
                    <p className="muted">
                      这个事件没有记录输入、输出或错误摘录。
                    </p>
                  );
                return (
                  <div className="raw-evidence">
                    {parts.map(([label, value]) => (
                      <div key={label}>
                        <label>{label}</label>
                        <pre>{renderEvidenceValue(value)}</pre>
                      </div>
                    ))}
                  </div>
                );
              })()}
            {tab === "token" && (
              <>
                <dl>
                  {(
                    [
                      "inputUncached",
                      "cacheRead",
                      "cacheWrite",
                      "output",
                      "reasoning",
                    ] as const
                  ).map((key) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd>
                        {(span.tokenDelta ?? span.tokens)?.[key] === undefined
                          ? "—"
                          : number((span.tokenDelta ?? span.tokens)?.[key])}
                      </dd>
                    </div>
                  ))}
                </dl>
                <p className="muted">
                  Reasoning 是 output 的子集，不重复加入 tracked total。
                </p>
              </>
            )}
            {tab === "relations" && (
              <div className="relation-list">
                <h3>父事件</h3>
                {parent ? (
                  <button onClick={() => choose(parent)}>
                    {nameOf(parent)} <span>→</span>
                  </button>
                ) : (
                  <p className="muted">根事件或父级不可用</p>
                )}
                <h3>子事件</h3>
                {children.length ? (
                  children.map((child) => (
                    <button key={idOf(child)} onClick={() => choose(child)}>
                      {nameOf(child)} <span>→</span>
                    </button>
                  ))
                ) : (
                  <p className="muted">没有可观察的子事件</p>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

/** Turns run to 8KB, so long ones clamp to a readable height. Clamping by
 *  rendered height rather than by character count matters: slicing the source
 *  at N characters can cut a table or a code fence in half, which then renders
 *  as garbage instead of as a truncated block. */
const collapsedTurnHeight = 320;

function TurnClamp({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Measured before paint on the un-clamped first render, so there is no
  // flash of full-height content.
  useLayoutEffect(() => {
    const node = ref.current;
    if (node) setOverflows(node.scrollHeight > collapsedTurnHeight + 40);
  }, []);

  const clamped = overflows && !expanded;
  return (
    <>
      <div ref={ref} className={clamped ? "turn-clamp" : undefined}>
        {children}
      </div>
      {overflows && (
        <button
          className="turn-expand"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "收起" : "展开全文"}
        </button>
      )}
    </>
  );
}

function TurnBlocks({ blocks }: { blocks: TurnBlock[] }) {
  return (
    <>
      {blocks.map((block, index) => {
        if (block.kind === "markdown")
          return <Markdown key={index} text={block.text} />;
        if (block.kind === "command")
          return (
            <p key={index} className="turn-command">
              <code>
                {block.name}
                {block.args ? ` ${block.args}` : ""}
              </code>
            </p>
          );
        return (
          <details key={index} className="turn-note">
            <summary>{block.label}</summary>
            <Markdown text={block.text} />
          </details>
        );
      })}
    </>
  );
}

function TraceConversation({
  turns,
  choose,
}: {
  turns: TraceSpan[];
  choose: (span: TraceSpan) => void;
}) {
  const parsed = useMemo(
    () => turns.map((turn) => parseTurn(conversationContent(turn))),
    [turns],
  );
  return (
    <section className="conversation-view" aria-labelledby="conversation-title">
      <header>
        <div>
          <p className="eyebrow">TRANSCRIPT</p>
          <h2 id="conversation-title">对话</h2>
        </div>
        <span>{turns.length} 个可观察轮次</span>
      </header>
      {turns.length ? (
        <ol>
          {turns.map((turn, index) => {
            const turnData = parsed[index];
            const kind = kindOf(turn.type);
            // A turn carrying nothing but injected scaffolding was never the
            // operator speaking, so it must not be labelled 用户.
            const role = turnData.harnessOnly
              ? "系统"
              : kind === "user"
                ? "用户"
                : "Agent";
            return (
              <li
                key={idOf(turn, index)}
                className={turnData.harnessOnly ? "system" : kind}
              >
                <div className="turn-head">
                  <span className="turn-role">{role}</span>
                  {turnData.from && (
                    <span className="turn-from">{turnData.from}</span>
                  )}
                  {turnData.subject && (
                    <span className="turn-subject" title={turnData.subject}>
                      {turnData.subject}
                    </span>
                  )}
                  <time>{timelineDuration(startOf(turn))}</time>
                  <button
                    className="turn-locate"
                    onClick={() => choose(turn)}
                    title="在时间轴中定位这一轮"
                  >
                    在时间轴定位 →
                  </button>
                </div>
                <div className="turn-body">
                  <TurnClamp>
                    <TurnBlocks blocks={turnData.blocks} />
                  </TurnClamp>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="empty-inline">原始对话轮次不可用。</p>
      )}
    </section>
  );
}

function TraceQuality({ run }: { run: SessionRun }) {
  const qualityRows = [
    ["事件轨迹", run.quality?.trajectory],
    ["Token", run.quality?.token],
    ["工具", run.quality?.tools],
    ["上下文", run.quality?.context],
    ["纠偏", run.quality?.correction],
    ["Skill 归因", run.quality?.skills],
  ];
  return (
    <div className="quality-view">
      <section>
        <p className="eyebrow">EVIDENCE QUALITY</p>
        <h2>证据可信度</h2>
        <p>质量标签描述数据来源，不代表模型表现评分。墙钟来自记录时间；活跃与空档由可观察事件间隔推导。</p>
        <dl>
          {qualityRows.map(([label, quality]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{ev(quality)}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section>
        <p className="eyebrow">CORRECTIONS</p>
        <h2>纠偏候选</h2>
        {run.correctionSignals?.length ? (
          run.correctionSignals.map((signal) => (
            <article key={signal.type}>
              <strong>{titleCase(signal.type)}</strong>
              <span>{signal.count ?? "—"} 次候选</span>
              {ev(signal.quality)}
            </article>
          ))
        ) : (
          <p className="muted">不可用或未识别候选</p>
        )}
        <small>纠偏为启发式候选，不等于已确认的用户意图。</small>
      </section>
      <section>
        <p className="eyebrow">VERIFICATION</p>
        <h2>验证与限制</h2>
        <p>{run.verification?.summary ?? "验证信息不可用"}</p>
        {ev(run.verification?.quality ?? run.quality?.verification)}
        <h3>解析限制</h3>
        <ul>
          {(
            run.parseWarnings ?? ["缺失字段不按 0 处理；质量标签限定解释范围。"]
          ).map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function PolishedTrace() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const initialSection = params.get("view");
  const [run, setRun] = useState<SessionRun>();
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const section: TraceSection = traceSections.some((item) => item.id === initialSection)
    ? initialSection as TraceSection : params.get("focus") ? "timeline" : "overview";
  const [cursor, setCursor] = useState(0);
  const spanType = params.get("type") ?? "all";
  const onlyErrors = params.get("errors") === "1";
  const compressed = params.get("time") !== "real";
  const requestedDensity = params.get("density");
  const density: TraceDensity = requestedDensity === "summary" || requestedDensity === "standard" ? requestedDensity : "full";
  const search = params.get("event") ?? "";
  const toolName = params.get("tool") ?? "";
  const eventSearchRef = useRef<HTMLInputElement>(null);
  const [showTree, setShowTree] = useState(true);
  const [showInspector, setShowInspector] = useState(true);
  const [mobilePanel, setMobilePanel] = useState<
    "tree" | "timeline" | "inspector"
  >("timeline");
  const [treeWidth, setTreeWidth] = useState(
    () =>
      Number(window.localStorage.getItem("session-insight-tree-width")) || 248,
  );
  const [inspectorWidth, setInspectorWidth] = useState(
    () =>
      Number(window.localStorage.getItem("session-insight-inspector-width")) ||
      332,
  );
  const rawSpans = useMemo(() => (run ? normalSpans(run) : []), [run]);
  const full = run ? totalDuration(run, rawSpans) : 1;
  const requestedStart = Number(params.get("fromMs") ?? 0);
  const requestedEnd = Number(params.get("toMs") ?? full);
  const range = useMemo<[number, number]>(() => {
    const start = Math.max(0, Math.min(full, requestedStart));
    const end = Math.max(0, Math.min(full, requestedEnd));
    return Number.isFinite(start) && Number.isFinite(end) && end > start ? [start, end] : [0, full];
  }, [full, requestedStart, requestedEnd]);
  const selected = useMemo(() => rawSpans.find((span) => idOf(span) === params.get("focus"))
    ?? rawSpans.find((span) => span.status === "error" || Boolean(span.error)) ?? rawSpans[0], [params, rawSpans]);
  const showTelemetry = params.get("telemetry") === "1" || Boolean(params.get("focus") && selected && isTelemetryOnly(selected));
  useEffect(() => { setCursor(startOf(selected ?? {})); }, [selected]);
  const matchesSearch = (span: TraceSpan) => [nameOf(span), span.type, span.tool, span.skill, span.input, span.output, span.error, span.summary, span.id]
    .filter(Boolean).join(" ").toLowerCase().includes(search.trim().toLowerCase());


  const updateQuery = useCallback(
    (patch: Record<string, string | undefined>) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          Object.entries(patch).forEach(([key, value]) =>
            value ? next.set(key, value) : next.delete(key),
          );
          return next;
        },
        { replace: true, state: location.state },
      );
    },
    [setParams, location.state],
  );

  const choose = (span: TraceSpan, reveal = false) => {
    setCursor(startOf(span));
    setShowInspector(true);
    setShowTree(true);
    setMobilePanel("inspector");
    const outside = startOf(span) < range[0] || startOf(span) > range[1];
    updateQuery({
      focus: idOf(span),
      view: reveal ? "timeline" : section,
      telemetry: isTelemetryOnly(span) || showTelemetry ? "1" : undefined,
      type: spanType !== "all" && kindOf(span.type) !== spanType ? undefined : params.get("type") ?? undefined,
      errors: onlyErrors && !(span.status === "error" || span.error) ? undefined : params.get("errors") ?? undefined,
      event: search && !matchesSearch(span) ? undefined : search || undefined,
      tool: toolName && span.tool !== toolName ? undefined : toolName || undefined,
      fromMs: outside ? undefined : params.get("fromMs") ?? undefined,
      toMs: outside ? undefined : params.get("toMs") ?? undefined,
    });
  };

  useEffect(() => {
    let live = true;
    setError("");
    setRun(undefined);
    void getRun(id)
      .then((source) => {
        if (!live) return;
        const next = normalizeRunEvidence(source);
        setRun(next);
      })
      .catch(
        (caught) =>
          live &&
          setError(caught instanceof Error ? caught.message : "加载失败"),
      );
    return () => {
      live = false;
    };
  }, [id, reload]);

  useEffect(() => {
    window.localStorage.setItem(
      "session-insight-tree-width",
      String(treeWidth),
    );
    window.localStorage.setItem(
      "session-insight-inspector-width",
      String(inspectorWidth),
    );
  }, [inspectorWidth, treeWidth]);

  const setSection = (next: TraceSection) => {
    updateQuery({ view: next, focus: next === "timeline" ? params.get("focus") ?? undefined : undefined });
  };
  const setRange = (next: [number, number]) => {
    updateQuery({
      fromMs: next[0] <= 0 ? undefined : String(Math.round(next[0])),
      toMs: next[1] >= full ? undefined : String(Math.round(next[1])),
    });
  };
  const setDensity = (next: TraceDensity) => {
    updateQuery({ density: next === "full" ? undefined : next });
  };
  const setSpanType = (next: string) => {
    updateQuery({ type: next === "all" ? undefined : next });
  };
  const setOnlyErrors = (next: boolean) => {
    updateQuery({ errors: next ? "1" : undefined });
  };
  const setCompressed = (next: boolean) => {
    updateQuery({ time: next ? undefined : "real" });
  };
  const setSearch = (next: string) => {
    updateQuery({ event: next || undefined });
  };
  const telemetryCount = useMemo(
    () => rawSpans.filter(isTelemetryOnly).length,
    [rawSpans],
  );
  const signalSpans = useMemo(
    () =>
      showTelemetry ? rawSpans : rawSpans.filter((span) => !isTelemetryOnly(span)),
    [rawSpans, showTelemetry],
  );
  const filteredSpans = useMemo(() => signalSpans.filter((span) =>
    (spanType === "all" || kindOf(span.type) === spanType) &&
    (!onlyErrors || span.status === "error" || Boolean(span.error)) &&
    (!toolName || span.tool === toolName) && (!search || matchesSearch(span))),
  [signalSpans, spanType, onlyErrors, toolName, search]);
  const spans = useMemo(() => search || toolName || onlyErrors || spanType !== "all" ? filteredSpans : spansAtDensity(filteredSpans, density, selected), [filteredSpans, density, selected, search, toolName, onlyErrors, spanType]);
  const matches = useMemo(() => search ? rawSpans.filter(matchesSearch) : [], [rawSpans, search]);
  const errors = useMemo(
    () =>
      rawSpans.filter((span) => span.status === "error" || Boolean(span.error)),
    [rawSpans],
  );
  const mapper = useMemo(
    () => timeMapper(range, rawSpans, compressed),
    [compressed, range, rawSpans],
  );
  const turns = useMemo(
    () =>
      (run?.turns?.length ? run.turns : rawSpans)
        .filter(isConversationTurn)
        .sort((left, right) => startOf(left) - startOf(right)),
    [rawSpans, run?.turns],
  );

  const stepThrough = (items: TraceSpan[], direction = 1) => {
    if (!items.length) return;
    const current = selected
      ? items.findIndex((span) => idOf(span) === idOf(selected))
      : -1;
    choose(items[(current + direction + items.length) % items.length], true);
  };
  const zoom = (scale: number) => {
    const size = range[1] - range[0];
    const nextSize = Math.min(full, Math.max(Math.min(100, full), size * scale));
    const midpoint = (range[0] + range[1]) / 2;
    const start = Math.max(
      0,
      Math.min(full - nextSize, midpoint - nextSize / 2),
    );
    setRange([start, Math.min(full, start + nextSize)]);
  };
  const beginResize = (
    event: React.PointerEvent<HTMLButtonElement>,
    side: "tree" | "inspector",
  ) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const origin = event.clientX;
    const initial = side === "tree" ? treeWidth : inspectorWidth;
    const move = (next: PointerEvent) => {
      const delta = (next.clientX - origin) * (side === "tree" ? 1 : -1);
      const value = Math.max(
        side === "tree" ? 208 : 280,
        Math.min(side === "tree" ? 360 : 460, initial + delta),
      );
      if (side === "tree") setTreeWidth(value);
      else setInspectorWidth(value);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  };
  const resizeByKeyboard = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    side: "tree" | "inspector",
  ) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta =
      (event.key === "ArrowRight" ? 16 : -16) * (side === "tree" ? 1 : -1);
    if (side === "tree")
      setTreeWidth((value) => Math.max(208, Math.min(360, value + delta)));
    else
      setInspectorWidth((value) => Math.max(280, Math.min(460, value + delta)));
  };

  useEffect(() => {
    const navigateRegions = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "f" &&
        section === "timeline"
      ) {
        event.preventDefault();
        eventSearchRef.current?.focus();
        eventSearchRef.current?.select();
        return;
      }
      if (event.key === "F8" && errors.length) {
        event.preventDefault();
        stepThrough(errors);
        return;
      }
      if (event.key !== "F6") return;
      const regions = Array.from(
        document.querySelectorAll<HTMLElement>("[data-workbench-region]"),
      );
      if (!regions.length) return;
      event.preventDefault();
      const active = regions.findIndex(
        (region) =>
          region === document.activeElement ||
          region.contains(document.activeElement),
      );
      regions[(active + 1) % regions.length]?.focus();
    };
    window.addEventListener("keydown", navigateRegions);
    return () => window.removeEventListener("keydown", navigateRegions);
  });

  if (error)
    return (
      <main id="main-content" className="workspace">
        <section className="state-panel">
          <p className="eyebrow">TRACE UNAVAILABLE</p>
          <h1>无法加载这个 session</h1>
          <p role="alert">{error}</p>
          <div className="page-actions">
            <Link to="/">返回会话库</Link>
            <button onClick={() => setReload((value) => value + 1)}>
              重试
            </button>
          </div>
        </section>
      </main>
    );
  if (!run)
    return (
      <main id="main-content" className="workspace">
        <p className="loading-state" role="status">
          正在加载 Trace…
        </p>
      </main>
    );

  const sessionName = run.sourceSessionId ?? run.sessionRef ?? run.id;
  const riskCount =
    Number((run.counts?.toolFailures ?? 0) > 0) +
    Number((contextRatio(run) ?? 0) >= 0.8) +
    Number((run.counts?.corrections ?? 0) > 0);
  const studioStyle = {
    "--tree-width": `${treeWidth}px`,
    "--inspector-width": `${inspectorWidth}px`,
  } as React.CSSProperties;
  return (
    <main
      id="main-content"
      className="trace-product"
      data-testid="session-detail"
    >
      <header className="session-context">
        <Link className="back-link" to={typeof location.state?.librarySearch === "string" ? `/${location.state.librarySearch}` : "/"} aria-label="返回会话库">
          ←
        </Link>
        <div className="session-identity">
          <p>
            {run.provider ?? "agent"} <span>·</span> {run.model ?? "模型不可用"}
          </p>
          <h1>{runLabel(run)}</h1>
          <div>
            <time>{dateTime(run.startedAt)}</time>
            {run.importedAt && <span title="继续产生的日志需要重新扫描或导入后更新分析">分析快照 {dateTime(run.importedAt)}</span>}
            {run.title?.trim() && run.project && <span>{run.project}</span>}
            <code title={sessionName}>{sessionName}</code>
          </div>
        </div>
        <div className="session-context-actions">
          <span className={riskCount ? "session-risk" : "session-ok"}>
            {riskCount ? `${riskCount} 类待查信号` : "未记录风险信号"}
          </span>
          <Link to={`/report?run=${encodeURIComponent(run.id)}`}>生成报告</Link>
          <details>
            <summary aria-label="更多操作">•••</summary>
            <div>
              <button
                onClick={() =>
                  navigator.clipboard?.writeText(window.location.href)
                }
              >
                复制当前链接
              </button>
              <Link to={`/compare?a=${encodeURIComponent(run.id)}`}>
                加入对比
              </Link>
            </div>
          </details>
        </div>
      </header>

      <div className="session-summary" aria-label="Session 摘要">
        <div>
          <span>总耗时</span>
          <strong>{duration(run.wallDurationMs ?? run.durationMs)}</strong>
          <small>活跃 {duration(run.activeDurationMs)}</small>
        </div>
        <div>
          <span>可追踪 Token</span>
          <strong>{tokens(trackedTokenTotal(run.tokens))}</strong>
          <small>{evidenceText[run.quality?.token ?? "unknown"]}</small>
        </div>
        <div>
          <span>工具调用</span>
          <strong>
            {run.counts?.tools === undefined ? "—" : number(run.counts.tools)}
          </strong>
          <small className={run.counts?.toolFailures ? "danger" : ""}>
            {run.counts?.toolFailures ?? "—"} 个失败
          </small>
        </div>
        <div>
          <span>上下文峰值</span>
          <strong>
            {contextRatio(run) === undefined
              ? "—"
              : `${Math.round(contextRatio(run)! * 100)}%`}
          </strong>
          <small>{evidenceText[run.quality?.context ?? "unknown"]}</small>
        </div>
      </div>

      <nav className="session-tabs" aria-label="Session 详情视图">
        {traceSections.map((item) => (
          <button
            key={item.id}
            aria-current={section === item.id ? "page" : undefined}
            onClick={() => setSection(item.id)}
          >
            {item.label}
            {item.id === "timeline" && errors.length > 0 ? (
              <span>{errors.length}</span>
            ) : null}
          </button>
        ))}
      </nav>

      {section === "overview" && (
        <SessionOverview run={run} spans={rawSpans} openSpan={(span) => choose(span, true)}
          openTokens={() => setSection("tokens")}
          openTool={(tool) => updateQuery({ view: "tools", callTool: tool, callResult: undefined, callQuery: undefined, callPage: undefined })} />
      )}
      {section === "tools" && <SessionTools run={run} spans={rawSpans} openSpan={(span) => choose(span, true)} />}
      {section === "tokens" && <SessionTokens run={run} spans={rawSpans} openSpan={(span) => choose(span, true)} />}
      {section === "conversation" && (
        <TraceConversation
          turns={turns}
          choose={(span) => choose(span, true)}
        />
      )}
      {section === "quality" && <TraceQuality run={run} />}
      {section === "timeline" && (
        <section className="timeline-workbench" aria-label="Trace 时间轴工作台">
          <div className="workbench-toolbar">
            <div className="event-search">
              <input
                ref={eventSearchRef}
                type="search"
                name="event-search"
                autoComplete="off"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter")
                    stepThrough(matches, event.shiftKey ? -1 : 1);
                }}
                placeholder="搜索命令、输入、输出或错误…"
                aria-label="搜索事件"
              />
              <span aria-live="polite">{search ? `${filteredSpans.length} 条` : "⌘F"}</span>
              {search && <button aria-label="下一个搜索结果" disabled={!matches.length} onClick={() => stepThrough(matches)}>↓</button>}
            </div>
            <div className="toolbar-group">
              <label>
                密度
                <select
                  aria-label="事件密度"
                  value={density}
                  onChange={(event) =>
                    setDensity(event.target.value as TraceDensity)
                  }
                >
                  <option value="full">完整事件</option>
                  <option value="standard">标准采样</option>
                  <option value="summary">重点摘要</option>
                </select>
              </label>
              <label>
                类型
                <select
                  aria-label="事件类型"
                  value={spanType}
                  onChange={(event) => setSpanType(event.target.value)}
                >
                  <option value="all">全部</option>
                  <option value="tool">工具</option>
                  <option value="model">模型</option>
                  <option value="user">用户</option>
                  <option value="other">其他</option>
                </select>
              </label>
              <button
                aria-pressed={onlyErrors}
                className={onlyErrors ? "is-active" : ""}
                onClick={() => setOnlyErrors(!onlyErrors)}
              >
                仅失败
              </button>
              {telemetryCount > 0 && (
                <button
                  data-testid="toggle-telemetry"
                  aria-pressed={showTelemetry}
                  className={showTelemetry ? "is-active" : ""}
                  title="Token pulse 与空 Reasoning 只驱动下方图表，默认不占用事件列表"
                  onClick={() => {
                    const next = !showTelemetry;
                    updateQuery({ telemetry: next ? "1" : undefined, focus: !next && selected && isTelemetryOnly(selected) ? undefined : params.get("focus") ?? undefined });
                  }}
                >
                  遥测事件 {telemetryCount}
                </button>
              )}
              {Object.keys(run.toolCounts ?? {}).length > 0 && <label>工具
                <select aria-label="工具名称" value={toolName} onChange={(event) => updateQuery({ tool: event.target.value || undefined })}>
                  <option value="">全部工具</option>
                  {Object.keys(run.toolCounts ?? {}).sort().map((tool) => <option key={tool} value={tool}>{tool}</option>)}
                </select>
              </label>}
              {errors.length > 0 && (
                <button onClick={() => stepThrough(errors)}>
                  下一个失败 <kbd>F8</kbd>
                </button>
              )}
            </div>
            <div className="toolbar-group time-controls">
              <button onClick={() => setRange([0, full])}>适应窗口</button>
              <button
                className="icon-button"
                aria-label="放大时间轴"
                title="放大时间轴"
                onClick={() => zoom(0.65)}
              >
                ＋
              </button>
              <button
                className="icon-button"
                aria-label="缩小时间轴"
                title="缩小时间轴"
                onClick={() => zoom(1.5)}
              >
                −
              </button>
              <div className="segmented">
                <button
                  data-testid="compressed-time"
                  aria-pressed={compressed}
                  className={compressed ? "is-active" : ""}
                  onClick={() => setCompressed(true)}
                >
                  压缩空档
                </button>
                <button
                  data-testid="real-time"
                  aria-pressed={!compressed}
                  className={!compressed ? "is-active" : ""}
                  onClick={() => setCompressed(false)}
                >
                  真实时间
                </button>
              </div>
            </div>
            <div className="toolbar-group pane-controls">
              <button
                aria-pressed={showTree}
                onClick={() => setShowTree(!showTree)}
              >
                结构
              </button>
              <button
                aria-pressed={showInspector}
                onClick={() => setShowInspector(!showInspector)}
              >
                检查器
              </button>
            </div>
          </div>
          <Minimap
            spans={rawSpans}
            full={full}
            range={range}
            compressed={compressed}
            setRange={setRange}
          />
          <div
            className="mobile-workbench-tabs"
            role="tablist"
            aria-label="工作台面板"
          >
            {(["tree", "timeline", "inspector"] as const).map((panel) => (
              <button
                key={panel}
                role="tab"
                aria-selected={mobilePanel === panel}
                onClick={() => setMobilePanel(panel)}
              >
                {panel === "tree"
                  ? "结构"
                  : panel === "timeline"
                    ? "时间轴"
                    : "检查器"}
              </button>
            ))}
          </div>
          <div
            className="trace-studio"
            style={studioStyle}
            data-tree={showTree ? "shown" : "hidden"}
            data-inspector={showInspector ? "shown" : "hidden"}
            data-mobile-panel={mobilePanel}
          >
            {showTree && (
              <div className="tree-pane" data-workbench-region tabIndex={-1}>
                <VirtualTraceTree
                  spans={spans}
                  selectedId={selected && idOf(selected)}
                  choose={choose}
                  idOf={idOf}
                  nameOf={nameOf}
                  hintOf={spanHint}
                  kindOf={kindOf}
                  startOf={startOf}
                  lengthOf={lengthOf}
                  formatDuration={timelineDuration}
                />
              </div>
            )}
            {showTree && (
              <button
                className="pane-splitter tree-splitter"
                role="separator"
                aria-label="调整事件结构宽度"
                aria-orientation="vertical"
                aria-valuenow={treeWidth}
                onPointerDown={(event) => beginResize(event, "tree")}
                onKeyDown={(event) => resizeByKeyboard(event, "tree")}
              />
            )}
            <div className="timeline-pane" data-workbench-region tabIndex={-1}>
              <div className="timeline-status" role="status">
                <span>
                  显示 {spans.length} / {signalSpans.length} 个事件
                  {!showTelemetry && telemetryCount > 0 && (
                    <em className="muted">
                      （另有 {telemetryCount} 个遥测事件未列出）
                    </em>
                  )}
                </span>
                {(search || toolName || spanType !== "all" || onlyErrors || density !== "full") && <button onClick={() => updateQuery({ event: undefined, tool: undefined, type: undefined, errors: undefined, density: undefined })}>显示全部事件</button>}
                <span>光标 {timelineDuration(cursor)}</span>
              </div>
              {spans.length === 0 && <p className="empty-inline">没有匹配事件。清除筛选或打开遥测事件后重试。</p>}
              <EvidenceTimeline
                spans={spans}
                mapper={mapper}
                selectedId={selected && idOf(selected)}
                choose={choose}
                cursor={cursor}
                setCursor={setCursor}
                idOf={idOf}
                nameOf={nameOf}
                kindOf={kindOf}
                startOf={startOf}
                lengthOf={lengthOf}
                formatDuration={timelineDuration}
              />
              <TelemetryPanel run={run} spans={rawSpans} mapper={mapper} />
            </div>
            {showInspector && (
              <button
                className="pane-splitter inspector-splitter"
                role="separator"
                aria-label="调整检查器宽度"
                aria-orientation="vertical"
                aria-valuenow={inspectorWidth}
                onPointerDown={(event) => beginResize(event, "inspector")}
                onKeyDown={(event) => resizeByKeyboard(event, "inspector")}
              />
            )}
            {showInspector && (
              <EvidenceInspector
                run={run}
                span={selected}
                spans={rawSpans}
                navSpans={spans}
                choose={choose}
                close={() => setShowInspector(false)}
              />
            )}
          </div>
        </section>
      )}
    </main>
  );
}

function useDetails(ids: string[]) {
  const [runs, setRuns] = useState<SessionRun[]>([]);
  const key = ids.filter(Boolean).join("|");
  useEffect(() => {
    let live = true;
    const sourceIds = key ? key.split("|") : [];
    if (!sourceIds.length) {
      setRuns([]);
      return () => {
        live = false;
      };
    }
    void Promise.all(sourceIds.map(getRun))
      .then((value) => live && setRuns(value.map(normalizeRunEvidence)))
      .catch(() => live && setRuns([]));
    return () => {
      live = false;
    };
  }, [key]);
  return runs;
}
function useDetailState(ids: string[]) {
  const [runs, setRuns] = useState<SessionRun[]>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const key = ids.filter(Boolean).join("|");
  const load = useCallback(async () => {
    const sourceIds = key ? key.split("|") : [];
    if (!sourceIds.length) {
      setRuns([]);
      setError("");
      return;
    }
    setLoading(true);
    try {
      setRuns(
        (await Promise.all(sourceIds.map(getRun))).map(normalizeRunEvidence),
      );
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [key]);
  useEffect(() => {
    void load();
  }, [load]);
  return { runs, loading, error, retry: load };
}
const runOptionLabel = (run: SessionRun) =>
  `${runLabel(run)} · ${run.provider ?? "未知来源"}/${run.model ?? "未知模型"} · ${dateTime(run.startedAt)}`;
function Difference({
  left,
  right,
  filter,
}: {
  left: SessionRun;
  right: SessionRun;
  filter: (value: string) => void;
}) {
  const keys = Array.from(
    new Set([
      ...Object.keys(left.toolCounts ?? {}),
      ...Object.keys(right.toolCounts ?? {}),
      ...skills(left).map((item) => `skill:${item.name}`),
      ...skills(right).map((item) => `skill:${item.name}`),
    ]),
  );
  return (
    <section className="difference">
      <h2>工具与 Skill 差异</h2>
      <div className="table-shell">
        <table>
          <thead>
            <tr>
              <th>类别</th>
              <th>名称</th>
              <th>基线</th>
              <th>候选</th>
              <th>Δ</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => {
              const skill = key.startsWith("skill:"),
                name = skill ? key.slice(6) : key,
                l = skill
                  ? skills(left).find((item) => item.name === name)?.count
                  : left.toolCounts?.[name]?.calls,
                r = skill
                  ? skills(right).find((item) => item.name === name)?.count
                  : right.toolCounts?.[name]?.calls,
                lObserved =
                  l !== undefined &&
                  (skill ||
                    Object.prototype.hasOwnProperty.call(
                      left.toolCounts ?? {},
                      name,
                    )),
                rObserved =
                  r !== undefined &&
                  (skill ||
                    Object.prototype.hasOwnProperty.call(
                      right.toolCounts ?? {},
                      name,
                    ));
              return (
                <tr key={key}>
                  <td>{skill ? "Skill" : "Tool"}</td>
                  <td>
                    <button
                      className="difference-filter"
                      onClick={() => filter(name)}
                    >
                      {name}
                    </button>
                  </td>
                  <td>
                    {lObserved ? l : <span className="muted">— · 未观测</span>}
                  </td>
                  <td>
                    {rObserved ? r : <span className="muted">— · 未观测</span>}
                  </td>
                  <td>{lObserved && rObserved ? r! - l! : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function usePagedRuns() {
  const [runs, setRuns] = useState<SessionRun[]>([]),
    [cursor, setCursor] = useState<string>(),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const load = useCallback(
    async (append = false) => {
      setLoading(true);
      try {
        const response = await listRuns(
            initialFilters,
            append ? cursor : undefined,
          ),
          normalized = response.runs.map(normalizeRunEvidence);
        setRuns((current) =>
          append ? [...current, ...normalized] : normalized,
        );
        setCursor(response.nextCursor ?? undefined);
        setError("");
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "加载失败");
      } finally {
        setLoading(false);
      }
    },
    [cursor],
  );
  useEffect(() => {
    void load(false);
  }, []);
  return {
    runs,
    cursor,
    loading,
    error,
    retry: () => load(false),
    loadMore: () => load(true),
  };
}

function compareNumberDelta(left?: number, right?: number) {
  return left === undefined || right === undefined
    ? "—"
    : `${right - left >= 0 ? "+" : ""}${number(right - left)}`;
}
function compareDurationDelta(left?: number, right?: number) {
  return left === undefined || right === undefined
    ? "—"
    : `${right - left >= 0 ? "+" : "−"}${timelineDuration(Math.abs(right - left))}`;
}
function compareRatioDelta(left?: number, right?: number) {
  return left === undefined || right === undefined
    ? "—"
    : `${right - left >= 0 ? "+" : ""}${((right - left) * 100).toFixed(1)} pp`;
}
export function formatCompareTick(value: number, crossDay: boolean) {
  return new Date(value).toLocaleString(
    "zh-CN",
    crossDay
      ? {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }
      : {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        },
  );
}

function CompareLane({
  run,
  normalized,
  commonStart,
  commonEnd,
  cursor,
  setCursor,
  focus,
}: {
  run: SessionRun;
  normalized: boolean;
  commonStart: number;
  commonEnd: number;
  cursor: number;
  setCursor: (value: number) => void;
  focus: string;
}) {
  const source = normalSpans(run),
    total = totalDuration(run, source),
    runStart = run.startedAt ? new Date(run.startedAt).getTime() : commonStart,
    filtered = focus
      ? source.filter((span) =>
          `${nameOf(span)} ${span.tool ?? ""} ${span.skill ?? ""}`
            .toLowerCase()
            .includes(focus.toLowerCase()),
        )
      : source,
    shown = boundedSpans(
      filtered,
      260,
      (span) => span.status === "error" || Boolean(span.error),
    ),
    context = samples(run, source),
    scale = Math.max(1, commonEnd - commonStart);
  const position = (offset: number) =>
    normalized
      ? Math.max(0, Math.min(1, offset / Math.max(1, total)))
      : Math.max(0, Math.min(1, (runStart + offset - commonStart) / scale));
  const current = normalized
    ? cursor
    : Math.max(0, Math.min(1, (cursor - commonStart) / scale));
  const update = (event: React.PointerEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect(),
      ratio = Math.max(
        0,
        Math.min(1, (event.clientX - box.left) / Math.max(1, box.width)),
      );
    setCursor(normalized ? ratio : commonStart + ratio * scale);
  };
  const tokenEvents = shown.filter(
      (span) => trackedTokenTotal(span.tokenDelta ?? span.tokens) !== undefined,
    ),
    tokenMax = Math.max(
      1,
      ...tokenEvents.map(
        (span) => trackedTokenTotal(span.tokenDelta ?? span.tokens) ?? 0,
      ),
    ),
    contextPoints = context
      .map(
        (sample) =>
          `${position(sample.offsetMs ?? 0) * 100},${100 - (sample.ratio ?? 0) * 100}`,
      )
      .join(" ");
  const crossDay =
      new Date(commonStart).toDateString() !==
      new Date(commonEnd).toDateString(),
    tick = (value: number) => formatCompareTick(value, crossDay);
  return (
    <section className="compare-lane" data-testid={`compare-lane-${run.id}`}>
      <header>
        <div>
          <strong>{runLabel(run)}</strong>
          <small>
            {run.provider ?? "—"} · {run.model ?? "模型不可用"}
          </small>
        </div>
        <span>
          {normalized ? "标准化 0–100%" : "共同真实时间"} · {duration(total)}
        </span>
      </header>
      <div className="compare-axis">
        <span>{normalized ? "0%" : tick(commonStart)}</span>
        <span>{normalized ? "50%" : tick(commonStart + scale / 2)}</span>
        <span>{normalized ? "100%" : tick(commonEnd)}</span>
      </div>
      <div
        className="compare-bars"
        role="img"
        aria-label={`${run.sourceSessionId ?? run.id} 的事件分布，共 ${filtered.length} 个事件`}
        onPointerMove={update}
      >
        {shown.map((span, index) => {
          const left = position(startOf(span)),
            right = position(startOf(span) + lengthOf(span));
          return (
            <i
              aria-hidden="true"
              key={idOf(span, index)}
              data-timeline-position={(left * 100).toFixed(3)}
              data-span-id={idOf(span, index)}
              className={kindOf(span.type)}
              title={nameOf(span)}
              style={{
                left: `${left * 100}%`,
                width: `${Math.max(0.45, (right - left) * 100)}%`,
              }}
            />
          );
        })}
        <CursorLine position={current} />
      </div>
      <div className="compare-sublane">
        <strong>Token</strong>
        <div
          role="img"
          aria-label={`${tokenEvents.length} 个 Token 变化`}
          data-testid="compare-token-pulse"
          onPointerMove={update}
        >
          {boundedSpans(tokenEvents, 160).map((span, index) => (
            <i
              aria-hidden="true"
              key={idOf(span, index)}
              className="model"
              data-timeline-position={(position(startOf(span)) * 100).toFixed(
                3,
              )}
              style={{
                left: `${position(startOf(span)) * 100}%`,
                height: `${Math.max(12, ((trackedTokenTotal(span.tokenDelta ?? span.tokens) ?? 0) / tokenMax) * 100)}%`,
              }}
            />
          ))}
          <CursorLine position={current} />
        </div>
        <small>{tokenEvents.length} 个变化</small>
      </div>
      <div className="compare-sublane">
        <strong>上下文</strong>
        <div
          className="compare-context"
          role="img"
          aria-label={`上下文峰值 ${contextRatio(run) === undefined ? "不可用" : `${Math.round(contextRatio(run)! * 100)}%`}`}
          onPointerMove={update}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
          >
            {contextPoints && (
              <polyline
                points={contextPoints}
                fill="none"
                stroke="currentColor"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
          <CursorLine position={current} />
        </div>
        <small>
          {contextRatio(run) === undefined
            ? "—"
            : `${Math.round(contextRatio(run)! * 100)}% 峰值`}
        </small>
      </div>
      <div className="compare-markers">
        <strong>质量</strong>
        <div>
          {shown
            .filter(
              (span) =>
                span.status === "error" ||
                Boolean(span.error) ||
                /correction|纠偏/i.test(`${span.type} ${span.name}`),
            )
            .map((span, index) => (
              <i
                aria-hidden="true"
                key={idOf(span, index)}
                className={
                  span.status === "error" || span.error ? "error" : "correction"
                }
                title={nameOf(span)}
                style={{ left: `${position(startOf(span)) * 100}%` }}
              />
            ))}
          <CursorLine position={current} />
        </div>
        <small>失败 / 纠偏</small>
      </div>
    </section>
  );
}

function PolishedCompare() {
  const [params, setParams] = useSearchParams(),
    a = params.get("a") ?? "",
    b = params.get("b") ?? "",
    library = usePagedRuns(),
    detail = useDetailState([a, b]),
    pair = detail.runs,
    [normalized, setNormalized] = useState(params.get("time") !== "real"),
    [focus, setFocus] = useState(params.get("filter") ?? ""),
    [cursor, setCursor] = useState(0.5);
  const updateParams = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    Object.entries(patch).forEach(([key, value]) =>
      value ? next.set(key, value) : next.delete(key),
    );
    setParams(next, { replace: true });
  };
  const choose = (key: "a" | "b", value: string) =>
    updateParams({ [key]: value || undefined });
  const picker = (
    <div className="compare-pickers">
      {(["a", "b"] as const).map((key) => (
        <label key={key}>
          {key === "a" ? "基线" : "候选"}
          <select
            aria-label={`${key === "a" ? "基线" : "候选"} session`}
            value={key === "a" ? a : b}
            onChange={(event) => choose(key, event.target.value)}
          >
            <option value="">选择 session</option>
            {library.runs.map((run) => (
              <option
                disabled={key === "a" ? run.id === b : run.id === a}
                key={run.id}
                value={run.id}
              >
                {runOptionLabel(run)}
              </option>
            ))}
          </select>
        </label>
      ))}
      {library.cursor && (
        <button
          data-testid="compare-load-more"
          onClick={() => void library.loadMore()}
          disabled={library.loading}
        >
          加载更多 session
        </button>
      )}
    </div>
  );
  if (library.error && !library.runs.length)
    return (
      <main id="main-content" className="workspace">
        <section className="state-panel">
          <p className="eyebrow">COMPARE UNAVAILABLE</p>
          <h1>无法加载 session 列表</h1>
          <p role="alert">{library.error}</p>
          <button onClick={library.retry}>重试</button>
        </section>
      </main>
    );
  if (detail.error)
    return (
      <main id="main-content" className="workspace">
        <section className="state-panel">
          <p className="eyebrow">COMPARE UNAVAILABLE</p>
          <h1>无法加载对比证据</h1>
          <p role="alert">{detail.error}</p>
          <button onClick={detail.retry}>重试</button>
        </section>
      </main>
    );
  if (a && b && detail.loading && pair.length < 2)
    return (
      <main id="main-content" className="workspace">
        <p className="loading-state" role="status">
          正在对齐两个 session...
        </p>
      </main>
    );
  if (pair.length < 2)
    return (
      <main id="main-content" className="workspace compare-empty">
        <div className="page-heading">
          <div>
            <p className="eyebrow">COMPARE</p>
            <h1>选择基线与候选 session</h1>
            <p>
              把两次运行放到同一尺度中，判断哪些变化是真实改善，哪些只是数据差异。
            </p>
          </div>
        </div>
        <section className="selection-panel">
          <span className="step-index">01</span>
          <div>
            <h2>建立对照组</h2>
            <p>
              先选择稳定基线，再选择要验证的候选运行。来源、模型与开始时间会帮助你区分同名
              session。
            </p>
          </div>
          {picker}
        </section>
      </main>
    );
  const [left, right] = pair,
    starts = pair.map((run) =>
      run.startedAt ? new Date(run.startedAt).getTime() : 0,
    ),
    ends = pair.map(
      (run, index) => starts[index] + totalDuration(run, normalSpans(run)),
    ),
    commonStart = Math.min(...starts),
    commonEnd = Math.max(...ends),
    cursorValue = normalized
      ? Math.max(0, Math.min(1, cursor))
      : Math.max(commonStart, Math.min(commonEnd, cursor));
  // Sibling subagent runs share one source session id, so the id alone can
  // print the same heading twice for two visibly different runs.
  const compareLabel = (run: SessionRun) => runLabel(run);
  return (
    <main id="main-content" className="workspace compare">
      <div className="page-heading">
        <div>
          <p className="eyebrow">COMPARE</p>
          <h1>
            {compareLabel(left)} <span>vs</span> {compareLabel(right)}
          </h1>
          <p>
            两侧事件、Token、上下文、失败与纠偏共享同一光标。
            {(left.sourceSessionId ?? left.sessionRef) ===
            (right.sourceSessionId ?? right.sessionRef) ? (
              <>
                两条来自同一 session（
                <code>{left.sourceSessionId ?? left.sessionRef}</code>）的不同
                run。
              </>
            ) : (
              <>
                <code>{left.sourceSessionId ?? left.sessionRef}</code>
                <span aria-hidden="true"> ↔ </span>
                <code>{right.sourceSessionId ?? right.sessionRef}</code>
              </>
            )}
          </p>
        </div>
        <div className="page-actions">
          <Link
            className="primary-action"
            to={`/report?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`}
          >
            生成对比报告
          </Link>
          <button onClick={() => updateParams({ a: b, b: a })}>
            交换基线 / 候选
          </button>
          <button
            aria-pressed={normalized}
            className={normalized ? "selected" : ""}
            onClick={() => {
              const next = !normalized;
              setNormalized(next);
              updateParams({ time: next ? undefined : "real" });
              setCursor(normalized ? commonStart : 0.5);
            }}
          >
            {normalized ? "标准化时间" : "共同真实时间"}
          </button>
        </div>
      </div>
      {picker}
      <div className="compare-deltas">
        <Metric
          label="可追踪 Token Δ"
          value={compareNumberDelta(
            trackedTokenTotal(left.tokens),
            trackedTokenTotal(right.tokens),
          )}
        />
        <Metric
          label="总耗时 Δ"
          value={compareDurationDelta(
            left.wallDurationMs ?? left.durationMs,
            right.wallDurationMs ?? right.durationMs,
          )}
        />
        <Metric
          label="失败 Δ"
          value={compareNumberDelta(
            left.counts?.toolFailures,
            right.counts?.toolFailures,
          )}
          tone={
            (right.counts?.toolFailures ?? 0) > (left.counts?.toolFailures ?? 0)
              ? "danger"
              : "neutral"
          }
        />
        <Metric
          label="上下文峰值 Δ"
          value={compareRatioDelta(contextRatio(left), contextRatio(right))}
        />
      </div>
      {focus && (
        <p className="feedback" role="status">
          已同步筛选：{focus} · 已高亮双方证据{" "}
          <button
            onClick={() => {
              setFocus("");
              updateParams({ filter: undefined });
            }}
          >
            清除
          </button>
        </p>
      )}
      <div className="compare-timelines">
        <CompareLane
          run={left}
          normalized={normalized}
          commonStart={commonStart}
          commonEnd={commonEnd}
          cursor={cursorValue}
          setCursor={setCursor}
          focus={focus}
        />
        <CompareLane
          run={right}
          normalized={normalized}
          commonStart={commonStart}
          commonEnd={commonEnd}
          cursor={cursorValue}
          setCursor={setCursor}
          focus={focus}
        />
      </div>
      <Difference
        left={left}
        right={right}
        filter={(value) => {
          setFocus(value);
          updateParams({ filter: value });
        }}
      />
      <p className="muted">
        {normalized
          ? "标准化模式按各 session 进度 0–100% 对齐。"
          : "真实时间模式按共同绝对时间轴对齐。"}{" "}
        选择工具或 Skill 名称可同时筛选两侧证据。
      </p>
    </main>
  );
}

function reportFindings(run: SessionRun) {
  const spans = normalSpans(run),
    tokenHotspot = spans
      .filter(
        (span) =>
          trackedTokenTotal(span.tokenDelta ?? span.tokens) !== undefined,
      )
      .reduce<
        TraceSpan | undefined
      >((best, span) => (!best || (trackedTokenTotal(span.tokenDelta ?? span.tokens) ?? 0) > (trackedTokenTotal(best.tokenDelta ?? best.tokens) ?? 0) ? span : best), undefined),
    failures = spans.filter(
      (span) => span.status === "error" || Boolean(span.error),
    ),
    skill = skills(run).sort((left, right) => right.count - left.count)[0],
    peak = contextRatio(run),
    wall = run.wallDurationMs ?? run.durationMs,
    idleRatio =
      wall && run.idleDurationMs !== undefined
        ? run.idleDurationMs / wall
        : undefined;
  return [
    {
      title: "Token 热点",
      value: tokenHotspot
        ? `${nameOf(tokenHotspot)} · ${tokens(trackedTokenTotal(tokenHotspot.tokenDelta ?? tokenHotspot.tokens))}`
        : "不可用",
      span: tokenHotspot,
      quality: run.quality?.token,
    },
    {
      title: "Context 压力",
      value:
        peak === undefined
          ? "不可用"
          : `${Math.round(peak * 100)}% peak${peak >= 0.8 ? " · 高风险" : ""}`,
      span:
        peak === undefined
          ? undefined
          : spans.find((span) => span.contextRatio === peak),
      quality: run.quality?.context,
    },
    {
      title: "失败证据",
      value:
        run.counts?.toolFailures === undefined
          ? "不可用"
          : `${run.counts.toolFailures} 个结构化失败`,
      span: failures[0],
      quality: run.quality?.tools ?? failures[0]?.quality,
    },
    {
      title: "空档占比",
      value:
        idleRatio === undefined
          ? "不可用"
          : `占墙钟 ${Math.round(idleRatio * 100)}%`,
      quality: run.quality?.timing,
    },
    {
      title: "Skill 使用",
      value: skill ? `${skill.name} · ${skill.count} 次` : "未识别或不可用",
      quality: skill ? "heuristic" : "unknown",
    },
    {
      title: "用户纠偏",
      value:
        run.counts?.corrections === undefined
          ? "不可用"
          : `${run.counts.corrections} 个候选（非确认）`,
      span: spans.find((span) =>
        /correction|纠偏/i.test(`${span.type} ${span.name}`),
      ),
      quality: run.quality?.correction,
    },
  ];
}

function richMarkdown(runs: SessionRun[]) {
  return `# Session 分析报告\n\n${runs
    .map((run) => {
      const findings = reportFindings(run)
        .map(
          (finding) =>
            `- ${finding.title}: ${finding.value} [${evidenceText[finding.quality?.toLowerCase() ?? "unknown"] ?? finding.quality ?? "不可用"}]`,
        )
        .join("\n");
      return `## ${runLabel(run)}\n\n- Session ID: ${run.sourceSessionId ?? run.sessionRef ?? run.id}\n- Provider/model: ${run.provider ?? "—"} / ${run.model ?? "—"}\n- Wall / active / idle: ${duration(run.wallDurationMs ?? run.durationMs)} / ${duration(run.activeDurationMs)} / ${duration(run.idleDurationMs)}\n- Tracked tokens / context: ${tokens(trackedTokenTotal(run.tokens))} / ${contextRatio(run) === undefined ? "—" : `${Math.round(contextRatio(run)! * 100)}%`}\n- Tools / failures: ${run.counts?.tools ?? "—"} / ${run.counts?.toolFailures ?? "—"}\n\n### Findings\n\n${findings}\n\n### Verification\n\n${run.verification?.summary ?? "不可用"}\n\n### Data limitations\n\n${(run.parseWarnings ?? ["缺失字段不按 0 显示；证据质量标签限定解释范围。"]).join("；")}\n\n[Open trace](/sessions/${run.id})`;
    })
    .join(
      "\n\n",
    )}\n\nReasoning tokens are an output subset and are not added to tracked tokens. Corrections are heuristic candidates, not confirmed user intent.`;
}

const htmlEscape = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
function legacyReportHtml(
  inputRuns: SessionRun[],
  origin = "http://127.0.0.1:4788",
) {
  const runs = inputRuns.map(normalizeRunEvidence);
  const sections = runs
    .map((run) => {
      const spans = normalSpans(run),
        full = totalDuration(run, spans),
        stride = Math.max(1, Math.ceil(spans.length / 160)),
        tokenEvents = spans.filter(
          (span) =>
            trackedTokenTotal(span.tokenDelta ?? span.tokens) !== undefined,
        ),
        tokenMax = Math.max(
          1,
          ...tokenEvents.map(
            (span) => trackedTokenTotal(span.tokenDelta ?? span.tokens) ?? 0,
          ),
        ),
        context = samples(run, spans),
        traceLines = spans
          .filter((_, index) => index % stride === 0)
          .map(
            (span) =>
              `<line class="${htmlEscape(kindOf(span.type))}" x1="${((startOf(span) / Math.max(1, full)) * 100).toFixed(3)}" x2="${((startOf(span) / Math.max(1, full)) * 100).toFixed(3)}" y1="3" y2="25"/>`,
          )
          .join(""),
        tokenBars = tokenEvents
          .map((span) => {
            const height = Math.max(
                2,
                ((trackedTokenTotal(span.tokenDelta ?? span.tokens) ?? 0) /
                  tokenMax) *
                  25,
              ),
              x = (startOf(span) / Math.max(1, full)) * 100;
            return `<rect x="${x.toFixed(3)}" y="${(28 - height).toFixed(3)}" width=".55" height="${height.toFixed(3)}"/>`;
          })
          .join(""),
        contextPoints = context
          .map(
            (sample) =>
              `${(((sample.offsetMs ?? 0) / Math.max(1, full)) * 100).toFixed(3)},${(28 - (sample.ratio ?? 0) * 25).toFixed(3)}`,
          )
          .join(" "),
        findings = reportFindings(run)
          .map((finding) => {
            const link = finding.span
              ? `/sessions/${encodeURIComponent(run.id)}?focus=${encodeURIComponent(idOf(finding.span))}`
              : "";
            return `<article><small>${htmlEscape(finding.title)} · ${htmlEscape(evidenceText[finding.quality?.toLowerCase() ?? "unknown"] ?? finding.quality ?? "不可用")}</small><strong>${htmlEscape(finding.value)}</strong>${link ? `<a href="${htmlEscape(link)}">定位 Trace 证据 →</a>` : "<span>无事件级锚点</span>"}</article>`;
          })
          .join(""),
        tools = Object.entries(run.toolCounts ?? {})
          .sort((left, right) => (right[1].calls ?? 0) - (left[1].calls ?? 0))
          .slice(0, 8)
          .map(
            ([name, stat]) =>
              `<li>${htmlEscape(name)} · ${htmlEscape(stat.calls ?? "—")} calls · ${htmlEscape(stat.failures ?? "—")} failed</li>`,
          )
          .join(""),
        skillRows = skills(run)
          .sort((left, right) => right.count - left.count)
          .slice(0, 8)
          .map(
            (skill) =>
              `<li>${htmlEscape(skill.name)} · ${skill.count} · ${htmlEscape(skill.source)}</li>`,
          )
          .join("");
      return `<section class="session"><header><div><p>${htmlEscape(run.provider ?? "—")} · ${htmlEscape(run.model ?? "模型不可用")}</p><h2>${htmlEscape(runLabel(run))}</h2><p>${htmlEscape(dateTime(run.startedAt))} · ${htmlEscape(run.project ?? run.runKind ?? "项目不可用")} · ${htmlEscape(run.sourceSessionId ?? run.sessionRef ?? run.id)}</p></div><a href="/sessions/${encodeURIComponent(run.id)}">打开完整 Trace →</a></header><div class="metrics"><div><small>总耗时 / 活跃 / 空档</small><b>${htmlEscape(duration(run.wallDurationMs ?? run.durationMs))}</b><span>${htmlEscape(duration(run.activeDurationMs))} / ${htmlEscape(duration(run.idleDurationMs))}</span></div><div><small>可追踪 Token / 上下文</small><b>${htmlEscape(tokens(trackedTokenTotal(run.tokens)))} / ${htmlEscape(contextRatio(run) === undefined ? "—" : `${Math.round(contextRatio(run)! * 100)}%`)}</b><span>Reasoning ${htmlEscape(tokens(run.tokens?.reasoning))}（output 子集）</span></div><div><small>工具 / 失败</small><b>${htmlEscape(number(run.counts?.tools))} / ${htmlEscape(number(run.counts?.toolFailures))}</b><span>${skills(run).length || "—"} 种 Skill</span></div><div><small>纠偏 / 验证</small><b>${htmlEscape(run.counts?.corrections ?? "—")} / ${htmlEscape(verificationLabel(run.verification?.status))}</b><span>纠偏为候选，非确认</span></div></div><div class="charts"><figure><figcaption>Trace 概览</figcaption><svg viewBox="0 0 100 28" preserveAspectRatio="none">${traceLines}</svg></figure><figure><figcaption>Token 变化</figcaption><svg viewBox="0 0 100 28" preserveAspectRatio="none">${tokenBars}</svg></figure><figure><figcaption>上下文压力</figcaption><svg viewBox="0 0 100 28" preserveAspectRatio="none"><polyline points="${contextPoints}"/></svg></figure></div><h3>证据线索</h3><div class="findings">${findings}</div><div class="columns"><section><h3>工具</h3><ul>${tools || "<li>不可用</li>"}</ul></section><section><h3>Skill</h3><ul>${skillRows || "<li>不可用</li>"}</ul></section><section><h3>验证与数据限制</h3><p>${htmlEscape(run.verification?.summary ?? "不可用")}</p><p>${htmlEscape(run.parseWarnings?.join("；") ?? "缺失字段不按 0 显示；证据质量标签限定解释范围。")}</p></section></div></section>`;
    })
    .join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><base href="${htmlEscape(`${origin}/`)}"><title>Session analysis report</title><style>:root{color-scheme:light;font:15px system-ui;color:#172033;background:#f6f8fb}*{box-sizing:border-box}body{max-width:1180px;margin:auto;padding:32px 24px 60px}h1{margin:0 0 6px}.intro{color:#667085;margin-bottom:22px}.session{background:white;border:1px solid #d9dee8;border-radius:12px;padding:20px;margin:16px 0}.session>header{display:flex;justify-content:space-between;gap:20px}.session h2,.session p{margin:3px 0}.session a{color:#425cc7}.metrics,.charts,.findings,.columns{display:grid;gap:10px}.metrics{grid-template-columns:repeat(4,1fr);margin:16px 0}.metrics>div,article,figure,.columns>section{border:1px solid #d9dee8;border-radius:8px;padding:11px;min-width:0}.metrics small,.metrics span,article small,article span{display:block;color:#667085}.metrics b,article strong{display:block;margin:6px 0}.charts,.columns{grid-template-columns:repeat(3,1fr)}figure{margin:0}figcaption{font-size:12px;color:#667085}svg{width:100%;height:92px;background:#eef2ff}.user{stroke:#0f9b78}.model{stroke:#2463c9}.tool{stroke:#7c3aed}.error{stroke:#b42318}.compact{stroke:#ad6b00}rect{fill:#2463c9}polyline{fill:none;stroke:#425cc7;stroke-width:1}.findings{grid-template-columns:repeat(3,1fr)}ul{padding-left:18px}@media(max-width:760px){.metrics,.charts,.findings,.columns{grid-template-columns:1fr}.session>header{display:block}}@media print{body{background:white;padding:0}.session{break-inside:avoid}}</style></head><body><h1>Session analysis report</h1><p class="intro">本报告由本地观测与确定性规则生成。Reasoning 是 output 子集；纠偏为启发式候选。</p>${sections}</body></html>`;
}

export function reportHtml(
  runs: SessionRun[],
  origin = "http://127.0.0.1:4788",
) {
  const styles = `:root{color-scheme:light;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#171a22;background:#f3f5f7}*{box-sizing:border-box}body{max-width:1120px;margin:auto;padding:36px 28px 64px}h1{margin:0 0 5px;font-size:30px;letter-spacing:-.03em}.intro{max-width:720px;margin:0 0 30px;color:#697180}.session{padding:24px 0 40px;border-top:1px solid #c8ced7}.session>header{display:flex;align-items:start;justify-content:space-between;gap:24px}.session h2{margin:3px 0;font-size:22px}.session p{margin:3px 0;color:#697180}.session a{color:#4a4bb8;text-decoration:none}.metrics{display:grid;grid-template-columns:repeat(4,1fr);margin:20px 0 28px;border:1px solid #dfe3e8;background:#fff}.metrics>div{min-width:0;padding:12px 14px;border-left:1px solid #dfe3e8}.metrics>div:first-child{border-left:0}.metrics small,.metrics span,article small,article span{display:block;color:#697180}.metrics b{display:block;margin:5px 0;font-size:17px;font-variant-numeric:tabular-nums}.charts,.columns{display:grid;grid-template-columns:repeat(3,1fr);gap:28px;border-top:1px solid #c8ced7}.charts{margin-top:10px}figure{min-width:0;margin:0;padding-top:12px}figcaption{margin-bottom:7px;color:#697180;font-size:12px}svg{width:100%;height:88px;border:1px solid #dfe3e8;background:#f8f9fb}.user{stroke:#087a60}.model{stroke:#315fbd}.tool{stroke:#6d4bc0}.error{stroke:#b42318}.compact{stroke:#9a6500}rect{fill:#315fbd}polyline{fill:none;stroke:#5556c9;stroke-width:1}.findings{display:grid;border-top:1px solid #c8ced7}.findings article{display:grid;grid-template-columns:150px minmax(0,1fr) 150px;min-height:48px;align-items:center;gap:16px;border-bottom:1px solid #dfe3e8}.findings article strong{font-size:13px}.findings article a,.findings article>span:last-child{text-align:right}.columns{margin-top:28px}.columns>section{padding-top:14px}.columns h3{margin:0 0 8px}.columns p,.columns li{color:#3f4654;font-size:12px}ul{padding-left:18px}@media(max-width:760px){body{padding:20px 16px}.session>header{display:block}.metrics{grid-template-columns:1fr 1fr}.metrics>div:nth-child(3){border-left:0}.metrics>div:nth-child(n+3){border-top:1px solid #dfe3e8}.charts,.columns{grid-template-columns:1fr}.findings article{grid-template-columns:1fr;gap:3px;padding:9px 0}.findings article a,.findings article>span:last-child{text-align:left}}@media print{body{max-width:none;padding:0;background:#fff}.session{break-inside:avoid}}`;
  return legacyReportHtml(runs, origin)
    .replaceAll("Session analysis report", "Session 分析报告")
    .replace(/<style>[\s\S]*?<\/style>/, `<style>${styles}</style>`);
}

function ReportMiniCharts({ run }: { run: SessionRun }) {
  const spans = normalSpans(run),
    full = totalDuration(run, spans),
    stride = Math.max(1, Math.ceil(spans.length / 120)),
    tokenEvents = spans.filter(
      (span) => trackedTokenTotal(span.tokenDelta ?? span.tokens) !== undefined,
    ),
    tokenMax = Math.max(
      1,
      ...tokenEvents.map(
        (span) => trackedTokenTotal(span.tokenDelta ?? span.tokens) ?? 0,
      ),
    ),
    data = samples(run, spans),
    points = data
      .map(
        (sample) =>
          `${((sample.offsetMs ?? 0) / Math.max(1, full)) * 100},${100 - (sample.ratio ?? 0) * 100}`,
      )
      .join(" ");
  return (
    <div className="report-charts">
      <div>
        <strong>Trace 概览</strong>
        <div
          className="report-trace"
          role="img"
          aria-label={`${spans.length} 个 Trace 事件的时间分布`}
        >
          {spans
            .filter((_, index) => index % stride === 0)
            .map((span, index) => (
              <i
                aria-hidden="true"
                key={idOf(span, index)}
                className={kindOf(span.type)}
                style={{
                  left: `${(startOf(span) / Math.max(1, full)) * 100}%`,
                }}
              />
            ))}
        </div>
      </div>
      <div>
        <strong>Token 变化</strong>
        <div
          className="report-token"
          role="img"
          aria-label={`${tokenEvents.length} 个 Token 变化`}
        >
          {boundedSpans(tokenEvents, 120).map((span, index) => (
            <i
              aria-hidden="true"
              key={idOf(span, index)}
              style={{
                left: `${(startOf(span) / Math.max(1, full)) * 100}%`,
                height: `${Math.max(8, ((trackedTokenTotal(span.tokenDelta ?? span.tokens) ?? 0) / tokenMax) * 100)}%`,
              }}
            />
          ))}
        </div>
      </div>
      <div>
        <strong>上下文压力</strong>
        <svg
          role="img"
          aria-label={`上下文压力曲线，${data.length} 个采样点`}
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          {points && (
            <polyline
              points={points}
              fill="none"
              stroke="currentColor"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
      </div>
    </div>
  );
}

function PolishedReport() {
  const [params, setParams] = useSearchParams(),
    library = usePagedRuns(),
    ids = [params.get("run"), params.get("a"), params.get("b")].filter(
      (id): id is string => Boolean(id),
    ),
    detail = useDetailState(ids),
    runs = detail.runs,
    [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle"),
    text = richMarkdown(runs);
  useEffect(() => setCopyState("idle"), [text]);
  const select = (value: string) => setParams(value ? { run: value } : {});
  const download = () => {
    const blob = new Blob([reportHtml(runs, window.location.origin)], {
        type: "text/html",
      }),
      link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "session-report.html";
    link.click();
    URL.revokeObjectURL(link.href);
  };
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  };
  if (library.error && !library.runs.length)
    return (
      <main id="main-content" className="workspace">
        <section className="state-panel">
          <p className="eyebrow">REPORT UNAVAILABLE</p>
          <h1>无法加载 session 列表</h1>
          <p role="alert">{library.error}</p>
          <button onClick={library.retry}>重试</button>
        </section>
      </main>
    );
  if (detail.error)
    return (
      <main id="main-content" className="workspace">
        <section className="state-panel">
          <p className="eyebrow">REPORT UNAVAILABLE</p>
          <h1>无法生成报告</h1>
          <p role="alert">{detail.error}</p>
          <button onClick={detail.retry}>重试</button>
        </section>
      </main>
    );
  return (
    <main id="main-content" className="workspace report">
      <div className="page-heading">
        <div>
          <p className="eyebrow">EVIDENCE REPORT</p>
          <h1>{runs.length > 1 ? "Session 对比报告" : "Session 分析报告"}</h1>
          <p>
            先给出可复核结论，再连接到 Trace 证据；缺失字段始终保持“不可用”。
          </p>
        </div>
        <div className="report-actions">
          <label>
            报告对象
            <select
              aria-label="报告 session"
              value={ids.length === 1 ? ids[0] : ""}
              onChange={(event) => select(event.target.value)}
            >
              <option value="">选择 session</option>
              {library.runs.map((run) => (
                <option key={run.id} value={run.id}>
                  {runOptionLabel(run)}
                </option>
              ))}
            </select>
          </label>
          {library.cursor && (
            <button
              data-testid="report-load-more"
              onClick={() => void library.loadMore()}
              disabled={library.loading}
            >
              加载更多 session
            </button>
          )}
          {runs.length > 0 && (
            <>
              <button onClick={() => void copy()}>
                {copyState === "copied"
                  ? "已复制"
                  : copyState === "error"
                    ? "复制失败"
                    : "复制 Markdown"}
              </button>
              <button onClick={download}>下载 HTML</button>
              <button onClick={() => window.print()}>打印</button>
            </>
          )}
        </div>
      </div>
      <p className="sr-status" aria-live="polite">
        {copyState === "copied"
          ? "Markdown 已复制"
          : copyState === "error"
            ? "复制失败，请重试"
            : ""}
      </p>
      {detail.loading && !runs.length ? (
        <p className="loading-state" role="status">
          正在生成证据报告...
        </p>
      ) : !runs.length ? (
        <section className="selection-panel report-empty">
          <span className="step-index">01</span>
          <div>
            <h2>选择明确的报告对象</h2>
            <p>
              报告不会替你猜测“最近一次”运行。请从 Trace 或 Compare
              生成，或在上方明确选择一个 session。
            </p>
          </div>
          <Link to="/">返回会话库</Link>
        </section>
      ) : (
        runs.map((run) => {
          const failures = run.counts?.toolFailures ?? 0;
          const peak = contextRatio(run) ?? 0;
          const isRisk = failures > 0 || peak >= 0.8;
          return (
          <section className="report-card rich-report" key={run.id}>
            {isRisk && (
              <div className="editorial-hero-card">
                <div>
                  <h2>
                    <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>
                    已记录的待查信号： {failures > 0 ? `${failures} 次工具失败` : ""} {peak >= 0.8 ? "及上下文高水位风险" : ""}
                  </h2>
                  <p>{ev(run.quality?.tools)} {ev(run.quality?.context)}</p>
                  <p>
                    先查看失败事件的输入、输出与错误，再结合上下文曲线判断原因。缺少事件锚点的指标仅供汇总参考。
                  </p>
                </div>
                <Link className="primary-action" to={`/sessions/${run.id}`}>
                  在 Trace 中复查 →
                </Link>
              </div>
            )}
            <header>
              <div>
                <p className="eyebrow">
                  {run.provider ?? "—"} · {run.model ?? "模型不可用"}
                </p>
                <h2>{runLabel(run)}</h2>
                <p>
                  {dateTime(run.startedAt)}
                  {run.project ? ` · ${run.project}` : ""} ·{" "}
                  <code>{run.sourceSessionId ?? run.sessionRef ?? run.id}</code>
                </p>
              </div>
              <Link to={`/sessions/${run.id}`}>打开完整 Trace →</Link>
            </header>
            <div className="report-grid">
              <Metric
                label="总耗时 / 活跃 / 空档"
                value={duration(run.wallDurationMs ?? run.durationMs)}
                note={`${duration(run.activeDurationMs)} / ${duration(run.idleDurationMs)}`}
              />
              <Metric
                label="Token / 上下文"
                value={`${tokens(trackedTokenTotal(run.tokens))} / ${contextRatio(run) === undefined ? "—" : `${Math.round(contextRatio(run)! * 100)}%`}`}
                note={`Reasoning ${tokens(run.tokens?.reasoning)}（output 子集）`}
              />
              <Metric
                label="工具 / 失败"
                value={`${number(run.counts?.tools)} / ${number(run.counts?.toolFailures)}`}
                note={`${skills(run).length || "—"} 种 Skill`}
                tone={run.counts?.toolFailures ? "danger" : "neutral"}
              />
              <Metric
                label="纠偏 / 验证"
                value={`${run.counts?.corrections ?? "—"} / ${verificationLabel(run.verification?.status)}`}
                note="纠偏为候选，非确认"
              />
            </div>
            <h3 className="section-title">证据线索</h3>
            <div className="bento-editorial-grid">
              {reportFindings(run).map((finding) => (
                <article className="bento-editorial-tile" key={finding.title}>
                  <div className="bento-tile-header">
                    <span className="bento-tile-tag">{finding.title}</span>
                    {ev(finding.quality)}
                  </div>
                  <div>
                    <div className="bento-tile-main">{finding.value}</div>
                    <div className="bento-tile-summary">
                      {finding.span ? "已锚定到具体 Trace 事件" : "全局统计项（无单点事件锚点）"}
                    </div>
                  </div>
                  {finding.span ? (
                    <Link
                      className="bento-tile-anchor"
                      data-testid="report-evidence-link"
                      to={`/sessions/${run.id}?focus=${encodeURIComponent(idOf(finding.span))}`}
                    >
                      定位 Trace 证据 →
                    </Link>
                  ) : (
                    <small style={{ color: "var(--muted)" }}>该项没有事件级锚点</small>
                  )}
                </article>
              ))}
            </div>
            <h3 className="section-title">证据分布</h3>
            <ReportMiniCharts run={run} />
            <div className="report-columns">
              <div>
                <h3>验证</h3>
                <p>{run.verification?.summary ?? "不可用"}</p>
                <p>
                  {ev(run.verification?.quality ?? run.quality?.verification)}
                </p>
              </div>
              <div>
                <h3>数据限制</h3>
                <p>
                  {run.parseWarnings?.join("；") ??
                    "缺失字段不按 0 显示；证据质量标签限定解释范围。"}
                </p>
              </div>
              <div>
                <h3>解释边界</h3>
                <p>
                  Reasoning 是 output 子集，不重复计入 tracked
                  tokens。活跃时间为推导值；纠偏为启发式候选。
                </p>
              </div>
            </div>

          </section>
        );
        })
      )}
    </main>
  );
}

export function App() {
  const [revision, setRevision] = useState(0);
  return (
    <>
      <Header refresh={() => setRevision((value) => value + 1)} />
      <Routes key={revision}>
        <Route path="/" element={<Library />} />
        <Route path="/insights" element={<Insights />} />
        <Route path="/sessions/:id" element={<PolishedTrace />} />
        <Route path="/compare" element={<PolishedCompare />} />
        <Route path="/report" element={<PolishedReport />} />
        <Route path="*" element={<Library />} />
      </Routes>
    </>
  );
}
