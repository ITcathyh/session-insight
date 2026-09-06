import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { optionsFromArgs, syncOnce } from "./sync-session-insight.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const fixtures = join(repository, "server/internal/sessioninsight/testdata");
let scratch, server, url;

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), "session-insight-sync-test-"));
  const binary = join(scratch, "session-insight");
  await promisify(execFile)("go", ["build", "-buildvcs=false", "-o", binary, "./cmd/session-insight"], {
    cwd: join(repository, "server"), env: { ...process.env, GOTOOLCHAIN: "auto" }, timeout: 120_000,
  });
  server = spawn(binary, ["--addr", "127.0.0.1:0", "--data", join(scratch, "remote/index.json")], { stdio: ["ignore", "ignore", "pipe"] });
  url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server startup timed out")), 10_000);
    server.once("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited: ${code}`)); });
    server.stderr.on("data", (chunk) => {
      const match = chunk.toString().match(/listening on (http:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
});

after(async () => {
  if (server && server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill("SIGTERM");
    await exited;
  }
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

beforeEach(async () => {
  const response = await fetch(url + "/api/session-insights/runs", { method: "DELETE" });
  assert.equal(response.status, 204);
});

async function setup(providers = ["codex", "claude", "traex"]) {
  const home = await mkdtemp(join(scratch, "source-"));
  for (const provider of providers) {
    await cp(join(fixtures, provider), join(home, provider === "traex" ? ".trae" : `.${provider}`), { recursive: true });
  }
  const options = optionsFromArgs(["--url", url, "--home", home, "--days", "0", "--state", join(home, "state.json")]);
  return options;
}

async function runs() {
  const response = await fetch(url + "/api/session-insights/runs");
  return (await response.json()).runs;
}

test("syncs all providers, retains child identity, updates and recovers deleted runs", async () => {
  const options = await setup();
  const codex = join(options.home, ".codex/sessions/2026/08/30/modern.jsonl");
  const original = await readFile(codex);
  const child = join(options.home, ".claude/projects/demo/subagents/worker.jsonl");
  await writeFile(child, (await readFile(child, "utf8")).replaceAll(',"isSidechain":true', ""));
  const first = await syncOnce(options, () => {});
  assert.deepEqual(first, { uploaded: 6, unchanged: 0, imported: 6, updated: 0, skipped: 0, failed: 0, bytes: first.bytes });
  const remote = await runs();
  assert.equal(remote.length, 6);
  for (const provider of ["codex", "claude", "traex"]) assert.equal(remote.filter((run) => run.provider === provider).length, 2);
  assert.equal(remote.find((run) => run.provider === "claude" && run.runKind === "main").counts.subagents, 1);
  assert.equal(remote.filter((run) => run.provider === "claude" && run.runKind === "subagent").length, 1);
  assert.deepEqual(await readFile(codex), original);
  const second = await syncOnce(options, () => {});
  assert.equal(second.uploaded, 0);
  assert.equal(second.unchanged, 6);
  assert.equal(second.bytes, 0);

  const before = remote.find((run) => run.provider === "codex" && run.sourceSessionId === "codex-modern-root");
  assert.ok(before);
  await appendFile(codex, '\n{"type":"event_msg","timestamp":"2026-08-31T12:00:00Z","payload":{"type":"user_message","message":"SYNC_UPDATE_SENTINEL"}}\n');
  const third = await syncOnce(options, () => {});
  assert.equal(third.uploaded, 1);
  assert.equal(third.updated, 1);
  assert.equal(third.unchanged, 5);
  const updated = (await runs()).find((run) => run.id === before.id);
  assert.equal(updated.counts.userTurns, before.counts.userTurns + 1);
  const detail = await (await fetch(url + `/api/session-insights/runs/${before.id}`)).json();
  assert.match(JSON.stringify(detail.trace), /SYNC_UPDATE_SENTINEL/);
  const index = await readFile(join(scratch, "remote/index.json"), "utf8");
  assert.doesNotMatch(index, /SYNC_UPDATE_SENTINEL/);
  const state = await readFile(options.state, "utf8");
  assert.doesNotMatch(state, /SYNC_UPDATE_SENTINEL|modern\.jsonl|\.codex|\/Users\//);
  assert.equal((await stat(options.state)).mode & 0o777, 0o600);

  await fetch(url + `/api/session-insights/runs/${before.id}`, { method: "DELETE" });
  const restored = await syncOnce(options, () => {});
  assert.equal(restored.imported, 1);
  assert.equal(restored.unchanged, 5);
  assert.equal((await runs()).length, 6);
  const forced = await syncOnce({ ...options, force: true }, () => {});
  assert.equal(forced.updated, 6);
});

test("reports oversize, invalid and symlink files, and retries failures without replaying successes", async () => {
  const options = await setup(["codex"]);
  const root = join(options.home, ".codex/sessions");
  await writeFile(join(root, "invalid.jsonl"), "not json\n");
  await writeFile(join(root, "oversize.jsonl"), "");
  await truncate(join(root, "oversize.jsonl"), 32 * 1024 * 1024 + 1);
  await symlink(join(root, "2026/08/30/modern.jsonl"), join(root, "link.jsonl"));
  const messages = [];
  const first = await syncOnce(options, (message) => messages.push(message));
  assert.equal(first.uploaded, 2);
  assert.equal(first.failed, 1);
  assert.equal(first.skipped, 2);
  assert.match(messages.join("\n"), /32 MiB/);
  assert.match(messages.join("\n"), /符号链接/);
  const saved = JSON.parse(await readFile(options.state, "utf8"));
  assert.equal(Object.keys(saved.files).length, 2);
  const retry = await syncOnce(options, () => {});
  assert.equal(retry.uploaded, 0);
  assert.equal(retry.unchanged, 2);
  assert.equal(retry.failed, 1);
});

test("filters by modification time and provider, and never propagates source deletion", async () => {
  const options = await setup();
  const modern = join(options.home, ".codex/sessions/2026/08/30/modern.jsonl");
  const archived = join(options.home, ".codex/archived_sessions/2026/08/30/legacy.jsonl");
  await utimes(archived, new Date(0), new Date(0));
  const filtered = await syncOnce({ ...options, days: 1, provider: "codex" }, () => {});
  assert.equal(filtered.uploaded, 1);
  assert.equal((await runs()).length, 1);
  await rm(modern);
  const next = await syncOnce({ ...options, days: 1, provider: "codex" }, () => {});
  assert.equal(next.uploaded, 0);
  assert.equal((await runs()).length, 1);
});

test("rejects non-loopback destinations and does not follow HTTP redirects", async () => {
  for (const target of ["http://10.37.23.29:4788", "https://127.0.0.1", "http://127.0.0.1/api", "http://user:secret@127.0.0.1", "http://127.0.0.1/?x=1"]) {
    assert.throws(() => optionsFromArgs(["--url", target]));
  }
  assert.equal(optionsFromArgs(["--url", "http://[::1]:4789"]).url, "http://[::1]:4789");
  const { createServer } = await import("node:http");
  let received = 0;
  const redirect = createServer((request, response) => {
    received++;
    response.writeHead(302, { location: url + "/api/session-insights/runs" });
    response.end();
  });
  redirect.listen(0, "127.0.0.1");
  await once(redirect, "listening");
  try {
    const options = await setup(["codex"]);
    await assert.rejects(syncOnce({ ...options, url: `http://127.0.0.1:${redirect.address().port}` }, () => {}), /fetch failed/);
    assert.equal(received, 1);
    await assert.rejects(readFile(options.state), { code: "ENOENT" });
  } finally {
    redirect.closeAllConnections();
    await new Promise((resolve) => redirect.close(resolve));
  }
});

test("state is isolated by destination and source, and incomplete parses are not checkpointed", async () => {
  const options = await setup([]);
  const root = join(options.home, ".codex/sessions");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "empty.jsonl"), '{"type":"session_meta","payload":{"id":"empty"}}\n');
  const result = await syncOnce(options, () => {});
  assert.equal(result.failed, 1);
  await assert.rejects(readFile(options.state), { code: "ENOENT" });
  const other = await setup(["codex"]);
  await syncOnce(other, () => {});
  await assert.rejects(syncOnce({ ...options, state: other.state }, () => {}), /状态不匹配/);
  assert.equal((await readdir(dirname(other.state))).some((name) => name.endsWith(".tmp")), false);
});

test("live and archived copies of one session retain the newer snapshot across syncs", async () => {
  const options = await setup([]);
  const live = join(options.home, ".codex/sessions/live.jsonl");
  const archived = join(options.home, ".codex/archived_sessions/archived.jsonl");
  const source = await readFile(join(fixtures, "codex/sessions/2026/08/30/modern.jsonl"), "utf8");
  const added = '\n{"type":"event_msg","timestamp":"2026-08-31T12:00:00Z","payload":{"type":"user_message","message":"NEWER_COPY_SENTINEL"}}\n';
  await mkdir(dirname(live), { recursive: true });
  await mkdir(dirname(archived), { recursive: true });
  await writeFile(archived, source);
  await writeFile(live, source + added);
  await utimes(archived, new Date(1000), new Date(1000));
  await utimes(live, new Date(2000), new Date(2000));
  const first = await syncOnce(options, () => {});
  assert.equal(first.uploaded, 2);
  assert.equal(first.imported, 1);
  assert.equal(first.updated, 1);
  const [run] = await runs();
  assert.equal((await runs()).length, 1);
  const detailURL = url + `/api/session-insights/runs/${run.id}`;
  assert.match(JSON.stringify(await (await fetch(detailURL)).json()), /NEWER_COPY_SENTINEL/);
  assert.equal((await syncOnce(options, () => {})).unchanged, 2);
  await utimes(archived, new Date(), new Date());
  assert.equal((await syncOnce(options, () => {})).unchanged, 2);
  const saved = JSON.parse(await readFile(options.state, "utf8"));
  const info = await stat(archived);
  assert.ok(Object.values(saved.files).some((file) => file.stamp === `${info.size}:${info.mtimeMs}:${info.ctimeMs}`));
  const stateInfo = await stat(options.state);
  assert.equal((await syncOnce(options, () => {})).unchanged, 2);
  assert.equal((await stat(options.state)).mtimeMs, stateInfo.mtimeMs);
  assert.match(JSON.stringify(await (await fetch(detailURL)).json()), /NEWER_COPY_SENTINEL/);
});

test("CLI syncs once per invocation and returns failure for skipped files", async () => {
  const options = await setup(["codex"]);
  const script = join(repository, "scripts/sync-session-insight.mjs");
  const args = [script, "--url", url, "--home", options.home, "--days", "0", "--state", options.state];
  const oversized = join(options.home, ".codex/sessions/too-large.jsonl");
  await writeFile(oversized, "");
  await truncate(oversized, 32 * 1024 * 1024 + 1);
  await assert.rejects(promisify(execFile)(process.execPath, args), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /上传 2.*跳过 1/);
    return true;
  });
  await rm(oversized);
  const { stdout } = await promisify(execFile)(process.execPath, args, { timeout: 10_000 });
  assert.match(stdout, /上传 0.*未变化 2/);
  assert.equal((stdout.match(/同步完成/g) || []).length, 1);
  assert.throws(() => optionsFromArgs(["--url", url, "--interval", "1"]), /interval/);
});
