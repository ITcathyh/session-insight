#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const maxFileBytes = 32 * 1024 * 1024;
const maxSyncBytes = 512 * 1024 * 1024;
const maxSyncFiles = 10_000;
const roots = [
  ["codex", ".codex/sessions"],
  ["codex", ".codex/archived_sessions"],
  ["claude", ".claude/projects"],
  ["traex", ".trae/cli/sessions"],
  ["traex", ".trae/sessions"],
];
const ignoredClaudeDirs = new Set(["backups", "history", "sessions"]);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const stamp = (info) => `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;

export function optionsFromArgs(args) {
  const { values } = parseArgs({ args, options: {
    url: { type: "string" }, home: { type: "string", default: homedir() },
    days: { type: "string", default: "7" }, provider: { type: "string" },
    state: { type: "string" },
    force: { type: "boolean", default: false }, help: { type: "boolean", default: false },
  } });
  if (values.help) return { help: true };
  if (!values.url) throw new Error("请用 --url 指定 SSH 隧道的本地地址，例如 http://127.0.0.1:4789");
  const url = new URL(values.url);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("--url 必须是 http://127.0.0.1:端口 或 http://[::1]:端口；远端请使用 SSH 隧道");
  }
  const days = Number(values.days);
  if (!Number.isInteger(days) || days < 0 || days > 3650) throw new Error("--days 必须为 0–3650 的整数（0 表示全部）");
  if (values.provider && !["codex", "claude", "traex"].includes(values.provider)) throw new Error("--provider 必须为 codex、claude 或 traex");
  const sourceHome = resolve(values.home);
  const configDir = process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support")
    : process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return { url: url.origin, home: sourceHome, days, provider: values.provider, force: values.force,
    state: resolve(values.state || join(configDir, "session-insight", "sync", `${hash(url.origin + "\0" + sourceHome)}.json`)) };
}

async function candidates(options, result, log) {
  const files = [];
  const cutoff = options.days ? Date.now() - options.days * 86_400_000 : 0;
  async function walk(relative, provider, root = false) {
    const path = join(options.home, relative);
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        result.skipped++;
        log(`跳过符号链接：${relative}`);
      } else if (info.isDirectory()) {
        for (const entry of await readdir(path, { withFileTypes: true })) {
          if (provider === "claude" && entry.isDirectory() && ignoredClaudeDirs.has(entry.name)) continue;
          if (entry.isDirectory() || entry.name.endsWith(".jsonl")) await walk(`${relative}/${entry.name}`, provider);
        }
      } else if (info.isFile() && info.mtimeMs >= cutoff) {
        files.push({ path, relative, info });
      }
    } catch (error) {
      if (root && error.code === "ENOENT") return;
      result.skipped++;
      log(`无法读取 ${relative}：${error.message}`);
    }
  }
  for (const [provider, root] of roots) {
    if (!options.provider || options.provider === provider) await walk(root, provider, true);
  }
  // Archived and live copies can share a run identity; the newest snapshot wins.
  return files.sort((a, b) => a.info.mtimeMs - b.info.mtimeMs || a.relative.localeCompare(b.relative));
}

async function request(options, path, init = {}) {
  const response = await fetch(options.url + "/api/session-insights" + path, {
    ...init, redirect: "error", signal: AbortSignal.any([options.signal, AbortSignal.timeout(120_000)].filter(Boolean)),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}：${(await response.text()).slice(0, 640)}`);
  return response.json();
}

async function remoteRunIDs(options) {
  const ids = new Set();
  let cursor = "";
  do {
    const page = await request(options, `/runs?limit=100&cursor=${encodeURIComponent(cursor)}`);
    if (!Array.isArray(page.runs)) throw new Error("目标没有返回有效的 Session Insight 会话列表");
    for (const run of page.runs) ids.add(run.id);
    cursor = page.nextCursor || "";
  } while (cursor);
  return ids;
}

async function saveState(path, state) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readSnapshot(file) {
  const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxFileBytes) throw new Error("单文件超过 32 MiB 或已不是普通文件");
    const chunks = [];
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > maxFileBytes) throw new Error("读取期间文件超过 32 MiB");
      chunks.push(chunk);
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error("读取期间文件有更新，将在下次同步重试");
    }
    return { body: Buffer.concat(chunks), stamp: stamp(after) };
  } finally {
    await handle.close();
  }
}

export async function syncOnce(options, log = console.log) {
  const result = { uploaded: 0, unchanged: 0, imported: 0, updated: 0, skipped: 0, failed: 0, bytes: 0 };
  const target = hash(options.url + "\0" + options.home);
  let state = { version: 1, target, files: {} };
  try {
    const saved = JSON.parse(await readFile(options.state, "utf8"));
    if (saved.version !== 1 || !saved.files || saved.target !== target) throw new Error("同步状态不匹配，请使用不同的 --state 文件");
    state = saved;
    await chmod(options.state, 0o600);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const remoteIDs = await remoteRunIDs(options);
  const files = await candidates(options, result, log);
  let attempted = 0;
  for (const file of files) {
    options.signal?.throwIfAborted();
    const key = hash(file.relative);
    const previous = state.files[key];
    const present = previous?.ids?.length && previous.ids.every((id) => remoteIDs.has(id));
    if (!options.force && present && previous.stamp === stamp(file.info)) {
      result.unchanged++;
      continue;
    }
    if (file.info.size > maxFileBytes || attempted >= maxSyncFiles || result.bytes + file.info.size > maxSyncBytes) {
      result.skipped++;
      log(`跳过 ${file.relative}：超过单文件 32 MiB / 单轮 512 MiB / 10,000 文件限制`);
      continue;
    }
    attempted++;
    try {
      const { body, stamp: snapshotStamp } = await readSnapshot(file);
      const digest = hash(body);
      if (!options.force && present && previous.digest === digest) {
        previous.stamp = snapshotStamp;
        await saveState(options.state, state);
        result.unchanged++;
        continue;
      }
      if (result.bytes + body.length > maxSyncBytes) throw new Error("读取期间文件增长，超过单轮 512 MiB 限制");
      result.bytes += body.length;
      const form = new FormData();
      form.append("relativePath", file.relative);
      form.append("files", new Blob([body]), basename(file.path));
      const response = await request(options, "/import", { method: "POST", body: form });
      if (!Array.isArray(response.runs) || !response.runs.length || response.filesScanned !== 1 || response.filesSkipped) {
        throw new Error("服务器未完整导入文件，本地不会记录为已同步");
      }
      result.uploaded++;
      result.imported += response.imported;
      result.updated += response.updated;
      const ids = response.runs.map((run) => run.id);
      for (const id of ids) remoteIDs.add(id);
      state.files[key] = { stamp: snapshotStamp, digest, ids };
      await saveState(options.state, state);
      const warnings = new Set([...(response.warnings || []), ...response.runs.flatMap((run) => run.parseWarnings || [])]);
      log(`已同步 ${file.relative}：新增 ${response.imported}，更新 ${response.updated}${warnings.size ? `；解析警告：${[...warnings].join("、")}` : ""}`);
    } catch (error) {
      options.signal?.throwIfAborted();
      result.failed++;
      log(`同步失败 ${file.relative}：${error.message}`);
    }
  }
  log(`同步完成：上传 ${result.uploaded}，未变化 ${result.unchanged}，新增 ${result.imported}，更新 ${result.updated}，跳过 ${result.skipped}，失败 ${result.failed}。`);
  return result;
}

async function main() {
  const options = optionsFromArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`用法：pnpm insight:sync --url http://127.0.0.1:4789 [选项]
先建立 SSH 隧道，再手动执行一次同步；服务仍只监听回环地址。
  --days 7          按文件修改时间选择最近 N 天；0 为全部
  --provider codex  只同步 codex / claude / traex；默认全部
  --home PATH       日志所属用户目录；默认当前用户目录
  --state PATH      本地增量状态文件；默认按目标地址和用户目录隔离
  --force           重新上传选中范围，包括未变化文件（如服务升级后）
同步会传输完整 JSONL；远端仅在解析期间暂存，保留摘要和有限摘录。
单文件上限 32 MiB；单轮上限 512 MiB / 10,000 个待处理文件。`);
    return;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  options.signal = controller.signal;
  try {
    const result = await syncOnce(options);
    if (result.failed || result.skipped) process.exitCode = 1;
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    process.exitCode = 130;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
