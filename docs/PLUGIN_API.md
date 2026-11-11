# XML Agent 插件开发指南（API v1）

> 适用版本：xml_agent >= 1.1.0　|　API 版本：`apiVersion: 1`
> 设计背景与演进计划见 `docs/PLUGIN_DESIGN.md`。

一个插件就是**一个目录**：

```
~/.xml-agent/plugins/<name>/
    plugin.json      ← 清单：名字、版本、权限、配置 schema
    index.js         ← 入口：导出 { setup(ctx) }
```

内置插件放在仓库的 `plugins/builtin/` 下，随安装包分发；用户插件放 `~/.xml-agent/plugins/`。
新增能力**不需要修改任何核心文件**。

---

## 一、最小可用插件

`~/.xml-agent/plugins/echo/plugin.json`

```json
{
    "name": "echo",
    "version": "1.0.0",
    "kind": "action",
    "apiVersion": 1,
    "description": "把 text 属性原样回显，用于验证插件链路",
    "permissions": [],
    "activation": "always"
}
```

`~/.xml-agent/plugins/echo/index.js`

```js
module.exports = {
    setup(ctx) {
        ctx.actions.register({
            name: "echo",
            schema: {
                attrs: {
                    text: { type: "string", required: true, nonEmpty: true },
                },
            },
            run(node, ctx2) {
                return { ok: true, action: "echo", text: ctx2.attrs.text };
            },
            meta: {
                prompt: {
                    group: "plugin",
                    usage: '<echo text="hello"/>',
                    note: "把 text 原样返回，用于测试。",
                },
            },
        });
    },
};
```

重启服务（或 `POST /api/plugins/reload`）后，模型就能看到并使用 `<echo text="hello"/>`。

---

## 二、plugin.json 字段

| 字段               | 必填 | 说明                                                                                  |
| ------------------ | ---- | ------------------------------------------------------------------------------------- |
| `name`             | ✅   | 小写字母/数字，允许 `-` `_` `.` 分隔；全局唯一                                        |
| `version`          | ✅   | 语义化版本                                                                            |
| `kind`             |      | `action` / `hook` / `provider` / `ui`，默认 `action`                                  |
| `apiVersion`       |      | 必须是 `1`                                                                            |
| `engines.xmlAgent` |      | 版本区间，如 `">=1.1.0 <2.0.0"`，支持 `>=` `<=` `>` `<` `=` `^` `~`，空格分隔多个条件 |
| `permissions`      |      | 权限 scope 数组，**动作申请的权限必须是这里的子集**                                   |
| `activation`       |      | `always`（默认）/ `manual` / `{ "keywords": ["抓取", "接口"] }`                       |
| `configSchema`     |      | 插件配置声明，见 §7                                                                   |
| `enabledByDefault` |      | 默认 `true`                                                                           |
| `deprecated`       |      | `true` 时不注入提示词                                                                 |

**权限 scope 全集**：
`workspace:read`、`workspace:write`、`shell:exec`、`network:http`、`system:screen`、`system:window`、`secrets:read`。

**默认授权策略**：

- 内置插件（`plugins/builtin/*`）声明的 scope 默认 `allow`；
- 用户插件默认 `ask` —— 在 v1 中 `ask` 表示**未授权即拒绝**，拒绝信息会回给模型，
  可在 `POST /api/permissions/grant` 或 `~/.xml-agent/permissions.json` 中改为 `allow` / `deny`。

`activation.mode === "keywords"` 时，只有任务文本命中关键词，该插件的动作才会出现在提示词里
（插件多起来以后控制提示词体积的关键手段）。

`activation: "manual"` 表示**不把该插件的动作注入提示词**。适用两种场景：

1. 能力的用法文档已经写在系统提示词里（例如内置 `screenshot` 插件，
   `prompts/system-prompt.js` 早就详细描述了它，再注入一遍只是撑大提示词）；
2. 作者希望由用户/上层显式提示，而不是每轮都出现。

> 动作本身仍然可用：`manual` 只影响"提示词里是否列出来"，不影响解析与执行。

---

## 三、动作定义（`ctx.actions.register`）

```js
{
    name: "fetch",                    // 动作名；不允许与内置动作同名
    schema: { attrs: {...}, allowExtra: false },
    validate(node) {},                // 可选：复杂校验，抛错即为拒绝
    run(node, ctx) {},                // 必需：可以是 async
    meta: {
        prompt: {                     // 必需
            group: "network",         //   提示词分组
            usage: '<fetch url="..."/>',  // 必需：模型侧用法示例
            note: "说明文字",          //   可选
            priority: 50,             //   预算裁剪时的优先级（大者保留）
        },
        permission: ["network:http"], // 申请的权限，必须是 manifest.permissions 子集
        terminal: null,               // "answer" | "end" | null
        mutating: false,              // 是否改动 workspace / 系统：会写进结果、Trace 与审计日志
        timeoutMs: 30000,             // 动作级超时，超时会 abort ctx.signal
        summary: (result) => "...",   // Trace / 报告用的统一摘要
        promptResult: (result) => {}, // 可选：回给模型的精简视图（见下）
        afterRun: (result, ctx) => {},// 可选：执行后钩子，可返回新的 result
        fastPath: (text) => null,     // 可选：自定义快速解析器（CDATA 复杂写法用）
    },
}
```

**`meta.promptResult`（重要）**：动作返回的结果会被 JSON 序列化进下一轮提示词。
如果结果里可能带大块数据（HTTP 响应体、文件内容），务必提供精简视图，否则会把模型上下文撑爆：

```js
promptResult: (result) => ({
    ...result,
    body: String(result.body || "").substring(0, 4000),
    bodyTruncatedForPrompt: true,
}),
```

完整结果仍保留在 Trace 与执行报告里，只有"回给模型"的那一份被裁剪。

`run` 的返回约定与内置动作完全一致：`{ ok, action, error?, ... }`。registry 会自动补上
`plugin`、`durationMs` 与 `mutating` 三个字段（内置动作同样带 `mutating`，两边口径一致）；
`ok: false` 时 `error` 会走既有的 Runtime 错误提示通道回给模型。

**内置动作名保留**：`read` `write` `edit` `exec` `answer` `done`。插件不得占用（加载期直接拒绝）。

`screenshot` **不在保留名里**——它本身就是插件动作（`plugins/builtin/screenshot`）。
但它同样不能和别人重名：任何两个插件注册同名动作时，后加载的那个会整体加载失败，
报 `REGISTRATION_CONFLICT`（"动作名 X 已被插件 Y 占用"）。

---

## 四、属性 schema 语法

`schema.attrs` 的每个键对应一个 XML 属性：

| 字段          | 说明                                                        |
| ------------- | ----------------------------------------------------------- |
| `type`        | `string`（默认）/ `integer` / `number` / `boolean` / `enum` |
| `required`    | 缺失即报错                                                  |
| `default`     | 缺失时补默认值（补在 `ctx.attrs` 上，`node` 保持不变）      |
| `nonEmpty`    | 字符串不允许为空白                                          |
| `enum`        | 允许值列表（`type: "string"` 时用）                         |
| `values`      | 允许值列表（`type: "enum"` 时用）                           |
| `min` / `max` | 数字范围                                                    |
| `maxLength`   | 字符串长度上限                                              |

**未知属性默认报错**（帮助模型发现拼写错误，错误信息会列出允许的属性）。
确需放行任意属性时设 `schema.allowExtra = true`。

校验结果在 `ctx.attrs` 里是已套用默认值、已完成类型转换的对象。

---

## 五、setup 期的 ctx

```js
{
    plugin:  { name, version, kind, dir, source },   // source: "builtin" | "user"
    config,                                          // 已套用 configSchema 默认值的配置
    logger:  { debug, info, warn, error },           // 自动带 [plugin:<name>] 前缀
    storage: { ... },                                // 见 §6
    secrets: { get(key), getAll() },                 // 受 secrets:read 门控，见 §6
    env:     { agentVersion, storeRoot },
    actions: { register(def) },
    hooks:   { on(event, handler) },
    onDispose(fn),                                   // 注册清理函数，重载/卸载时逆序执行
    eventFormatters: { register(type, fn) },
    providers: { register(name, factory, meta) },    // 接入 createProvider，见 §5.1
    ui: { registerPanel/settings/ComposerAction },   // 声明式 UI，见 §8
    api:  { get/post/put/delete/register },          // 插件自定义接口，见 §8.1
    permissions: { check(scope), policy(scope) },
}
```

setup 期**不提供** `fs` / `http`：能力只在动作执行期、且通过权限校验之后才下发。
`secrets` 同理受权限约束——清单没声明 `secrets:read`（或策略不是 `allow`）时，
`ctx.secrets.get()` 一律返回 `null`、`getAll()` 返回 `{}`，并打一条 warn 说明原因。

### 生命周期与热重载

```js
module.exports = {
    setup(ctx) {
        const timer = setInterval(tick, 5000);
        ctx.onDispose(() => clearInterval(timer)); // 重载 / 卸载时回收
    },
    // 也可以从模块上导出（在 ctx 之外拿不到的资源用这个）
    dispose() {
        /* close sockets ... */
    },
};
```

- `POST /api/plugins/reload` 不只是重读清单：**插件目录下所有模块的 require 缓存都会被清掉**，
  改了被 `require` 的子模块（`lib/helper.js`）也会真正生效；
- 重载前会先执行各插件登记的清理函数（逆序，后申请的先释放）与 `module.exports.dispose`，
  单个清理抛错只告警、不中断重载；**没登记清理的定时器/监听器会每重载一次泄漏一份**；
- 注册冲突（动作名、provider id、格式器重复）导致插件加载失败时，setup 里已申请的资源
  会立即释放，不用等到下次重载。

### 5.1 注册 Provider（`kind: "provider"`）

```js
ctx.providers.register(
    "my-llm", // provider id（小写，不能与内置的 chatgpt / qwen / deepseek / glm / gemini 重名）
    (options) => new MyProvider(options), // 工厂：返回 provider 实例
    {
        label: "My LLM",
        targetUrl: "https://my-llm.example", // 默认访问地址（可被 config 覆盖）
        conversationIdPattern: "/chat/([0-9a-zA-Z-]+)", // 会话 URL → id，字符串或 RegExp
        supportsImages: true,
    }
);
```

**实例契约**（创建时校验，缺方法会直接报错而不是跑到一半才炸）：

- 必需：`start()` / `send(prompt)` / `close()`
- 可选：`uploadImages(paths)` / `getConversationIdFromUrl(url)` / `ensurePageAlive()`
- 可选：`getActionMarkupHint()` —— 返回一段"本平台输出格式约束"，会被拼进首轮提示词。
  只有当平台会破坏 XML 时才需要实现：例如 Gemini 的渲染器会把裸的 `<answer>` 标签
  整块丢弃（DOM 里只剩文本），必须要求模型把动作放进代码块。
- 属性：`currentConversationId`

注册成功后：

- `createProvider("my-llm", options)` 可用（Agent 会自动选中它）；
- 它出现在 `GET /api/providers` 里，前端 provider 下拉框自动出现（不用改前端）；
- 会话 URL 识别用你声明的 `conversationIdPattern`；
- 访问地址解析顺序：`config.browser.targetUrls["my-llm"]` > 你的 `targetUrl`。

**冲突处理**：provider id 与内置（`chatgpt` / `deepseek` / `qwen` / `glm` / `gemini`）或其它插件
重名时，插件直接加载失败（`status:"error"` 并给出具体 id），不会"加载成功但永远选不到"。
`factory` 不是函数、id 不合法的，同样在加载期拒绝。

---

## 六、运行期的 ctx（`run(node, ctx)` 的第二个参数）

| 成员                             | 说明                                                              |
| -------------------------------- | ----------------------------------------------------------------- |
| `ctx.attrs`                      | 已校验并套用默认值的属性表                                        |
| `ctx.workspace`                  | 当前 workspace 绝对路径                                           |
| `ctx.signal`                     | `AbortSignal`，动作超时会被 abort（传给 `ctx.http` 即可自动中断） |
| `ctx.config`                     | 插件配置                                                          |
| `ctx.fs`                         | workspace 作用域文件访问（越界直接抛错）                          |
| `ctx.http`                       | 受控 HTTP 客户端                                                  |
| `ctx.storage`                    | 插件私有存储                                                      |
| `ctx.secrets`                    | 只读密钥（按 `secrets:read` 门控，未授权时为 `null`）             |
| `ctx.logger`                     | 带前缀的日志                                                      |
| `ctx.permissions`                | `{ check(scope), policy(scope), granted }`                        |
| `ctx.events.emit(type, payload)` | 触发插件自己的钩子事件                                            |
| `ctx.redact(text)`               | 用已知密钥值做脱敏                                                |

### ctx.fs

`resolve` `exists` `stat` `list` `readText(target, {maxBytes})` `readJson` `writeText(target, content)` `writeJson(target, value)`
路径**只能是 workspace 内的相对路径**（复用 Runtime 的越界保护，绝对路径/`../` 会被拒绝）。单文件上限 2MB。

### ctx.http

```js
const response = await ctx.http.request({
    url,
    method,
    body,
    headers,
    timeoutMs,
    maxBytes,
    signal,
});
// → { status, statusText, headers, body, bytes, truncated }
```

- 域名白名单来自插件配置 `config.allowHosts`（约定字段，默认空 = 全部拒绝）；
  支持 `"*"`、`"example.com"`、`"example.com:8080"`、`"*.example.com"`；
- 只支持 http/https；**不跟随重定向**（防 SSRF 借道跳转）；
- 响应体有硬上限（默认 1MB，最大 4MB），超出置 `truncated: true`；
- 错误码：`HTTP_INVALID_URL`、`HTTP_HOST_NOT_ALLOWED`、`HTTP_TIMEOUT`、`HTTP_ABORTED`、`HTTP_REQUEST_FAILED`。

### ctx.storage

目录：`~/.xml-agent/plugin-data/<name>/`（不进用户 workspace，也不进插件安装目录）

刻意与插件安装目录 `~/.xml-agent/plugins/<name>/` 分开：那边是"待加载插件"的扫描根，
数据目录放在里面会被当成一个缺少 `plugin.json` 的插件，每次启动都报一条假故障。
旧版本写在 `plugins/<name>/data/`，启动时会自动搬到新位置（同名文件改名为 `*.migrated` 保留）。

`readJson(name, fallback)` `writeJson(name, value)`（原子写）`appendLine(name, text)` `readText(name)`

清理/枚举用 `list()` `remove(name)`：

- `list()` 返回私有目录里的文件名数组（已排序，不含子目录与隐藏文件）；
- `remove(name)` 删除一个文件，删掉返回 `true`，本来就不在返回 `false`；
  其他失败（占用、权限）会抛错——**清理逻辑请显式处理**，不要吞掉，
  否则"自动清理"会变成一句空话（`audit-log` 的 `keepDays` 曾经就是这样）；
- `list()` + `remove()` 只在私有目录内生效，插件仍然拿不到宿主的绝对路径。

### ctx.secrets

从 `~/.xml-agent/secrets.json` 读取，日志与 Trace 中请用 `ctx.redact(text)` 脱敏。

**门控规则**（两处都生效，口径一致）：

| 时机     | 拿到值的条件                                                     |
| -------- | ---------------------------------------------------------------- |
| setup 期 | 清单 `permissions` 含 `secrets:read` **且** 策略是 `allow`       |
| 动作执行 | 该动作的 `meta.permission` 含 `secrets:read`（此时策略已校验过） |

未授权时读到的是 `null` / `{}`，同时 `ctx.secrets.denied === true`，可据此降级而不是瞎猜。
内置插件默认 `allow`；用户插件默认 `ask`（= 未授权），需要在 Plugins 面板里授权或调用
`POST /api/permissions/grant`。

密钥本身可以直接在 Plugins 面板的 `secrets` 区块增删改（`GET/PUT/DELETE /api/plugins/secrets`）：
接口**只回键名与长度、不回值**，避免前端一次 XSS 就等于交出全部凭据。

---

## 七、configSchema 与配置

```json
"configSchema": {
    "allowHosts": { "type": "array", "default": ["127.0.0.1"], "description": "..." },
    "httpTimeoutMs": { "type": "integer", "default": 30000, "min": 1000, "max": 60000 }
}
```

支持类型：`string` / `integer` / `number` / `boolean` / `array`（元素按字符串处理）。
数值类型可用 `min` / `max` 声明范围，越界会被拒绝（`CONFIG_INVALID`），
而不是把一个负的保留天数写进配置文件。
配置存 `~/.xml-agent/plugins-config.json`，写入时按 schema 校验、未知字段丢弃。

API：`GET/POST /api/plugins/:name/config`（body：`{ "config": {...} }`）。

---

## 八、钩子与事件格式器

### 钩子

```js
ctx.hooks.on("runtime.result", (event) => {
    /* 只观察，不要阻塞 */
});
```

handler 抛错或返回 rejected Promise 都只记一条 warn，不影响主流程。

可用事件名（Agent 侧）：

| 事件                                                                           | 时机                         |
| ------------------------------------------------------------------------------ | ---------------------------- |
| `agent.started` / `agent.completed` / `agent.stopped` / `agent.error`          | 生命周期                     |
| `step.started`                                                                 | 每一步开始                   |
| `provider.request` / `provider.response` / `provider.retry` / `provider.error` | 模型调用                     |
| `action.parsed` / `action.parse_error`                                         | XML 解析                     |
| `runtime.result`                                                               | 每个动作执行完（含插件动作） |
| `answer`                                                                       | 模型给出最终答案             |
| `action.denied`                                                                | 插件动作因权限被拒           |
| `plugins.loaded`                                                               | 插件加载完成                 |
| `session.finished`                                                             | WebUI 会话一次运行结束       |

### 事件格式器（可选）

```js
ctx.eventFormatters.register("plugin.echo.tick", (event) => "TICK " + event.n);
```

注册后，`AgentSession` 的控制台输出会优先用你的格式器；没有格式器的事件
会走"类型 + JSON 摘要"的兜底，因此**不会出现空白**（1.0.x 的行为是静默丢弃）。

### 声明式 UI（v1.1.0 已可用）

面板由插件以**纯 JSON** 声明，宿主前端（`Plugins` 面板里的 `Plugin panels` 区块）
按 `blocks` 渲染。**插件不向浏览器下发任何可执行代码**——这是刻意的安全边界。

```js
ctx.ui.registerPanel({
    id: "audit-log",
    title: "Audit Log",
    description: "可选说明",
    blocks: [
        { kind: "note", text: "一段说明文字" },
        {
            kind: "status",
            title: "Overview",
            path: "/summary", // 相对本插件接口命名空间
            items: [
                { label: "Entries", value: "total" }, // 取值可用点号路径
                { label: "Last", value: "recent.0.ts" },
            ],
        },
        {
            kind: "table",
            title: "Recent entries",
            path: "/summary",
            rows: "recent", // 从响应里取哪个数组
            columns: [
                { key: "ts", label: "Time" },
                { key: "event", label: "Event" },
            ],
            empty: "没有数据时显示这句",
        },
        {
            kind: "action",
            label: "Run",
            path: "/do-something",
            method: "POST", // 默认 POST
            body: { any: "json" }, // 可选请求体
            description: "按钮旁的说明",
        },
    ],
});
```

规则与边界：

- `path` 一律相对 `/api/plugins/<name>/api`，由宿主拼接；插件无法指向别人的接口；
- 非法 block（未知 `kind`、缺 `path`、`status` 没有 `items` 等）**只跳过该面板并记录原因**，
  不会让插件整体失效（`GET /api/plugins` 的 `uiErrors` 里能看到）；
- 宿主只渲染文本/表格/按钮，不执行插件字符串、不注入 HTML；
- `action` 执行完会自动刷新同面板里的 `status` / `table` 数据块。

### 8.1 插件自定义接口（`ctx.api`）

面板要显示数据，就需要接口。插件只能在自己的命名空间下注册：

```js
ctx.api.get("/summary", (request) => ({ total: 42 }));
ctx.api.post("/do", (request) => ({ ok: true, got: request.body }));
```

- 最终路径：`GET /api/plugins/<name>/api/summary`；
- 方法：`GET` / `POST` / `PUT` / `DELETE`（`register(method, path, handler)` 或快捷方法）；
- handler 收到 `{ plugin, method, path, query, body, config, storage, logger, signal, secrets }`；
- 返回值会被 JSON 化；抛错返回 `500 { error }`；未注册的 method+path 返回 404；
- **单次执行上限 15s**（`plugins.apiTimeoutMs` / `XML_AGENT_PLUGIN_API_TIMEOUT_MS`）：超时返回
  `504 { code:"PLUGIN_API_TIMEOUT" }` 并 abort `ctx.signal`。handler 里做的自定义 I/O
  应当监听 `ctx.signal`，否则连接会一直挂着（前端面板会永远转圈）；
- 路径校验：必须以 `/` 开头、不含 `..`、只允许字母数字与 `_-./`；重复注册会导致插件加载失败。

内置示例见 `plugins/builtin/audit-log/index.js`（hook + api + 面板三合一）。

---

## 九、错误与隔离

| 情况                                                     | 表现                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| `plugin.json` 缺失 / 非法 / apiVersion 或 engines 不匹配 | 该插件 `status:"error"`，`GET /api/plugins` 可见原因，其它插件照常 |
| `setup()` 抛错                                           | 同上，且**半注册状态会被整体丢弃**（先 staging 后提交）            |
| 动作名与内置或其它插件冲突                               | 该插件 `status:"error"`                                            |
| provider id 与内置或其它插件冲突                         | 该插件 `status:"error"`（否则会被 provider 注册表静默丢弃）        |
| 动作申请的 scope 未在清单声明                            | 加载期拒绝                                                         |
| `run()` 抛错 / 返回非对象                                | 变成 `{ ok:false, error }` 回给模型，会话继续                      |
| `run()` 超时                                             | `{ ok:false, timedOut:true }`，同时 abort `ctx.signal`             |
| 插件接口超时                                             | `504 { code:"PLUGIN_API_TIMEOUT" }`，同时 abort `ctx.signal`       |
| 钩子抛错                                                 | 记 warn，主流程继续                                                |

清单读不出来的插件（缺 `plugin.json`、JSON 坏了）不会被"藏起来"：注册表会用目录名建一条
`status:"error"` 的占位记录，`GET /api/plugins` 能查到它、错误原因就在 `error` 字段里，
修好文件按 Reload 即可恢复。`GET /api/plugins` 的 `errors` 数组仍保留原始加载错误清单。

状态文件（`plugins-state.json` / `plugins-config.json` / `permissions.json` / `secrets.json`）
按 `mtime + size` 缓存：动作执行路径上不再反复读盘解析，手工编辑这些 JSON 也会立刻生效。

---

## 十、调试与自检

```js
// 在你的插件仓库里跑一下契约自检
const sdk = require("xml-agent/plugins/sdk");
sdk.assertPluginConformance(require("./index.js")); // 抛错即不符合契约
```

- `XML_AGENT_PLUGINS=0`：一键回到"仅内置动作"，用于确认问题是否由插件引起；
- `GET /api/plugins`：查看每个插件的 `status` / `error` / `actions` / `effectivePermissions` / `config`；
- `POST /api/plugins/reload`：改完插件代码后热重载（会重新执行 `index.js`，子模块可能仍在 require 缓存里）；
- `node test/test-plugins.js`：仓库自带的端到端用例，可作为写插件时的参考实现。

---

## 十一、安全声明（务必阅读）

**插件是与宿主同权限的 Node.js 代码**。宿主提供了权限声明、作用域门面（不给 raw `fs` /
`child_process`，`http` 受白名单约束）与审计，但这**不是沙箱**：

- 只安装你信任的插件；
- 从网络下载的插件目录在被 `require` 的瞬间就拥有完整进程权限；
- 计划中的跨进程隔离尚未实现（`run` 已是 async + `AbortSignal`，为将来的隔离预留了形状）。

内置插件是最好的参考实现：

| 插件                         | 演示了什么                                                                                                                                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugins/builtin/fetch`      | action + schema 校验 + `ctx.http` + `meta.promptResult`（回给模型的精简视图）                                                                                                                                                    |
| `plugins/builtin/screenshot` | action + 自定义 `validate` + `meta.fastPath` + `meta.collectImages`（产物自动上传给模型）+ `engine/` 私有实现；**它本来是内置动作，v1.1.0 迁成插件，之后又把引擎从核心 `capture/` 下沉进来**，可作为"把已有能力插件化"的完整模板 |
| `plugins/builtin/audit-log`  | hook + `ctx.api` + 声明式面板（三合一）                                                                                                                                                                                          |
