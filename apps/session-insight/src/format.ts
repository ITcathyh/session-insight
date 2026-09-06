import type { TokenBuckets } from "./types";

export function number(value?: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1, notation: "compact" }).format(value);
}

export function tokens(value?: number): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return "—";
  return `${number(value)} tokens`;
}

export function duration(milliseconds?: number): string {
  if (milliseconds === undefined || milliseconds === null || !Number.isFinite(milliseconds)) return "—";
  if (milliseconds === 0) return "0s";
  if (milliseconds < 60_000) return `${Math.max(1, Math.round(milliseconds / 1000))}s`;
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

export function dateTime(value?: string): string {
  if (!value) return "未知时间";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "未知时间" : date.toLocaleString("zh-CN", { hour12: false });
}

export function titleCase(value: string): string {
  return value.replace(/[_-]/g, " ");
}

/** "3 分钟前" reads faster than a timestamp when scanning a list for recent work. */
export function relativeTime(value?: string, now: number = Date.now()): string {
  if (!value) return "未知时间";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知时间";
  const seconds = Math.round((now - date.getTime()) / 1000);
  if (seconds < 0) return "刚刚";
  if (seconds < 60) return "刚刚";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  return `${Math.floor(months / 12)} 年前`;
}

export function trackedTokenTotal(value?: TokenBuckets): number | undefined {
  if (typeof value?.total === "number") return value.total;
  const values = [
    value?.inputUncached,
    value?.cacheRead,
    value?.cacheWrite,
    value?.output,
  ];
  return values.some((value) => typeof value === "number")
    ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : undefined;
}

export function timelineDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) return "—";
  if (milliseconds === 0) return "0s";
  // Rounding everything to whole seconds printed "0s" on every sub-second
  // call — most tool calls — which reads as "no duration recorded".
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  if (milliseconds < 10_000) return `${(milliseconds / 1000).toFixed(1)}s`;
  return milliseconds < 60_000
    ? `${Math.round(milliseconds / 1000)}s`
    : duration(milliseconds);
}
