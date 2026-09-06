import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./app";
import type { SessionRun } from "./types";

const session: SessionRun = {
  id: "example", title: "检查构建失败", provider: "codex", durationMs: 200000,
  quality: { token: "unknown", tools: "unknown" },
  trace: Array.from({ length: 1000 }, (_, index) => ({
    id: `event-${index}`, type: "tool", tool: "exec_command", name: "exec_command",
    input: index === 998 ? '{"cmd":"check-needle --verbose"}' : '{"cmd":"other command"}',
    startOffsetMs: index * 100, durationMs: 50, status: "unknown",
  })),
};
const stats = { runCount: 1, tokens: {}, tokenRunCount: 0, projects: [], daily: [], tools: [], providers: [], models: [] };
const respond = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
function mockSession() {
  vi.stubGlobal("fetch", vi.fn((url: RequestInfo | URL) => String(url).includes("/runs/example")
    ? respond(session) : String(url).includes("/stats") ? respond(stats) : respond({ runs: [session], total: 1 })));
}
function mount(path = "/") { return render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>); }
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear(); });

describe("analysis workflow", () => {
  it("keeps search and recovery visible for zero matches", async () => {
    vi.stubGlobal("fetch", vi.fn(() => respond({ runs: [], total: 0 })));
    mount("/?q=missing");
    expect(await screen.findByText("没有匹配的 session")).toBeInTheDocument();
    expect(screen.getByTestId("search-input")).toHaveValue("missing");
    expect(screen.queryByText("从当前 session 开始分析")).not.toBeInTheDocument();
  });

  it("uses server-side sorting across the library", async () => {
    mockSession(); mount();
    await screen.findByTestId("session-example");
    fireEvent.change(screen.getByLabelText("会话排序"), { target: { value: "tokens" } });
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("/runs?sort=tokens"))).toBe(true));
  });

  it("scans the selected range and retains skipped-file feedback after the first import", async () => {
    let scanned = false;
    vi.stubGlobal("fetch", vi.fn((url: RequestInfo | URL) => {
      if (String(url).endsWith("/scan")) {
        scanned = true;
        return respond({ runs: [session], count: 1, imported: 1, updated: 0, filesScanned: 2, filesSkipped: 1, warnings: ["scan_file_limit_reached"] });
      }
      return String(url).includes("/stats") ? respond(stats) : respond({ runs: scanned ? [session] : [], total: scanned ? 1 : 0 });
    }));
    mount();
    await screen.findByText("从当前 session 开始分析");
    const main = within(screen.getByRole("main"));
    fireEvent.change(main.getByLabelText("扫描时间范围"), { target: { value: "1" } });
    fireEvent.change(main.getByLabelText("扫描来源"), { target: { value: "codex" } });
    fireEvent.click(main.getByTestId("scan-local"));
    await screen.findByTestId("session-example");
    expect(main.getByTestId("import-result")).toHaveTextContent("跳过 1 个");
    expect(main.getByTestId("import-result")).toHaveTextContent("文件数量达到扫描上限");
    expect(fetch).toHaveBeenCalledWith("/api/session-insights/scan", expect.objectContaining({ body: JSON.stringify({ days: 1, providers: ["codex"] }) }));
  });

  it("batches directories exceeding the 20-file request limit", async () => {
    const sizes: number[] = [];
    vi.stubGlobal("fetch", vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith("/import")) {
        const size = (init?.body as FormData).getAll("files").length;
        sizes.push(size);
        return respond({ runs: [], count: size, imported: size, updated: 0, filesScanned: size, filesSkipped: 0 });
      }
      return String(url).includes("/stats") ? respond(stats) : respond({ runs: [session], total: 1 });
    }));
    mount();
    await screen.findByTestId("session-example");
    fireEvent.change(screen.getByTestId("directory-input"), { target: { files: Array.from({ length: 23 }, (_, index) => new File(["{}"], `${index}.jsonl`)) } });
    expect(sizes).toEqual([]);
    fireEvent.click(screen.getByTestId("sync-selected"));
    await waitFor(() => expect(screen.getByTestId("import-result")).toHaveTextContent("新增 23 条"));
    expect(sizes).toEqual([20, 3]);
  });

  it("uploads only checked files after the user starts sync and preserves relative paths", async () => {
    const uploads: FormData[] = [];
    vi.stubGlobal("fetch", vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith("/import")) {
        uploads.push(init?.body as FormData);
        return respond({ runs: [], count: 1, imported: 1, updated: 0, filesScanned: 1, filesSkipped: 0 });
      }
      return String(url).includes("/stats") ? respond(stats) : respond({ runs: [session], total: 1 });
    }));
    mount();
    await screen.findByTestId("session-example");
    fireEvent.click(screen.getByText("同步会话"));
    const child = new File(["{}"], "worker.jsonl");
    Object.defineProperty(child, "webkitRelativePath", { value: "project/subagents/worker.jsonl" });
    const files = [child, new File(["{}"], "private.jsonl")];
    fireEvent.change(screen.getByTestId("directory-input"), { target: { files } });
    expect(uploads).toHaveLength(0);
    fireEvent.click(screen.getByLabelText("同步 private.jsonl"));
    expect(screen.getByTestId("sync-selected")).toHaveTextContent("同步所选 1 个文件");
    fireEvent.click(screen.getByTestId("sync-selected"));
    await waitFor(() => expect(uploads).toHaveLength(1));
    expect(uploads[0].getAll("relativePath")).toEqual(["project/subagents/worker.jsonl"]);
    expect((uploads[0].getAll("files") as File[]).map((file) => file.name)).toEqual(["worker.jsonl"]);
  });

  it("cancels a pending selection without uploading and disables oversized files", async () => {
    mockSession(); mount();
    await screen.findByTestId("session-example");
    fireEvent.click(screen.getByText("同步会话"));
    const oversized = new File(["{}"], "large.jsonl");
    Object.defineProperty(oversized, "size", { value: 32 * 1024 * 1024 + 1 });
    fireEvent.change(screen.getByTestId("file-input"), { target: { files: [oversized, new File(["{}"], "small.jsonl")] } });
    expect(screen.getByLabelText("同步 large.jsonl")).toBeDisabled();
    expect(screen.getByLabelText("同步 large.jsonl")).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "取消全选" }));
    expect(screen.getByTestId("sync-selected")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "全选可同步文件" }));
    expect(screen.getByTestId("sync-selected")).toHaveTextContent("同步所选 1 个文件");
    fireEvent.click(screen.getByRole("button", { name: "取消选择" }));
    expect(screen.queryByTestId("sync-selected")).not.toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/import"))).toBe(false);
  });

  it("retains failed selections in an initially empty library and retries only unfinished batches", async () => {
    const sizes: number[] = [];
    let imported = false;
    vi.stubGlobal("fetch", vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith("/import")) {
        const size = (init?.body as FormData).getAll("files").length;
        sizes.push(size);
        if (sizes.length === 2) return Promise.resolve(new Response("try again", { status: 500 }));
        imported = true;
        return respond({ runs: [], count: size, imported: size, updated: 0, filesScanned: size, filesSkipped: 0 });
      }
      return String(url).includes("/stats") ? respond(stats) : respond({ runs: imported ? [session] : [], total: imported ? 1 : 0 });
    }));
    mount();
    await screen.findByText("从当前 session 开始分析");
    const main = within(screen.getByRole("main"));
    fireEvent.change(main.getByTestId("directory-input"), { target: { files: Array.from({ length: 23 }, (_, index) => new File(["{}"], `${index}.jsonl`)) } });
    fireEvent.click(main.getByTestId("sync-selected"));
    await waitFor(() => expect(main.getByRole("alert")).toHaveTextContent("已完成 20 个文件"));
    expect(main.getByTestId("sync-selected")).toHaveTextContent("同步所选 3 个文件");
    expect(main.getAllByRole("checkbox")).toHaveLength(3);
    fireEvent.click(main.getByTestId("sync-selected"));
    await waitFor(() => expect(sizes).toEqual([20, 3, 3]));
    await screen.findByTestId("session-example");
  });

  it("searches all event excerpts and reveals a match beyond summary sampling", async () => {
    mockSession(); mount("/sessions/example?view=timeline&density=summary");
    await screen.findByTestId("session-detail");
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索事件" }), { target: { value: "check-needle" } });
    expect(screen.getByText("显示 1 / 1000 个事件")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "搜索事件" }), { key: "Enter" });
    expect(screen.getByTestId("trace-inspector")).toHaveTextContent("check-needle");
    expect(screen.getByRole("treeitem")).toHaveAttribute("aria-selected", "true");
  });

  it("shows full default evidence with bounded rendered rows", async () => {
    mockSession(); mount("/sessions/example?view=timeline");
    await screen.findByTestId("session-detail");
    expect(screen.getByText("显示 1000 / 1000 个事件")).toBeInTheDocument();
    expect(screen.getAllByRole("treeitem").length).toBeLessThan(80);
  });

  it("opens linked telemetry and preserves an explicitly selected Token view", async () => {
    vi.stubGlobal("fetch", vi.fn(() => respond({ ...session, trace: [{ id: "pulse", name: "Token pulse", type: "model", tokenDelta: { output: 4 } }] })));
    const rendered = mount("/sessions/example?focus=pulse");
    await screen.findByTestId("session-detail");
    expect(screen.getByTestId("toggle-telemetry")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("treeitem")).toHaveTextContent("Token pulse");
    fireEvent.click(screen.getByRole("button", { name: "Token 分析" }));
    expect(screen.getByRole("heading", { name: "最大消耗事件" })).toBeInTheDocument();
    rendered.unmount();
    mount("/sessions/example?view=tokens&focus=pulse");
    await screen.findByTestId("session-detail");
    expect(screen.getByRole("heading", { name: "最大消耗事件" })).toBeInTheDocument();
  });

  it("clears incompatible filters when locating a conversation turn", async () => {
    vi.stubGlobal("fetch", vi.fn(() => respond({ ...session, trace: [{ id: "user", type: "user", input: "复查测试", startOffsetMs: 100 }] })));
    mount("/sessions/example?view=conversation&type=tool&errors=1&event=nomatch&fromMs=1000&toMs=2000");
    await screen.findByTestId("session-detail");
    fireEvent.click(screen.getByRole("button", { name: "在时间轴定位 →" }));
    expect(screen.getByRole("treeitem")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "仅失败" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByLabelText("事件类型")).toHaveValue("all");
    expect(screen.getByRole("searchbox", { name: "搜索事件" })).toHaveValue("");
  });
});
