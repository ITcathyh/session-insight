import type { ImportResult, RunFilters, RunListResponse, SessionRun, Stats } from "./types";

const baseUrl = "/api/session-insights";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, init);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `请求失败（${response.status}）`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function listRuns(filters: RunFilters, cursor?: string): Promise<RunListResponse> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  if (cursor) params.set("cursor", cursor);
  const query = params.toString();
  return request<RunListResponse>(`/runs${query ? `?${query}` : ""}`);
}

/** Totals across every matching run. The list endpoint only returns one page,
 *  so header metrics must come from here or they silently describe a slice. */
export function getStats(filters: RunFilters): Promise<Stats> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  const query = params.toString();
  return request<Stats>(`/stats${query ? `?${query}` : ""}`);
}

export function getRun(id: string): Promise<SessionRun> {
  return request<SessionRun>(`/runs/${encodeURIComponent(id)}`);
}

export function importSessions(files: File[]): Promise<ImportResult> {
  const form = new FormData();
  files.forEach((file) => {
    const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    form.append("relativePath", relativePath || file.name);
    form.append("files", file, file.name);
  });
  return request<ImportResult>("/import", { method: "POST", body: form });
}

export function scanLocal(): Promise<ImportResult> {
  return request<ImportResult>("/scan", { method: "POST" });
}

export function clearRuns(): Promise<void> {
  return request<void>("/runs", { method: "DELETE" });
}
