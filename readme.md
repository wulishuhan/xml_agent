# XML Agent

一个基于 Node.js 实现的工程型 AI Agent Framework（当前版本 **1.1.0**）。

核心设计理念：

- **LLM 负责理解任务和规划**
- **Runtime 负责安全执行**（LLM 不直接操作电脑）
- **XML Action** 作为 Agent 与 Workspace 之间的通信协议

通过这种架构，可以构建安全、可扩展、可审计的工程型 AI Agent。

---

## 目录

- [快速开始](#快速开始)
- [浏览器选择与切换](#浏览器选择与切换)
- [桌面应用（Electron）](#桌面应用electron)
- [项目架构](#项目架构)
- [核心模块与动作协议](#核心模块与动作协议)
- [插件系统](#插件系统)
- [配置（单一来源）](#配置单一来源)
- [会话与存储管理](#会话与存储管理)
- [测试与代码质量](#测试与代码质量)
- [设计原则](#设计原则)
- [当前能力](#当前能力)
- [文档索引](#文档索引)

---

# 快速开始

## 环境要求

- Node.js >= 20.19
- Windows 10 / 11 (x64)（桌面版 / 打包版）
- Google Chrome 或 Microsoft Edge（Agent 通过 CDP 复用浏览器，不自带内核）

## 安装

```bash
git clone https://github.com/wulishuhan/xml_agent.git
cd xml_agent
npm install
```

## 使用 WebUI

生产模式：

```bash
npm run webui
# 访问 http://localhost:3000/xml_agent_web/（可用 PORT 环境变量改端口）
```

开发模式：

```bash
npm run webui:dev
# 访问 http://localhost:5173
```

浏览器路径配置见[浏览器选择与切换](#浏览器选择与切换)。

## 命令行调用

参数：

| 参数          | 说明                                                               |
| :------------ | :----------------------------------------------------------------- |
| `--provider`  | 可选，默认 `chatgpt`，支持 `chatgpt` / `qwen` / `deepseek` / `glm` |
| `--workspace` | 必填，工作目录（必须存在）                                         |

示例：

```bash
node agent.js --workspace "D:\code\vue\ppl" "创建一个vue项目，是关于泡泡龙的游戏"

node agent.js --provider qwen --workspace "D:\code\vue\ppl" "创建一个vue项目，是关于泡泡龙的游戏"
```

## 手动启动浏览器 CDP

XML Agent 通过 Chrome DevTools Protocol 连接已运行的浏览器（Chrome / Edge 均支持）。

Windows PowerShell（Chrome，默认端口 9222）：

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$PWD\chrome-agent-profile"
```

Windows PowerShell（Edge，默认端口 9223）：

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --remote-debugging-port=9223 `
  --user-data-dir="$PWD\edge-agent-profile"
```

启动后在该浏览器中登录以下任一平台：

- https://chatgpt.com
- https://chat.qwen.ai
- https://chat.deepseek.com
- https://chat.z.ai

**注意：登录后不要关闭该浏览器窗口。**

---

# 浏览器选择与切换

Edge 与 Chrome 同属 Chromium 内核，完整实现了 CDP 协议，因此可以直接复用现有的 CDP 连接与自动化能力。

## 配置

默认使用 **Edge**（独立 CDP 端口 9223），可在设置里切换为 Chrome（端口 9222）。
默认值统一由 `config/schema.js` 控制：

```js
browser: {
  browserType: "edge",  // 浏览器类型：edge（默认）| chrome
  chromePath: "",       // 留空表示按 browserType 自动探测常见安装路径
  edgePath: "",         // Edge 专用路径（browserType 为 edge 时优先使用）
}
```

可完全留空，Agent 会自动探测本机已安装的 Edge / Chrome。环境变量覆盖：

```bash
BROWSER_TYPE=edge
BROWSER_EDGE_PATH=C:\...\msedge.exe
EDGE_PATH=...
```

**桌面版（Electron）与 Web 版都可以在界面里配置**：点击右上角 Settings（Web 版显示为 Browser Settings），即可选择 Chrome / Edge、查看探测结果、设置各自 CDP 端口、保存并一键切换。Web 版配置保存在 `~/.xml-agent/webui-browser.json`，保存后立即同步到运行环境（写入 `BROWSER_TYPE`、`BROWSER_CDP_URL` 等环境变量并更新 `agentConfig`），新任务即使用所选浏览器。

## 独立 CDP 端口

Chrome 与 Edge 默认使用不同端口，避免互相占用：

- Chrome：`http://127.0.0.1:9222`
- Edge：`http://127.0.0.1:9223`

`electron/settings.js` 提供 `DEFAULT_CDP_URLS` 与 `resolveCdpUrl(settings, browserType)`；写入采用原子写（先写 `.tmp` 再 rename），非法 URL 回退默认端口。旧版仅含 `cdpUrl` 的配置自动迁移。

## 自动探测（跨平台）

`electron/chrome-finder.js` 与 `providers/browser-agent.js` 均内置候选路径：

- Windows：`Program Files (x86)\Microsoft\Edge\...`、`Program Files\...`、`LOCALAPPDATA\...`、Edge Beta / Dev / SxS
- macOS：`/Applications/Microsoft Edge.app/...`
- Linux：`/usr/bin/microsoft-edge`、`/usr/bin/microsoft-edge-stable`、`/opt/microsoft/msedge/msedge` 等

`findBrowser({ browserType: "edge" })` / `findEdge()` 按类型精确探测，`findChrome()` 保持向后兼容。

## 启动参数

Edge 首次启动会尝试导入 Chrome 数据并弹出欢迎页，可能阻塞 CDP 就绪。`electron/chrome-launcher.js` 与 `providers/browser-agent.js` 会为 Edge 追加：

```
--no-startup-window
--disable-features=msEdgeSidebarV2,msEdgeIdentityFeatures,EdgeCollections
--disable-edge-shopping
```

Chrome / Edge 使用独立 user-data-dir（`chrome-agent-profile` / `edge-agent-profile`），避免登录态互相覆盖。

## 连接校验与切换

`getCdpVersionInfo(cdpUrl)` 读取 `/json/version` 的 `Browser` 字段，识别当前 CDP 端点实际连接的是 Chrome 还是 Edge。

桌面版支持真正的浏览器切换（IPC `browser:switch`）：

1. 记录本应用启动的浏览器进程 pid / 类型 / cdpUrl；
2. 切换时先关闭旧浏览器进程（Windows 使用 `taskkill /T /F` 关闭整棵进程树），等待旧端口释放；
3. 再在目标浏览器对应的独立端口启动新浏览器。

`browser:status` 返回 `cdpUrl`、`connectedBrowserType` 与 `typeMatches`。Desktop Settings 会提示 "Connected browser (different from selected)"，并提供 "Switch to Chrome/Edge now" 按钮完成整套切换。

## Web 版浏览器接口

实现在 `webui/browser-settings.js`，不依赖 Electron：

```
GET  /api/browser/settings                   读取浏览器配置
POST /api/browser/settings                   保存浏览器配置（保存即生效）
GET  /api/browser/detect?type=chrome|edge    探测浏览器可执行文件
GET  /api/browser/status                     浏览器 / CDP 状态（含 typeMatches）
POST /api/browser/launch                     启动当前所选浏览器
POST /api/browser/switch                     切换浏览器（body: { browserType }）
```

切换行为：只关闭"由本服务启动并记录了 pid"的浏览器进程（Windows 使用 `taskkill /T /F`），再在目标浏览器的独立端口启动；若端口被外部手动启动的浏览器占用，会提示占用而不会误杀。

---

# 桌面应用（Electron）

开发调试：

```bash
npm run electron:dev
```

直接启动：

```bash
npm run electron:start
```

构建 Windows 安装包（安装版 + 便携版 + zip）：

```bash
npm run electron:build
```

离线打包：将 `winCodeSign` / `nsis` / `nsis-resources` 的 `.7z` 放入 `download/` 后执行：

```bash
npm run electron:offline-cache
npm run electron:build
```

产物位于 `release/` 目录。

## 任务完成通知（Windows）

桌面版在任务**正常完成**（status 为 `completed`）后发送系统通知，最小化或后台时也能收到反馈。

- 只在任务真正完成时通知：走完 `<done/>` 流程、状态变为 `completed` 时触发；用户点 Stop、任务报错或被中断**不会**通知。
- 防误弹：前端以"本次订阅期间是否真正观察到运行中状态"（`sawRunning`）为守卫，只有"运行中 → 完成"的状态转变才发送。
- 实现分布：`electron/notifier.js`（通知内容与状态判断）、`electron/main.js`（`showDesktopNotification()` 与 IPC `notify:task-done` / `notify:send`）、`electron/preload.js`（`contextBridge` 暴露）、`webui/frontend/src/services/desktop-notify.js`（仅 Electron 环境调用，Web 版静默跳过）。
- **Windows 关键点**：需在 `app.whenReady()` 中调用 `app.setAppUserModelId("com.shuhan.xmlagent")`，否则 Toast 通知会被系统静默丢弃。
- 收不到通知时检查：是否最新打包的 exe；系统"通知"设置是否对该应用开启；是否处于专注助手 / 勿扰模式。
- 回归测试：`node test/test-desktop-notify.js`

---

# 项目架构

## 目录结构

```
actions/            内置动作定义（read/write/exec/answer/done）
agent/              单步闭环拆分（step / artifacts / inputs / retry）
processes/          子进程登记表（停止会话时按进程树结束）
plugins/            插件系统（registry / sdk / capabilities / builtin）
providers/          模型后端（registry.js：元数据 + 契约校验；dom/ 提取工具）
config/             schema.js（配置单一来源）+ agent-config.js（投影）
parse/              XML 协议解析（校验委托动作表）
prompts/            系统提示与插件提示词构建
workspace/          manifest / history / report
webui/
  server.js         装配 + 生命周期
  routes/           sessions / workspace / storage / browser / agent-config / plugins / providers
  session/          AgentSession / SessionManager / 持久化
  request-input.js  入参归一化（会话 id、附图路径）
  frontend/         Vue 3 SPA（含 PluginsPanel / PluginPanels）
electron/           桌面端主进程
docs/               设计文档与版本发布说明
test/               测试（unit/ 下为纯离线单测）
```

## 整体流程

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

---

# 核心模块与动作协议

## Agent

入口：`agent.js`（编排器本体在 `agent-core.js`，单步闭环在 `agent/step.js`）。

职责：接收任务 → 初始化 Workspace → 加载 Provider → 调用 LLM → 解析 XML Action → 调用 Runtime → 管理生命周期。

`Agent.stop()` 会先结束本会话启动的所有子进程（见 Runtime），再关闭浏览器。

## Runtime

- 编排与沙箱：`runtime.js`（Workspace 路径校验 + 动作分发）
- 动作实现：`actions/`（read / write / exec / answer / done，v1.1.0 起由动作定义对象承载）
- 截图动作：`plugins/builtin/screenshot`（v1.1.0 起是内置插件，不是内置动作）
- 子进程登记：`processes/registry.js`

Runtime 是系统的执行核心，LLM 不直接操作电脑，所有操作必须通过 XML Action。内置动作与插件动作走同一条分发链路（内置表 → 插件表），因此新增能力不需要改 `runtime.js`。

**进程生命周期**：`exec`（含 `--background`）启动的子进程统一登记到 `processes/registry.js`；用户点「停止」时 `Agent.stop()` 先按进程树结束它们（Windows `taskkill /T /F`，POSIX 进程组 `SIGTERM` → `SIGKILL`），再关浏览器。不登记句柄的话，`--background` 的 detached 进程会成为孤儿占着端口，前台长命令也要等满 `maxExecTimeout`（默认 5 分钟）。

### read

读取文件或目录：

```xml
<read path="package.json"/>
<read path="src"/>
```

### write

写入文件（自动创建父目录，仅限 Workspace 内）：

```xml
<write path="src/test.js"><![CDATA[
console.log("hello");
]]></write>
```

### exec

执行命令（工作目录固定为 Workspace，超时上限 `runtime.maxExecTimeout`，默认 300 秒）：

```xml
<exec command="npm test"/>
```

命令末尾加 `--background` 可后台运行（exec 会剥掉该旗标再执行）：

```xml
<exec command="node server.js --background"/>
```

后台进程在会话停止或异常结束时会被一并结束，不会残留成孤儿进程。

### screenshot（内置插件提供）

截取桌面 / 指定窗口 / CDP 浏览器页面，一次最多 8 个目标；成功后自动上传给模型：

```xml
<screenshot source="screen" path="screenshots/desktop.png"/>
<screenshot>
  <target source="window" windowTitle="Visual Studio Code" path="screenshots/vscode.png"/>
  <target source="screen" path="screenshots/desktop.png"/>
</screenshot>
```

自 v1.1.0 起它由内置插件 `plugins/builtin/screenshot` 提供（不再是 `actions/` 里的内置动作），因此：

- 可在 Plugins 面板里单独停用，或用权限面板 deny `system:screen` / `system:window` 关闭；
- 结果带 `plugin` 与 `durationMs`，审计日志可区分；
- `XML_AGENT_PLUGINS=0` 关闭整个插件系统时，截图能力随之不可用。

### answer

返回最终答案：

```xml
<answer><![CDATA[
项目分析完成。
]]></answer>
```

### done

结束 Agent 生命周期：

```xml
<done/>
```

## Provider

目录：`providers/`（注册表在 `providers/registry.js`）。

```js
const provider = createProvider("chatgpt");
```

当前支持：ChatGPT、DeepSeek、Qwen、GLM、Gemini。BrowserAgent 内置页面自愈机制（`ensurePageAlive`），浏览器崩溃或标签页关闭时自动重连恢复会话。浏览器类型可通过 `browserType` 选项或 `BROWSER_TYPE` 环境变量指定为 `chrome` 或 `edge`；CDP URL 优先使用按浏览器类型解析后的环境变量（`BROWSER_CDP_URL` / `XML_AGENT_CDP_URL`）。

> Gemini 用的是独立浏览器配置目录（`%TEMP%/edge-agent-profile-9223`），**首次使用需要在弹出的浏览器窗口里登录一次 Google 账号**，之后保持登录状态。

### 新增一个 provider（不需要改 server / 前端）

每个 provider 模块导出自己的元数据，注册表据此创建实例、解析访问地址与会话 id：

```js
meta: {
  id: "glm",
  label: "GLM",
  defaultTargetUrl: "https://zchat.z.ai",
  conversationIdPattern: GLM_CONVERSATION_PATTERN,
  supportsImages: true,
  create: (options) => new GlmProvider(options),
}
```

- 实例契约：必需 `start` / `send` / `close`，可选 `uploadImages` / `getConversationIdFromUrl` / `ensurePageAlive`；创建时校验，缺方法直接报错。
- 访问地址：`config.browser.targetUrls[name]`（覆盖表）优先，未配置则用 provider 的 `defaultTargetUrl`。
- 会话 id：统一由 `normalizeConversationId` 用该 provider 声明的正则解析（GLM 的 `/s/<id>` 与 `/c/<id>` 都能识别）。
- 前端 provider 下拉框读 `GET /api/providers`，插件注册的 provider 会自动出现。

插件也可以用 `ctx.providers.register(name, factory, meta)` 贡献 provider，详见 `docs/PLUGIN_API.md` §5.1。回归测试：`node test/test-provider-registry.js`。

## Prompt 系统

目录：`prompts/`

- `system-prompt.js`：Agent 基础能力与规则
- `first-prompt.js`：首次调用时注入 Workspace、Manifest、用户任务
- `runtime-prompt.js`：根据 Runtime 返回生成下一轮 Prompt
- `xml-error-prompt.js` / `send-error-prompt.js` / `done-prompt.js`：异常与终止处理

## Workspace

Agent 操作的目标目录。所有路径必须是相对路径，禁止绝对路径或 `../` 越权访问（`execScope: "all"` 时才放开绝对路径）。

## History & Report

- 会话数据保存在 `~/.xml-agent/webui-sessions/`
- 工作区产物迁移至 `~/.xml-agent/workspaces/<hash>/`，不污染代码仓库
- 任务完成后自动生成执行报告

---

# 插件系统

从 1.1.0 起，**新增一个 XML 动作不再需要修改核心文件**——写一个插件目录即可。

```
plugins/                     内置插件（随包分发）
    sdk.js                   插件契约层（清单/动作定义/schema/版本区间/自检）
    registry.js              发现 / 校验 / 加载 / 隔离 / 权限 / 执行 / 钩子
    capabilities.js          作用域门面（workspace fs、受控 http、storage、secrets）
    builtin/
        fetch/               action 插件（HTTP 请求，域名白名单）
        audit-log/           hook 插件（JSONL 审计日志，按保留期自动清理）
        screenshot/          action 插件（截屏，引擎随插件自带）

~/.xml-agent/plugins/<name>/ 用户插件
    plugin.json
    index.js
```

## 使用

- 插件默认启用。`XML_AGENT_PLUGINS=0` 可一键回到"仅内置动作"。
- 内置 `fetch` 动作：`<fetch url="http://127.0.0.1:3000/api" method="GET"/>`，只允许访问插件配置 `allowHosts` 白名单内的主机（默认 `127.0.0.1` / `localhost`）。
- 内置 `audit-log` 插件把动作执行、权限拒绝、会话结束写成 JSONL，落在
  `~/.xml-agent/plugin-data/audit-log/audit-YYYYMMDD.jsonl`（插件私有数据目录，不进 workspace）。
  配置 `keepDays`（默认 14）控制保留期：超出窗口的整日日志在启动或跨天时自动删除，设为 0 表示不清理。

## 界面：Plugins 面板

Web 版与桌面版顶部都有 **Plugins** 按钮（History / Trace 旁边），打开后可以：

- 查看每个插件的状态（`loaded` / `disabled` / `error`）、来源（`builtin` / `user`）、动作与错误原因；
- 一键启用 / 禁用插件（写 `~/.xml-agent/plugins-state.json`）；
- 逐个 scope 调整权限策略：`allow` / `ask` / `deny`（写 `~/.xml-agent/permissions.json`）；
- 按 `configSchema` 渲染配置表单并保存（写 `~/.xml-agent/plugins-config.json`，服务端按类型校验）；
- Reload 重新扫描插件目录（改完插件代码不用重启服务）；
- 查看插件声明的面板（`Plugin panels` 区块）：插件用纯 JSON 声明 `note` / `status` / `table` / `action` 四种 block，宿主前端渲染并调用插件自己的只读接口（`/api/plugins/<name>/api/*`）——插件不向浏览器下发任何 JS。

> 前端面板只是调用下面的接口，没有额外权限；REST 接口仍然可以单独使用（例如 CI 或脚本）。

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

插件在 `plugin.json` 里声明需要的 scope（`network:http`、`workspace:write`、`shell:exec` …），动作的 `meta.permission` 必须是它的子集，否则**加载期直接拒绝**。

- 内置插件声明的 scope 默认 `allow`；
- 用户插件默认 `ask`，v1 中等同于"未授权即拒绝"，拒绝原因会回给模型；
- 所有插件动作的调用都会带 `plugin` / `durationMs` 写入 Trace，便于审计。

## 插件开发文档

- 开发契约（清单字段、动作定义、schema、ctx 能力、钩子、错误码、安全声明）：`docs/PLUGIN_API.md`
- 设计与演进（现状诊断、P0 前置重构、四类插件、权限模型、路线图）：`docs/PLUGIN_DESIGN.md`
- 回归测试：`npm run test:plugins`（离线，不需要浏览器与大模型）

---

# 配置（单一来源）

从 v1.1.0 起，所有运行参数的**默认值、环境变量名、校验规则**都只在 `config/schema.js` 里声明一次：

- `config/agent-config.js` 只是它的投影（默认值 + 环境变量覆盖 + 校验）；
- 设置面板的默认值（`webui/agent-config-api.js`）从同一处派生，改默认值不用改两遍；
- 桌面版 `electron/settings.js` 与 Web 版 `webui/browser-settings.js` 的浏览器默认端口、`cdpUrls` 归一化、`browserType` 归一化共用同一份实现；
- 「保存即生效」的 `applyToRuntime` 按 schema 里的 env 名回写环境变量，不再手抄映射。

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

回归测试：`node test/test-config-schema.js`（含"四处默认值必须同源"的漂移守卫）。

---

# 会话与存储管理

## 存储上限

配置位于 `config/agent-config.js` 的 `session` 块：

| 字段            | 默认值 | 说明                    |
| :-------------- | :----- | :---------------------- |
| `maxSessions`   | 100    | 最多保存的会话数量      |
| `maxDiskBytes`  | 200MB  | 会话存储目录最大占用    |
| `warnThreshold` | 0.8    | 达到上限 80% 时触发告警 |

达到上限后创建新会话会返回明确提示（错误码 `MAX_SESSIONS` / `MAX_DISK`），需先删除旧会话。
WebUI 侧边栏提供存储占用指示条与告警提示，悬停可查看详细信息。

环境变量覆盖：`WEBUI_MAX_SESSIONS`、`WEBUI_MAX_DISK_BYTES`、`WEBUI_WARN_THRESHOLD`。

存储 API：

- `GET /api/storage`：查询存储状态
- `POST /api/storage/clean`：清理临时文件与释放空间

启动时自动清理上次异常退出遗留的 `.tmp` 文件。

## 同一会话多次运行（resume）

同一 conversation 再次运行任务时，**复用同一个 session**（sessionId 不变），不会在侧边栏新增会话条目。`webui/routes/sessions.js` 的 `/api/run` 对同一 provider + conversation：

- 若已有运行中的 session，直接复用；
- 若已结束，调用 `existing.resume(task)` 在同一 session 内继续一次新运行（重置运行状态、更新 task、追加输出，`runCount` +1）；
- 不存在则新建 session。

同一个 session 会累积多次运行的回复，供 History 与 Trace 回看。

## Agent Activity 按运行分段

`webui/frontend/src/components/AgentConsole.vue` 以 `agent.started` 事件为边界，把 output 拆分为 Run 1、Run 2……

- 默认只展示**最近一次运行**，Final Answer 也只基于当前运行计算；
- 工具栏提供 "All runs / Current run" 切换查看全部历史运行，顶部显示 "Run N · current"。

## History（回复历史）

顶部 "History" 打开当前会话的回复历史（只针对左侧已选中的 session）：

- 左栏为当前 session 的回复时间线（Reply 1、Reply 2…，含时间、标题、预览、状态）；
- 右栏为选中回复的完整内容，Markdown 自动渲染；默认选中最新一条；
- 每条回复的标题基于其自身内容生成，同一会话内标题互不相同；
- 搜索框只过滤当前会话内的回复。

## Trace（执行轨迹）

顶部 "Trace" 查看当前会话的执行轨迹，按"每次运行"分段（Run 1、Run 2…），每个 Run 内部按 step 展示：

- Action parsed（解析出的 XML 动作）
- Runtime result（动作执行结果，带 ok / failed 徽标）
- Provider request / response、provider error / retry
- Agent started / completed / stopped / error（记录在 Run 级别）

可展开 "Details" 查看事件完整 JSON，支持 Expand all / Collapse all、Refresh。

---

# 测试与代码质量

格式化：

```bash
npm run format        # 格式化代码
npm run format:check  # 检查格式
```

测试（按场景分层，`test:offline` 不需要浏览器与大模型）：

```bash
npm run test:offline             # 离线全量 = unit + core + plugins
npm run test:unit                # 纯离线单测（含停止语义、审计清理等回归）
npm run test:core                # 核心动作 / 配置 / 路由面
npm run test:plugins             # 插件系统
npm run test:electron            # Electron 相关测试
npm run test:conversation:all    # 全量会话测试

node test/test-desktop-notify.js # 桌面任务完成通知测试
node test/test-edge-cdp.js       # Edge CDP 支持测试
node test/test-edge-settings-io.js
node test/test-edge-agent-config.js
node test/test-provider-registry.js
node test/test-config-schema.js
```

---

# 设计原则

- **LLM 不直接执行**：所有操作通过 XML Action 交由 Runtime 执行，避免权限失控。
- **Runtime 是安全边界**：控制文件访问、命令执行、路径权限、超时与子进程生命周期。
- **Provider 与 Agent 解耦**：新增模型无需修改 Agent 核心逻辑。
- **能力可插拔**：动作、hook、provider、UI 都可以由插件贡献，核心不持有具体业务能力。
- **可审计**：History 与 Trace 完整记录 Agent 行为，便于调试与回放。

---

# 当前能力

- ✅ XML Agent 协议
- ✅ Workspace 安全管理（路径沙箱、超时、进程树级别的停止）
- ✅ 文件读写与命令执行（含后台执行与停止语义）
- ✅ 多模型 Provider（ChatGPT / DeepSeek / Qwen / GLM / Gemini）
- ✅ Runtime 与 XML 错误恢复
- ✅ BrowserAgent 页面自愈
- ✅ Chrome / Microsoft Edge CDP 支持（自动探测、启动参数适配、独立端口、一键切换）
- ✅ Web 版浏览器设置面板（保存即生效）
- ✅ 同一会话复用 session 的多次运行（resume，累积回复）
- ✅ Agent Activity 按运行分段，实时显示当前运行
- ✅ History 回复历史（时间线、Markdown 渲染、内容化标题）
- ✅ Trace 执行轨迹（按运行分段，Run 头部显示该次运行任务）
- ✅ 会话持久化与存储上限管理
- ✅ Report 生成
- ✅ 插件系统（action / hook / provider / ui 四类插件，权限声明 + 审计）
- ✅ Plugins 管理面板（启停 / 权限策略 / 配置表单 / Reload / 声明式面板，Web 与桌面一致）
- ✅ Electron 桌面端（安装版 / 便携版 / zip）
- ✅ 桌面任务完成后的 Windows 系统通知（仅 completed 触发，点击通知聚焦主窗口）
- ✅ 离线打包支持
- ✅ Prettier 代码风格统一

---

# 文档索引

| 文档                                       | 内容                                                             |
| :----------------------------------------- | :--------------------------------------------------------------- |
| `docs/PLUGIN_API.md`                       | 插件开发契约：清单字段、动作定义、schema、ctx 能力、钩子、错误码 |
| `docs/PLUGIN_DESIGN.md`                    | 插件化设计：现状诊断、P0 重构、四类插件、权限模型、路线图        |
| `docs/ARCHITECTURE_FLOW.md`                | 架构与数据流：模块职责、动作分发、子进程生命周期                 |
| `docs/RELEASE_NOTES_1.0.1.md` ~ `1.1.0.md` | 各版本更新日志                                                   |

---

# 免责声明

本项目为个人学习与技术研究用途的参考学习项目，仅用于学习、研究、技术交流与自用，不用于任何商业用途，也不构成任何形式的产品或服务。

本项目通过浏览器自动化（CDP）操作第三方大模型平台的网页界面来演示 Agent 架构，属于技术探索与学习实践。使用者应遵守各第三方平台（包括但不限于 ChatGPT、DeepSeek、Qwen、GLM、Gemini 等）的用户协议、服务条款及相关法律法规。使用本项目所产生的任何后果由使用者自行承担，与项目作者无关。

本项目不隶属于、不代表、也未获得上述任何平台或其所属公司的授权、认可或赞助。相关名称、商标及知识产权归其各自所有者所有。

本项目按"现状"提供，不对可用性、稳定性、合规性作任何明示或暗示的担保。作者不对因使用本项目而导致的任何直接或间接损失承担责任。如相关权利方认为本项目存在不当之处，请联系作者，作者将及时处理。
