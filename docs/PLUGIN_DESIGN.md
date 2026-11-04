# XML Agent 插件化与架构优化设计

| 项目     | 内容                                                             |
| -------- | ---------------------------------------------------------------- |
| 文档状态 | 设计蓝图 + v1.1.0 落地状态（见 §零）                             |
| 适用版本 | 基线 1.0.7 → 已落地 1.1.0                                        |
| 文档性质 | 设计文档（§零 之后为设计蓝图，文中代码为接口示意）               |
| 关联文档 | `readme.md`、`docs/PLUGIN_API.md`、`docs/RELEASE_NOTES_1.1.0.md` |

---

## 零、实现状态（v1.1.0 落地情况）

本文是设计蓝图。v1.1.0 已实现**插件内核**与 **P0 的 ①③**，其余为后续迭代：

| 设计项                                                     | 状态      | 说明                                                                                                                                                                                |
| ---------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 插件注册表（发现 / 校验 / 隔离 / 权限 / 执行 / 钩子）      | ✅ 已实现 | `plugins/registry.js` + `plugins/registry/`                                                                                                                                         |
| 插件 SDK（清单 / 动作定义 / schema / 版本区间 / 契约自检） | ✅ 已实现 | `plugins/sdk.js`                                                                                                                                                                    |
| 能力门面（workspace fs / 受控 http / storage / secrets）   | ✅ 已实现 | `plugins/capabilities.js`                                                                                                                                                           |
| 内置示例插件 `fetch`（action）/ `audit-log`（hook）        | ✅ 已实现 | `plugins/builtin/`                                                                                                                                                                  |
| 插件管理 HTTP API + 权限接口                               | ✅ 已实现 | `webui/routes/plugins.js`                                                                                                                                                           |
| ③ 事件格式化注册表 + 未知事件兜底                          | ✅ 已实现 | `agent-session.js` 三层格式化                                                                                                                                                       |
| ② Prompt 构建器（插件区块自动生成 + 预算裁剪）             | ⚠️ 部分   | 插件区块已自动生成；内置动作的完整文档仍手写在 `prompts/system-prompt.js`（定义里已带简版用法）                                                                                     |
| ① 动作定义对象化                                           | ✅ 已实现 | 6 个内置动作迁入 `actions/`，`runtime.js` 只剩沙箱 + 查表；`xml-parse.js` 校验走同一张表                                                                                            |
| ④ `server.js` 拆路由                                       | ✅ 已实现 | 653 → 161 行，路由按领域拆到 `webui/routes/*.js`；`test-route-surface.js` 冻结接口表                                                                                                |
| P1 配置单源（`config/schema.js`）                          | ✅ 已实现 | 默认值 / env 名 / 校验 / 浏览器设置归一化收敛到一处，四处副本已删，含"必须同源"的漂移守卫测试                                                                                       |
| P2 截图迁移为插件                                          | ✅ 已实现 | `plugins/builtin/screenshot` 自包含（动作 + 引擎 `engine/`），内置动作表只剩 5 个；核心无截图实现、无截图 HTTP 接口。删掉插件目录即彻底移除，`<screenshot>` 报 `Unknown XML Action` |
| P3 Provider 契约化                                         | ✅ 已实现 | `providers/registry.js`：元数据 + 契约校验 + 插件 provider 接入；地址与会话 id 正则由 provider 声明                                                                                 |
| P4 声明式 UI 面板                                          | ✅ 已实现 | `note/status/table/action` 四种 block 由宿主渲染；数据来自 `ctx.api.*`（限定插件命名空间，插件零 JS 进浏览器）                                                                      |
| P5 权限授权 UI / secrets 管理                              | ⚠️ 部分   | 权限已有可视化授权界面；`secrets.json` 仍需手工编辑                                                                                                                                 |

**P0 ① 的落地方式**（等价性由 `test/test-builtin-actions.js` 的 53 项用例锁死）：

- 动作实现、校验规则与错误文案逐行搬到 `actions/*.js`，只把 `this` 换成 `ctx.runtime`；
- `xml-parse.js` 的 `validateAction` switch 与两份手写解析器改为**委托动作表**（`meta.fastPath`），
  导出面（`ACTION_NAMES` / `tryExtractWriteManually` / `normalizeScreenshotTargets` 等）保持不变；
- `agent-core.js` 不再认 `action === "answer" / "done"`，改为读 `meta.terminal`；
- 截图上传不再特判动作名，改为读 `meta.collectImages`（插件动作同样可用）；
- 为消除 `parse ↔ actions` 循环依赖，取出两个叶子模块 `parse/xml-chars.js`、`parse/xml-text.js`；
- 附带修正：`runtime.maxReadSize` / `maxFileSize` / `maxExecTimeout` / `maxExecOutputSize`
  改为调用时读取，`/api/agent/config` 保存后即时生效（此前是模块加载时快照，需重启）。

**② 为什么仍是"部分"**：`prompts/system-prompt.js` 里的内置动作文档是 1.0.x 以来逐字打磨的，
直接改成由定义自动生成等于重写模型侧提示词，会真实改变模型行为。这一步应单独做一次
"提示词改版 + 效果回归"，而不是混进等价性重构里。定义对象现在已带 `prompt.usage` /
`note` / `priority`，改版时只需换渲染器。

---

## 一、背景与目标

### 1.1 背景

XML Agent 当前的扩展方式是"改核心文件"。架构本身是清晰的（LLM 思考 / Runtime 执行 / XML 通信 / Workspace 目标），但**协议、能力、提示词、可观测性四者是硬编码耦合的**：任何一次能力扩展都要在多个文件之间同步修改，漏改不会报错，只会表现为"模型不用这个能力""控制台空白""Trace 缺一步"这类难排查的静默失败。

本设计的目标是把"能力"从核心代码里抽出来，变成**可注册、可声明、可授权、可审计**的插件单元，同时顺带解决一批与插件化同源的结构性问题。

### 1.2 设计目标

1. **单文件加能力**：新增一个 XML 动作，只需要新增一个插件文件，不改动 `runtime.js` / `parse/` / `prompts/` / `agent-core.js` / 前端。
2. **协议稳定**：XML Action 协议、事件名、会话文件格式对已有用户保持兼容。
3. **安全不退化**：插件能力仍然只能长在 Runtime 边界上，通过权限声明 + 作用域门面 + 审计落地，而不是把 `fs` / `net` 直接交给插件。
4. **失败隔离**：任何插件加载失败、抛异常、超时，都只影响自身那一步，不影响会话、进程与其它插件。
5. **可观测**：每个插件动作的调用（插件名、动作名、权限、耗时、结果）自动进入 history / Trace / 报告。

### 1.3 非目标（本设计明确不做）

- 不做浏览器内插件的任意 JS 执行（v1 只做宿主渲染的声明式 UI）。
- 不做插件市场 / 在线分发 / 自动升级。
- 不做插件级沙箱的内核（如 V8 isolate、seccomp）。v1 的信任模型明确为"插件 = 同权限 Node 代码"，只安装可信插件；跨进程隔离作为 v2 的预留方向（接口已为此留出空间，见 §6.9）。
- 不改变"模型负责思考、Runtime 负责执行"的整体架构，不改 XML 协议语法。

---

## 二、现状诊断

### 2.1 现有分层

```
agent.js / webui/server.js          ← 入口（CLI + HTTP 647 行单文件）
      │
 agent-core.js                      ← 编排：manifest → prompt → provider.send → parse → runtime.run → history
      │                    │
 prompts/*            parse/xml-parse.js ──→ runtime.js ──→ workspace（fs / exec / screenshot）
 (硬编码动作文档)      (硬编码动作校验)      (硬编码 actionHandlers)
      │
 providers/*          ← CDP 浏览器自动化（browser-agent.js 基类 + deepseek/qwen/chatgpt/glm）
      │
 webui/session/*      ← AgentSession / SessionManager / session-store（~/.xml-agent/webui-sessions）
      │
 webui/frontend       ← Vue3 SPA（App.vue + 6 个组件 + services）
 electron/*           ← 主进程：端口扫描、后端启动、IPC、Windows 通知、浏览器启动器
```

### 2.2 核心问题：新增一个动作要改 6~8 个文件

以"新增 `<fetch url="..."/>`"为例，必须同步修改的位置：

| 序号 | 文件                                           | 改什么                                     | 漏改后果                  |
| ---- | ---------------------------------------------- | ------------------------------------------ | ------------------------- |
| 1    | `parse/xml-parse.js:16`                        | `ACTION_NAMES` 数组                        | 报 `Unknown XML Action`   |
| 2    | `parse/xml-parse.js:173`                       | `validateAction()` 的 switch               | 报 `Unknown XML Action`   |
| 3    | `runtime.js:444`                               | `actionHandlers` getter + 新方法           | 报 `Unknown action`       |
| 4    | `prompts/system-prompt.js`                     | 动作文档段                                 | 不报错，但模型永远不会用  |
| 5    | `prompts/runtime-prompt.js`                    | 后续轮次的使用提示                         | 不报错，但模型会误用/混用 |
| 6    | `agent-core.js:428-492`                        | `runStep` 中 answer/done/screenshot 的特判 | 视动作而定                |
| 7    | `webui/session/agent-session.js:133`           | `formatEvent()` 的 switch                  | 控制台该步空白            |
| 8    | `webui/frontend/src/components/AgentTrace.vue` | 事件渲染                                   | Trace 缺该步              |
| 9    | `workspace/report.js:33`                       | 报告渲染 switch                            | 报告缺该步                |

其中第 6 项说明了更深的问题：**编排器已经不懂"通用协议"，只懂"当前这 6 个动作"**。

- `agent-core.js:181-225` 的 `attachScreenshotToProvider()` 把 `action === "screenshot"` 的业务逻辑写死在 Agent 里；
- `agent-core.js:465-481` 把 `answer` / `done` 的语义写死在循环里。

这两处是把能力搬出核心的主要障碍。

### 2.3 其它可量化的问题

| 类别       | 具体问题                                                                                                                                                                                               | 位置                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| 配置重复   | agent/runtime/session 三段默认值在 `config/agent-config.js:33-54` 与 `webui/agent-config-api.js:19-35` 各写一遍，必然漂移                                                                              | 2 文件                        |
| 配置重复   | 浏览器默认值/探测/切换逻辑三处实现：`config/agent-config.js:55-90`、`electron/settings.js`、`webui/browser-settings.js`                                                                                | 3 文件                        |
| 安全       | `execScope="all"` 仅用 `normalized.startsWith("..")` 判断，Windows 下归一化不可靠；`resolvePath` 无 `realpath` 比对，符号链接可逃出 workspace                                                          | `runtime.js:99-124`           |
| 安全       | `exec` 直接 `shell:true` 执行任意命令并继承完整 `process.env`，无命令确认、无 allowlist                                                                                                                | `runtime.js:334-407`          |
| 性能       | `buildWorkspaceManifest` 每次运行同步递归扫描整个 workspace（深度 10、无条数/字节上限），大仓库会把首轮 prompt 撑爆                                                                                    | `workspace/manifest.js:48`    |
| 阻塞       | runtime 内 `readFileSync` / `readdirSync` / `statSync` 全同步，跑在 Express + Electron 主进程事件循环上                                                                                                | `runtime.js:125-221`          |
| 事件字符串 | `event.type` 字符串在 `agent-session.js:133`、`AgentTrace.vue`、`AgentConsole.vue` 各维护一份，无 schema、无兜底                                                                                       | 3 文件                        |
| 前端巨石   | `DesktopSettings.vue` 46.9KB、`AgentTrace.vue` 40.2KB、`App.vue` 27.0KB；无状态库，全靠 props/emit                                                                                                     | `webui/frontend/src`          |
| 测试       | 40 个 `test/*.js` 全为手工脚本，多数依赖真实浏览器与登录态，无 runner、无 CI、无单测/live 分层                                                                                                         | `test/`、`package.json:23-26` |
| 契约隐式   | Provider 靠鸭子类型（`start/send/close/uploadImages/currentConversationId`），无接口校验；新增 provider 需同时改 `providers/index.js`、`config/agent-config.js:84-89`、桌面设置 UI、前端 provider 列表 | 4 处                          |

### 2.4 结论

上面第 2.2 节的耦合，与插件化要解决的是**同一个问题**：把"动作的定义"从"动作的执行现场"里剥离出来。因此本设计的落地顺序是——**先做四项零行为变更的前置重构（P0），插件系统只是"注册表再多扫一个目录"**。

---

## 三、优化清单

### 3.1 P0：插件化前置四件套（纯重构，零行为变更）

#### ① 动作定义对象化（Action Definition）

把每个动作收敛成一个**自描述对象**，`runtime.js` 退化为"查表 + 鉴权 + 执行 + 计时"。

```js
// 接口草案（P0 阶段仍位于仓库内 actions/，P1 才允许外部目录注册）
{
    name: "read",
    schema: {                       // 校验策略，替代 validateAction 的 switch
        attrs: { path: { type: "string", required: true } },
        children: null,
    },
    validate(node) { /* 可选：复杂校验（如 screenshot 的 target 归一化） */ },
    run(node, ctx) {
        return { ok: true, action: "read", path: node["@_path"], content: "..." };
    },
    meta: {
        prompt: {
            group: "workspace",                  // 提示词分组，用于稳定排序与预算裁剪
            usage: '<read path="package.json"/>',
            note: "读取文件或目录；目录返回 entries",
            priority: 10,
        },
        terminal: null,                          // "answer" | "end" | null
        permission: ["workspace:read"],          // 见 §6.7
        mutating: false,
        timeoutMs: 15000,
        fastPath: null,                          // write/screenshot 的手写解析器挂这里
        summary: (result) => "read " + result.path,  // Trace / 报告统一摘要
        afterRun: null,                          // 执行后钩子（截图插件用它上传图片）
    },
}
```

需要同步处理的关键点：

- `parse/xml-parse.js:173` 的 `validateAction()` switch → `registry.validate(name, node)`；内置动作迁入定义对象。
- `parse/xml-parse.js:16` 的 `ACTION_NAMES` → 由 registry 派生。
- `tryExtractWriteManually`（`:32`）/ `tryExtractScreenshotManually`（`:71`）→ 挂到 `meta.fastPath`，`extractXML` 遍历 registry 的 fastPath 集合，语义不变。
- `agent-core.js:465-481` 的 answer/done 特判 → 改为 `meta.terminal` 驱动：
    - `terminal: "answer"`：产生 `answer` 事件，后续 prompt 用 `getDonePrompt()`；
    - `terminal: "end"`：结束循环。
- `agent-core.js:458` 的 `attachScreenshotToProvider()` → 改为动作定义上的 `afterRun(result, ctx)`，由截图插件通过 `ctx.agent.uploadImagesToModel(paths)` 自行完成上传。

#### ② Prompt 构建器（Prompt Builder）

`prompts/system-prompt.js` 当前是 6.6KB 静态模板串。改为 `buildSystemPrompt(ctx)`：

- 骨架（角色、协议、规则）保留在 `prompts/sections/core.md`；
- **动作文档段由 `registry` 的 `meta.prompt` 自动生成**：按 `group` 分组、组内按 `priority` 排序，保证输出稳定、可做 golden 测试；
- 支持**技能文件模式**：文档超长的插件只注入 3 行摘要 + `如需详情：<read path=".agent/skills/http.md"/>`，避免系统提示词无限膨胀（XML Agent 的模型输出质量对提示词长度极其敏感，这是插件化最大的隐性风险）；
- **全局字符预算**（默认 8000），超预算按 `prompt.priority` 裁剪并显式告知模型"已省略 N 个能力"；
- 分轮次职责保持现状：`first-prompt.js` 注入 workspace + manifest + task；`runtime-prompt.js` 只给下一轮提示（沿用小体积策略）。
- **验收标准**：内置动作集合下，新构建器输出与旧 `SYSTEM_PROMPT` 逐字节一致（golden 测试）。

#### ③ 事件格式化注册表

- `agent-session.js:133-191` 的 `formatEvent()` switch → `eventFormatters` 映射：`Map<eventType, (event) => string | null>`。
- 内置格式器迁出到 `webui/session/event-formatters.js`。
- **必须提供默认兜底格式器**：未知事件渲染为 `类型 + JSON 摘要`，而不是 `null`。这是当前最脆的一环——插件新增任何事件都不会再让控制台空白。
- 前端 `AgentTrace.vue` 同步增加"未知事件 → 通用 JSON 渲染"兜底。

#### ④ `webui/server.js` 拆路由

647 行单文件 → `webui/routes/{sessions,workspace,browser,agent-config,storage,plugins}.js`，`server.js` 只保留 `createApp({ registry })` 组装与 `startServer` / `shutdown`。

**这同时是插件注册 HTTP 路由的挂载点**，因此不是"可选优化"，而是插件系统的前置条件。

### 3.2 P1：与插件化无关的独立加固（可并行推进）

| 项            | 方案                                                                                                                                                                                    | 收益                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 配置单源      | 抽出 `config/schema.js`（默认值 + 类型 + 环境变量映射 + 校验），`config/agent-config.js`、`webui/agent-config-api.js`、`electron/settings.js`、`webui/browser-settings.js` 全部从它派生 | 消灭 3 处漂移                            |
| 路径安全      | `resolvePath` 增加 `realpath` 比对（防符号链接逃逸）；越界判断改用 `path.relative()` 而非字符串前缀；Windows 路径统一归一化                                                             | 堵住 workspace 逃逸                      |
| exec 治理     | 危险命令静态规则（`rm -rf` / `format` / `shutdown` / `reg` / `net user` 等）+ `execScope=all` 降级为逐条确认 + env 白名单传递                                                           | 与 readme 宣称的"Runtime 是安全边界"对齐 |
| manifest 治理 | 增加 `maxEntries`（默认 3000）与 `maxBytes`；超限输出"目录树已截断，请用 read 按需探索"                                                                                                 | 防大仓库撑爆 prompt                      |
| 异步化        | runtime 文件操作改用 `fs.promises`                                                                                                                                                      | 长任务期间 Electron 主进程不卡           |
| 测试体系      | 引入 `node --test`：`test/unit/**`（快、无网络）+ `test/live/**`（`XML_AGENT_LIVE=1` 才跑）；新增 `npm run test` / `test:unit` / `test:live`                                            | 当前改任何核心文件都无法快速回归         |
| 前端拆分      | `DesktopSettings.vue` 拆为 `settings/` 下若干子面板；引入轻量 store（`reactive` 单例即可，不必上 Pinia）                                                                                | 46.9KB 单文件已难维护                    |

> P0 与 P1 的关系：P0 是插件系统的必要条件，P1 是项目健康度的独立收益。两者都建议在 1.1.0 内完成，但 P1 不与插件系统互相阻塞。

---

## 四、插件系统设计

### 4.1 设计原则

1. **插件只能长在 Runtime 边界上**。插件提供的是"新的 XML 动作 / 新的 Provider / 新的 UI 声明"，不提供"让模型直接碰 fs 与网络"的通道。协议不变，安全模型才不塌。
2. **自描述**。一个动作 = 校验 + 执行 + 模型文档 + Trace 摘要 + 权限声明，写在**一个文件里**。这是对 §2.2 那张表的直接回答。
3. **失败隔离**。插件加载失败、抛异常、超时，只能影响自身那一步。
4. **默认最小权限 + 全部可审计**。动作必须声明 `permission`，未授权则不注册——模型根本看不到这个能力，而不是运行时报错。
5. **不破坏兼容**。`XML_AGENT_PLUGINS=0` 时行为与 1.0.7 完全一致；会话文件 v1 可读。

### 4.2 四类插件

| kind         | 贡献                                                       | 风险             | v1   |
| ------------ | ---------------------------------------------------------- | ---------------- | ---- |
| **action**   | XML 动作 + 提示词 + Trace + 权限                           | 中（按声明权限） | ✅   |
| **hook**     | 只观察不改流程：审计日志、桌面通知、指标、成本统计         | 低               | ✅   |
| **provider** | 新的模型后端（契约校验 + 适配器）                          | 高               | ✅   |
| **ui**       | 声明式面板 / 设置项 / 按钮（宿主渲染，插件零 JS 进浏览器） | 低               | ✅   |
| transport    | 提供新的 CDP/浏览器自动化原语                              | 高               | 暂缓 |

### 4.3 目录布局与插件清单

```
plugins/                          ← 内置插件（随包分发；electron-builder files 需加 "plugins/**/*"）
    registry.js                   ← 发现 / 校验 / 排序 / 加载 / 隔离 / 状态
    sdk.js                        ← definePlugin() / defineAction() / 作用域门面 / 测试工具
    builtin/
        screenshot/               ← P2 迁移目标：非核心能力以插件存在，且引擎随插件走
            plugin.json
            index.js              ← 动作定义（validate / run / meta）
            engine/               ← 截图引擎：take-screenshot / screenshot / windows / proc
        audit-log/                ← hook 插件示例
        fetch/                    ← action 插件示例（域名白名单）
    README.md                     ← 插件开发说明

~/.xml-agent/plugins/<name>/      ← 用户插件（不进仓库、不进安装包）
    plugin.json
    index.js
~/.xml-agent/plugin-data/<name>/  ← 插件私有数据（与安装目录分开，不进插件扫描根）
~/.xml-agent/plugins-state.json   ← 启用/禁用状态
~/.xml-agent/permissions.json     ← 权限策略（每 scope: allow / deny / ask）
~/.xml-agent/secrets.json         ← 密钥（0600，日志脱敏）
```

`plugin.json` 清单草案：

```jsonc
{
    "name": "fetch",
    "version": "1.0.0",
    "kind": "action",
    "apiVersion": 1,
    "engines": { "xmlAgent": ">=1.1.0 <2.0.0" },
    "description": "HTTP 请求动作（域名白名单 + 超时 + 体积上限）",
    "permissions": ["network:http"],
    "activation": "always", // always | { keywords: ["抓取","接口"] } | manual
    "configSchema": {
        "allowHosts": { "type": "array", "default": [], "description": "允许访问的域名" },
    },
}
```

### 4.4 插件入口与被注入的能力

```js
// plugins/builtin/fetch/index.js
module.exports = {
    manifest,                     // 来自 plugin.json，加载期已校验
    setup(ctx) {
        ctx.actions.register(fetchAction);          // 见 §4.5
        ctx.hooks.on("session.finished", onFinish); // hook 插件主要用法
        ctx.providers.register("myllm", MyProvider, { targetUrl: "...", supportsImages: true });
        ctx.ui.registerPanel({ id: "fetch", title: "Fetch", schema: [...] });
    },
};
```

`ctx` 提供的全部能力（**刻意不暴露 raw `fs` / raw `fetch` / `child_process`**）：

| 成员                                                               | 说明                                                                                            |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `ctx.actions.register`                                             | 注册 XML 动作（校验期即做权限与 schema 检查）                                                   |
| `ctx.providers.register(name, factory, meta)`                      | 注册 Provider（`meta.targetUrl` 自动并入浏览器 targetUrls）                                     |
| `ctx.hooks.on(event, handler)`                                     | 观察生命周期：`session.created/finished`、`runtime.result`、`agent.error` 等                    |
| `ctx.ui.registerPanel / registerSettings / registerComposerAction` | 声明式 UI 贡献                                                                                  |
| `ctx.fs`                                                           | workspace 内受控文件访问（复用 Runtime 的 `resolvePath`，天然不能越界）                         |
| `ctx.http`                                                         | 受控请求：域名白名单、超时、响应体积上限、禁止跨域重定向                                        |
| `ctx.permissions.check(scope)`                                     | 权限控制器；申请未授权 scope 直接抛错                                                           |
| `ctx.secrets.get(key)`                                             | 密钥读取，返回值在日志与 Trace 中自动脱敏                                                       |
| `ctx.config`                                                       | 本插件配置（`configSchema` 默认值 + 用户覆盖，带类型校验）                                      |
| `ctx.storage`                                                      | 插件私有 JSON KV + `~/.xml-agent/plugin-data/<name>/`（与插件安装目录分开，避免被当成插件扫描） |
| `ctx.events.emit(type, payload)`                                   | 事件必须带 `plugin.<name>.` 命名空间前缀                                                        |
| `ctx.logger`                                                       | 结构化日志（自动带插件名前缀）                                                                  |
| `ctx.agent.uploadImagesToModel(paths)`                             | 唯一能让模型"看到"产物的通道（截图插件用它，从而把 `attachScreenshotToProvider` 从核心摘除）    |

### 4.5 动作定义对象（对外契约）

与 §3.1 ① 完全一致，这是插件作者唯一需要理解的核心结构。一个动作包含五件事：

1. **校验**：`schema` 声明式校验（attrs 类型/必填/枚举 + children 结构），复杂场景用 `validate(node)` 覆盖；
2. **执行**：`run(node, ctx)` 返回 `{ ok, action, ... }`，与现有 Runtime 返回结构完全一致（`ok/action/error` 是既有约定，前端与报告已依赖）；
3. **模型文档**：`meta.prompt.{ group, usage, note, priority }`，由构建器自动拼装；
4. **可观测**：`meta.summary(result)` 统一 Trace / 报告摘要；`mutating` 标记供 UI 提示；
5. **安全**：`meta.permission` 必须是插件 `manifest.permissions` 的子集，否则**加载期拒绝**；`meta.timeoutMs` 与 `AbortSignal` 由 Runtime 强制。

### 4.6 插件生命周期

```
进程启动 → registry.load()
    ├─ 扫描 plugins/builtin/* 与 ~/.xml-agent/plugins/*
    ├─ 读 plugin.json → 校验 name/version/apiVersion/engines/kind/permissions
    ├─ 读 plugins-state.json → 是否启用（默认：内置启用；用户插件启用，但需授权 scope）
    ├─ require(index.js) → setup(ctx) → 收集注册项
    ├─ 注册冲突检测（动作名/Provider 名与内置或其它插件冲突则拒绝后者）
    └─ 单个插件异常 → 标记 status:"error"，其余照常

Agent run
    ├─ 按 activation 决定注入哪些插件动作到本轮的提示词
    ├─ runtime.run(action) → permissions.check → timeout(AbortSignal) → run() → afterRun()
    └─ 调用记录写入 history：{ plugin, action, permission, durationMs, ok }

进程退出 → 状态写回 plugins-state.json
```

#### 代码组织

注册表曾经是单个 1300 行的类，现按职责拆到 `plugins/registry/`，`plugins/registry.js`
只保留构造、`userDirs` getter 与单例，其余方法以 mixin 挂回 `PluginRegistry.prototype`
（`this` 语义不变，导出面不变）：

| 文件                   | 职责                       | 主要方法                                                |
| :--------------------- | :------------------------- | :------------------------------------------------------ |
| `registry.js`          | 门面：构造、单例、默认配置 | `createRegistry` / `getRegistrySafe` / `defaultOptions` |
| `registry/shared.js`   | 常量与工具                 | `createScopedLogger` / `runWithTimeout`                 |
| `registry/storage.js`  | 持久化                     | `storageDir` / `_readState` / `_migrateLegacyStorage`   |
| `registry/loader.js`   | 加载管线                   | `load` / `_loadPlugin` / `_commit`                      |
| `registry/context.js`  | 上下文装配                 | `_createSetupContext` / `_createRunContext`             |
| `registry/catalog.js`  | 只读查询                   | `getActionDefinition` / `listPromptContributions`       |
| `registry/present.js`  | 对外展示                   | `getStatus` / `getUiManifest` / `formatEvent`           |
| `registry/api.js`      | 插件 HTTP 接口             | `callPluginApi`                                         |
| `registry/settings.js` | 配置与权限                 | `getConfig` / `getPolicy` / `grantPermission`           |
| `registry/invoke.js`   | 动作执行与钩子             | `invokeAction` / `emitHook`                             |

### 4.7 权限模型（v1）

**scope 集合**：`workspace:read`、`workspace:write`、`shell:exec`、`network:http`、`system:screen`、`system:window`、`secrets:read`。

**判定顺序**：`manifest.permissions` ⊇ `action.meta.permission`（加载期静态校验）→ 运行期 `permissions.json` 策略（`allow` / `deny` / `ask`）→ 作用域门面只授予通过的 scope。

**v1 的 `ask` 简化**：`ask` = 拒绝并向前端推送一次授权卡片，用户点击即写入 `permissions.json` 变为 `allow`。**不做挂起阻塞式确认**，避免任务执行中卡死会话。

**拒绝时的模型反馈**：返回结构化错误（`{ ok:false, error:"permission denied: network:http" }`），走既有的 `getRuntimeErrorPrompt()` 通道。模型能看懂并换方案，用户也能在 Trace 里看到原因。

**审计**：每次插件动作调用都写入 history 与 Trace，字段固定为 `plugin / action / permission / durationMs / ok`，使"谁在什么时候用了什么权限"始终可回放。

### 4.8 集成点清单（改动面，每处都很薄）

| #   | 位置                             | 改动                                                                                                                                           |
| --- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `plugins/registry.js`（新增）    | 扫描、校验（apiVersion / engines / permissions）、拓扑排序、加载隔离、状态持久化                                                               |
| 2   | `runtime.js`                     | `get actionHandlers()` → `merge(builtinActions, registry.actions)`；`run()` 增加权限检查、超时、`AbortSignal`、`afterRun`、调用记录            |
| 3   | `parse/xml-parse.js`             | `validateAction` 走 registry；fastPath 从 `meta.fastPath` 收集；`ACTION_NAMES` 派生                                                            |
| 4   | `prompts/`                       | 新增 `builder.js`；`system-prompt.js` 退化为 `sections/core.md`；动作文档自动生成 + 预算裁剪                                                   |
| 5   | `agent-core.js`                  | 注入 registry；answer/done 走 `meta.terminal`；删除 `attachScreenshotToProvider`；Provider 由 registry 解析                                    |
| 6   | `webui/server.js`                | `createApp({ registry })`；新增 `GET /api/plugins`、`GET/POST /api/plugins/:name/config`、`GET /api/plugins/ui`、`POST /api/permissions/grant` |
| 7   | `webui/session/agent-session.js` | `formatEvent` → 格式器注册表（含兜底）；`restore()` 兼容 v1 会话文件                                                                           |
| 8   | `webui/frontend`                 | 新增 `PluginPanel.vue`（声明式渲染）；Settings 增加 Plugins 页；Trace 增加未知事件兜底                                                         |

**Electron 侧 v1 零逻辑改动**：一切都走本地 HTTP（桌面版本就是本地服务器），只需两件事：

- `package.json` 的 `build.files` 增加 `"plugins/**/*"`（否则打包后插件缺失）；
- 设置入口复用 Web 版 Plugins 面板（无需新增 IPC）。

### 4.9 可靠性护栏

- **超时**：每个动作 `timeoutMs` + `AbortSignal` 传播；超时返回结构化错误，不抛栈。
- **加载失败隔离**：单个插件 `setup()` 失败只标记 `status:"error"` 并通过 `/api/plugins` 暴露原因。
- **缓存**：清单按 mtime 失效；`XML_AGENT_PLUGINS=0` 一键回到"仅内置动作"。
- **提示词预算**：`maxPromptChars`（默认 8000），超限按 `priority` 裁剪并明确告知模型。
- **激活策略**：`activation`（`always` / `keywords` / `manual`）。插件变多后，只有被任务触发的插件才注入提示词——这是长期不失控的关键。
- **降级**：插件动作可在 `plugin.json` 声明 `"deprecated": true`，加载时告警且不注入提示词。

### 4.10 前端 UI 贡献（v1 声明式）

前端只认三样东西，全部由宿主组件渲染，插件不提供可执行 JS：

```jsonc
// GET /api/plugins/ui 返回
{
    "panels": [
        {
            "id": "fetch",
            "title": "Fetch",
            "schema": [
                /* 表单字段描述 */
            ],
        },
    ],
    "settings": [
        {
            "plugin": "fetch",
            "fields": [
                /* configSchema 映射 */
            ],
        },
    ],
    "actions": [{ "plugin": "fetch", "label": "Test fetch", "command": "fetch.selfTest" }],
}
```

- 宿主提供 `PluginPanel.vue`，按 `schema` 渲染表单并调用 `/api/plugins/:name/config` 保存；
- "New Session" 中未启用插件的动作不会出现在提示里（提示词层已过滤，UI 无需重复判断）；
- 二期（可选）再讨论 `import()` 加载插件 ESM 包——v1 明确不做，避免给前端开任意代码执行的口子。

### 4.11 版本与兼容

- `apiVersion: 1` 固定；`engines.xmlAgent` 语义化版本区间校验，不满足则拒绝加载并给出明确原因。
- 会话文件：`session-store` 版本升至 2，读取端同时接受 v1（当前 40 个 `test/*.js` 与用户磁盘上的历史会话都不受影响）。
- 事件：新增事件一律带命名空间；既有事件名与 payload **不做破坏性修改**。
- 配置：`config/schema.js` 成为单源，旧配置文件缺字段用默认值补齐（现有 `mergeWithDefaults` 行为保留）。

---

## 五、改造后的目录结构

```
xml_agent/
├─ agent-core.js                 ← 编排，仅依赖 registry 抽象（无具体动作知识）
├─ runtime.js                    ← 查表 + 鉴权 + 超时 + 执行 + 记录
├─ agent.js                      ← CLI 入口（不变）
├─ actions/                      ← P0：内置动作定义（read/write/exec/answer/done）
├─ plugins/                      ← 插件系统（registry / sdk / builtin）
├─ config/
│   ├─ schema.js                 ← P1：配置单源
│   └─ agent-config.js           ← 从 schema 派生（保持现有导出面）
├─ prompts/
│   ├─ builder.js                ← 新增：提示词构建器
│   ├─ sections/core.md          ← 从 system-prompt.js 抽出
│   └─ first-prompt.js / runtime-prompt.js / ...
├─ parse/xml-parse.js            ← 校验委托给 registry，保留 fastPath 机制
├─ providers/                    ← 契约化 + 注册表（P3）
├─ webui/
│   ├─ server.js                 ← 只剩 createApp / startServer / shutdown
│   ├─ routes/                   ← sessions / workspace / browser / agent-config / storage / plugins
│   ├─ session/                  ← agent-session / session-manager / session-store / event-formatters
│   └─ frontend/                 ← 新增 PluginPanel.vue、settings/ 子面板
├─ electron/                     ← v1 仅打包配置调整
├─ test/
│   ├─ unit/                     ← node --test，无网络
│   └─ live/                     ← XML_AGENT_LIVE=1 才跑
└─ docs/PLUGIN_API.md            ← 对外插件开发契约文档（P1 交付）
```

---

## 六、落地路线

每个阶段都可独立交付、独立验证。

| 阶段   | 内容                                                                                | 交付判据                                                  | 主要涉及文件                                                                                                         |
| ------ | ----------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **P0** | ①动作定义对象化 ②Prompt 构建器 ③事件格式器注册表 ④`server.js` 拆路由                | 行为零变更；`npm test` 全绿；prompt golden 测试逐字节一致 | `runtime.js`、`parse/xml-parse.js`、`prompts/`、`agent-core.js`、`webui/server.js`、`webui/session/agent-session.js` |
| **P1** | registry + sdk + 加载器 + `/api/plugins` + `fetch` 动作插件 + `audit-log` hook 插件 | 不碰核心即可新增动作；单插件加载失败不影响启动            | `plugins/*`、`webui/routes/plugins.js`                                                                               |
| **P2** | 截图迁移为插件；删除 `agent-core.js` 的截图特判                                     | 截图回归测试全绿；核心再无动作特判                        | `plugins/builtin/screenshot/`、`agent-core.js`                                                                       |
| **P3** | Provider 契约 + 四个 provider 适配为注册项（列表数据化）                            | 新增 provider 只改插件目录，前端选项自动出现              | `providers/`、`config/schema.js`                                                                                     |
| **P4** | 声明式 UI 贡献（Plugins 设置页、按钮、Trace 渲染器）                                | 一个插件能自带设置表单并被保存                            | `webui/frontend/src/components/PluginPanel.vue`                                                                      |
| **P5** | 权限授权 UI + secrets + 每插件配置表单 + `activation` 关键词                        | 越权动作被拒且原因在 Trace 中可见                         | `plugins/`、前端                                                                                                     |

**提前见效的捷径**：P0 的 ① + ② 单独完成即可拿到"改一个文件即可加动作"的全部收益，插件系统可以晚一步。反之若想在无 P0 的情况下先验证插件价值，只能采用"内置动作保持原样 + 仅插件动作走新表"的双轨方案——**不推荐**，会长期留下两套校验与两套提示词逻辑。

---

## 七、测试与验收

### 7.1 分层

| 层   | 位置                                | 运行方式                   | 内容                                                                                                |
| ---- | ----------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------- |
| 单元 | `test/unit/`                        | `node --test`，无网络      | registry 发现/校验/冲突、schema 校验、权限判定、prompt 预算裁剪、事件兜底格式器、`resolvePath` 越界 |
| 契约 | `test/unit/plugin-contract.test.js` | 同上                       | `assertPluginConformance(plugin)`：任何第三方插件可自检是否符合 API                                 |
| 集成 | `test/integration/`                 | 本地起 Express（随机端口） | `/api/plugins`、`/api/run` 全链路（用 fake provider，不碰浏览器）                                   |
| LIVE | `test/live/`                        | `XML_AGENT_LIVE=1`         | 真实 CDP + 模型，保留现有用例                                                                       |

### 7.2 关键验收判据

1. `XML_AGENT_PLUGINS=0` 下，全部既有测试结果与 1.0.7 基线一致。
2. 内置动作集合下，`buildSystemPrompt()` 输出与旧 `SYSTEM_PROMPT` 逐字节一致。
3. 新增 `fetch` 插件后：模型能看到该动作、能成功调用、Trace 与控制台均有记录、报告含该步 —— **核心文件零改动**。
4. 故意写一个 `setup()` 抛异常的插件：进程正常启动，其余插件与内置动作可用，`/api/plugins` 显示该插件 `status:"error"` 与原因。
5. 故意让插件调用未声明权限的动作：加载期被拒绝，模型侧根本看不到该动作。
6. 会话文件 v1 在 1.1.0 下可正常恢复。

---

## 八、风险与权衡

| 风险           | 说明                                                                                  | 缓解                                                                                           |
| -------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **提示词膨胀** | 插件变多后系统提示词变长，XML 输出稳定性下降（这是同类 XML 协议方案最常见的失效模式） | 预算裁剪 + 技能文件模式 + `activation` 关键词激活 + golden 测试守住体积                        |
| **信任模型**   | 插件是同权限 Node 代码，恶意插件可做任何事                                            | 作用域门面（不给 raw fs/net）+ 权限声明 + 审计 + "仅安装可信插件"的显式警告；跨进程隔离列为 v2 |
| **双轨期风险** | P0 重构期间新旧逻辑并存容易漏改                                                       | P0 必须一次做完四件套并以 "prompt golden + 全量测试" 作为完成门槛；不在中途发布                |
| **性能回退**   | registry 查表 + 权限检查 + 计时带来微小常数开销                                       | 动作表在启动期冻结（`Object.freeze`），`run()` 热路径只做一次 Map 查询                         |
| **测试成本**   | 现有 40 个手工脚本迁移到 `node --test` 需要时间                                       | 只迁移可离线的用例（manifest/config/xml-parse/session），LIVE 用例保持现状并加环境变量门控     |
| **打包遗漏**   | 新增 `plugins/`、`actions/` 目录若未加入 `build.files`，打包后功能缺失                | 作为 P1 的显式检查项，并在 `test/unit/package-files.test.js` 中校验 `build.files` 覆盖新增目录 |

---

## 九、待决策项

| #   | 决策点       | 选项                                                                         | 建议                                                                                  |
| --- | ------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | 插件信任模型 | (a) 同权限 Node 代码 + 权限门面 + 审计；(b) 先做子进程隔离（stdio JSON-RPC） | (a)，隔离列为 v2；`run()` 已设计为 async + signal，天然可迁移                         |
| 2   | UI 插件边界  | (a) 仅宿主渲染的声明式面板；(b) 允许 `import()` 插件 ESM                     | (a)                                                                                   |
| 3   | 用户插件目录 | (a) 仅 `~/.xml-agent/plugins`；(b) 另允许项目内 `./.xml-agent/plugins`       | (a)；项目内目录作为"默认禁用"的可选补充                                               |
| 4   | 版本策略     | 破坏面涉及 `runtime/parse/prompts/agent-core`，建议直接发 **1.1.0**          | 新增插件 API、默认行为不变，`readme.md` 增"插件"章，`docs/PLUGIN_API.md` 作为对外契约 |

---

## 十、附录：不变式清单

下面这些在 P0~P5 全过程中**不允许变化**，是回归测试的锚点：

1. XML Action 语法、单动作约束（每次响应只能一个 XML Action）。
2. Runtime 返回结构约定：`{ ok, action, error? }` + 各动作既有字段。
3. 事件名与 payload 形状（新增事件可以，修改既有事件不行）。
4. 会话文件路径（`~/.xml-agent/webui-sessions/<id>.json`）与可读性。
5. `execScope` 语义（`workspace` / `all`）与默认值 `workspace`。
6. 桌面版与 Web 版的行为一致性（同一后端实现，不得为了插件引入分叉）。
7. 打包产物目录结构（`plugins/**` 必须随包分发）。
