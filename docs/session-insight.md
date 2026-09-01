# Session Insight

Session Insight 是一个只在本机运行的 Codex / Claude Code / TraeX session 分析器。它提供一个本地 server 和浏览器前端：可以导入 JSONL 文件或目录、扫描本机已有 session、按条件搜索，并查看 token 脉冲、Trace / 瀑布图、工具、Skill、验证、子 agent、空闲间隔和可能纠偏等指标。

页面由五个工作区组成：

- **Library**：每行以会话标题（取自首条 user prompt）作为主标识，而不是 session UUID；可搜索对话内容，也可按 provider、模型、工具、Skill、错误和上下文风险筛选；勾选两条可直接比较。顶部指标覆盖全部匹配结果，不只是已加载的当页。
- **全局分析**：跨全部已索引 session 的聚合视图——token 走势与构成、最耗 token 的项目、最常失败的工具、provider/模型构成和风险面。每一行都可点击，带对应筛选跳回 Library。
- **Trace**：树、waterfall、工具/token/context 三条同步轨道共用同一份事件数据；可按类型或异常过滤，选中事件会在 Inspector 中显示有限摘录、状态、token 和上下文证据，也可切到 Conversation。对话页按 Markdown 渲染，并拆开运行时注入的外壳标签。
- **Compare**：并排比较两条 session，可在标准化时间与共同真实时间之间切换，并同步筛选 Tool / Skill 差异。两侧以会话标题标识——同一 session 派生的多个子 agent run 共用一个 session ID，只显示 ID 会让两条不同的 run 看起来一样。
- **Report**：从 Trace 或 Compare 打开，可复制 Markdown、下载单文件 HTML 或打印。

## 启动

在仓库根目录执行：

```bash
pnpm insight
```

命令会先构建 `@session-insight/app`，再启动 Go server。打开 <http://127.0.0.1:4788> 即可使用。需要本机已安装 Node.js、pnpm 和 Go。

这个入口是独立工具，不读取仓库的 `.env`，不要求登录、workspace 或 PostgreSQL。

如需换端口或数据位置，可以覆盖环境变量：

```bash
SESSION_INSIGHT_ADDR=127.0.0.1:5799 pnpm insight
SESSION_INSIGHT_DATA="$PWD/.session-insight/index.json" pnpm insight
```

`SESSION_INSIGHT_ADDR` 是监听地址，格式为 `host:port`。`SESSION_INSIGHT_DATA` 是本地分析索引文件路径；父目录会自动创建。未设置时，server 使用操作系统的用户配置目录下的 `session-insight/index.json`：macOS 通常是 `~/Library/Application Support/session-insight/index.json`，Linux 通常是 `~/.config/session-insight/index.json`。

## 导入和分析

在页面中选择上传 JSONL 文件，或选择包含 session 文件的目录。Codex、Claude Code 与 TraeX 文件会按内容自动识别；TraeX 的 `model_provider` 为 `trae` 或 `traex` 时都会归一为 provider `traex`。导入结束后可以按 provider、model、项目、时间、工具、Skill、错误、纠偏、上下文风险和关键词搜索。

也可以使用“扫描本机”读取当前用户可访问的 Codex、Claude Code 与 TraeX session。TraeX 会扫描当前目录 `~/.trae/cli/sessions` 和旧版目录 `~/.trae/sessions`。扫描只产生聚合结果，不修改原始 session 文件。

单次扫描受总字节上限约束（默认 512 MB）；超出后剩余文件会计入 `filesSkipped`。session 很多时，可用 `providers` 参数分别扫描某一类，或提高 `days` 覆盖更早的记录。

### 会话标题与内容搜索

每条 run 会从首条 user prompt 提取一行标题用于识别。`<teammate-message summary="…">` 这类结构化外壳会取其 summary，纯标签行会跳过。没有 user 轮次的 run（例如空会话）不产生标题，界面回退为「项目 · 短 ID」。

关键词搜索同时匹配标题、对话正文、原始 session ID、provider、model、项目、工具名和 Skill 名。命中正文时，列表行会显示匹配片段，说明这条为什么被选中。对话正文的搜索索引在首次搜索时从 trace 文件懒加载到内存，不写入磁盘索引。

### 事件降噪

Trace 的事件列表默认不显示纯遥测事件——`Token pulse` 和没有文本的 `Reasoning`。它们只驱动下方的 Token 变化与上下文压力图表，本身不代表发生了什么；一条典型 run 有 38 个 token pulse 对 23 次工具调用，列出它们会淹没真正的工作。工具栏的「遥测事件 N」按钮可以随时显示全部。

时长按实测值显示：亚秒事件显示 `37ms`，十秒内显示一位小数，没有实测时长的瞬时事件不显示时长而不是显示 `0s`。事件列表每行在工具名之后附一段来源于输入的短提示（`bash` 显示命令、`edit` 显示文件路径），因为一次 run 里三十行都叫 `bash` 时只看工具名无法定位。检查器的「上一条 / 下一条」在当前列出的事件之间移动，与列表计数一致；从别处跳转到一个被折叠的遥测事件时会自动展开遥测。

### 对话渲染

对话页按 Markdown 渲染正文——标题、粗体、行内代码、围栏代码、列表、表格、引用、链接。本机 11311 个对话轮次里 33% 含行内代码、19% 粗体、12% 标题、9% 列表、6% 表格，按纯文本显示会把这些变成 `##`、`**` 和 `|---|` 噪音。渲染产出 React 元素而非 HTML 字符串，会话内容无法注入标记；只有 http(s) 链接会成为可点链接。

运行时注入的外壳会被拆开：`<teammate-message>` 的 `teammate_id` 与 `summary` 变成气泡抬头，正文正常渲染；`<system-reminder>`、`<task-notification>`、`<local-command-*>` 折叠成带标签的附注；`<command-name>` 三元组显示为一行 `/命令 参数`。**只含注入内容的轮次标为「系统」而不是「用户」**——那不是操作者说的话。未见过的标签保持原样，不猜测标签含义。

超长轮次按渲染高度裁剪并可展开，不按字符数截断——按字符切会把表格或代码块从中间切开。

详情页提供每个事件的有限长度输入、输出和错误摘录，用于本机诊断；它不是完整 transcript 阅读器。`Tracked tokens` 只累加 input、cache read、cache write 和 output；reasoning 是 output 的子集，不重复累加。墙钟、活跃和 idle 分开显示，idle 来自相邻可观察事件间超过 5 分钟的间隔。

## 数据落点

- 上传文件只在导入请求期间进入受保护的临时目录，解析完成后临时文件会删除。
- `index.json` 只保存可搜索的 run 摘要，外加每条一行的会话标题；对话正文不写入索引。每个 run 的事件 Trace 独立写入 `runs/<run-id>/trace.json`，避免 Session Library 读取所有事件。
- Trace 保存原始 session ID、token/context 脉冲，以及输入、输出、错误摘录。user 轮次与 agent 回复上限 8 KB（便于回读对话），工具输入 / 输出 / 错误上限 640 字节。不会保存原始文件路径或完整 JSONL。
- 提高对话摘录上限后，`runs/` 目录会明显变大（本机 650 余条 session 约从 53 MB 增至百 MB 量级）。已有 trace 保持导入时的长度，重新扫描后才会带上更长的对话。
- 数据默认只写入本机用户配置目录；使用 `SESSION_INSIGHT_DATA` 可以把索引放到指定位置。
- server 只接受回环监听地址（例如 `127.0.0.1:4788` 或 `[::1]:4788`）；非回环地址会被拒绝启动。

## 本地 API

- `GET /api/session-insights/runs`：分页列表；支持 `q`、`provider`、`model`、`tool`、`skill`、`error=true`、`correction=true`、`contextRisk=true`、`from`、`to`、`sort=duration|tokens|tools|context|startedAsc`。每条结果带 `title`（会话标题）、`sourceSessionId`（前端稳定字段）和兼容字段 `sessionId`；`q` 命中对话正文时还带 `snippet`。
- `GET /api/session-insights/stats`：对全部匹配 run 的聚合，接受与 `/runs` 相同的筛选参数。返回 token 分桶、工具调用与失败、受影响 run 数、上下文风险数、缓存命中率，以及 provider / model / 项目 / 工具 / 按天分布。Library 顶部指标与全局分析页都由它驱动，因此这些数字始终描述全部匹配结果而非当前页。
- `GET /api/session-insights/runs/:id`：完整 session，包括 `trace`。每个事件有父子 / turn 归属、时间、状态、token 增量、上下文、质量和有限摘录。
- `POST /api/session-insights/import`、`POST /api/session-insights/scan`：导入或扫描；`scan` 接受 `days` 与 `providers`。`DELETE /api/session-insights/runs/:id` 与 `DELETE /api/session-insights/runs`：清除分析索引。

## 清除数据

页面中的清除操作只删除 Session Insight 的本地分析索引，不删除 Codex、Claude Code 或 TraeX 的原始 session 文件。要彻底移除索引，可停止 server 后删除 `SESSION_INSIGHT_DATA` 指向的文件；未设置环境变量时删除上述默认配置目录中的 `session-insight/index.json`。
