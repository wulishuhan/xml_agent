# XML Agent

一个基于 Node.js 实现的工程型 AI Agent Framework（当前版本 **1.1.1**）。

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

### 附带图片（识图）

三种添加方式，走同一条校验与上传链路：点「添加图片」、直接 `Ctrl+V` 粘贴截图、把文件拖进输入区。

- 限制：单次最多 8 张，单张 20MB，只收 png / jpg / jpeg / webp / gif / bmp。超限会在本地就拦下并说明哪张被跳过，不会先把 21MB 传完再报错。
- 附件条显示缩略图 + 原始文件名（点缩略图看原图）；上传接口存盘时会加时间戳后缀防重名，界面显示时去掉。
- 图片按会话暂存：切到别的会话再切回来，没发出去的图片还在；发送后清空，不会重复上传。
- 真正上传给模型发生在 provider 启动之后、第一条 prompt 之前（`images.uploaded` / `images.missing` 事件可查），失败不阻断任务。
- 附件落在 `<workspace>/uploads/`，回读走 `GET /api/uploads/:name?workspace=...`（只允许该目录下的一级文件）。顶层的 `uploads/` 不进工作区清单，避免白占提示词预算；记忆转移不搬图片，它是一次性运行时状态。

### 技能（Skills）

右上角的 **Skills** 面板用来管理"技能文档"——一份自包含的 Markdown 指令，模型按需 `read` 进来照着做
（写作规范、流程约定这类知识适合这么做：不占系统提示词，也不需要注册新动作）。面板里能直接读全文、
**就地编辑并保存**、启用/禁用，以及把内置或用户级技能**安装到当前工作区**（`read` 被沙箱限制在工作区内，
不安装模型读不到）。

内置技能（随安装包分发，在 `app.asar` 里）是只读的——点 **Copy & edit** 会先复制一份到工作区，之后改的是
那份副本：内置文件改了下次升级也会被覆盖。保存是整篇覆盖，`Ctrl/⌘+S` 也可以。
单次保存受请求体大小限制（100 KB 左右），技能文档本来该精简，超过 1 MB 的会直接报错。

工作区里可用且启用的技能，会在首轮提示词里列成一小段清单（名称 + 相对路径 + 一句话用途）。
细节见 [`skills/README.md`](skills/README.md)。

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

两个打包时才会遇到、但脚本已经接管的情况（不用人工处理）：

- **`release/win-unpacked` 被占用**：删不掉也改不了名（典型是里面的 `app.asar` 被某个进程独占，
  `rm` / `rd` / `ren` 全报 Access denied，只有重启才释放）。脚本会自动改到
  `release/.fallback-build-<时间戳>/` 构建，成功后把安装包、blockmap 与 `latest.yml` 拷回
  `release/`；解包目录留在兜底目录里，下一次构建自动回收。
- **`rcedit` 写版本资源失败**（`Unable to commit changes`）：脚本按既有约定跳过，
  解包后的 `XMLAgent.exe` 属性里会显示 Electron 的版本号，安装包自身仍是真实版本。
  插件里需要强制跳过时设 `XML_AGENT_SKIP_RCEDIT=1`。

## 任务完成通知（Windows）

桌面版在任务**正常完成**（status 为 `completed`）后发送系统通知，最小化或后台时也能收到反馈。

- 只在任务真正完成时通知：走完 `<done/>` 流程、状态变为 `completed` 时触发；用户点 Stop、任务报错或被中断**不会**通知。
- 防误弹：前端以"本次订阅期间是否真正观察到运行中状态"（`sawRunning`）为守卫，只有"运行中 → 完成"的状态转变才发送。
- 实现分布：`electron/notifier.js`（通知内容与状态判断）、`electron/main.js`（`showDesktopNotification()` 与 IPC `notify:task-done` / `notify:send`）、`electron/preload.js`（`contextBridge` 暴露）、`webui/frontend/src/services/desktop-notify.js`（仅 Electron 环境调用，Web 版静默跳过）。
- **Windows 关键点**：需在 `app.whenReady()` 中调用 `app.setAppUserModelId("com.shuhan.xmlagent")`，否则 Toast 通知会被系统静默丢弃。
- 收不到通知时检查：是否最新打包的 exe；系统"通知"设置是否对该应用开启；是否处于专注助手 / 勿扰模式。
- 回归测试：`node test/test-desktop-notify.js`

## 日志与排查

桌面版与 `node webui/server.js` 会把运行日志写到：

```
~/.xml-agent/logs/xml-agent.log
```

- 启动信息、插件加载、命令执行、provider 关闭、子进程清理这些关键路径都在里面。打包后的 exe 没有终端，这是唯一的排查入口。
- 入口启动时会接管 `console.*`，所以既有代码里的 `console.log` 同样会落盘，不必逐处改成 logger。
- 单文件上限 2MB，写满后轮转为 `xml-agent.1.log`，最多保留 3 个（合计约 6MB），不会无限增长。
- 级别用环境变量 `LOG_LEVEL` 控制（`error` / `warn` / `info` / `debug` / `trace`，默认 `info`），运行期可用 `logger.setLogLevel("debug")` 调整。
- 只有 `electron/main.js` 与 `node webui/server.js` 这两个真实入口会启用；单测与 CLI 不会往主目录写文件。
- 回归测试：`node test/unit/test-logger-file.js`

---

# 项目架构

## 目录结构

```
actions/            内置动作定义（read/write/edit/exec/answer/done）
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
- 动作实现：`actions/`（read / write / edit / exec / answer / done，v1.1.0 起由动作定义对象承载）
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

只处理文本文件：检测到 NUL 字节会返回 `binary: true` 的错误，而不是把乱码塞进提示词（二进制内容请用 `exec` 处理）。路径解析按真实路径校验，工作区内的符号链接 / junction 指向外部时会被拒绝。

### write

写入文件（自动创建父目录，仅限 Workspace 内）：

```xml
<write path="src/test.js"><![CDATA[
console.log("hello");
]]></write>
```

路径里的 XML 实体（`&amp;`、`&lt;`…）会被解码，与 `read` 的行为一致；目标是已存在的目录时返回明确错误，不会抛出底层 `EPERM`。Windows 下的保留设备名（`CON`、`NUL`、`COM1`…）与 `file.txt:stream` 这类数据流写法会被拒绝——它们不会真正落盘，却会让写入"看似成功"。

### edit

局部修改已存在的文件：给出"要替换的原文"和"改成什么"，其余内容逐字节保留。

```xml
<edit path="src/app.js">
  <change>
    <old><![CDATA[const port = 3000;]]></old>
    <new><![CDATA[const port = process.env.PORT || 3000;]]></new>
  </change>
</edit>
```

- 一次可以带多个 `<change>`（上限 20），按顺序执行；`<new>` 留空表示删除这段内容。
- `old` 必须在文件里出现且唯一。出现多次时报错并给出行号，可以多写几行上下文收窄，或用 `all="true"` 全部替换。
- 匹配分两档：先精确匹配；不中再忽略行首缩进与行尾空白找一次。后者命中会按原位置的缩进差补齐 `new` 的缩进，并在结果里标 `matched: "loose"`；锚点归一化后不足 16 字符时不启用，避免短串误命中别处。
- 任何一处 `<change>` 失败就整体不落盘（与 `write` 同样的原子写：临时文件 + 改名），不会留下改了一半的文件；JSON 改坏会被拒绝。
- 结果带 `diff`，只列被替换的行（超过 40 行 / 2000 字符截断），模型据此自检，不必再整篇 `read`。
- 文件不存在时返回 `File does not exist; use <write> to create it`——新建与整体重写仍然归 `write`。

为什么需要它：同一个改动用 `write` 表达，模型得重新生成整个文件。token 花在复述没变的代码上，更要紧的是任何一处手误都会改到本来没问题的地方，而 diff 里根本看不出来。

### exec

执行命令（工作目录固定为 Workspace，超时上限 `runtime.maxExecTimeout`，默认 300 秒）：

```xml
<exec command="npm test"/>
```

命令末尾加 `--background` 可后台运行（exec 会剥掉该旗标再执行）。只认**命令结尾**的这个标记，命令中间出现同名字符串不会被改写：

```xml
<exec command="node server.js --background"/>
```

输出上限 `runtime.maxExecOutputSize`（默认 1MB）。超限时保留**首尾**两段（失败摘要通常在末尾），并置 `outputTruncated: true`；子进程缓冲上限是它的 8 倍，超过缓冲才会杀进程，此时会明确说明"剩余输出已丢弃"。

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

当前支持：ChatGPT、DeepSeek、Qwen、GLM、Gemini。BrowserAgent 内置页面自愈机制（`ensurePageAlive`），浏览器崩溃或标签页关闭时自动重连恢复会话（首次连接失败会小退避重试，CDP 地址的尾斜杠会被自动去掉）。浏览器类型可通过 `browserType` 选项或 `BROWSER_TYPE` 环境变量指定为 `chrome` 或 `edge`；CDP URL 优先使用按浏览器类型解析后的环境变量（`BROWSER_CDP_URL` / `XML_AGENT_CDP_URL`）。

整轮任务另有墙钟上限 `agent.runTimeoutMs`（默认 30 分钟，`AGENT_RUN_TIMEOUT_MS` 覆盖，`0` 表示不限制）：`maxSteps` 只管步数，浏览器 provider 每步十几秒，没有这个上限时单任务可能跑半小时而界面上毫无反馈。超时后状态记为 `timeout`，已产生的历史与报告照常落盘。这个上限是**硬**的：除了两步之间检查，还有一个看门狗在到点时直接关掉 provider —— 浏览器那边的 CDP 调用挂住时自身没有超时，只靠"两步之间检查"会让单步无限拖下去。

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

### 为什么提示词写成「正常人求助」的口吻

网页版平台的提示词不是真的 system 消息，而是**一条普通用户消息**。同一段内容，
如果写成「你是一个运行在 Node.js Runtime 上的 Agent，必须…／不允许…」，
在平台的风控分类器里就是典型的角色劫持 / 脚本注入模板，同一账号频繁这么发很容易被限流甚至封号
（DeepSeek 网页版实测风险最高）。所以这里的写法按三条规矩来，改提示词时别破坏：

| 规矩           | 具体做法                                                                                               | 钉住它的测试                        |
| -------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| 说人话         | 第一人称陈述任务（"我在本机维护一个项目，你每次只发一段动作"），不写角色设定、不堆"必须/不允许"        | `test/unit/test-first-prompt.js` §5 |
| 不外发宿主细节 | 不出现盘符路径、`127.0.0.1`、`CDP` / `remote-debugging`、`Node.js Runtime`；工作区只给项目名           | 同上                                |
| 尽量短         | 系统提示 1.5k 字符（原 4.7k，去掉重复示例与修辞性禁令）；每轮回包 400 字符量级；工作区清单 8k 字符封顶 | §6 + `clampManifest`                |

首轮提示词（含插件/技能清单）从 6.5k 字符降到 2.5k 左右，每轮回包从 ~700 降到 ~440，
长结果用紧凑 JSON 并按 4000 字符 / 200 项截断（`prompts/runtime-prompt.js`）。

> 提示词只能降低「内容特征」的命中率。真正决定封号的是**行为**：轮次频率、出错重试节奏、
> 单账号同时挂几个会话。这部分不在提示词里，改提示词不会让自动化访问变得合规。

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
        memory-transfer/     action 插件（会话记忆压缩+摘要后转移：记录 + 模型对话线程）

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

### 会话记忆转移（memory-transfer）

把一个会话的"记忆"写到另一个会话 id 上。记忆分两层，来源不同：

| 层         | 存在哪                | 决定什么                         |
| ---------- | --------------------- | -------------------------------- |
| 记录       | `output` / `task`     | 界面上能不能回看之前发生了什么   |
| 模型上下文 | `info.conversationId` | 下一句话模型记不记得之前聊过什么 |

**记录不会进模型上下文**：`output` 只被前端渲染，agent 每轮发给模型的只有首轮的
`task` 加本轮的增量结果。真正的"记忆"是 `conversationId` 指向的 provider 对话线程 ——
转移时复用它，模型就等于回到原对话继续聊。

四种模式（`mode`）：

| 模式      | 搬什么                 | 模型记得历史 | 界面能看到历史 | 适用                         |
| --------- | ---------------------- | ------------ | -------------- | ---------------------------- |
| `full`    | 记录 + 线程（默认）    | ✅           | ✅             | 换会话接着做，上下文还宽裕   |
| `records` | 只搬记录               | 靠摘要       | ✅             | 想留档，但新开一段干净对话   |
| `link`    | 只接续线程             | ✅           | ❌ 一行说明    | 上下文重要，但不想界面变长   |
| `digest`  | 只搬 `task` + 一页摘要 | 靠摘要       | ❌ 一行说明    | **上下文满了换会话**（推荐） |

上下文快满时用 `digest`：那个场景下旧记录正是把窗口塞满的东西，一并搬过去只是让界面
再长一遍；模型真正需要的只有"做过什么、改过哪些文件、还差什么"，也就是摘要本身。
Web 端上下文横幅的「转移并新开」按钮走的就是这个模式。
`digest` 只搬摘要，所以拒绝 `digest=off`（`MEMORY_DIGEST_REQUIRED`），
摘要也写不进工作区时整体失败（`MEMORY_DIGEST_WRITE_FAILED`），不会留一个只有 task 的空会话。

搬记录时（`full` / `records`）默认会先压缩（`compress`）：真实会话里体积几乎全花在对"接着做"没帮助的地方 ——
每条记录的 `event` 是 `content` 的原始副本（实测比 `content` 还大 1~2 倍），
外加几千条 `Agent step 42` / `Provider request (step 42)` 过程噪声。

| 档位     | 做什么                                                        | 实测（3.7MB 会话） |
| -------- | ------------------------------------------------------------- | ------------------ |
| `off`    | 原样搬                                                        | 0%                 |
| `auto`   | 默认：不超预算不动手，超了先 `light`，仍超再 `strong`         | 省 87%             |
| `light`  | 去 `event` 副本 + 截断超长单条（头 60%/尾 20%）+ 折叠连续噪声 | 省 70~87%          |
| `strong` | `light` + 合并连续重复 + 按字符预算省略中段（保留开头与结尾） | 省 80~90%          |

#### 摘要：让模型真的读到历史

压缩只解决"界面回看"的体积，模型那边什么都没变。所以当模型拿不到线程时
（`digest` / `records` 模式，或源会话压根没有 `conversationId`），插件会把流水账压成
**一页 markdown**，落到工作区的 `.xml-agent-memory/<to>.md`，并在新会话的 `task`
末尾写明「开工前先 read 这个文件」：

```markdown
# 会话记忆摘要

> 从会话 `aaa` 转到 `bbb` · 2026-11-11 10:56 · 源记录 2227 条

## 任务 / 会话状态 ← 任务原话、provider、工作区、运行起止时间（按记录算，不是文件时间）

## 改过的文件（76） ← 从 runtime.result 里聚合，带写入次数；只列前 40，尾行写明"另有 36 个未列出"

## 读过的文件或目录（8） ← 失败的 read 不进这里，它只在报错里出现

## 执行过的命令（142） ← 剥掉 `cmd /c chcp 65001 >nul &&` 这类壳，同一条合并计数、标出失败次数

## 报错（23） ← 去重后的条数（同一句报错出现 7 次只算一条），文件类失败带路径

## 动作统计 / 最后几个动作

                        ← 最后几个动作是"做了什么"，不是原始日志：
                          `write src/ch3.md` / `✗ exec npm test（退出码 1）` /
                          `answer …` / `⏹ Agent stopped by user`
```

| 档位     | 什么时候生成                                              |
| -------- | --------------------------------------------------------- |
| `off`    | 从不                                                      |
| `auto`   | 默认：只在模型拿不到历史时生成（`full` 且接上线程则跳过） |
| `always` | 总是生成（想留一份能给人看的复盘时用）                    |

- 摘要读的是**压缩前**的记录：`action` / `path` / `command` 都在 `event` 里，压完就没了；
- 字符预算 `maxDigestChars`（默认 8000），超了按「尾部 → 读过 → 命令 → 报错」的顺序裁列表，
  "改过的文件"与总数最后才动；
- 目标会话的 `workspace` 与当前工作区不同时**不落盘**（写到别处模型也 read 不到），
  只在 `warnings` 里说明，转移本身照常成功；
- 摘要目录已加进工作区清单的忽略表：不占提示词预算，但按 task 里给的相对路径仍能 `read` 到；
- 只读预览：`POST /api/plugins/memory-transfer/api/digest {"from":"aaa"}` 直接返回这份 markdown。

```xml
<!-- 上下文满了换会话：只带任务 + 一页摘要，省略 to 会自动新开一个 -->
<memory-transfer from="aaa" mode="digest"/>

<!-- 想把过程记录也带过去 -->
<memory-transfer from="aaa" to="bbb" mode="records" compress="auto" digest="auto"/>
```

```bash
curl -X POST http://127.0.0.1:3000/api/plugins/memory-transfer/api/transfer \
  -H "Content-Type: application/json" \
  -d '{"from":"aaa","to":"bbb","mode":"records","compress":"auto","digest":"auto"}'

curl "http://127.0.0.1:3000/api/plugins/memory-transfer/api/sessions?limit=20"   # 会话摘要列表（含 outputChars）

# 只读预览：先看能省多少 / 模型会读到什么，不写任何会话与文件
curl -X POST http://127.0.0.1:3000/api/plugins/memory-transfer/api/preview \
  -H "Content-Type: application/json" -d '{"from":"aaa","compress":"strong"}'
curl -X POST http://127.0.0.1:3000/api/plugins/memory-transfer/api/digest \
  -H "Content-Type: application/json" -d '{"from":"aaa"}'
```

- 目标会话不存在时，按源会话的 `workspace` / `provider` 自动新建（状态 `completed`，**不会自动开始运行**）；
- 目标已存在时保留它自己的 `workspace` / `createdAt`，只覆盖记忆相关字段；
- 会拒绝的三种情况：`from === to`、源会话正在运行、目标会话正在运行；
- `provider` 不一致时不复用 `conversationId`（那是 provider 侧的 id），`full` 会降级成 `records` 并在结果里回 `warnings`；
- 记录条数有上限（插件配置 `maxOutputRecords`，默认 2000），超出保留最近的部分并插入一行说明；
- 压缩是有损的，代价说清楚：去掉 `event` 后，搬过去的历史在 Trace 面板里只能看到摘要（Console 不受影响）；
  省略的中段不会消失，原始记录仍在源会话里，目标会话只留一行说明；
- HTTP 接口没有 `host.workspace`，因此 `/transfer` 不写摘要文件，摘要正文在 `result.digest.markdown` 里返回，由调用方自己落盘；
- 图片（`images`）不搬：那是一次性上传的运行时状态，恢复时会话也不还原；
- `full` / `link` 之后两个会话共用同一条 provider 对话线程，在任一边继续聊都会影响另一边。

权限上是三个独立 scope：`sessions:read`（列会话、读摘要）、`sessions:write`（执行转移）、
`workspace:write`（把摘要 md 写进工作区）。插件不直接读写 `~/.xml-agent/webui-sessions`：
WebUI 启动时把 `SessionManager` 注入注册表，插件通过 `ctx.sessions` 调用，内存与磁盘由宿主统一同步。

### 上下文快满的提醒（context-budget）

模型平台的上下文是有限窗口（主流 1M）。满了以后平台会自己截断早期内容，模型「突然忘事」，
而本地原本没有任何提示。现在 WebUI 会把占用算出来，快满时在界面上提醒并支持一键转移。

估算口径（`webui/session/context-budget.js`）：

| 组成        | 怎么算                                                            | 精度 |
| ----------- | ----------------------------------------------------------------- | ---- |
| 首轮提示词  | 系统提示词（精确）+ task + 工作区清单（上限 8K 字符）             | 近似 |
| 每轮 prompt | 拿 `runtime.result` 里的 result 跑一遍真实的 `getRuntimeOkPrompt` | 精确 |
| 模型回复    | 累加 `provider.response.length`                                   | 精确 |
| 图片        | 每张按 1200 token                                                 | 近似 |

token 折算：中文 1 字 ≈ 1 token、英文 4 字符 ≈ 1 token、其他 2 字符。
对中文偏高估（实际约 1.5 字/token），偏高估意味着**早一点提醒**，这个场景偏保守是安全的。

阈值：80% 提醒（`warn`）、92% 标红（`critical`）。窗口默认 1000000，可用环境变量覆盖：

```bash
XML_AGENT_CONTEXT_LIMIT=200000 npm run webui
```

```bash
curl http://127.0.0.1:3000/api/sessions/<id>/context
# { limit, used, ratio, remaining, level, chars, steps, degraded }
```

SSE 的 `context` 事件在**连接建立时**推一次、之后**跨阈值时**再推，
所以打开一个已经 86% 的旧会话，横幅会立刻出现，不用等下一步。

前端有两个入口：

- **会话信息栏右侧常驻**：`上下文 12% · 转移会话 ▾`，任何比例都能用，菜单里选
  「只带摘要」（`digest`）或「带上完整记录」（`records`）。没到阈值就想换条线
  （拆任务、换 provider、把这条线先放着）走这里 —— 它不依赖提醒逻辑。
- **会话信息栏下方的横幅**：只在 80% / 92% 出现，两个按钮 ——
  「转移并新开」（源会话还在跑就先停，因为 transfer 拒绝运行中的会话）与「稍后」
  （同一会话不再重复打扰，切换会话后重新生效）。

两个入口都不接旧的 provider 线程：横幅走 `digest`，手动菜单给 `digest` 与 `records`。
`full` 会复用那条已经满了的 provider 线程，等于没换，所以不放进界面。

已知限制：

- 已结束的会话若被 `memory-compress` 压缩过（`event` 被删），prompt 重建不了，
  只能用记录 content 当上下界，结果里 `degraded: true`；
- 首轮提示词里的工作区清单是经验值、不扫盘：为 3% 的精度同步读几千个文件不划算；
- 估的是 provider 侧「历史文本」的量，平台自己的系统包装与工具调用格式不计入。

## 记忆能力的边界：哪些在核心，哪些在插件

判断标准只有一条：**没有这个插件时，这个能力还该不该存在**。

| 能力                                        | 位置                                                   | 为什么                                                   |
| ------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------- |
| 会话存储（读写 json、内存/磁盘同步）        | `webui/session/session-store.js`、`session-manager.js` | 宿主基础设施，任何入口都依赖                             |
| 上下文占用估算（used / limit / ratio）      | `webui/session/context-budget.js`                      | 驱动界面横幅与 SSE，不做转移也必须存在                   |
| 摘要生成（一页 markdown）                   | `webui/session/memory-digest.js`                       | 纯函数，只读记录；预览、脚本、单测都能直接调             |
| 记录压缩（去 `event`、折叠噪声）            | `webui/session/memory-compress.js`                     | 同上，确定性规则                                         |
| 转移编排（四种模式、拒绝条件、降级）        | `webui/session/memory-transfer.js`                     | 要同时操作 store + manager + provider 语义，只有宿主能做 |
| 权限判定（`sessions:*`、`workspace:write`） | `plugins/sdk.js`、`plugins/registry/settings.js`       | 权限模型属于框架                                         |
| 摘要落盘（到底写到哪个工作区）              | `plugins/registry/shared.js`                           | 框架适配层：把相对路径映射进工作区沙箱                   |
| 动作 `<memory-transfer/>`、`/api/...`、面板 | `plugins/builtin/memory-transfer/`                     | 纯插件：禁用或换掉它，上面这些都还成立                   |
| 上下文横幅 + 常驻转移菜单                   | `webui/frontend`                                       | 界面属于核心，只通过插件接口调用                         |

三条边界规则：

1. **插件不碰 `~/.xml-agent/webui-sessions`**：宿主通过 `registry.setHostSessions` 注入 `SessionManager`，
   插件只拿 `ctx.sessions` 门面。卸载、降权、并发写入因此都由宿主统一管。
2. **框架不做业务判断**：`registry/shared.js` 只回答"这个相对路径落在哪个工作区、能不能写"，
   不认识 `mode=digest` 是什么；模式语义留在 `memory-transfer.js`。
3. **界面不散落插件内部路径**：需要调插件接口时，路径常量集中放在
   `webui/frontend/src/services/agent-api.js` 顶部；插件被禁用（接口 404）时给一句人话，
   而不是把 `Plugin API not found` 丢给用户。

一个已经踩过的坑：`createDigestWriter` 原本把"当前工作区"绑死在动作上下文里，
而接口路径（HTTP 面板 / 脚本）拿不到 `host.workspace` —— 于是 `mode=digest` 走 HTTP 时
**摘要永远写不出去，整个转移直接失败**，Web 的一键转移按钮必然报错。现在分成两个场景：
动作路径绑定 workspace 走插件沙箱；接口路径按目标会话自己记录的 workspace 解析
（路径分量由 `memory-digest` 生成：固定目录 + 已白名单校验的会话 id），
并且仍然显式拒绝绝对路径与 `..`。

## 界面：Plugins 面板

Web 版与桌面版顶部都有 **Plugins** 按钮（History / Trace 旁边），打开后可以：

- 查看每个插件的状态（`loaded` / `disabled` / `error`）、来源（`builtin` / `user`）、动作与错误原因；
- 一键启用 / 禁用插件（写 `~/.xml-agent/plugins-state.json`）；
- 逐个 scope 调整权限策略：`allow` / `ask` / `deny`（写 `~/.xml-agent/permissions.json`）；
- 按 `configSchema` 渲染配置表单并保存（写 `~/.xml-agent/plugins-config.json`，服务端按类型校验）；
- 增删密钥（`secrets` 区块）：接口只回键名与长度，值写进 `~/.xml-agent/secrets.json` 后**读不回来**；
- Reload 重新扫描插件目录（改完插件代码不用重启服务，被 `require` 的子模块也会重新加载）；
- 查看插件声明的面板（`Plugin panels` 区块）：插件用纯 JSON 声明 `note` / `status` / `table` / `action` 四种 block，宿主前端渲染并调用插件自己的只读接口（`/api/plugins/<name>/api/*`）——插件不向浏览器下发任何 JS。

> 卡片默认是收起的（插件有四五个、审计日志那种面板一展开就是几十行，全展开会把后面的内容顶出屏幕）。
> 点卡片头部展开，收起时头部右侧会显示 `3 action(s) · 2 permission(s) · config` 这样的一行摘要；
> 两块区域各自有「Expand all / Collapse all」，状态按卡片记在 `localStorage`
> （`xml-agent.plugins.collapsed` / `xml-agent.plugin-panels.collapsed`），刷新后保持。
> 折叠逻辑在 `webui/frontend/src/services/collapse-state.js`，测试 `test/unit/test-collapse-state.mjs`。

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
GET  /api/plugins/secrets         密钥键名清单（只回 key 与长度，不回值）
PUT  /api/plugins/secrets/:key    写入 / 覆盖一个密钥（{ value }，落盘权限 0600）
DELETE /api/plugins/secrets/:key  删除一个密钥
GET  /api/providers               可用模型后端（内置 + 插件），供前端下拉使用

# 技能（Skill）：builtin / user / workspace 三处合并，id 形如 workspace:novel-writing
GET    /api/skills                技能列表（来源 / 启用状态 / 是否有工作区可读路径）
GET    /api/skills/:id            读取完整文档
PUT    /api/skills/:id            保存文档（{ content }，内置只读，整篇覆盖）
POST   /api/skills/:id/enabled    启用 / 禁用（{ enabled }，只影响提示词）
POST   /api/skills/:id/install    复制到工作区 .agent/skills/（{ workspace }）
DELETE /api/skills/:id            从工作区移除（内置 / 用户级不可删）

# 插件自定义接口（由插件用 ctx.api.* 注册，路径固定在其命名空间下）
GET  /api/plugins/<name>/api/<path>
POST /api/plugins/<name>/api/<path>
```

## 权限模型

插件在 `plugin.json` 里声明需要的 scope（`network:http`、`workspace:write`、`shell:exec`、`sessions:read`/`sessions:write` …），动作的 `meta.permission` 必须是它的子集，否则**加载期直接拒绝**。

- 内置插件声明的 scope 默认 `allow`；
- 用户插件默认 `ask`，v1 中等同于"未授权即拒绝"，拒绝原因会回给模型；
- `secrets:read` 有两道门：清单声明 + 策略 `allow`。setup 期与动作执行期口径一致，
  未授权时 `ctx.secrets.get()` 返回 `null`（`ctx.secrets.denied === true`），不会静默泄漏；
- `sessions:read` / `sessions:write` 同样两道门：动作由 `invoke` 校验，**插件接口**由
  `callPluginApi` 自己校验（接口不经过动作那套校验，只靠路径限制的话，知道 URL 就能绕过权限）。
- 所有插件动作的调用都会带 `plugin` / `durationMs` / `mutating` 写入 Trace 与审计日志，便于回放。

## 插件生命周期

- `ctx.onDispose(fn)` 或 `module.exports.dispose()` 登记清理：Reload / 卸载时按逆序执行，
  定时器、监听器、socket 不登记就会每重载一次泄漏一份；
- Reload 会清掉插件目录下所有模块的 require 缓存，改了子模块也会真正生效；
- 清单坏掉、缺 `index.js`、动作或 provider 重名的插件都会以 `status:"error"` 出现在 Plugins 面板里，
  原因写在 `error` 字段——不会"凭空消失"；
- 插件自定义接口有 15s 执行上限，超时返回 `504 PLUGIN_API_TIMEOUT`。

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

测试按「能不能在没有浏览器、没有大模型的情况下跑」分层。**CI 只跑 `test:offline`**：

```bash
npm run test:offline    # 离线全量 = unit + core + plugins + api + desktop
npm run test:unit       # 纯离线单测（停止语义、审计清理、日志落盘、动作超时、测试清单与依赖声明守卫…）
npm run test:core       # 内置动作 / 配置 / 路由面 / XML 解析
npm run test:plugins    # 插件系统
npm run test:api        # 起真实 HTTP 服务的接口测试（随机端口，临时 workspace）
npm run test:desktop    # 桌面端：设置读写、通知、exe 修补、图片路径
npm run test:ui         # Vue 单文件组件能否编译

npm run test:live       # ⚠️ 需要真实 Chrome/Edge + 已登录的 DeepSeek/Qwen/GLM/ChatGPT
npm run test:electron   # 需要 Electron 运行时
```

关于 `test:live`：这 33 个脚本会真的打开浏览器、真的发消息给模型，跑一轮几分钟到几十分钟，
还会消耗额度。**它们不属于 CI**，只在改动 provider / 截图 / 上传链路后手工跑。
改坏了要第一时间发现，请把断言写进 `test/unit`（用录制好的响应做夹具），而不是加 live 脚本。

`test/unit/test-test-inventory.js` 会检查 `test/` 下的每个文件：要么被某个 npm script 引用，
要么在脚本的白名单里写明「为什么是手工探针 / 辅助模块」。以后新增测试忘了挂脚本会直接失败，
避免再次出现「51 个测试从没被跑过」的情况。

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
- ✅ `edit` 局部修改（锚点替换，不必整篇重写）
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
- ✅ 上下文预算与记忆转移（四种模式、压缩档位、摘要 md）
- ✅ 附带图片（识图：选择 / 粘贴 / 拖拽，按会话暂存）
- ✅ 中英双语界面
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
| `docs/RELEASE_NOTES_1.0.1.md` ~ `1.3.0.md` | 各版本更新日志                                                   |

---

# 免责声明

本项目为个人学习与技术研究用途的参考学习项目，仅用于学习、研究、技术交流与自用，不用于任何商业用途，也不构成任何形式的产品或服务。

本项目通过浏览器自动化（CDP）操作第三方大模型平台的网页界面来演示 Agent 架构，属于技术探索与学习实践。使用者应遵守各第三方平台（包括但不限于 ChatGPT、DeepSeek、Qwen、GLM、Gemini 等）的用户协议、服务条款及相关法律法规。使用本项目所产生的任何后果由使用者自行承担，与项目作者无关。

本项目不隶属于、不代表、也未获得上述任何平台或其所属公司的授权、认可或赞助。相关名称、商标及知识产权归其各自所有者所有。

本项目按"现状"提供，不对可用性、稳定性、合规性作任何明示或暗示的担保。作者不对因使用本项目而导致的任何直接或间接损失承担责任。如相关权利方认为本项目存在不当之处，请联系作者，作者将及时处理。
