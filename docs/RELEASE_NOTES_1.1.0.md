# XML Agent 1.1.0 发布说明

本版本引入**插件系统**：新增一个 XML 动作不再需要修改核心文件，写一个插件目录即可。
默认行为与 1.0.7 完全一致（没有任何启用的插件动作时，首轮提示词逐字节不变）。

## 一、新增：插件系统

### 能力

| 类型       | 贡献                                             | 本版状态                                 |
| ---------- | ------------------------------------------------ | ---------------------------------------- |
| `action`   | 新的 XML 动作 + 模型文档 + Trace 摘要 + 权限声明 | ✅ 可用                                  |
| `hook`     | 只观察不干预：审计日志、通知、指标               | ✅ 可用                                  |
| `provider` | 新的模型后端（`ctx.providers.register`）         | ✅ 可用（契约校验 + 前端下拉自动出现）   |
| `ui`       | 声明式面板 / 设置项 / 按钮                       | ✅ 可用（note/status/table/action 面板） |

### 目录

```
plugins/
    sdk.js              契约层：清单校验、动作定义、属性 schema、版本区间、契约自检
    registry.js         发现 / 加载隔离 / 权限 / 执行 / 钩子 / 状态持久化
    capabilities.js     作用域门面：workspace fs、受控 http、storage、secrets
    builtin/fetch/      action 插件（HTTP 请求，域名白名单）
    builtin/audit-log/  hook 插件（JSONL 审计日志，按 keepDays 自动清理）
    builtin/screenshot/ action 插件（截屏，平台引擎随插件自带）

~/.xml-agent/plugins/<name>/plugin.json + index.js     用户插件
~/.xml-agent/plugins-state.json                        启停状态
~/.xml-agent/plugins-config.json                       插件配置
~/.xml-agent/permissions.json                          权限策略
```

### 一个动作的五件事，写在一个文件里

```js
ctx.actions.register({
    name: "echo",
    schema: { attrs: { text: { type: "string", required: true } } },
    run: (node, ctx) => ({ ok: true, action: "echo", text: ctx.attrs.text }),
    meta: {
        prompt: { group: "plugin", usage: '<echo text="hi"/>', note: "回显文本" },
        permission: [],
        timeoutMs: 5000,
        summary: (result) => "echo " + result.text,
    },
});
```

校验、执行、模型文档、Trace 摘要、权限声明同源，因此**不会再出现"漏改某个文件导致静默失败"**
（1.0.x 新增动作要同时改 6~8 个文件，且多数漏改不报错）。

### 安全模型

- 动作必须声明 `permission`，且必须是 `plugin.json` 的 `permissions` 子集 —— 否则**加载期拒绝**；
- 运行期再按 `permissions.json` 判定 `allow` / `deny` / `ask`（v1 的 `ask` = 未授权即拒绝，原因回给模型）；
- 插件不拿 raw `fs` / `child_process`：`ctx.fs` 只能在 workspace 内活动（复用 Runtime 的越界保护），
  `ctx.http` 受域名白名单、超时、体积上限约束，且**不跟随重定向**（防 SSRF 借道跳转）；
- 每次插件动作调用都带 `plugin` / `durationMs` 进入 history 与 Trace，可审计；
- 内置 `audit-log` 插件把动作执行、权限拒绝、会话结束写成 JSONL。

> 插件仍是**与宿主同权限的 Node.js 代码**，这不是沙箱；只安装可信插件。详见 `docs/PLUGIN_API.md` 第十一节。

## 二、动作定义对象化（P0：纯重构，零行为变更）

新增 `actions/` 目录，把 6 个内置动作从 `runtime.js` 里搬出来，统一成与插件动作相同的"动作定义对象"：

```
actions/
    index.js        动作表（Map<name, definition>）+ fastPath 列表
    read.js         读取文件/目录
    write.js        写入文件（含手写快速解析器）
    exec.js         执行命令（异步，不阻塞事件循环）
    screenshot.js   截图（含多目标、校验、产物声明）
    answer.js       terminal = "answer"
    done.js         terminal = "end"
```

落地要点（等价性由 53 项用例锁死）：

- run 的方法体与错误文案**逐行搬移**，只把 `this` 换成 `ctx.runtime`，因此行为完全不变；
- `xml-parse.js` 的 `validateAction` switch 与两份手写快速解析器改为**委托动作表**
  （`meta.fastPath`），公开导出面（`ACTION_NAMES`、`tryExtractWriteManually`、
  `tryExtractScreenshotManually`、`normalizeScreenshotTargets`）保持不变；
- `agent-core.js` 不再认 `action === "answer" / "done"`，改为读 `meta.terminal`；
- 截图上传不再特判动作名，改为读 `meta.collectImages`（插件动作同样可用这条通道）；
- 新增两个叶子模块 `parse/xml-chars.js`、`parse/xml-text.js`，消除 `parse ↔ actions` 循环依赖。

**附带修正**：`runtime.maxReadSize` / `maxFileSize` / `maxExecTimeout` / `maxExecOutputSize`
改为调用时读取，通过 `/api/agent/config` 保存后即时生效（此前是模块加载时快照，必须重启）。

## 三、其余改动（插件系统接线）

| 文件                               | 改动                                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `parse/xml-parse.js`               | 未知动作先查插件注册表；校验委托动作表；支持插件 `fastPath`；解析结果新增 `plugin` 字段                                |
| `runtime.js`                       | 从 496 行降到 ~220 行：只剩 Workspace 沙箱 + 查表执行 + 插件动作；兼容方法（`read`/`screenshot`/`actionHandlers`）保留 |
| `prompts/plugin-prompt.js`（新增） | 插件动作文档自动生成，带字符预算裁剪；无插件时返回空串                                                                 |
| `prompts/first-prompt.js`          | 在系统提示词后追加插件区块；无插件时输出与 1.0.7 逐字节一致                                                            |
| `agent-core.js`                    | 事件转发插件钩子（异常完全隔离）；`meta.terminal` 驱动终止语义；`meta.collectImages` 驱动产物上传                      |
| `webui/session/agent-session.js`   | 事件格式化改为"内置 → 插件格式器 → 通用兜底"三层；**未知事件不再静默消失**；会话结束触发 `session.finished` 钩子       |
| `webui/server.js`                  | 启动时加载插件并打印统计；注册插件管理路由                                                                             |
| `webui/routes/plugins.js`（新增）  | `/api/plugins*` 与 `/api/permissions*`                                                                                 |
| `config/agent-config.js`           | 新增 `plugins` 块（`enabled` / `dirs` / `maxPromptChars` / `storeRoot`）及对应环境变量                                 |
| `package.json`                     | 版本 1.1.0；`build.files` 增加 `actions/**/*` 与 `plugins/**/*`（否则打包后功能缺失）；新增测试脚本                    |

## 四、新增：Plugins 管理面板（前端）

顶部新增 **Plugins** 按钮（History / Trace 旁边），Web 版与桌面版一致。以前只能靠 `curl`
调整的插件权限与配置，现在都有界面：

- 插件卡片：名称 / 版本 / `kind` / 来源（`builtin`·`user`）/ 状态（`loaded`·`disabled`·`error`）+ 错误原因；
- 启用 / 禁用开关（写 `~/.xml-agent/plugins-state.json`，保存后立即 reload）；
- 权限逐 scope 下拉：`allow` / `ask` / `deny`（写 `~/.xml-agent/permissions.json`）；
- 按 `configSchema` 自动渲染配置表单（array / string / integer / number / boolean），
  保存时由服务端按类型校验，非法值回红色提示；
- Reload 按钮：改完插件代码无需重启服务；
- 插件系统被 `XML_AGENT_PLUGINS=0` 关闭时显示明确横幅，而不是空白列表。

涉及文件：`webui/frontend/src/components/PluginsPanel.vue`（新增）、
`webui/frontend/src/services/agent-api.js`（新增 7 个插件接口封装）、`App.vue`（按钮 + 挂载）。

## 五、优化：配置单一来源（`config/schema.js`）

同一批默认值此前散落在四处，并且**已经产生了实际漂移**：

| 副本                        | 问题                                                                      |
| --------------------------- | ------------------------------------------------------------------------- |
| `config/agent-config.js`    | 持有全部默认值 + 20 个环境变量 if 分支 + 校验                             |
| `webui/agent-config-api.js` | 又写了一份 agent/runtime/session 默认值与校验 —— 改前者设置面板不会跟着变 |
| `electron/settings.js`      | 自己一份 `DEFAULT_CDP_URLS` / `buildCdpUrls` / `normalizeSettings`        |
| `webui/browser-settings.js` | 又一份 `DEFAULT_CDP_URLS` / `buildCdpUrls` / `normalizeSettings`          |

结果之一：`config/agent-config.js` 的 `browser.browserType` 默认是 **edge**（2024 年一次提交），
而桌面版/Web 版"浏览器设置"的默认是 **chrome** —— 同一个产品里两套默认，靠注释才能解释。

现在这些都收敛到 `config/schema.js` 一处声明：

```js
{
    path: "agent.maxSteps",
    default: 100,
    type: "int",
    min: 1,
    env: ["AGENT_MAX_STEPS"],
    message: "agent.maxSteps must be a positive integer",
}
```

- `config/agent-config.js` 变成 `schema.buildConfig(process.env)` 的投影（不再有字面量）；
- `webui/agent-config-api.js` 的默认值与校验从 schema 派生，`applyToRuntime` 的 env 映射也由
  schema 的 `env` 声明生成（不再手抄环境变量名）；
- `electron/settings.js` 与 `webui/browser-settings.js` 共用 `DEFAULT_CDP_URLS` /
  `normalizeBrowserSettings` / `resolveCdpUrl` / `getProfileDirName`；
- `electron/chrome-finder.js` 的 `normalizeBrowserType` 也改为转发 schema（第 4 份副本消失）。

**默认浏览器统一为 Edge**：此前 `config/agent-config.js` 默认 edge，而桌面/Web 的"浏览器设置"
默认 chrome —— 同一个产品两套默认。现已收敛为 `schema.DEFAULT_BROWSER_TYPE = "edge"`：

- 默认浏览器：Edge（CDP 9223），设置里仍可切换为 Chrome（9222）；
- `browser.cdpUrl` 的兜底值也跟随默认浏览器（9223），不会再出现"默认 edge 却连 9222"；
- `electron/settings.js` 的 `DEFAULT_SETTINGS` 与 `webui/browser-settings.js` 的默认值同步为 edge；
- 显式传入非法值（如 `"firefox"`）仍归一化为 chrome —— 那是"给个已知值"的兜底，不是默认值，
  保持 1.0.x 行为不变。

其余默认值与校验规则**行为零变更**：`test-edge-settings-io` / `test-electron-settings` /
`test-edge-agent-config` / `test-edge-cdp` 全部通过（断言已按新默认更新）。

新增 `test/test-config-schema.js`（76 项）：除了行为等价，还包含**漂移守卫**——
断言 `agent-config` 与 `schema.buildConfig(process.env)` 逐键一致、设置面板默认值
`=== schema.defaultsForUI()`、`electron.DEFAULT_CDP_URLS` 与 schema 相同、
`webui` 归一化结果与 schema 相同、`agent-config-api.js` 源码里不再出现环境变量字面量。

## 六、优化：Provider 契约化（`providers/registry.js`）

在此之前，"有哪些模型后端"这件事散落在四处，并且**已经漏了一个真 bug**：

| 位置                       | 问题                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `providers/index.js`       | 硬编码 4 个类的映射表                                                                 |
| `config/agent-config.js`   | `browser.targetUrls` 再写一份 4 个访问地址                                            |
| `webui/server.js`          | 按 provider 名写死"URL → conversationId"分支，只认 DeepSeek `/a/chat/s/` 与通用 `/c/` |
| `agent-api.js` + `App.vue` | 前端又一份正则 + 硬编码 4 个 `<option>`                                               |

**真 bug**：`providers/glm.js` 自己支持 `/(?:c|s)/<id>` 两种会话 URL，但 `webui/server.js` 只认
`/c/<id>` —— 从 GLM 的 `/s/<id>` 会话链接续聊时 conversationId 被解析成 `null`，被当成新会话。
现在正则由 provider 自己声明，这条路径自然通了（`test-provider-registry.js` 有对应用例）。

现在每个 provider 模块导出自己的元数据：

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

- `createProvider(name, options)` 只查表，并在**创建时**做契约校验
  （必需 `start` / `send` / `close`，可选 `uploadImages` 等），缺方法立刻报错；
- 访问地址解析顺序：`config.browser.targetUrls[name]`（覆盖表，默认为空）> provider 自身声明；
- 会话 id 规范化统一走 `providers/registry.normalizeConversationId`（`webui/server.js` 仅转发）；
- 新增 `GET /api/providers`，前端 provider 下拉与会话 id 提示改由它驱动
  （接口异常时回落内置表，页面不会坏）；
- **插件 provider 真正接通**：`ctx.providers.register(name, factory, meta)` 现在会被
  `createProvider` / `listProviders` / 会话 id 解析同时看到，不需要改 server 或前端。

新增 `test/test-provider-registry.js`（38 项）：元数据、地址覆盖、契约校验、14 条会话 id 用例
（含 GLM `/s/` 修复与未知 provider 回落）、插件 provider 的注册/创建/正则/坏实例拒绝，
以及"config 不得再写死 provider 地址"的漂移守卫。

## 七、新增：声明式 UI 面板（P4）

插件现在能往界面上加东西了，而且是**零可执行代码**的方式：面板用纯 JSON 声明，宿主渲染。

```
ctx.ui.registerPanel({
    id: "audit-log", title: "Audit Log",
    blocks: [
        { kind: "note", text: "..." },
        { kind: "status", path: "/summary", items: [{ label: "Entries", value: "total" }] },
        { kind: "table",  path: "/summary", rows: "recent", columns: [...] },
        { kind: "action", label: "Run", path: "/do", method: "POST" },
    ],
});
```

面板要显示数据就需要接口，因此同时落地了 `ctx.api`：

- `ctx.api.get/post/put/delete/register`，路径固定在本插件命名空间
  （`/summary` → `GET /api/plugins/<name>/api/summary`）；
- 宿主按 method+path 精确匹配注册表，插件之间不可能串路径；
- 返回 JSON；抛错 → 500；未注册 → 404；路径含 `..` 或缺少前导 `/` → 加载期拒绝。

安全边界（刻意为之）：宿主只渲染文本/表格/按钮，**不执行插件字符串、不注入 HTML**；
非法 block 只跳过该面板并记入 `uiErrors`，不会让插件整体失效。

`Plugins` 面板里新增 `Plugin panels` 区块；内置 `audit-log` 插件成了完整示例
（hook 写日志 + `/summary` 只读接口 + 面板显示概览与最近条目）。

新增 `test/test-plugin-ui.js`（27 项）；`test/test-plugin-api.js` 增加 4 项 HTTP 级校验
（面板 manifest 带 `basePath`、插件接口可访问、未注册路径 404、没接口的插件 404）。

## 八、重构：`server.js` 拆路由（P0 ④）

`webui/server.js` 从 653 行的单文件降到 **161 行**，路由按领域拆到 `webui/routes/`：

| 文件                     | 负责                                            |
| ------------------------ | ----------------------------------------------- |
| `routes/sessions.js`     | `/api/run`、会话 CRUD、SSE 输出流、按工作区分组 |
| `routes/workspace.js`    | 目录浏览、新建文件夹                            |
| `routes/storage.js`      | 存储统计与临时文件清理                          |
| `routes/browser.js`      | 浏览器设置、探测、CDP 状态 / 启动 / 切换        |
| `routes/agent-config.js` | agent / runtime / session 运行参数              |
| `routes/plugins.js`      | 插件管理 + 插件自定义接口                       |
| `routes/providers.js`    | provider 列表                                   |

`server.js` 现在只保留两件事：**启动顺序**（会话恢复 → 浏览器设置 → Agent 配置 → 插件加载，
每步失败都只记日志）和**装配**（中间件、静态资源、路由注册顺序、HTTP 生命周期）。
入参归一化（会话 id / 附图路径）提取到 `webui/request-input.js`，
`server.js` 继续 re-export，既有调用方与测试不受影响。

新增 `test/test-route-surface.js`（8 项）把 35 条接口的 (method, path) **全表冻结**：
拆分/重构时少一条接口立刻失败，多一条也失败（新增接口必须同步更新清单，避免接口无声扩大）；
同时校验 `express.json()` 在路由之前、`/api` 兜底 404 在最后、以及 `sessionManager` /
`normalizeConversationId` / `normalizeImages` 的兼容导出仍在。

## 九、迁移：截图变成内置插件（P2）

`<screenshot>` 原本是 `runtime.js` 里写死的第 6 个内置动作，现在搬到
`plugins/builtin/screenshot/`，走与第三方插件完全相同的链路：

| 迁移前                              | 迁移后                                            |
| ----------------------------------- | ------------------------------------------------- |
| `actions/screenshot.js`（内置动作） | `plugins/builtin/screenshot/index.js`（内置插件） |
| `runtime.getWorkspace()`            | `ctx.workspace`                                   |
| `runtime.resolvePath()`             | `ctx.fs.resolve()`（同一套越界保护）              |
| `logger`                            | `ctx.logger`（`[plugin:screenshot]` 前缀）        |
| 无法单独关闭                        | 权限面板 deny `system:screen` 即可整体关闭        |
| Trace 里没有来源                    | 结果带 `plugin` 与 `durationMs`，审计日志可区分   |

内置动作表随之瘦身：`read / write / exec / answer / done`（5 个），
`screenshot` 从 `RESERVED_ACTION_NAMES` 移除。`Runtime` 的动作分发统一成
"内置表 → 插件表"，`actionHandlers` 与 `runtime.screenshot()` 等兼容方法继续可用。

**两处行为差异（已用测试固定）**：

1. 越界路径不再抛栈，而是返回结构化失败
   `{ ok:false, action:"screenshot", error:"Path escapes workspace" }`
   —— 插件动作的执行统一由 registry 兜底，抛栈本来也会被转成同样形状；结构化结果还保留了
   `action` 名，Trace / 报告更容易读。`test/test-screenshot.js` 已改为接受两种表现。
2. 动作级超时 300s（此前无上限）—— 与 `runtime.maxExecTimeout` 同量级，避免截图卡住时整轮任务不返回。

**代价（必须知道）**：`XML_AGENT_PLUGINS=0` 关闭插件系统时，截图能力也会一起消失。
启动日志现在会明确提示这一点。若只想关掉截图能力，请在权限面板 deny `system:screen`，
而不是关掉整个插件系统。

新增 `test/test-screenshot-plugin.js`（31 项）：内置表瘦身、插件来源与权限、动作元数据、
4 条错误文案冻结、`actionHandlers` 兼容、越界拒绝、真实截图链路、deny/reload 授权演练、产物收集；
`test/test-builtin-actions.js` 同步更新为 5 个内置动作（54 项）。
端到端另有 `test/test-agent-screenshot-flow.js`（截图 → `meta.collectImages` → mock provider 上传，
`uploadedCount=1`）。

## 十、环境变量

```
XML_AGENT_PLUGINS=0                    关闭插件系统（用户插件 + 内置插件，含截图能力）
XML_AGENT_PLUGIN_DIRS=/a/plugins:/b     额外插件目录（path.delimiter 分隔）
XML_AGENT_PLUGIN_MAX_PROMPT_CHARS=8000  插件动作文档的提示词预算
XML_AGENT_STORE_ROOT=D:\my-store        插件状态/配置/权限的存储根目录（默认 ~/.xml-agent）
```

## 十一、验证

```
npm run test:offline     # = test:core + test:plugins
npm run test:ui          # Vue SFC 编译校验（不需要 Vite/esbuild 也能跑）
npm run webui:build      # 前端产物
```

- `test/test-builtin-actions.js`：53 项通过（动作表与顺序、**校验错误文案逐字节冻结**、
  解析结构、Runtime 执行、兼容调用面、终止语义、产物收集、**系统提示词指纹 golden**）
- `test/test-plugins.js`：47 项通过（发现与加载、解析层校验、Runtime 调用、白名单拒绝、
  权限拒绝与授权、请求/动作级超时、体积截断与 promptView 精简视图、内置动作不受影响、
  审计落盘、提示词区块、事件兜底、插件隔离与命名冲突、SDK 契约、一键禁用）
- `test/test-plugin-api.js`：23 项通过（`/api/plugins`、配置读写与非法配置拦截、权限授权、
  reload、404/400 分支、`/api/providers`、插件自定义接口、声明式面板 manifest，
  以及**前端产物里确实包含 Plugins 面板**）
- `test/test-plugin-hooks-smoke.js`：验证 `Agent.emitEvent` → 插件钩子 → 审计落盘 的完整链路
- `test/check-vue-sfc.js`：9 个单文件组件全部通过 `@vue/compiler-sfc` 编译（模板 / 脚本 / 样式）
- `test/test-config-schema.js`：76 项通过（默认值逐项、环境变量覆盖与非法值回落、
  校验文案冻结、浏览器设置归一化与旧字段迁移、**四处默认值必须同源**、`applyToRuntime` 保存即生效）
- `test/test-provider-registry.js`：38 项通过（provider 元数据、地址覆盖优先级、契约校验、
  会话 id 规范化含 GLM `/s/` 修复、插件 provider 接入、漂移守卫）
- `test/test-plugin-ui.js`：27 项通过（接口与面板定义校验、登记与隔离、GET/POST/404/500、
  面板 manifest 的 `basePath`、内置插件"面板引用路径必须有对应接口"的一致性守卫）
- `test/test-route-surface.js`：8 项通过（35 条接口的 (method, path) 全表冻结、
  中间件顺序、兼容导出、入参归一化）
- `test/test-screenshot-plugin.js`：31 项通过（截图作为内置插件的完整回归，见第九节）
- `test/test-xml-parse-cdata.js`：9/9（write 的 CDATA 手写快速解析器）

既有离线用例回归：`test-xml.js`（8 PASS / 7 预期 FAIL）、`test-config.js`、`test-manifest.js`、
`test-session-manager-images.js`（5/5）、`test-session-limit.js`（6/6）、`test-storage-api.js`、
`test-webui-api.js`、`test-screenshot-extract.js` 全部通过。

## 十二、升级提示

- 直接覆盖安装即可；用户设置与会话数据保存在 `%APPDATA%/XMLAgent` 下，不会被清除。
- 打包版请使用 1.1.0 的新安装包：旧 exe 不含 `plugins/` 目录，插件不会加载。
- 不需要插件时无需任何操作：没有任何启用的插件动作时，行为与 1.0.7 完全一致。
- 内置 `fetch` 动作默认只允许访问本机（`127.0.0.1` / `localhost`）；要访问其它域名请修改
  `fetch` 插件配置的 `allowHosts`。

## 十三、发布前加固（tag 前完成）

以下修复在 1.1.0 打 tag 前完成，随本版一起发布。

### 停止会话真的能停下命令（行为修复）

1.0.x 起 `exec --background` 用 `detached + unref` 启动进程且不登记句柄，
前台命令也不登记，导致"点停止"之后命令仍在系统里跑（后台进程成为孤儿占着端口，
前台长命令要等满 5 分钟超时）。1.1.0 修复：

- 新增 `processes/registry.js`：登记会话启动的所有子进程（前台 + 后台），
  停止时按**进程树**结束（Windows `taskkill /T /F`，POSIX 进程组 `SIGTERM` → `SIGKILL`）；
- `Agent.stop()` 先结束子进程再关浏览器；会话异常结束时同样收摊；
- 被停止的命令返回 `stopped: true`，不再伪装成"命令执行失败"让模型重试。

**行为变化**：`--background` 启动的进程现在会随会话停止一起结束；如需长期驻留的服务，
请在 Agent 外自行启动。

### 审计日志保留策略真正生效

`audit-log` 插件的 `keepDays`（默认 14）此前只打印不删除。现在启动与跨天时
会删除超出保留期的整日日志文件（窗口含今天），`keepDays=0` 表示不清理。
为此插件 storage 门面新增 `list()` / `remove(name)`（详见 `docs/PLUGIN_API.md`）。

### Provider 层不再静默吞错

补齐了约 10 处会掩盖真实故障的空 catch：输入框诊断逐项收集错误、
`waitForInput` 超时带上最后一次错误、GLM/DeepSeek 回复定位失败与
Qwen 合并缺段（可能导致 XML 闭合标签丢失）均留痕。空回复排查不再两眼一抹黑。

### 大模块拆分与能力下沉

- `plugins/registry.js`（1311 行）拆为门面 + `registry/` 下 8 个职责模块；
- 截图引擎从核心 `capture/` 下沉到 `plugins/builtin/screenshot/engine/`，
  核心不再持有截图实现，删除插件目录即彻底移除该能力；
- `agent-core.js` 拆出 `agent/step.js`（单步闭环）与 `agent/inputs.js`。

### 新增回归测试

`test/unit/test-process-registry.js`（12 项）、`test-exec-stop.js`（17 项）、
`test-audit-retention.js`（11 项）；`test:offline` 全绿。
