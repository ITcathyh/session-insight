import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type { TraceSpan } from "./types";

export interface TraceTimeMapper {
  at: (time: number) => number;
  from: (position: number) => number;
  ticks: Array<{ time: number; position: number }>;
  compressedGaps: number;
}

export interface TraceVisualizationHelpers {
  idOf: (span: TraceSpan, index?: number) => string;
  nameOf: (span: TraceSpan) => string;
  kindOf: (value?: string) => string;
  startOf: (span: TraceSpan) => number;
  lengthOf: (span: TraceSpan) => number;
  formatDuration: (milliseconds: number) => string;
}

export interface VirtualTraceTreeProps extends TraceVisualizationHelpers {
  spans: TraceSpan[];
  selectedId?: string;
  choose: (span: TraceSpan) => void;
  /** Short distinguishing text for the row — thirty rows all named "bash"
   *  cannot be navigated on the tool name alone. */
  hintOf: (span: TraceSpan) => string;
}

interface TreeNode {
  span: TraceSpan;
  id: string;
  order: number;
  parentId?: string;
  children: TreeNode[];
}

interface VisibleTreeRow {
  node: TreeNode;
  depth: number;
}

const TREE_ROW_HEIGHT = 34;
const TREE_OVERSCAN = 8;
const DEFAULT_TREE_HEIGHT = 480;

function buildTree(
  spans: TraceSpan[],
  idOf: TraceVisualizationHelpers["idOf"],
): {
  roots: TreeNode[];
  byId: Map<string, TreeNode>;
} {
  const nodes: TreeNode[] = [];
  const byId = new Map<string, TreeNode>();
  const seenObjects = new WeakSet<TraceSpan>();

  const collect = (span: TraceSpan, inheritedParentId?: string) => {
    if (seenObjects.has(span)) return;
    seenObjects.add(span);

    const order = nodes.length;
    const id = idOf(span, order);
    let node = byId.get(id);
    if (!node) {
      node = {
        span,
        id,
        order,
        parentId: span.parentId ?? inheritedParentId,
        children: [],
      };
      nodes.push(node);
      byId.set(id, node);
    } else if (!node.parentId && (span.parentId || inheritedParentId)) {
      node.parentId = span.parentId ?? inheritedParentId;
    }

    for (const child of span.children ?? []) collect(child, id);
  };

  for (const span of spans) collect(span);

  for (const node of nodes) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent && parent !== node && !parent.children.includes(node))
      parent.children.push(node);
  }

  for (const node of nodes)
    node.children.sort((left, right) => left.order - right.order);

  const attached = new Set(nodes.flatMap((node) => node.children));
  const roots = nodes.filter((node) => !attached.has(node));

  // A malformed parent cycle otherwise produces no roots. Keeping the first node as a
  // root makes the evidence inspectable while the visited guard below prevents loops.
  if (!roots.length && nodes.length) roots.push(nodes[0]);
  roots.sort((left, right) => left.order - right.order);
  return { roots, byId };
}

function visibleTreeRows(
  roots: TreeNode[],
  collapsed: ReadonlySet<string>,
): VisibleTreeRow[] {
  const rows: VisibleTreeRow[] = [];
  const visited = new Set<string>();
  const visit = (node: TreeNode, depth: number) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    rows.push({ node, depth });
    if (!collapsed.has(node.id)) {
      for (const child of node.children) visit(child, depth + 1);
    }
  };
  for (const root of roots) visit(root, 0);
  return rows;
}

export function VirtualTraceTree({
  spans,
  selectedId,
  choose,
  idOf,
  nameOf,
  hintOf,
  kindOf,
  lengthOf,
  formatDuration,
}: VirtualTraceTreeProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(DEFAULT_TREE_HEIGHT);
  const tree = useMemo(() => buildTree(spans, idOf), [idOf, spans]);

  useEffect(() => {
    setCollapsed((current) => {
      const next = new Set([...current].filter((id) => tree.byId.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [tree]);

  useEffect(() => {
    if (!selectedId) return;
    setCollapsed((current) => {
      const next = new Set(current);
      const visited = new Set<string>();
      let node = tree.byId.get(selectedId);
      let changed = false;
      while (node?.parentId && !visited.has(node.parentId)) {
        visited.add(node.parentId);
        if (next.delete(node.parentId)) changed = true;
        node = tree.byId.get(node.parentId);
      }
      return changed ? next : current;
    });
  }, [selectedId, tree]);

  const rows = useMemo(
    () => visibleTreeRows(tree.roots, collapsed),
    [collapsed, tree.roots],
  );
  const rowById = useMemo(
    () => new Map(rows.map((row, index) => [row.node.id, index])),
    [rows],
  );

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const selectedIndex = selectedId ? rowById.get(selectedId) : undefined;
    if (!viewport || selectedIndex === undefined) return;
    const rowTop = selectedIndex * TREE_ROW_HEIGHT;
    const rowBottom = rowTop + TREE_ROW_HEIGHT;
    if (
      rowTop < viewport.scrollTop ||
      rowBottom > viewport.scrollTop + viewport.clientHeight
    ) {
      const top = Math.max(
        0,
        rowTop - (viewport.clientHeight - TREE_ROW_HEIGHT) / 2,
      );
      if (typeof viewport.scrollTo === "function")
        viewport.scrollTo({ top, behavior: "auto" });
      else viewport.scrollTop = top;
    }
  }, [rowById, selectedId]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () =>
      setViewportHeight(viewport.clientHeight || DEFAULT_TREE_HEIGHT);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const first = Math.max(
    0,
    Math.floor(scrollTop / TREE_ROW_HEIGHT) - TREE_OVERSCAN,
  );
  const last = Math.min(
    rows.length,
    Math.ceil((scrollTop + viewportHeight) / TREE_ROW_HEIGHT) + TREE_OVERSCAN,
  );
  const renderedRows = rows.slice(first, last);
  const hasVisibleSelection = selectedId ? rowById.has(selectedId) : false;

  const toggle = (id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const focusRow = (index: number) => {
    const target = rows[Math.max(0, Math.min(rows.length - 1, index))];
    if (!target) return;
    choose(target.node.span);
    const viewport = viewportRef.current;
    if (viewport) {
      const top = Math.max(0, index * TREE_ROW_HEIGHT - viewportHeight / 2);
      if (typeof viewport.scrollTo === "function")
        viewport.scrollTo({ top, behavior: "auto" });
      else viewport.scrollTop = top;
    }
    requestAnimationFrame(() => itemRefs.current.get(target.node.id)?.focus());
  };

  const handleItemKey = (
    event: KeyboardEvent<HTMLButtonElement>,
    row: VisibleTreeRow,
    index: number,
  ) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusRow(index + (event.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (event.key === "ArrowRight" && row.node.children.length) {
      event.preventDefault();
      if (collapsed.has(row.node.id)) toggle(row.node.id);
      else focusRow(index + 1);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (row.node.children.length && !collapsed.has(row.node.id)) {
        toggle(row.node.id);
      } else if (row.node.parentId) {
        const parentIndex = rowById.get(row.node.parentId);
        if (parentIndex !== undefined) focusRow(parentIndex);
      }
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      focusRow(event.key === "Home" ? 0 : rows.length - 1);
    }
  };

  return (
    <section
      className="trace-tree virtual-trace-tree"
      aria-labelledby="virtual-trace-tree-title"
    >
      <header>
        <strong id="virtual-trace-tree-title">事件结构</strong>
        <span>{spans.length} 个 span</span>
      </header>
      {rows.length ? (
        <div
          ref={viewportRef}
          className="virtual-tree-viewport"
          role="tree"
          aria-label="Trace 事件层级"
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
          <div
            className="virtual-tree-spacer"
            style={{ height: rows.length * TREE_ROW_HEIGHT }}
          >
            {renderedRows.map((row, offset) => {
              const index = first + offset;
              const { node, depth } = row;
              const expandable = node.children.length > 0;
              const expanded = expandable && !collapsed.has(node.id);
              const selected = selectedId === node.id;
              const hint = hintOf(node.span);
              return (
                <div
                  className={`virtual-tree-row${selected ? " selected" : ""}`}
                  data-span-id={node.id}
                  key={node.id}
                  role="none"
                  style={
                    {
                      "--depth": depth,
                      height: TREE_ROW_HEIGHT,
                      transform: `translateY(${index * TREE_ROW_HEIGHT}px)`,
                    } as CSSProperties
                  }
                >
                  {expandable ? (
                    <button
                      type="button"
                      className="tree-disclosure"
                      aria-label={`${expanded ? "折叠" : "展开"} ${nameOf(node.span)}`}
                      aria-expanded={expanded}
                      onClick={() => toggle(node.id)}
                      tabIndex={-1}
                    >
                      <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
                    </button>
                  ) : (
                    <span
                      className="tree-disclosure-placeholder"
                      aria-hidden="true"
                    />
                  )}
                  <button
                    ref={(element) => {
                      if (element) itemRefs.current.set(node.id, element);
                      else itemRefs.current.delete(node.id);
                    }}
                    type="button"
                    className="virtual-tree-item"
                    role="treeitem"
                    aria-level={depth + 1}
                    aria-expanded={expandable ? expanded : undefined}
                    aria-selected={selected}
                    tabIndex={
                      selected || (!hasVisibleSelection && index === 0) ? 0 : -1
                    }
                    title={
                      hint ? `${nameOf(node.span)} · ${hint}` : nameOf(node.span)
                    }
                    onClick={() => choose(node.span)}
                    onKeyDown={(event) => handleItemKey(event, row, index)}
                  >
                    <span
                      className={`dot ${kindOf(node.span.type)}`}
                      aria-hidden="true"
                    />
                    <span className="tree-name">{nameOf(node.span)}</span>
                    {/* Always rendered so the row's grid columns stay
                        aligned whether or not a hint exists. */}
                    <span className="tree-hint">{hint}</span>
                    <span
                      className={`tree-status${node.span.status === "error" || node.span.error ? " error" : ""}`}
                    >
                      {node.span.status ?? (node.span.error ? "error" : "")}
                    </span>
                    {/* Use the measured duration, not lengthOf — that one floors
                        at 1ms to keep zero-length events drawable, which renders
                        as a misleading "0s" on the majority of rows. */}
                    {(node.span.durationMs ?? 0) > 0 && (
                      <time>{formatDuration(node.span.durationMs as number)}</time>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="muted">没有可观察 span</p>
      )}
    </section>
  );
}

export interface EvidenceTimelineProps extends TraceVisualizationHelpers {
  spans: TraceSpan[];
  mapper: TraceTimeMapper;
  selectedId?: string;
  choose: (span: TraceSpan) => void;
  cursor: number;
  setCursor: (time: number) => void;
}

type LaneKey = "user" | "model" | "tool" | "other";

interface TimelineLane {
  key: LaneKey;
  label: string;
  spans: TraceSpan[];
  counts: number[];
  errors: number[];
}

const TIMELINE_AXIS_HEIGHT = 38;
const TIMELINE_LANE_HEIGHT = 55;
const TIMELINE_PLOT_LEFT = 76;
const TIMELINE_PLOT_RIGHT = 14;

function laneOf(kind: string): LaneKey {
  if (kind === "user" || kind === "model" || kind === "tool") return kind;
  return "other";
}

function nearestSpan(
  spans: TraceSpan[],
  time: number,
  startOf: TraceVisualizationHelpers["startOf"],
): TraceSpan | undefined {
  let nearest: TraceSpan | undefined;
  let distance = Number.POSITIVE_INFINITY;
  for (const span of spans) {
    const nextDistance = Math.abs(startOf(span) - time);
    if (nextDistance < distance) {
      distance = nextDistance;
      nearest = span;
    }
  }
  return nearest;
}

function densityPath(
  values: number[],
  maximum: number,
  left: number,
  width: number,
  baseline: number,
): string {
  if (!values.some(Boolean)) return "";
  const bucketWidth = width / values.length;
  const amplitude = TIMELINE_LANE_HEIGHT - 19;
  let path = `M ${left} ${baseline}`;
  values.forEach((value, index) => {
    const x0 = left + index * bucketWidth;
    const x1 = x0 + bucketWidth;
    const height = value
      ? Math.max(2, (Math.log1p(value) / Math.log1p(maximum)) * amplitude)
      : 0;
    const top = baseline - height;
    path += `L ${x0} ${baseline}L ${x0} ${top}L ${x1} ${top}L ${x1} ${baseline}`;
  });
  return `${path}Z`;
}

function errorPath(
  values: number[],
  left: number,
  width: number,
  baseline: number,
): string {
  const bucketWidth = width / values.length;
  let path = "";
  values.forEach((value, index) => {
    if (!value) return;
    const center = left + (index + 0.5) * bucketWidth;
    const half = Math.max(1.5, Math.min(4, bucketWidth * 0.48));
    const top = baseline - TIMELINE_LANE_HEIGHT + 12;
    path += `M ${center - half} ${top + 5}L ${center} ${top}L ${center + half} ${top + 5}L ${center} ${top + 10}Z`;
  });
  return path;
}

function clamped(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function EvidenceTimeline({
  spans,
  mapper,
  selectedId,
  choose,
  cursor,
  setCursor,
  idOf,
  nameOf,
  kindOf,
  startOf,
  lengthOf,
  formatDuration,
}: EvidenceTimelineProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(900);
  const plotWidth = Math.max(
    1,
    width - TIMELINE_PLOT_LEFT - TIMELINE_PLOT_RIGHT,
  );
  const bucketCount = Math.max(48, Math.min(420, Math.floor(plotWidth / 3)));
  const rangeStart = Math.min(mapper.from(0), mapper.from(1));
  const rangeEnd = Math.max(mapper.from(0), mapper.from(1));

  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const measure = () =>
      setWidth(Math.max(320, Math.round(svg.getBoundingClientRect().width)));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  const visibleSpans = useMemo(
    () =>
      spans
        .filter(
          (span) =>
            startOf(span) <= rangeEnd &&
            startOf(span) + lengthOf(span) >= rangeStart,
        )
        .sort((left, right) => startOf(left) - startOf(right)),
    [lengthOf, rangeEnd, rangeStart, spans, startOf],
  );

  const lanes = useMemo<TimelineLane[]>(() => {
    const result: TimelineLane[] = [
      {
        key: "user",
        label: "用户",
        spans: [],
        counts: Array(bucketCount).fill(0),
        errors: Array(bucketCount).fill(0),
      },
      {
        key: "model",
        label: "模型",
        spans: [],
        counts: Array(bucketCount).fill(0),
        errors: Array(bucketCount).fill(0),
      },
      {
        key: "tool",
        label: "工具",
        spans: [],
        counts: Array(bucketCount).fill(0),
        errors: Array(bucketCount).fill(0),
      },
      {
        key: "other",
        label: "其他",
        spans: [],
        counts: Array(bucketCount).fill(0),
        errors: Array(bucketCount).fill(0),
      },
    ];
    const byKey = new Map(result.map((lane) => [lane.key, lane]));

    for (const span of visibleSpans) {
      const lane = byKey.get(laneOf(kindOf(span.type)))!;
      const position = clamped(mapper.at(startOf(span)));
      const bucket = Math.min(
        bucketCount - 1,
        Math.floor(position * bucketCount),
      );
      lane.spans.push(span);
      lane.counts[bucket] += 1;
      if (span.status === "error" || Boolean(span.error))
        lane.errors[bucket] += 1;
    }
    // An empty lane is a labelled blank row; drop it so the remaining lanes get
    // the height instead.
    return result.filter((lane) => lane.spans.length > 0);
  }, [bucketCount, kindOf, mapper, startOf, visibleSpans]);

  const globalMaximum = Math.max(1, ...lanes.flatMap((lane) => lane.counts));
  // Height follows the lanes that actually have events, so dropping an empty
  // lane reclaims its space instead of leaving a gap.
  const chartHeight =
    TIMELINE_AXIS_HEIGHT + Math.max(1, lanes.length) * TIMELINE_LANE_HEIGHT + 28;
  const selected = useMemo(
    () =>
      selectedId
        ? spans.find((span, index) => idOf(span, index) === selectedId)
        : undefined,
    [idOf, selectedId, spans],
  );
  const selectedLane = selected
    ? lanes.findIndex((lane) => lane.key === laneOf(kindOf(selected.type)))
    : -1;
  const selectedPosition = selected
    ? clamped(mapper.at(startOf(selected)))
    : undefined;
  const cursorPosition = clamped(mapper.at(cursor));
  const cursorTime = Math.max(rangeStart, Math.min(rangeEnd, cursor));
  const annotation = selected
    ? `${nameOf(selected)} · ${selected.durationMs === undefined ? "时长未记录" : formatDuration(selected.durationMs)}`
    : "";
  const annotationWidth = Math.min(260, Math.max(110, annotation.length * 7));
  const selectedX =
    selectedPosition === undefined
      ? 0
      : TIMELINE_PLOT_LEFT + selectedPosition * plotWidth;
  const annotationX = Math.max(
    TIMELINE_PLOT_LEFT,
    Math.min(
      width - TIMELINE_PLOT_RIGHT - annotationWidth,
      selectedX - annotationWidth / 2,
    ),
  );

  const positionFromPointer = (event: PointerEvent<SVGSVGElement>): number => {
    const box = event.currentTarget.getBoundingClientRect();
    const renderedX =
      ((event.clientX - box.left) / Math.max(1, box.width)) * width;
    return clamped((renderedX - TIMELINE_PLOT_LEFT) / plotWidth);
  };

  const chooseNearest = (time: number) => {
    const span = nearestSpan(visibleSpans, time, startOf);
    if (span) choose(span);
  };

  const handleKey = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const direction = event.key === "ArrowLeft" ? -1 : 1;
      const candidates =
        direction < 0
          ? visibleSpans.filter((span) => startOf(span) < cursor).reverse()
          : visibleSpans.filter((span) => startOf(span) > cursor);
      const next = candidates[0];
      setCursor(
        next
          ? startOf(next)
          : mapper.from(clamped(mapper.at(cursor) + direction * 0.01)),
      );
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setCursor(mapper.from(event.key === "Home" ? 0 : 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      chooseNearest(cursor);
    }
  };

  return (
    <section
      className="evidence-timeline"
      aria-labelledby="evidence-timeline-title"
    >
      <header>
        <div>
          <strong id="evidence-timeline-title">执行证据</strong>
          <span>{visibleSpans.length} 个可见事件</span>
        </div>
        <span>
          {mapper.compressedGaps
            ? `${mapper.compressedGaps} 个空档已压缩`
            : "真实墙钟"}
        </span>
      </header>
      <svg
        ref={svgRef}
        className="evidence-timeline-chart"
        viewBox={`0 0 ${width} ${chartHeight}`}
        preserveAspectRatio="none"
        role="slider"
        tabIndex={0}
        aria-label="执行证据时间轴。左右方向键按事件移动光标，按 Enter 选择最近事件。"
        aria-orientation="horizontal"
        aria-valuemin={Math.round(rangeStart)}
        aria-valuemax={Math.round(rangeEnd)}
        aria-valuenow={Math.round(cursorTime)}
        aria-valuetext={formatDuration(cursorTime)}
        onPointerMove={(event) =>
          setCursor(mapper.from(positionFromPointer(event)))
        }
        onPointerDown={(event) => {
          event.currentTarget.focus();
          const time = mapper.from(positionFromPointer(event));
          setCursor(time);
          chooseNearest(time);
        }}
        onKeyDown={handleKey}
      >
        <title>按用户、模型、工具和其他事件聚合的执行时间轴</title>
        <g className="timeline-axis">
          {mapper.ticks.map((tick) => {
            const x = TIMELINE_PLOT_LEFT + clamped(tick.position) * plotWidth;
            return (
              <g key={`${tick.time}-${tick.position}`}>
                <line
                  x1={x}
                  x2={x}
                  y1={TIMELINE_AXIS_HEIGHT - 5}
                  y2={chartHeight - 8}
                />
                <text
                  x={x}
                  y={18}
                  textAnchor={
                    tick.position <= 0
                      ? "start"
                      : tick.position >= 1
                        ? "end"
                        : "middle"
                  }
                >
                  {formatDuration(tick.time)}
                </text>
              </g>
            );
          })}
        </g>
        {lanes.map((lane, index) => {
          const top = TIMELINE_AXIS_HEIGHT + index * TIMELINE_LANE_HEIGHT;
          const baseline = top + TIMELINE_LANE_HEIGHT - 8;
          return (
            <g className={`evidence-lane ${lane.key}`} key={lane.key}>
              <text className="lane-label" x={10} y={top + 26}>
                {lane.label}
              </text>
              <text className="lane-count" x={10} y={top + 42}>
                {lane.spans.length}
              </text>
              <line
                className="lane-baseline"
                x1={TIMELINE_PLOT_LEFT}
                x2={width - TIMELINE_PLOT_RIGHT}
                y1={baseline}
                y2={baseline}
              />
              <path
                className="lane-density"
                d={densityPath(
                  lane.counts,
                  globalMaximum,
                  TIMELINE_PLOT_LEFT,
                  plotWidth,
                  baseline,
                )}
              />
              <path
                className="lane-errors"
                d={errorPath(
                  lane.errors,
                  TIMELINE_PLOT_LEFT,
                  plotWidth,
                  baseline,
                )}
              />
            </g>
          );
        })}
        <g className="timeline-cursor-svg" aria-hidden="true">
          <line
            x1={TIMELINE_PLOT_LEFT + cursorPosition * plotWidth}
            x2={TIMELINE_PLOT_LEFT + cursorPosition * plotWidth}
            y1={TIMELINE_AXIS_HEIGHT - 5}
            y2={chartHeight - 8}
          />
          <circle
            cx={TIMELINE_PLOT_LEFT + cursorPosition * plotWidth}
            cy={TIMELINE_AXIS_HEIGHT - 5}
            r={3.5}
          />
        </g>
        {selected && selectedPosition !== undefined && selectedLane >= 0 && (
          <g className="timeline-selection" aria-hidden="true">
            <line
              x1={selectedX}
              x2={selectedX}
              y1={
                TIMELINE_AXIS_HEIGHT + selectedLane * TIMELINE_LANE_HEIGHT + 5
              }
              y2={
                TIMELINE_AXIS_HEIGHT +
                (selectedLane + 1) * TIMELINE_LANE_HEIGHT -
                8
              }
            />
            <circle
              cx={selectedX}
              cy={
                TIMELINE_AXIS_HEIGHT + selectedLane * TIMELINE_LANE_HEIGHT + 12
              }
              r={4}
            />
            <rect
              x={annotationX}
              y={chartHeight - 25}
              width={annotationWidth}
              height={20}
              rx={4}
            />
            <text x={annotationX + 7} y={chartHeight - 11}>
              {annotation.slice(0, 36)}
            </text>
          </g>
        )}
      </svg>
      <p className="timeline-instruction">
        移动指针检查时刻，点击定位最近事件；键盘可使用左右方向键和 Enter。
      </p>
    </section>
  );
}
