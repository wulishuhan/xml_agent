# XML Agent

一个基于 Node.js 实现的工程型 AI Agent Framework。
当前版本：**1.1.0**
核心设计理念：
LLM 负责理解任务和规划
Runtime 负责安全执行
XML Action 作为 Agent 与 Workspace 之间的通信协议

# 快速开始

## 环境要求

Node.js >= 20.19
Windows 10 / 11 (x64) - 桌面版/打包版
Google Chrome 或 Microsoft Edge（Agent 通过 CDP 复用浏览器，不自带内核）

## 安装

```
git clone https://github.com/wulishuhan/xml_agent.git
cd xml_agent
npm install
```

## 使用 WebUI

### 配置浏览器路径

默认使用 **Edge**（独立 CDP 端口 9223），可在设置里切换为 Chrome（端口 9222）。
默认值统一由 `config/schema.js` 的 `DEFAULT_BROWSER_TYPE` 控制：

```
browser: {
  // 浏览器类型：edge（默认）| chrome
  browserType: "edge",
  // 留空表示按 browserType 自动探测常见安装路径
  chromePath: "",
  // Edge 专用路径（browserType 为 edge 时优先使用）
  edgePath: "",
}
```

也可以完全留空，Agent 会按 `browserType` 自动探测本机已安装的 Edge / Chrome。
**桌面版（Electron）与 Web 版都可以在界面里配置**：点击右上角 Settings（Web 版显示为 Browser Settings），即可选择 Chrome / Edge、查看探测结果、设置各自 CDP 端口、保存并一键切换。Web 版的配置保存在 `~/.xml-agent/webui-browser.json`，保存后会立即同步到运行环境，新任务即使用所选浏览器。

### 启动服务

生产模式：

```
npm run webui
```

访问：http://localhost:3000/xml_agent_web/
开发模式：

```
npm run webui:dev
```

访问：http://localhost:5173

## 命令行调用

参数说明：
`--provider`: 可选，默认 chatgpt，支持 chatgpt / qwen / deepseek / glm
`--workspace`: 必填，工作目录（必须存在）
示例：

```
node agent.js --workspace "D:\code\vue\ppl" "创建一个vue项目，是关于泡泡龙的游戏"

node agent.js --provider qwen --workspace "D:\code\vue\ppl" "创建一个vue项目，是关于泡泡龙的游戏"
```

## 手动启动浏览器 CDP

XML Agent 通过 Chrome DevTools Protocol 连接已运行的浏览器（Chrome / Edge 均支持）。
Windows PowerShell（Chrome，默认端口 9222）示例：

```
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$PWD\chrome-agent-profile"
```

Windows PowerShell（Edge，默认端口 9223）示例：

```
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --remote-debugging-port=9223 `
  --user-data-dir="$PWD\edge-agent-profile"
```

启动后在该浏览器中登录以下任一平台：
https://chatgpt.com

https://chat.qwen.ai

https://chat.deepseek.com

https://chat.z.ai

**注意：** 登录后不要关闭该浏览器窗口。

## 桌面应用（Electron）

开发调试：

```
npm run electron:dev
```

直接启动：

```
npm run electron:start
```

构建 Windows 安装包（安装版 + 便携版 + zip）：

```
npm run electron:build
```

离线打包：将 `winCodeSign` / `nsis` / `nsis-resources` 的 `.7z` 放入 `download/` 后执行：

```
npm run electron:offline-cache
npm run electron:build
```

产物位于 `release/` 目录。

# 桌面任务完成通知（Windows）

桌面版（Electron）在任务**正常完成**（status 为 `completed`）后，会向 Windows 发送一条系统通知，提示"任务完成了"。当应用最小化或在后台时也能及时收到反馈。

## 触发时机

只在任务真正完成时通知：
任务走完 `<done/>` 流程、会话状态变为 `completed` 时触发；

用户主动点击 Stop 停止、或任务报错 / 被中断时**不会**发送通知（避免打扰）。

为避免打开一个已完成的历史会话时误弹通知，前端以"本次订阅期间是否真正观察到运行中状态"（`sawRunning`）作为守卫：只有"运行中 → 完成"的状态转变才发送通知。

## 实现结构

`electron/notifier.js`（新增）：生成通知内容（标题"XML Agent · 任务完成"，正文为任务摘要 + provider）与状态判断（`shouldNotify` 仅在 `completed` 时返回 true）。

`electron/main.js`：新增 `showDesktopNotification()`，使用 Electron 原生 `Notification` 弹出通知，点击通知可恢复并聚焦主窗口；新增 IPC `notify:task-done` / `notify:send`。**关键**：Windows 上需在 `app.whenReady()` 中调用 `app.setAppUserModelId("com.shuhan.xmlagent")`，否则 Toast 通知会被系统静默丢弃（不报错也不显示）。

`electron/preload.js`：通过 `contextBridge` 暴露 `window.xmlAgentDesktop.notifications.taskDone / send`。

`webui/frontend/src/services/desktop-notify.js`（新增）：`notifyTaskCompleted()`，仅在 Electron 桌面版且任务完成时调用主进程发送通知；Web 版静默跳过。

`webui/frontend/src/App.vue`：在 SSE `finished` 事件中，若本次运行从 running 变为 completed，则调用 `notifyTaskCompleted()`。

## 注意事项

通知仅在桌面版生效，Web 版（浏览器打开 WebUI）不会弹出系统通知。

若收不到通知，请检查：是否使用最新打包的程序（旧的 exe 不含通知代码）；Windows 系统"通知"设置是否对该应用开启；是否处于专注助手 / 勿扰模式。

回归测试：`node test/test-desktop-notify.js`。

# 浏览器选择与切换（Chrome / Edge）

Edge 与 Chrome 同属 Chromium 内核，完整实现了 CDP 协议，因此可以直接复用现有的 CDP 连接与自动化能力。

## 1. 配置层

`config/agent-config.js` 的 `browser` 块：

字段默认值说明browserType`edge`浏览器类型，默认 Edge，可选 `chrome`edgePath`""`Edge 可执行文件路径，留空自动探测
桌面版配置持久化在用户数据目录的 `settings.json`，支持 `cdpUrls: { chrome, edge }` 分别保存两种浏览器的端口。
可通过环境变量覆盖：
`BROWSER_TYPE=edge`

`BROWSER_EDGE_PATH=C:\...\msedge.exe`

`EDGE_PATH=...`

## 2. 独立 CDP 端口

Chrome 与 Edge 默认使用**不同端口**，避免互相占用：
Chrome：`http://127.0.0.1:9222`

Edge：`http://127.0.0.1:9223`

`electron/settings.js` 提供 `DEFAULT_CDP_URLS` 与 `resolveCdpUrl(settings, browserType)`；写入设置采用原子写入（先写 .tmp 再 rename），并对非法 URL 回退默认端口。旧版仅含 `cdpUrl` 的配置会自动迁移。

## 3. 自动探测（跨平台）

`electron/chrome-finder.js` 与 `providers/browser-agent.js` 均内置 Edge 候选路径：
Windows：`Program Files (x86)\Microsoft\Edge\Application\msedge.exe`、`Program Files\...`、`LOCALAPPDATA\...`、Edge Beta / Dev / SxS

macOS：`/Applications/Microsoft Edge.app/...`

Linux：`/usr/bin/microsoft-edge`、`/usr/bin/microsoft-edge-stable`、`/opt/microsoft/msedge/msedge` 等

`findBrowser({ browserType: "edge" })` / `findEdge()` 可按类型精确探测，`findChrome()` 保持向后兼容。

## 4. 启动参数

Edge 首次启动会尝试导入 Chrome 数据并弹出欢迎页，可能阻塞 CDP 就绪。`electron/chrome-launcher.js` 与 `providers/browser-agent.js` 会为 Edge 追加：
`--no-startup-window`

`--disable-features=msEdgeSidebarV2,msEdgeIdentityFeatures,EdgeCollections`

`--disable-edge-shopping`

Chrome / Edge 使用独立的 user-data-dir（`chrome-agent-profile` / `edge-agent-profile`），避免登录态互相覆盖。

## 5. 连接校验与切换

`getCdpVersionInfo(cdpUrl)` 读取 `/json/version` 的 `Browser` 字段，识别当前 CDP 端点实际连接的是 Chrome 还是 Edge。
桌面版支持真正的**浏览器切换**（IPC `browser:switch`）：
记录本应用启动的浏览器进程 pid / 类型 / cdpUrl；

切换时先关闭旧浏览器进程（Windows 使用 `taskkill /T /F` 关闭整棵进程树），等待旧端口释放；

再在目标浏览器对应的独立端口启动新浏览器。

`browser:status` 返回 `cdpUrl`、`connectedBrowserType` 与 `typeMatches`（实际连接类型是否与所选一致），Desktop Settings 会提示"Connected browser (different from selected)"，并提供 "Switch to Chrome/Edge now" 按钮完成整套切换。

## 6. Web 版浏览器设置与切换

Web 版（用浏览器打开 WebUI）同样支持选择与切换浏览器，实现在 `webui/browser-settings.js`，不依赖 Electron。
配置保存位置：`~/.xml-agent/webui-browser.json`（原子写入，非法 URL 回退默认端口，旧 cdpUrl 字段自动迁移）。
保存后会自动同步到运行环境（`applyToRuntime`）：写入 `BROWSER_TYPE`、`BROWSER_CDP_URL`、`XML_AGENT_BROWSER_TYPE`、`XML_AGENT_CDP_URL` 等环境变量，并更新已加载的 `agentConfig` 单例，因此新任务立即使用所选浏览器；服务启动时也会读取该配置并应用。
Web 版 API：
`GET  /api/browser/settings` 读取浏览器配置

`POST /api/browser/settings` 保存浏览器配置（保存即生效）

`GET  /api/browser/detect?type=chrome|edge` 探测浏览器可执行文件

`GET  /api/browser/status` 浏览器 / CDP 状态（含 typeMatches）

`POST /api/browser/launch` 启动当前所选浏览器

`POST /api/browser/switch` 切换浏览器（body: { browserType }）

切换行为：只关闭“由本服务启动并记录了 pid”的浏览器进程（Windows 使用 `taskkill /T /F`），再在目标浏览器的独立端口启动；若端口被外部手动启动的浏览器占用，会提示占用而不会误杀。
界面操作：右上角 Settings（Web 版显示 Browser Settings）→ 选择 Chrome / Edge → Save 保存，或点 `Switch to Chrome/Edge now` 完成切换。

# 会话、History 与 Trace

## 同一会话多次运行（resume）

同一 conversation 再次运行任务时，**复用同一个 session**（sessionId 不变），不会在侧边栏新增会话条目。`webui/routes/sessions.js` 的 `/api/run` 对同一 provider + conversation：
若已有运行中的 session，直接复用；

若已结束，调用 `existing.resume(task)` 在同一 session 内继续一次新运行（`AgentSession.resume` 会重置运行状态、更新 task、追加输出，`runCount` +1）；

不存在则新建 session。

这样同一个 session 会累积多次运行的回复，供 History 与 Trace 回看。

## Agent Activity 按运行分段

`webui/frontend/src/components/AgentConsole.vue` 以 `agent.started` 事件为边界，把 output 拆分为 Run 1、Run 2……
默认只展示**最近一次运行**，Final Answer 也只基于当前运行计算，因此新任务开始后立即切换到本次运行，不会再停留在上一次的 answer；

工具栏提供 "All runs / Current run" 切换查看全部历史运行，顶部显示 "Run N · current"。

## History（回复历史）

顶部 "History" 打开当前会话的回复历史（只针对左侧已选中的 session）：
左栏为当前 session 的回复时间线（Reply 1、Reply 2…，含时间、标题、预览、状态）；

右栏为选中回复的完整内容，Markdown 自动渲染；默认选中最新一条回复；

每条回复的标题基于其自身内容生成，同一会话内多条回复标题互不相同；

搜索框只过滤当前会话内的回复。

## Trace（执行轨迹）

顶部 "Trace" 查看当前会话的执行轨迹，按"每次运行"分段（Run 1、Run 2…），每个 Run 内部再按 step 展示：
Action parsed（解析出的 XML 动作）

Runtime result（动作执行结果，带 ok / failed 徽标）

Provider request / response、provider error / retry

Agent started / completed / stopped / error（记录在 Run 级别）

可展开 "Details" 查看事件完整 JSON，支持 Expand all / Collapse all、Refresh。

# 项目架构

## 目录结构（v1.1.0）

```
actions/            内置动作定义（read/write/exec/answer/done）
plugins/            插件系统（registry / sdk / capabilities / builtin）
providers/          模型后端（含 registry.js：元数据 + 契约校验）
config/             schema.js（配置单一来源）+ agent-config.js（投影）
parse/              XML 协议解析（校验委托动作表）
prompts/            系统提示与插件提示词构建
webui/
  server.js         装配 + 生命周期（161 行）
  routes/           sessions / workspace / storage / browser / agent-config / plugins / providers
  session/          AgentSession / SessionManager / 持久化
  request-input.js  入参归一化（会话 id、附图路径）
  frontend/         Vue 3 SPA（含 PluginsPanel / PluginPanels）
electron/           桌面端主进程
```

整体流程：

```
User Task
   |
   v
 Agent
   |
   | Prompt
   v
 LLM Provider
   |
   | XML Action
   v
 XML Parser
   |
   v
 Runtime
   |
   +----------------+
   |                |
   v                v
Workspace        Command
(read/write)     (exec)
   |                |
   v                v
Runtime Result
   |
   v
Agent Continue
   |
   +---- answer
   |
   +---- done
```

# 核心模块

## Agent

入口：`agent.js`
职责：
接收用户任务

初始化 Workspace

加载 Provider

调用 LLM

解析 XML Action

调用 Runtime

管理 Agent 生命周期

## Runtime

文件：`runtime.js`（Workspace 沙箱 + 动作分发）
动作实现：`actions/`（read / write / exec / answer / done，从 v1.1.0 起由动作定义对象承载）
截图动作：`plugins/builtin/screenshot`（v1.1.0 起是内置插件，不是内置动作）

Runtime 是系统的执行核心，LLM 不直接操作电脑，所有操作必须通过 XML Action。
内置动作与插件动作走同一条分发链路（内置表 → 插件表），因此新增能力不再需要改 `runtime.js`。
支持的 Action：

### read

读取文件或目录：

```
<read path="package.json"/>
<read path="src"/>
```

### write

写入文件（自动创建父目录，仅限 Workspace 内）：

```
<write path="src/test.js"><![CDATA[
console.log("hello");
]]></write>
```

### exec

执行命令（工作目录固定为 Workspace，有超时限制）：

```
<exec command="npm test"/>
```

### screenshot（内置插件提供）

截取桌面 / 指定窗口 / CDP 浏览器页面，一次最多 8 个目标；成功后自动上传给模型：

```
<screenshot source="screen" path="screenshots/desktop.png"/>
<screenshot>
  <target source="window" windowTitle="Visual Studio Code" path="screenshots/vscode.png"/>
  <target source="screen" path="screenshots/desktop.png"/>
</screenshot>
```

自 v1.1.0 起它由内置插件 `plugins/builtin/screenshot` 提供（不再是 `actions/` 里的内置动作），因此：

- 可在 Plugins 面板里单独停用，或用权限面板 deny `system:screen` / `system:window` 关闭；
- 结果会带上 `plugin` 与 `durationMs`，审计日志可区分；
- `XML_AGENT_PLUGINS=0` 关闭整个插件系统时，截图能力也随之不可用。

### answer

返回最终答案：

```
<answer><![CDATA[
项目分析完成。
]]></answer>
```

### done

结束 Agent 生命周期：

```
<done/>
```

## Provider

目录：`providers/`（注册表在 `providers/registry.js`）
统一接口：

```
const provider = createProvider("chatgpt");
```

当前支持：ChatGPT、DeepSeek、Qwen、GLM。BrowserAgent 内置页面自愈机制（ensurePageAlive），浏览器崩溃或标签页关闭时会自动重连恢复会话。浏览器类型可通过 `browserType` 选项或 `BROWSER_TYPE` 环境变量指定为 `chrome` 或 `edge`；CDP URL 优先使用主进程按浏览器类型解析后写入的环境变量（`BROWSER_CDP_URL` / `XML_AGENT_CDP_URL`）。

### 新增一个 provider（v1.1.0 起不需要改 server / 前端）

每个 provider 模块导出自己的元数据，注册表据此创建实例、解析访问地址与会话 id：

```
meta: {
  id: "glm",
  label: "GLM",
  defaultTargetUrl: "https://zchat.z.ai",
  conversationIdPattern: GLM_CONVERSATION_PATTERN,
  supportsImages: true,
  create: (options) => new GlmProvider(options),
}
```

- 实例契约：必需 `start` / `send` / `close`，可选 `uploadImages` / `getConversationIdFromUrl` /
  `ensurePageAlive`；创建时会校验，缺方法直接报错。
- 访问地址：`config.browser.targetUrls[name]`（覆盖表）优先，未配置则用 provider 的 `defaultTargetUrl`。
- 会话 id：统一由 `normalizeConversationId` 用该 provider 声明的正则解析
  （因此 GLM 的 `/s/<id>` 与 `/c/<id>` 都能识别）。
- 前端 provider 下拉框读 `GET /api/providers`，插件注册的 provider 会自动出现。

插件也可以用 `ctx.providers.register(name, factory, meta)` 贡献 provider，详见
`docs/PLUGIN_API.md` §5.1。回归测试：`node test/test-provider-registry.js`。

## Prompt 系统

目录：`prompts/`
包含：
`system-prompt.js`：定义 Agent 基础能力与规则

`first-prompt.js`：首次调用时注入 Workspace、Manifest、用户任务

`runtime-prompt.js`：根据 Runtime 返回生成下一轮 Prompt

`xml-error-prompt.js` / `send-error-prompt.js` / `done-prompt.js`：异常与终止处理

## Workspace

Agent 操作的目标目录，所有路径必须是相对路径，禁止绝对路径或 `../` 越权访问。

## History & Report

会话数据保存在 `~/.xml-agent/webui-sessions/`

工作区产物迁移至 `~/.xml-agent/workspaces/<hash>/`，不再污染代码仓库

任务完成后自动生成执行报告

# 配置（单一来源）

从 v1.1.0 起，所有运行参数的**默认值、环境变量名、校验规则**都只在 `config/schema.js` 里声明一次：

- `config/agent-config.js` 只是它的投影（默认值 + 环境变量覆盖 + 校验）；
- 设置面板的默认值（`webui/agent-config-api.js`）从同一处派生，改默认值不用改两遍；
- 桌面版 `electron/settings.js` 与 Web 版 `webui/browser-settings.js` 的浏览器默认端口、
  `cdpUrls` 归一化、`browserType` 归一化共用同一份实现；
- 「保存即生效」的 `applyToRuntime` 也按 schema 里的 env 名回写环境变量，不再手抄映射；

```js
// config/schema.js 中的一个字段声明
{
    path: "agent.maxSteps",
    default: 100,
    type: "int",
    min: 1,
    env: ["AGENT_MAX_STEPS"],
    message: "agent.maxSteps must be a positive integer",
}
```

回归测试：`node test/test-config-schema.js`（75 项，含"四处默认值必须同源"的漂移守卫）。

# 会话与存储管理（v1.0.2）

配置项位于 `config/agent-config.js` 的 `session` 块：

字段默认值说明maxSessions100最多保存的会话数量maxDiskBytes200MB会话存储目录最大占用warnThreshold0.8达到上限 80% 时触发告警
达到上限后创建新会话会返回明确提示（错误码 MAX_SESSIONS / MAX_DISK），需先删除旧会话。
WebUI 侧边栏提供存储占用指示条与告警提示，悬停可查看详细信息。
支持环境变量覆盖：
WEBUI_MAX_SESSIONS

WEBUI_MAX_DISK_BYTES

WEBUI_WARN_THRESHOLD

API：
`GET /api/storage`：查询存储状态

`POST /api/storage/clean`：清理临时文件与释放空间

启动时自动清理上次异常退出遗留的 `.tmp` 文件。

# 代码质量

格式化：

```
npm run format        # 格式化代码
npm run format:check  # 检查格式
```

测试：

```
npm run test:electron            # Electron 相关测试
npm run test:conversation        # 会话测试
npm run test:conversation:all    # 全量会话测试
node test/test-desktop-notify.js # 桌面任务完成通知测试
node test/test-edge-cdp.js       # Edge CDP 支持测试
node test/test-edge-settings-io.js
node test/test-edge-agent-config.js
node test/test-edge-settings-io.js
```

# 设计原则

**LLM 不直接执行**：所有操作通过 XML Action 交由 Runtime 执行，避免权限失控。

**Runtime 是安全边界**：控制文件访问、命令执行、路径权限与超时。

**Provider 与 Agent 解耦**：新增模型无需修改 Agent 核心逻辑。

**可审计**：History 与 Trace 完整记录 Agent 行为，便于调试与回放。

# 当前能力

✅ XML Agent 协议

✅ Workspace 安全管理

✅ 文件读写与命令执行

✅ 多模型 Provider（ChatGPT / DeepSeek / Qwen / GLM）

✅ Runtime 与 XML 错误恢复

✅ BrowserAgent 页面自愈

✅ Chrome / Microsoft Edge CDP 支持（含自动探测与启动参数适配）

✅ Chrome / Edge 独立 CDP 端口与一键切换（桌面版 + Web 版均可配置）

✅ Web 版浏览器设置面板（选择浏览器、探测路径、独立端口、保存即生效）

✅ 同一会话复用 session 的多次运行（resume，累积回复）

✅ Agent Activity 按运行分段，实时显示当前运行

✅ History 回复历史（按会话查看回复时间线、Markdown 渲染、内容化标题）

✅ Trace 执行轨迹（按运行分段，Run 头部显示该次运行任务以区分 Run1/2/3）

✅ 界面长标题/摘要统一以省略号收尾（工作区标题、History 详情标题、Trace Run/Step 摘要）

✅ 会话持久化与存储上限管理

✅ Report 生成

✅ Electron 桌面端（安装版 / 便携版 / zip）

✅ 桌面任务完成后的 Windows 系统通知（仅 completed 触发，点击通知可聚焦主窗口）

✅ 离线打包支持

✅ Prettier 代码风格统一

✅ 插件系统（action / hook / provider / ui 四类插件，权限声明 + 审计）

✅ Plugins 管理面板（启停 / 权限策略 / 配置表单 / Reload，Web 版与桌面版一致）

# 插件系统（v1.1.0）

从 1.1.0 起，**新增一个 XML 动作不再需要修改核心文件**——写一个插件目录即可。

```
plugins/                     内置插件（随包分发）
    sdk.js                   插件契约层（清单/动作定义/schema/版本区间/自检）
    registry.js              发现 / 校验 / 加载 / 隔离 / 权限 / 执行 / 钩子
    capabilities.js          作用域门面（workspace fs、受控 http、storage、secrets）
    builtin/
        fetch/               示例：action 插件（HTTP 请求，域名白名单）
        audit-log/           示例：hook 插件（JSONL 审计日志）

~/.xml-agent/plugins/<name>/ 用户插件
    plugin.json
    index.js
```

## 使用

- 插件默认启用。`XML_AGENT_PLUGINS=0` 可一键回到"仅内置动作"。
- 内置 `fetch` 动作：`<fetch url="http://127.0.0.1:3000/api" method="GET"/>`，
  只允许访问插件配置 `allowHosts` 白名单内的主机（默认 `127.0.0.1` / `localhost`）。
- 内置 `audit-log` 插件把动作执行、权限拒绝、会话结束写成 JSONL，落在
  `~/.xml-agent/plugins/audit-log/data/audit-YYYYMMDD.jsonl`。

## 界面：Plugins 面板

Web 版与桌面版顶部都有 **Plugins** 按钮（History / Trace 旁边），打开后可以：

- 查看每个插件的状态（`loaded` / `disabled` / `error`）、来源（`builtin` / `user`）、动作与错误原因；
- 一键启用 / 禁用插件（写 `~/.xml-agent/plugins-state.json`）；
- 逐个 scope 调整权限策略：`allow` / `ask` / `deny`（写 `~/.xml-agent/permissions.json`）；
- 按 `configSchema` 渲染配置表单并保存（写 `~/.xml-agent/plugins-config.json`，服务端按类型校验）；
- Reload 重新扫描插件目录（改完插件代码不用重启服务）；
- **查看插件声明的面板**（`Plugin panels` 区块）：插件用纯 JSON 声明 `note` / `status` /
  `table` / `action` 四种 block，宿主前端渲染并调用插件自己的只读接口
  （`/api/plugins/<name>/api/*`）——插件不向浏览器下发任何 JS。

> 前端面板只是调用下面这些接口，没有额外权限；REST 接口仍然可以单独使用（例如 CI 或脚本）。

## 管理接口

```
GET  /api/plugins                 插件列表（状态 / 动作 / 有效权限 / 配置 / 错误）
POST /api/plugins/reload          重新扫描并加载
POST /api/plugins/:name/enabled   启用 / 禁用（{ enabled }）
GET  /api/plugins/:name/config    读取配置
POST /api/plugins/:name/config    写入配置（按 configSchema 校验）
GET  /api/plugins/ui              声明式 UI 贡献（面板 / 设置 / 按钮）
GET  /api/permissions             权限 scope 与当前策略
POST /api/permissions/grant       授权某个 scope（{ scope, policy }）
GET  /api/providers               可用模型后端（内置 + 插件），供前端下拉使用

# 插件自定义接口（由插件用 ctx.api.* 注册，路径固定在其命名空间下）
GET  /api/plugins/<name>/api/<path>
POST /api/plugins/<name>/api/<path>
```

## 权限模型

插件在 `plugin.json` 里声明需要的 scope（`network:http`、`workspace:write`、`shell:exec` …），
动作的 `meta.permission` 必须是它的子集，否则**加载期直接拒绝**。

- 内置插件声明的 scope 默认 `allow`；
- 用户插件默认 `ask`，v1 中等同于"未授权即拒绝"，拒绝原因会回给模型；
- 所有插件动作的调用都会带 `plugin` / `durationMs` 写入 Trace，便于审计。

## 文档

插件开发契约（清单字段、动作定义、schema、ctx 能力、钩子、错误码、安全声明）见：

docs/PLUGIN_API.md

设计与演进计划（现状诊断、P0 前置重构、四类插件、权限模型、路线图）见：

docs/PLUGIN_DESIGN.md

回归测试：`npm run test:plugins`（离线，不需要浏览器与大模型）。

# 设计文档

插件化与架构优化的完整设计（现状诊断、P0 前置重构、插件系统 API、权限模型、分阶段路线、测试与验收判据）见：

docs/PLUGIN_DESIGN.md

# 更新日志

详见 docs/ 目录：
docs/RELEASE_NOTES_1.1.0.md

docs/RELEASE_NOTES_1.0.1.md

docs/RELEASE_NOTES_1.0.2.md

docs/RELEASE_NOTES_1.0.3.md

docs/RELEASE_NOTES_1.0.4.md

docs/RELEASE_NOTES_1.0.5.md

docs/RELEASE_NOTES_1.0.6.md

docs/RELEASE_NOTES_1.0.7.md

# 总结

XML Agent 是一个轻量级工程 AI Agent Harness。
核心思想：
模型负责思考

Runtime 负责执行

XML 负责通信

Workspace 负责目标环境

通过这种架构，可以构建安全、可扩展、可审计的工程型 AI Agent。

# 免责声明

本项目为个人学习与技术研究用途的参考学习项目，仅用于学习、研究、技术交流与自用，不用于任何商业用途，也不构成任何形式的产品或服务。
本项目通过浏览器自动化（CDP）操作第三方大模型平台的网页界面来演示 Agent 架构，属于技术探索与学习实践。
使用者应遵守各第三方平台（包括但不限于 ChatGPT、DeepSeek、Qwen、GLM 等）的用户协议、服务条款及相关法律法规。使用本项目所产生的任何后果由使用者自行承担，与项目作者无关。
本项目不隶属于、不代表、也未获得上述任何平台或其所属公司的授权、认可或赞助。相关名称、商标及知识产权归其各自所有者所有。
本项目按“现状”提供，不对可用性、稳定性、合规性作任何明示或暗示的担保。作者不对因使用本项目而导致的任何直接或间接损失承担责任。
如相关权利方认为本项目存在不当之处，请联系作者，作者将及时处理。
