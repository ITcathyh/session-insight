import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { clearRuns, getStats, importSessions, listRuns, scanLocal } from "./api";
import { dateTime, duration, number, relativeTime, tokens, trackedTokenTotal } from "./format";
import type { ImportResult, RunFilters, SessionRun, Stats } from "./types";
import { contextRatio, ev, normalizeRunEvidence, runLabel } from "./session-model";

export const initialFilters: RunFilters = {
  q: "",
  provider: "",
  tool: "",
  skill: "",
  model: "",
  from: "",
  to: "",
  error: "",
  correction: "",
  contextRisk: "",
  sort: "",
};
const importWarningText: Record<string, string> = {
  scan_candidate_limit_reached: "候选文件达到扫描上限，结果可能不完整",
  scan_file_limit_reached: "文件数量达到扫描上限，结果可能不完整",
  candidate_path_unreadable: "部分候选路径无法读取",
  line_too_long: "部分超长记录未解析",
  malformed_json: "部分记录不是有效 JSON",
  unknown_event: "存在尚未识别的事件类型",
  unknown_timestamp: "部分事件缺少有效时间",
};
function useLibrary() {
  const [params, setParams] = useSearchParams();
  const filters = useMemo<RunFilters>(() => ({
    ...initialFilters,
    ...Object.fromEntries(Object.keys(initialFilters).map((key) => [key, params.get(key) ?? ""])),
  }), [params]);
  const [runs, setRuns] = useState<SessionRun[]>([]);
  const [total, setTotal] = useState<number>();
  const [cursor, setCursor] = useState<string>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<Stats>();
  const [revision, setRevision] = useState(0);
  const requestSequence = useRef(0);
  const setFilters = (next: RunFilters) => {
    const query = new URLSearchParams();
    Object.entries(next).forEach(([key, value]) => { if (value) query.set(key, value); });
    setParams(query, { replace: true });
  };
  useEffect(() => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setStats(undefined);
    setError("");
    const timer = window.setTimeout(() => {
      void listRuns(filters).then((response) => {
        if (sequence !== requestSequence.current) return;
        setRuns(response.runs.map(normalizeRunEvidence));
        setTotal(response.total);
        setCursor(response.nextCursor ?? undefined);
      }).catch((caught: unknown) => {
        if (sequence === requestSequence.current) setError(caught instanceof Error ? caught.message : "加载失败");
      }).finally(() => {
        if (sequence === requestSequence.current) setLoading(false);
      });
      void getStats(filters).then((next) => {
        if (sequence === requestSequence.current) setStats(next);
      }).catch(() => {
        if (sequence === requestSequence.current) setStats(undefined);
      });
    }, 150);
    return () => { window.clearTimeout(timer); ++requestSequence.current; };
  }, [filters, revision]);
  const loadMore = async () => {
    if (loading || !cursor) return;
    const sequence = requestSequence.current;
    setLoading(true);
    try {
      const response = await listRuns(filters, cursor);
      if (sequence !== requestSequence.current) return;
      setRuns((previous) => [...previous, ...response.runs.map(normalizeRunEvidence)]);
      setTotal(response.total);
      setCursor(response.nextCursor ?? undefined);
      setError("");
    } catch (caught) {
      if (sequence === requestSequence.current) setError(caught instanceof Error ? caught.message : "加载失败");
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  };
  return { filters, setFilters, runs, total, cursor, error, loading, stats,
    refresh: () => setRevision((value) => value + 1), loadMore };
}

function ImportControls({
  onDone,
  compact = false,
}: {
  onDone: (result?: ImportResult) => void;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [days, setDays] = useState(7);
  const [provider, setProvider] = useState("");
  const [progress, setProgress] = useState("");
  const navigate = useNavigate();
  const [result, setResult] = useState<ImportResult>();
  const [error, setError] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const directory = useRef<HTMLInputElement>(null);

  const upload = async (files: File[]) => {
    const accepted = files.filter((item) => /\.jsonl?$/i.test(item.name));
    if (!accepted.length) { setError("请选择 .json 或 .jsonl 文件。"); return; }
    if (accepted.some((item) => item.size > 32 * 1024 * 1024)) {
      setError("单个上传文件超过 32 MB。大型 session 需要在日志所在机器运行服务，再使用扫描服务端。");
      return;
    }
    setBusy(true);
    setError("");
    setResult(undefined);
    const aggregate: ImportResult = { runs: [], count: 0, imported: 0, updated: 0, filesScanned: 0, filesSkipped: 0, warnings: [] };
    let completed = 0;
    try {
      while (completed < accepted.length) {
        const batch: File[] = [];
        let bytes = 0;
        for (const item of accepted.slice(completed)) {
          if (batch.length === 20 || (batch.length && bytes + item.size > 32 * 1024 * 1024)) break;
          batch.push(item);
          bytes += item.size;
        }
        setProgress(`正在导入 ${completed + 1}–${completed + batch.length} / ${accepted.length} 个文件…`);
        const next = await importSessions(batch);
        for (const key of ["count", "imported", "updated", "filesScanned", "filesSkipped"] as const) aggregate[key] += next[key] ?? 0;
        aggregate.runs.push(...(next.runs ?? []));
        aggregate.warnings = [...new Set([...aggregate.warnings ?? [], ...next.warnings ?? []])];
        completed += batch.length;
        setResult({ ...aggregate });
      }
      onDone(aggregate);
      if (accepted.length === 1 && aggregate.runs.length === 1 && !aggregate.filesSkipped && !aggregate.warnings?.length) navigate(`/sessions/${aggregate.runs[0].id}`);
    } catch (caught) {
      setError(`${completed ? `已完成 ${completed} 个文件，剩余文件未导入。` : ""}${caught instanceof Error ? caught.message : "无法导入 session。"}`);
      if (completed) onDone({ ...aggregate, warnings: [...aggregate.warnings ?? [], "部分文件未导入，请重新选择剩余文件。"] });
    } finally {
      setBusy(false);
      setProgress("");
      if (file.current) file.current.value = "";
      if (directory.current) directory.current.value = "";
    }
  };

  const scan = async () => {
    setBusy(true);
    setError("");
    try {
      const next = await scanLocal({ days, providers: provider ? [provider] : undefined });
      setResult(next);
      onDone(next);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "无法扫描服务端 session。",
      );
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (!window.confirm("清除已分析的 session？原文件不会被删除。")) return;
    setBusy(true);
    setError("");
    try {
      await clearRuns();
      setResult(undefined);
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "清除失败，请重试。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={compact ? "import-menu" : "import-panel"}>
      <input
        ref={file}
        data-testid="file-input"
        className="visually-hidden"
        type="file"
        accept=".json,.jsonl"
        aria-label="选择 session 文件"
        multiple
        onChange={(event) => void upload(Array.from(event.target.files ?? []))}
      />
      <input
        ref={directory}
        data-testid="directory-input"
        className="visually-hidden"
        type="file"
        accept=".json,.jsonl"
        aria-label="选择 session 目录"
        multiple
        {...({ webkitdirectory: "" } as Record<string, string>)}
        onChange={(event) => void upload(Array.from(event.target.files ?? []))}
      />
      {!compact && (
        <div className="import-copy">
          <p className="eyebrow">CODEX · CLAUDE CODE · TRAEX</p>
          <h2>从当前 session 开始分析</h2>
          <p>
            选择一个 JSONL 文件即可打开分析，或扫描运行服务的机器上的 session。
            原始记录只读，分析数据保存在服务端。
          </p>
        </div>
      )}
      <fieldset className="scan-options" disabled={busy}>
        <legend>扫描范围</legend>
        <label>时间
          <select aria-label="扫描时间范围" value={days} onChange={(event) => setDays(Number(event.target.value))}>
            <option value={1}>最近 1 天</option><option value={7}>最近 7 天</option>
            <option value={30}>最近 30 天</option><option value={0}>全部历史</option>
          </select>
        </label>
        <label>来源
          <select aria-label="扫描来源" value={provider} onChange={(event) => setProvider(event.target.value)}>
            <option value="">所有来源</option><option value="codex">仅 Codex</option>
            <option value="claude">仅 Claude Code</option><option value="traex">仅 TraeX</option>
          </select>
        </label>
      </fieldset>
      <div className="import-actions">
        <button onClick={() => file.current?.click()} disabled={busy}>
          选择文件
        </button>
        <button onClick={() => directory.current?.click()} disabled={busy}>
          选择目录
        </button>
        <button
          className="primary"
          onClick={() => void scan()}
          disabled={busy}
          data-testid="scan-local"
        >
          {busy ? "正在处理…" : "扫描服务端"}
        </button>
        <button
          className="danger-ghost"
          onClick={() => void clear()}
          disabled={busy}
          data-testid="clear-runs"
        >
          清除索引
        </button>
      </div>
      <p className="muted">扫描服务端读取运行服务的机器；选择文件或目录从当前电脑上传。同步完成后刷新页面查看最新分析。</p>
      {progress && <p role="status" className="import-progress">{progress}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {result && <ImportFeedback result={result} />}
    </div>
  );
}

function ImportFeedback({ result }: { result: ImportResult }) {
  return (
<div
          className={
            result.warnings?.length
              ? "import-result warning-panel"
              : "import-result feedback"
          }
          role="status"
          aria-live="polite"
          data-testid="import-result"
        >
          <strong>
            处理 {result.filesScanned} 个文件：新增 {result.imported} 条，更新{" "}
            {result.updated} 条，跳过 {result.filesSkipped} 个。
          </strong>
          {result.warnings?.length ? (
            <ul>
              {result.warnings.map((warning) => (
                <li key={warning}>{importWarningText[warning] ?? warning}</li>
              ))}
            </ul>
          ) : (
            <span>索引已更新。</span>
          )}
          {result.runs?.length === 1 && <Link to={`/sessions/${result.runs[0].id}`}>打开这个 session →</Link>}
        </div>
  );
}

export function Header({ refresh }: { refresh: () => void }) {
  const location = useLocation();
  const importMenu = useRef<HTMLDetailsElement>(null);
  const [dark, setDark] = useState(
    () =>
      window.localStorage.getItem("session-insight-theme") === "dark" ||
      (!window.localStorage.getItem("session-insight-theme") &&
        document.documentElement.dataset.theme === "dark"),
  );

  useEffect(() => {
    const theme = dark ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem("session-insight-theme", theme);
  }, [dark]);
  useEffect(() => {
    if (importMenu.current) importMenu.current.open = false;
  }, [location.pathname, location.search]);

  const selected = (target: string) =>
    target === "/" ? location.pathname === "/" : location.pathname === target;
  return (
    <>
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <header className="topbar">
        <Link to="/" className="brand" aria-label="Session Insight 会话库">
          <span className="brand-mark" aria-hidden="true">
            S
          </span>
          <span>
            Session Insight<small>Session 会话分析器</small>
          </span>
        </Link>
        <nav aria-label="主要导航">
          <Link
            className={selected("/") ? "active" : ""}
            aria-current={selected("/") ? "page" : undefined}
            to="/"
          >
            会话库
          </Link>
          <Link
            className={selected("/insights") ? "active" : ""}
            aria-current={selected("/insights") ? "page" : undefined}
            to="/insights"
          >
            全局分析
          </Link>
          <Link
            className={selected("/compare") ? "active" : ""}
            aria-current={selected("/compare") ? "page" : undefined}
            to="/compare"
          >
            对比
          </Link>
          <Link
            className={selected("/report") ? "active" : ""}
            aria-current={selected("/report") ? "page" : undefined}
            to="/report"
          >
            报告
          </Link>
        </nav>
        {location.pathname.startsWith("/sessions/") && (
          <span className="context-label" aria-current="page">
            Trace 详情
          </span>
        )}
        <div className="topbar-actions">
          <details ref={importMenu} className="top-import">
            <summary>导入 session</summary>
            <ImportControls compact onDone={refresh} />
          </details>
          <button
            className="icon-button"
            aria-label={dark ? "切换到浅色模式" : "切换到深色模式"}
            title={dark ? "切换到浅色模式" : "切换到深色模式"}
            onClick={() => setDark(!dark)}
          >
            <span aria-hidden="true">{dark ? "☀" : "◐"}</span>
          </button>
        </div>
      </header>
    </>
  );
}

function Filters({
  value,
  change,
}: {
  value: RunFilters;
  change: (next: RunFilters) => void;
}) {
  const update = (key: keyof RunFilters, next: string) =>
    change({ ...value, [key]: next });
  const activeCount = Object.values(value).filter(Boolean).length;
  const labels: Record<keyof RunFilters, string> = {
    q: "搜索",
    provider: "智能体",
    tool: "工具",
    skill: "Skill",
    model: "模型",
    from: "开始",
    to: "结束",
    error: "失败",
    correction: "纠偏",
    contextRisk: "高上下文",
    sort: "排序",
  };
  const active = (
    Object.entries(value) as Array<[keyof RunFilters, string]>
  ).filter(([, current]) => Boolean(current));
  return (
    <section className="filters" aria-label="筛选 session">
      <div className="filter-primary">
        <label className="search-field">
          <span className="visually-hidden">搜索 session</span>
          <input
            type="search"
            name="session-search"
            autoComplete="off"
            value={value.q}
            onChange={(event) => update("q", event.target.value)}
            placeholder="搜索对话内容、项目、模型或 session ID..."
            aria-label="搜索"
            data-testid="search-input"
          />
        </label>
        <select
          name="provider"
          value={value.provider}
          onChange={(event) => update("provider", event.target.value)}
          aria-label="Provider"
        >
          <option value="">所有智能体</option>
          <option value="codex">Codex</option>
          <option value="claude">Claude Code</option>
          <option value="traex">TraeX</option>
        </select>
        <select
          name="quality"
          value={value.error}
          onChange={(event) => update("error", event.target.value)}
          aria-label="异常"
        >
          <option value="">全部质量</option>
          <option value="true">仅看失败</option>
        </select>
        <details className="advanced-filters">
          <summary>
            更多筛选{activeCount > 0 && <span>{activeCount}</span>}
          </summary>
          <div className="advanced-filter-grid">
            <label>
              模型
              <input
                name="model"
                autoComplete="off"
                value={value.model}
                onChange={(event) => update("model", event.target.value)}
                placeholder="例如 gpt-5.6-sol..."
                aria-label="按模型筛选"
              />
            </label>
            <label>
              工具
              <input
                name="tool"
                autoComplete="off"
                value={value.tool}
                onChange={(event) => update("tool", event.target.value)}
                placeholder="例如 exec..."
                aria-label="按工具筛选"
              />
            </label>
            <label>
              Skill
              <input
                name="skill"
                autoComplete="off"
                value={value.skill}
                onChange={(event) => update("skill", event.target.value)}
                placeholder="例如 query..."
                aria-label="按 Skill 筛选"
              />
            </label>
            <label>
              纠偏
              <select
                name="correction"
                value={value.correction}
                onChange={(event) => update("correction", event.target.value)}
                aria-label="纠偏"
              >
                <option value="">全部</option>
                <option value="true">有纠偏候选</option>
              </select>
            </label>
            <label>
              上下文
              <select
                name="context-risk"
                value={value.contextRisk}
                onChange={(event) => update("contextRisk", event.target.value)}
                aria-label="上下文风险"
              >
                <option value="">全部</option>
                <option value="true">高风险</option>
              </select>
            </label>
            <label>
              开始日期
              <input
                name="from"
                type="date"
                value={value.from}
                onChange={(event) => update("from", event.target.value)}
              />
            </label>
            <label>
              结束日期
              <input
                name="to"
                type="date"
                value={value.to}
                onChange={(event) => update("to", event.target.value)}
              />
            </label>
          </div>
        </details>
        {activeCount > 0 && (
          <button
            className="ghost-button"
            onClick={() => change(initialFilters)}
          >
            清除筛选
          </button>
        )}
      </div>
      {active.length > 0 && (
        <div className="active-filters" aria-label="已启用的筛选">
          {active.map(([key, current]) => (
            <button
              key={key}
              aria-label={`移除${labels[key]}筛选`}
              onClick={() => update(key, "")}
            >
              <span>
                {labels[key]}：{current === "true" ? "是" : current}
              </span>
              <b aria-hidden="true">×</b>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

export function Library() {
  const state = useLibrary();
  const navigate = useNavigate();
  const location = useLocation();
  const [picked, setPicked] = useState<string[]>([]);
  const [importResult, setImportResult] = useState<ImportResult>();
  // The server already applied every filter; re-filtering here would only hide
  // rows the pager has fetched and desync the count from the header.
  const visible = state.runs;
  const toggle = (id: string) =>
    setPicked((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : current.length < 2
          ? [...current, id]
          : [current[1], id],
    );

  // Header metrics come from /stats so they describe every matching run, not the
  // page that happens to be loaded.
  const stats = state.stats;
  const totalTokens = stats?.tokens?.total;
  const totalFailures = stats && (stats.toolOutcomeRunCount > 0 || stats.toolFailures > 0) ? stats.toolFailures : undefined;
  const highContextCount = stats?.contextRiskRuns;
  const cacheRatio =
    stats?.cacheHitRatio === undefined
      ? undefined
      : Math.round(stats.cacheHitRatio * 100);
  const scopeNote =
    stats === undefined
      ? "正在统计..."
      : `覆盖全部 ${number(stats.runCount)} 个匹配 session`;

  const sentinel = useRef<HTMLDivElement>(null);
  const { cursor, loading, loadMore } = state;
  useEffect(() => {
    const node = sentinel.current;
    // jsdom and older engines have no IntersectionObserver; the explicit
    // "load more" button remains the fallback path.
    if (!node || !cursor || loading || typeof IntersectionObserver === "undefined")
      return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [cursor, loading, loadMore]);

  return (
    <main id="main-content" className="workspace">
      <div className="page-heading">
        <div>
          <p className="eyebrow">SESSION INSIGHT</p>
          <h1>会话库</h1>
          <p>打开一个 session，查看 Token 去向、问题线索和工具调用链。</p>
        </div>
        <div className="page-actions">
          <span className="session-count" aria-live="polite">
            {state.total === undefined
              ? "正在加载..."
              : `${state.total} 个 session`}
          </span>
          {picked.length === 2 && (
            <button
              className="primary"
              onClick={() => navigate(`/compare?a=${picked[0]}&b=${picked[1]}`)}
            >
              对比已选 2 条
            </button>
          )}
        </div>
      </div>
      {state.total === 0 && !state.loading && !state.error && !Object.values(state.filters).some(Boolean) ? (
        <ImportControls onDone={(result) => { setImportResult(result); state.refresh(); }} />
      ) : (
        <>
          {importResult && <ImportFeedback result={importResult} />}
          {(stats === undefined || stats.runCount > 0) && (
            <div className="metric-hero-grid" data-testid="library-metrics">
              <div className="metric-card-body">
                <div className="metric-top-label">
                  <span>总追踪 Tokens</span>
                  <span className="pro-pill exact"><span className="status-dot-subtle"></span>全量</span>
                </div>
                <div className="metric-big-num" data-testid="metric-tokens">
                  {tokens(totalTokens)}
                </div>
                <div className="metric-footer-note">{scopeNote}</div>
              </div>

              <div className="metric-card-body">
                <div className="metric-top-label">
                  <span>工具失败</span>
                  <span className={`pro-pill ${totalFailures ? "error" : "neutral"}`}>
                    <span className="status-dot-subtle"></span>{totalFailures === undefined ? "未判定" : totalFailures ? "需关注" : "未记录失败"}
                  </span>
                </div>
                <div className="metric-big-num" style={{ color: totalFailures ? "var(--danger)" : "inherit" }}>
                  {totalFailures === undefined ? "—" : number(totalFailures)} <span style={{ fontSize: "13px", fontWeight: 400, color: "var(--muted)" }}>次失败</span>
                </div>
                <div className="metric-footer-note">
                  {stats === undefined
                    ? "日志中记录的工具失败"
                    : `分布在 ${number(stats.failedRunCount)} 个 session`}
                  {stats && <span> · {number(stats.toolOutcomeRunCount)} / {number(stats.runCount)} 条结果可判定</span>}
                </div>
              </div>

              <div className="metric-card-body">
                <div className="metric-top-label">
                  <span>高上下文水位 (&gt;80%)</span>
                  <span className={`pro-pill ${highContextCount ? "warning" : "neutral"}`}>
                    <span className="status-dot-subtle"></span>{highContextCount ?? "—"} 条会话
                  </span>
                </div>
                <div className="metric-big-num" style={{ color: highContextCount ? "var(--warning)" : "inherit" }}>
                  {highContextCount ?? "—"} <span style={{ fontSize: "13px", fontWeight: 400, color: "var(--muted)" }}>超警戒</span>
                </div>
                <div className="metric-footer-note">
                  建议关注长会话 Compact
                </div>
              </div>

              <div className="metric-card-body">
                <div className="metric-top-label">
                  <span>Prompt Cache 命中</span>
                  <span className="pro-pill exact"><span className="status-dot-subtle"></span>全量</span>
                </div>
                <div className="metric-big-num">
                  {cacheRatio === undefined ? "—" : `${cacheRatio}%`}
                </div>
                <div className="metric-footer-note">
                  cache read 占可缓存输入的比例
                </div>
              </div>
            </div>
          )}

          <Filters value={state.filters} change={state.setFilters} />

          <div className="filter-tags-strip">
            <button
              className={`tag-chip ${!state.filters.error && !state.filters.contextRisk && !state.filters.correction ? "selected" : ""}`}
              onClick={() => state.setFilters({ ...state.filters, error: "", contextRisk: "", correction: "" })}
            >
              全部会话{state.total === undefined ? "" : ` (${number(state.total)})`}
            </button>
            <button
              className={`tag-chip ${state.filters.error === "true" ? "selected" : ""}`}
              onClick={() => state.setFilters({ ...state.filters, error: state.filters.error === "true" ? "" : "true" })}
            >
              <span className="status-dot-subtle" style={{ color: "var(--danger)" }}></span>
              存在工具失败{stats === undefined ? "" : ` (${number(stats.failedRunCount)})`}
            </button>
            <button
              className={`tag-chip ${state.filters.contextRisk === "true" ? "selected" : ""}`}
              onClick={() => state.setFilters({ ...state.filters, contextRisk: state.filters.contextRisk === "true" ? "" : "true" })}
            >
              <span className="status-dot-subtle" style={{ color: "var(--warning)" }}></span>
              高上下文 &gt;80%{stats === undefined ? "" : ` (${number(stats.contextRiskRuns)})`}
            </button>
            <button
              className={`tag-chip ${state.filters.correction === "true" ? "selected" : ""}`}
              onClick={() => state.setFilters({ ...state.filters, correction: state.filters.correction === "true" ? "" : "true" })}
            >
              <span className="status-dot-subtle" style={{ color: "var(--brand)" }}></span>
              命中纠偏候选{stats === undefined ? "" : ` (${number(stats.correctionRuns)})`}
            </button>
          </div>

          <div className="table-note">
            <label className="library-sort">排序
              <select aria-label="会话排序" value={state.filters.sort ?? ""}
                onChange={(event) => state.setFilters({ ...state.filters, sort: event.target.value })}>
                <option value="">最近开始</option>
                <option value="tokens">Token 最多</option>
                <option value="duration">耗时最长</option>
                <option value="tools">工具调用最多</option>
                <option value="context">上下文最高</option>
                <option value="startedAsc">最早开始</option>
              </select>
            </label>
            <span>缺失数据保持“不可用”，不会按 0 计算。</span>
            <span>
              {state.total === undefined
                ? `${visible.length} 条结果`
                : `已显示 ${visible.length} / ${number(state.total)} 条`}
            </span>
          </div>
          {state.error && (
            <p className="error" role="alert">
              {state.error} <button onClick={state.refresh}>重新加载</button>
            </p>
          )}
          {!state.loading && !state.error && !visible.length && (
            <div className="empty">
              <strong>没有匹配的 session</strong>
              <span>试试更短的关键词，或清除筛选查看全部记录。</span>
              <button onClick={() => state.setFilters(initialFilters)}>清除筛选</button>
            </div>
          )}
          <div className="table-wrap" aria-busy={state.loading}>
            <table className="session-table">
              <thead>
                <tr>
                  <th aria-label="选择" />
                  <th>会话 / 项目</th>
                  <th>智能体 / 模型</th>
                  <th>开始时间</th>
                  <th>墙钟 / 活跃构成</th>
                  <th>Tracked tokens</th>
                  <th>风险信号</th>
                  <th>证据</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((run) => {
                  const total = trackedTokenTotal(run.tokens);
                  const peak = contextRatio(run);
                  const sessionId = run.sourceSessionId ?? run.sessionRef ?? run.id;
                  const label = runLabel(run);
                  // When there is no title the headline already carries the
                  // project and id, so the sub-line must not repeat them.
                  const titled = Boolean(run.title?.trim());
                  const subLabel =
                    [
                      titled ? run.project : undefined,
                      run.runKind === "subagent" ? "子 agent" : undefined,
                    ]
                      .filter(Boolean)
                      .join(" · ") || (titled ? sessionId : "");
                  const wall = run.wallDurationMs ?? run.durationMs ?? 0;
                  const activeRatio = wall > 0 && run.activeDurationMs !== undefined ? Math.min(1, Math.max(0, run.activeDurationMs / wall)) : 1;
                  return (
                    <tr key={run.id}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`选择 ${runLabel(run)} 进行对比`}
                          checked={picked.includes(run.id)}
                          onChange={() => toggle(run.id)}
                        />
                      </td>
                      <td>
                        <Link
                          className="session-link"
                          data-testid={`session-${run.id}`}
                          to={`/sessions/${run.id}`}
                          state={{ librarySearch: location.search }}
                          title={`${label}\n${sessionId}`}
                        >
                          <strong className={run.title ? "" : "untitled"}>
                            {label}
                          </strong>
                          {subLabel && <small>{subLabel}</small>}
                          {run.snippet && (
                            // Why this row matched, when the hit is in the body
                            // rather than the title.
                            <small className="match-snippet">{run.snippet}</small>
                          )}
                        </Link>
                      </td>
                      <td data-label="智能体">
                        <span className="provider">{run.provider ?? "—"}</span>
                        <small>{run.model ?? "模型不可用"}</small>
                      </td>
                      <td data-label="开始" title={dateTime(run.startedAt)}>
                        {relativeTime(run.startedAt)}
                        <small>{dateTime(run.startedAt)}</small>
                      </td>
                      <td data-label="耗时">
                        {duration(run.wallDurationMs ?? run.durationMs)}
                        <small>活跃 {duration(run.activeDurationMs)}</small>
                        {run.activeDurationMs !== undefined && <div className="time-ratio-meter" title={`活跃 ${Math.round(activeRatio * 100)}%`}>
                          <div className="active-fill" style={{ width: `${Math.round(activeRatio * 100)}%` }}></div>
                          <div className="idle-fill" style={{ width: `${Math.round((1 - activeRatio) * 100)}%` }}></div>
                        </div>}
                      </td>
                      <td data-label="Token">{tokens(total)}</td>
                      <td data-label="信号">
                        <div className="risk-signals">
                          {run.counts?.toolFailures ? (
                            <span className="danger">
                              {run.counts.toolFailures} 失败
                            </span>
                          ) : null}
                          {peak !== undefined && peak >= 0.8 ? (
                            <span className="warning">
                              Context {Math.round(peak * 100)}%
                            </span>
                          ) : null}
                          {run.counts?.corrections ? (
                            <span className="warning">
                              {run.counts.corrections} 纠偏候选
                            </span>
                          ) : null}
                          {!run.counts?.toolFailures &&
                          !(peak !== undefined && peak >= 0.8) &&
                          !run.counts?.corrections ? (
                            <span className="muted">未记录风险信号</span>
                          ) : null}
                        </div>
                      </td>
                      <td data-label="证据">
                        {ev(run.quality?.trajectory ?? run.quality?.tools)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {state.cursor && (
            <>
              {/* Paging 655 runs by hand meant 13 clicks; the sentinel keeps the
                  button for keyboard and test use but scrolling is enough. */}
              <div ref={sentinel} aria-hidden="true" className="scroll-sentinel" />
              <button
                className="load-more"
                data-testid="load-more"
                onClick={() => void state.loadMore()}
                disabled={state.loading}
              >
                {state.loading ? "正在加载..." : "加载更多"}
              </button>
            </>
          )}
        </>
      )}
    </main>
  );
}
