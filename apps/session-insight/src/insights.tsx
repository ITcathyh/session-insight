import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getStats } from "./api";
import { duration, number, tokens } from "./format";
import type { DayStat, Stats } from "./types";

const emptyFilters = {
  q: "",
  provider: "",
  tool: "",
  skill: "",
  model: "",
  from: "",
  to: "",
};

function percent(part: number, whole: number): string {
  if (!whole) return "—";
  return `${Math.round((part / whole) * 100)}%`;
}

/** A bar chart of daily volume. Deliberately unlabelled per-bar: the point is
 *  the shape of the workload over time, with exact figures on hover. Only the
 *  ends are dated, which is enough to read the span without a dense axis. */
function DailyChart({ days }: { days: DayStat[] }) {
  if (!days.length) return <p className="empty-inline">没有可用的时间分布。</p>;
  const observedDays = days.filter(
    (day): day is DayStat & { tokens: number } => typeof day.tokens === "number",
  );
  const actualPeak = Math.max(...observedDays.map((day) => day.tokens), 0);
  const scalePeak = Math.max(actualPeak, 1);
  return (
    <>
      <div
        className="insight-bars"
        role="img"
        aria-label={`最近 ${days.length} 天的 token 用量分布`}
      >
        {days.map((day) => {
          const height =
            day.tokens === undefined
              ? 0
              : Math.max(2, Math.round((day.tokens / scalePeak) * 100));
          return (
            <div
              key={day.date}
              className={`insight-bar${day.failures > 0 ? " has-failures" : ""}`}
              style={{ height: `${height}%` }}
              title={`${day.date}\n${number(day.tokens)} tokens · ${day.tokenRunCount}/${day.runs} 个 session 有 token 观测 · ${day.failures} 次失败`}
            />
          );
        })}
      </div>
      <div className="insight-axis">
        <span>{days[0].date}</span>
        <span>峰值 {observedDays.length ? number(actualPeak) : "—"} tokens</span>
        <span>{days[days.length - 1].date}</span>
      </div>
    </>
  );
}

export function Insights() {
  const [stats, setStats] = useState<Stats>();
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    setError("");
    void getStats(emptyFilters)
      .then((next) => live && setStats(next))
      .catch((caught) => {
        if (live)
          setError(caught instanceof Error ? caught.message : "统计加载失败");
      });
    return () => {
      live = false;
    };
  }, []);

  const busiest = useMemo(() => {
    const observedDays = stats?.daily.filter(
      (day): day is DayStat & { tokens: number } => typeof day.tokens === "number",
    );
    if (!observedDays?.length) return undefined;
    return observedDays.reduce((top, day) => (day.tokens > top.tokens ? day : top));
  }, [stats]);

  if (error)
    return (
      <main id="main-content" className="workspace">
        <p className="error" role="alert">
          {error}
        </p>
      </main>
    );

  if (!stats)
    return (
      <main id="main-content" className="workspace">
        <p className="muted">正在统计全部 session…</p>
      </main>
    );

  if (stats.runCount === 0)
    return (
      <main id="main-content" className="workspace">
        <div className="empty">
          <strong>还没有已索引的 session</strong>
          <span>
            先到<Link to="/">会话库</Link>导入记录或扫描服务端记录。
          </span>
        </div>
      </main>
    );

  const totalTokens = stats.tokens.total;
  const cacheRead = stats.tokens.cacheRead;
  const inputUncached = stats.tokens.inputUncached;
  const output = stats.tokens.output;
  const cacheWrite = stats.tokens.cacheWrite;
  const recordedFailures = stats.toolFailures > 0;
  const toolFailures = recordedFailures || stats.toolOutcomeRunCount > 0 ? stats.toolFailures : undefined;
  const failedRuns = recordedFailures || stats.toolOutcomeRunCount > 0 ? stats.failedRunCount : undefined;
  const toolFailureNote = recordedFailures
    ? `已记录 ${number(stats.toolFailures)} 次失败；${number(stats.toolOutcomeRunCount)}/${number(stats.runCount)} 个 session 的工具结果可判定。`
    : stats.toolOutcomeRunCount > 0
      ? `${number(stats.toolOutcomeRunCount)}/${number(stats.runCount)} 个 session 的工具结果可判定。`
      : stats.toolRunCount > 0
        ? `${number(stats.toolRunCount)} 个 session 记录了工具调用；没有可判定的工具结果。`
        : "没有可判定的工具结果。";

  return (
    <main id="main-content" className="workspace insights-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Cross-session analysis</p>
          <h1>全局分析</h1>
          <p>{`覆盖已索引的全部 ${number(stats.runCount)} 个 session。所有数字来自可观察字段，不做推测。`}</p>
        </div>
      </div>

      <div className="metric-hero-grid">
        <div className="metric-card-body">
          <div className="metric-top-label">
            <span>累计 Tokens</span>
          </div>
          <div className="metric-big-num">{tokens(totalTokens)}</div>
          <div className="metric-footer-note">
            {number(stats.tokenRunCount)} 个 session 有 token 观测
          </div>
        </div>
        <div className="metric-card-body">
          <div className="metric-top-label">
            <span>墙钟总时长</span>
          </div>
          <div className="metric-big-num">{duration(stats.wallDurationMs)}</div>
          <div className="metric-footer-note">
            其中活跃 {duration(stats.activeDurationMs)}（
            {percent(stats.activeDurationMs, stats.wallDurationMs)}）
          </div>
        </div>
        <div className="metric-card-body">
          <div className="metric-top-label">
            <span>工具失败</span>
          </div>
          <div className="metric-big-num" style={{ color: recordedFailures ? "var(--danger)" : "inherit" }}>
            {number(toolFailures)}
          </div>
          <div className="metric-footer-note">
            {toolFailureNote}
          </div>
        </div>
        <div className="metric-card-body">
          <div className="metric-top-label">
            <span>受影响 session</span>
          </div>
          <div className="metric-big-num">
            {number(failedRuns)}
          </div>
          <div className="metric-footer-note">
            占全部的 {failedRuns === undefined ? "—" : percent(failedRuns, stats.runCount)}
          </div>
        </div>
      </div>

      <section className="insight-block">
        <header>
          <h2>用量走势</h2>
          <span className="muted">
            最近 {stats.daily.length} 天
            {busiest ? ` · 峰值 ${busiest.date}` : ""}
          </span>
        </header>
        <DailyChart days={stats.daily} />
        <p className="insight-note">
          条形高度为当日 token 用量，红色表示当日出现工具失败；未观测 token 的日期显示为 —。
        </p>
      </section>

      <div className="insight-columns">
        <section className="insight-block">
          <header>
            <h2>Token 构成</h2>
          </header>
          <dl className="insight-list">
            {([
              ["缓存读取", cacheRead],
              ["未缓存输入", inputUncached],
              ["输出", output],
              ["缓存写入", cacheWrite],
            ] as Array<[string, number | undefined]>)
              .sort((a, b) => (b[1] ?? -1) - (a[1] ?? -1))
              .map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>
                    <span className="insight-value">{number(value)}</span>
                    <span className="insight-share">
                      {value === undefined ? "—" : percent(value, totalTokens ?? 0)}
                    </span>
                  </dd>
                </div>
              ))}
          </dl>
          <p className="insight-note">
            reasoning 是 output 的子集，不重复计入总量。
          </p>
        </section>

        <section className="insight-block">
          <header>
            <h2>最常失败的工具</h2>
          </header>
          {stats.tools.length ? (
            <table className="insight-table">
              <thead>
                <tr>
                  <th>工具</th>
                  <th>调用</th>
                  <th>失败</th>
                  <th>失败率</th>
                </tr>
              </thead>
              <tbody>
                {stats.tools.map((tool) => (
                  <tr key={tool.name}>
                    <td>
                      <Link to={`/?tool=${encodeURIComponent(tool.name)}`}>
                        {tool.name}
                      </Link>
                    </td>
                    <td>{number(tool.calls)}</td>
                    <td className={tool.failures ? "danger" : ""}>
                      {number(tool.failures)}
                    </td>
                    <td>{percent(tool.failures, tool.calls)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="empty-inline">没有观察到工具调用。</p>
          )}
        </section>
      </div>

      <section className="insight-block">
        <header>
          <h2>项目分布</h2>
          <span className="muted">按 token 用量排序</span>
        </header>
        <table className="insight-table">
          <thead>
            <tr>
              <th>项目</th>
              <th>Session</th>
              <th>Tokens</th>
              <th>墙钟</th>
              <th>失败</th>
            </tr>
          </thead>
          <tbody>
            {stats.projects.map((project) => (
              <tr key={project.name}>
                <td>
                  <Link to={`/?q=${encodeURIComponent(project.name)}`}>
                    {project.name}
                  </Link>
                </td>
                <td>{number(project.runs)}</td>
                <td>
                  {number(project.tokens)}
                  {project.tokenRunCount !== project.runs && (
                    <span className="muted">{`（${project.tokenRunCount}/${project.runs} 个已观测）`}</span>
                  )}
                </td>
                <td>{duration(project.durationMs)}</td>
                <td className={project.failures ? "danger" : ""}>
                  {number(project.failures)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="insight-columns">
        <section className="insight-block">
          <header>
            <h2>智能体构成</h2>
          </header>
          <dl className="insight-list">
            {stats.providers.map((provider) => (
              <div key={provider.name}>
                <dt>
                  <Link to={`/?provider=${encodeURIComponent(provider.name)}`}>
                    {provider.name}
                  </Link>
                </dt>
                <dd>
                  <span className="insight-value">{number(provider.count)}</span>
                  <span className="insight-share">
                    {percent(provider.count, stats.runCount)}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="insight-block">
          <header>
            <h2>模型构成</h2>
          </header>
          <dl className="insight-list">
            {stats.models.slice(0, 8).map((model) => (
              <div key={model.name}>
                <dt>
                  <Link to={`/?model=${encodeURIComponent(model.name)}`}>
                    {model.name}
                  </Link>
                </dt>
                <dd>
                  <span className="insight-value">{number(model.count)}</span>
                  <span className="insight-share">
                    {percent(model.count, stats.runCount)}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      </div>

      <section className="insight-block">
        <header>
          <h2>风险面</h2>
        </header>
        <dl className="insight-list">
          <div>
            <dt>
              <Link to="/?contextRisk=true">上下文峰值 &gt; 80%</Link>
            </dt>
            <dd>
              <span className="insight-value">{number(stats.contextRiskRuns)}</span>
              <span className="insight-share">
                {percent(stats.contextRiskRuns, stats.runCount)}
              </span>
            </dd>
          </div>
          <div>
            <dt>
              <Link to="/?correction=true">出现纠偏候选</Link>
            </dt>
            <dd>
              <span className="insight-value">{number(stats.correctionRuns)}</span>
              <span className="insight-share">
                {percent(stats.correctionRuns, stats.runCount)}
              </span>
            </dd>
          </div>
          <div>
            <dt>
              <Link to="/?error=true">出现工具失败</Link>
            </dt>
            <dd>
              <span className="insight-value">{number(failedRuns)}</span>
              <span className="insight-share">
                {failedRuns === undefined ? "—" : percent(failedRuns, stats.runCount)}
              </span>
            </dd>
          </div>
          <div>
            <dt>使用了子 agent</dt>
            <dd>
              <span className="insight-value">{number(stats.subagentRuns)}</span>
              <span className="insight-share">
                {percent(stats.subagentRuns, stats.runCount)}
              </span>
            </dd>
          </div>
          <div>
            <dt>空档时间</dt>
            <dd>
              <span className="insight-value">{duration(stats.idleDurationMs)}</span>
              <span className="insight-share">
                {percent(stats.idleDurationMs, stats.wallDurationMs)}
              </span>
            </dd>
          </div>
        </dl>
        <p className="insight-note">
          带链接的行会跳回会话库并应用对应筛选；子 agent
          与空档时间没有对应筛选，只作为分母参考。
        </p>
      </section>
    </main>
  );
}
