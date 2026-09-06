import { useMemo } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { number, timelineDuration } from "./format";
import { idOf, nameOf, spanHint } from "./session-model";
import type { SessionRun, TraceSpan } from "./types";
import "./tool-chain.css";

const pageSize = 40;

type Outcome = "ok" | "error" | "unknown";

function isTool(span: TraceSpan) {
  return Boolean(span.tool) || /tool|shell|exec/i.test(span.type ?? "");
}

function outcomeOf(span: TraceSpan): Outcome {
  const status = span.status?.toLowerCase() ?? "";
  if (span.error || /error|fail|cancel/.test(status)) return "error";
  if (/^(ok|success|completed|complete|done)$/.test(status)) return "ok";
  return "unknown";
}

function outcomeText(outcome: Outcome, status?: string) {
  if (outcome === "ok") return "成功";
  if (outcome === "error") return "失败";
  return status?.toLowerCase() === "pending" ? "仍在执行" : "结果未判定";
}

function unknownReason(span: TraceSpan) {
  if (span.status?.toLowerCase() === "pending")
    return "记录显示仍在执行，尚未记录结果。";
  return "没有记录明确的成功或失败结果。";
}

function excerpt(value?: string) {
  const text = value?.trim();
  if (!text) return "未记录";
  return text.length > 360 ? `${text.slice(0, 360)}…` : text;
}

function offsetLabel(offset?: number) {
  return offset === undefined ? "—" : timelineDuration(offset);
}

function parentLabel(parent: TraceSpan) {
  const label = spanHint(parent);
  const isUserTurn = /user|turn/i.test(parent.type ?? "");
  return `${isUserTurn ? "用户轮次" : "父事件"}：${nameOf(parent)}${label ? ` · ${label}` : ""}`;
}

export function SessionTools({
  run,
  spans,
  openSpan,
}: {
  run: SessionRun;
  spans: TraceSpan[];
  openSpan: (span: TraceSpan) => void;
}) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const tool = params.get("callTool") ?? "";
  const result = params.get("callResult") ?? "";
  const query = params.get("callQuery") ?? "";
  const requestedPage = Math.max(0, Math.floor(Number(params.get("callPage")) || 0));
  const update = (key: string, value: string) => setParams((current) => {
    const next = new URLSearchParams(current);
    if (value) next.set(key, value); else next.delete(key);
    if (key !== "callPage") next.delete("callPage");
    return next;
  }, { replace: true, state: location.state });
  const allSpans = spans;
  const records = useMemo(() => {
    const byId = new Map(allSpans.map((span, index) => [idOf(span, index), span]));
    return allSpans
      .map((span, order) => ({ span, order, id: idOf(span, order) }))
      .filter(({ span }) => isTool(span))
      .map(({ span, order, id }) => ({
        span,
        order,
        id,
        name: span.tool ?? nameOf(span),
        outcome: outcomeOf(span),
        parent: span.parentId ? byId.get(span.parentId) : undefined,
      }))
      .sort(
        (left, right) =>
          (left.span.startOffsetMs ?? 0) - (right.span.startOffsetMs ?? 0) ||
          left.order - right.order,
      );
  }, [allSpans]);
  const names = useMemo(
    () => [...new Set(records.map((item) => item.name))].sort((left, right) => left.localeCompare(right, "zh-CN")),
    [records],
  );
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return records.filter((item) => {
      if (tool && item.name !== tool) return false;
      if (result && item.outcome !== result) return false;
      if (!needle) return true;
      return `${item.span.input ?? ""}\n${item.span.output ?? ""}\n${item.span.error ?? ""}`.toLowerCase().includes(needle);
    });
  }, [query, records, result, tool]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(requestedPage, pageCount - 1);
  const visible = filtered.slice(page * pageSize, (page + 1) * pageSize);

  return (
    <section className="tool-chain" aria-label="工具调用链">
      <header className="tool-chain-header">
        <div>
          <p className="eyebrow">TOOL CALLS</p>
          <h2>调用链</h2>
          <p>
            顺序表示记录中的观测先后；父级只表示记录中的关系，不推断工具与模型之间的因果。
          </p>
        </div>
        <span className="tool-chain-total">共 {number(filtered.length)} 条</span>
      </header>

      <div className="tool-chain-filters" aria-label="筛选工具调用">
        <label>
          工具
          <select value={tool} onChange={(event) => update("callTool", event.target.value)}>
            <option value="">全部工具</option>
            {names.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <label>
          结果
          <select value={result} onChange={(event) => update("callResult", event.target.value)}>
            <option value="">全部结果</option>
            <option value="error">仅失败</option>
            <option value="unknown">结果未判定</option>
          </select>
        </label>
        <label className="tool-chain-search">
          搜索输入/输出/错误
          <input value={query} onChange={(event) => update("callQuery", event.target.value)} type="search" name="call-search" autoComplete="off" placeholder="命令、文件或错误内容…" />
        </label>
      </div>

      {!records.length ? (
        <p className="tool-chain-empty">这个 session 没有可观察的工具调用。</p>
      ) : !filtered.length ? (
        <p className="tool-chain-empty">没有符合当前筛选条件的工具调用；共检查 {number(records.length)} 条记录。</p>
      ) : (
        <ol className="tool-chain-list" start={page * pageSize + 1}>
          {visible.map((item) => (
            <li className="tool-call" key={item.id}>
              <div className="tool-call-topline">
                <span className="tool-call-order">{offsetLabel(item.span.startOffsetMs)}</span>
                <strong>{item.name}</strong>
                <span className={`tool-call-status ${item.outcome}`}>{outcomeText(item.outcome, item.span.status)}</span>
                <span className="tool-call-duration">耗时 {item.span.durationMs === undefined ? "—" : timelineDuration(item.span.durationMs)}</span>
              </div>
              {item.parent ? (
                <button className="tool-call-parent" onClick={() => item.parent && openSpan(item.parent)}>{parentLabel(item.parent)}</button>
              ) : (
                <p className="tool-call-parent missing">父级关系未记录。</p>
              )}
              <p className="tool-call-hint">输入提示：{spanHint(item.span) || "未记录可识别的命令或文件提示。"}</p>
              <div className="tool-call-excerpts">
                <div><span>输入摘录</span><pre>{excerpt(item.span.input)}</pre></div>
                <div><span>输出摘录</span><pre>{excerpt(item.span.output)}</pre></div>
                {item.span.error && <div><span>错误摘录</span><pre>{excerpt(item.span.error)}</pre></div>}
              </div>
              {item.outcome === "unknown" && <p className="tool-call-unknown">{unknownReason(item.span)}</p>}
              <button className="tool-call-open" onClick={() => openSpan(item.span)}>在检查器查看完整本地摘录</button>
            </li>
          ))}
        </ol>
      )}
      {filtered.length > pageSize && (
        <nav className="tool-chain-pagination" aria-label="工具调用分页">
          <button onClick={() => update("callPage", String(page - 1))} disabled={page === 0}>上一页</button>
          <span>第 {page + 1} / {pageCount} 页</span>
          <button onClick={() => update("callPage", String(page + 1))} disabled={page + 1 >= pageCount}>下一页</button>
        </nav>
      )}
      <p className="tool-chain-source">本页基于「{run.title?.trim() || run.id}」的本地 trace 摘录；原始摘录受导入上限约束。</p>
    </section>
  );
}
