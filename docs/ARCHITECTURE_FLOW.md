# XML Agent 架构流转图

本文档通过 Mermaid 流程图展示 XML Agent 各模块之间的交互与数据流转。项目名 XML Agent 保留为历史名称，当前 Action 协议为 JSON。

## 1. 整体执行流程 (Agent Core Loop)

```mermaid
graph TD
    User[用户任务] --> Agent[Agent Core]
    Agent -->|1. 初始化 Workspace & Runtime| Runtime[Runtime Engine]
    Agent -->|2. 加载 Provider| Provider[LLM Provider]
    Agent -->|3. 构建 Prompt| Prompts[Prompt Builder]
    Prompts -->|注入 System Prompt + 项目名/任务/能力约束| Agent

    subgraph Execution_Loop [执行循环]
        Agent -->|4. 发送 Prompt| Provider
        Provider -->|5. LLM 返回一个 JSON envelope| Parser[extractAction + JSON Schema]
        Parser -->|6. 解析并校验 Action| Agent
        Agent -->|7. 调用 Runtime.run| Runtime
        Runtime -->|8. 内置动作优先| Dispatch{内置动作?}
        Dispatch -->|是| Actions[actions/index.js]
        Dispatch -->|否| Plugins[Plugin Registry]
        Plugins -->|9. catalog 校验 / invoke 执行| PluginActions[Plugin Actions]

        Actions -->|10. 返回结果| Runtime
        PluginActions -->|10. 返回结果| Runtime
        Runtime -->|11. 记录 History| History[Session History]
        Runtime -->|12. 触发 Hooks| Hooks[Plugin Hooks]

        Runtime -->|13. 结果回传| Agent
        Agent -->|14. 判断是否终止| Decision{Terminal?}
        Decision -->|No: 继续| Prompts
        Decision -->|Yes: Answer/Done| End[任务结束]
    end

    End --> Report[生成报告]
```

## 2. 动作分发细节 (Runtime Dispatch)

```mermaid
graph LR
    A[Runtime.run action, params] --> B{内置动作?}
    B -->|是| C[actions/index.js 获取 Definition]
    B -->|否| D[registry.hasAction / invokeAction]
    D -->|不存在| E[抛出 Unknown action 错误]
    D -->|存在| F[catalog 动作目录 / invoke 执行器]
    C --> G[超时控制]
    F --> H[权限校验 / JSON Schema / validate / 超时]
    G --> I[执行 run params, ctx]
    H --> I
    I --> J[返回结构化结果 ok, action, error]
    J --> K[插件 afterRun / collectImages]
    K --> L[History / Trace / Audit]
```

解析期还有一层校验：`parse/json-action.js` 先校验 envelope，内置参数走 `actions/index.js` 与 `parse/action-schema.js`，插件参数走 `plugins/registry/catalog.js`。执行期插件还会在 `invoke.js` 再校验一次。

## 3. 插件系统加载流程 (Plugin Lifecycle)

```mermaid
graph TD
    Start[服务启动] --> Scan[扫描插件目录]
    Scan -->|plugins/builtin/*| Builtin[内置插件]
    Scan -->|~/.xml-agent/plugins/*| User[用户插件]

    Builtin --> Validate[校验 plugin.json]
    User --> Validate

    Validate -->|失败| Error[标记 status: error]
    Validate -->|成功| Load[require index.js]

    Load --> Setup[执行 setup ctx]
    Setup --> Register[注册 Actions / Hooks / Providers / UI]
    Register --> Check[冲突检测 & 权限校验]
    Check -->|通过| Ready[插件就绪]
    Check -->|失败| Error
```

## 4. WebUI 与后端交互 (WebUI Architecture)

```mermaid
graph TB
    Browser[浏览器前端 Vue3] -->|HTTP API| Server[Express Server webui/server.js]

    Server -->|路由分发| Routes[Routes Modules]
    Routes -->|Sessions| SessionMgr[Session Manager]
    Routes -->|Plugins| PluginAPI[Plugin API]
    Routes -->|Browser| BrowserSettings[Browser Settings]

    SessionMgr -->|SSE Stream| Browser
    SessionMgr -->|启动 Agent| AgentCore[agent-core.js]

    AgentCore -->|事件| EventBus[Event Emitter]
    EventBus -->|格式化| Trace[Agent Trace UI]
    EventBus -->|存储| Store[Session Store ~/.xml-agent]
```

## 5. 关键模块职责说明

| 模块            | 职责                                       | 关键文件                                                                                               |
| :-------------- | :----------------------------------------- | :----------------------------------------------------------------------------------------------------- |
| **Agent Core**  | 任务编排、Prompt 构建、循环控制            | `agent-core.js`                                                                                        |
| **Agent Step**  | 单轮闭环：发送 → 解析 → 执行 → 决定下一步  | `agent/step.js`, `agent/artifacts.js`                                                                  |
| **Runtime**     | 文件路径校验、动作分发、子进程登记与结束   | `runtime.js`, `actions/`, `processes/registry.js`                                                      |
| **Plugins**     | 能力扩展、权限管理、审计日志               | `plugins/registry.js`（门面）, `plugins/registry/{loader,catalog,invoke,context}.js`, `plugins/sdk.js` |
| **Provider**    | 模型适配、CDP 连接、会话管理               | `providers/registry.js`, `providers/browser-chat.js`, `providers/browser-agent.js`                     |
| **JSON Action** | envelope 提取、内置/插件参数校验、动作路由 | `parse/json-candidate.js`, `parse/json-action.js`, `parse/action-schema.js`, `actions/index.js`        |
| **WebUI**       | 用户界面、会话管理、实时反馈               | `webui/server.js`, `webui/frontend/`                                                                   |

> **截图不在核心**。它是 `plugins/builtin/screenshot` 这一个插件的能力，
> 引擎（平台分派 / 窗口枚举 / 子进程）随插件放在 `plugins/builtin/screenshot/engine/`。
> 核心目录不包含任何截图实现，也没有截图 HTTP 接口——删除整个插件目录即可彻底移除该能力，
> 此时 `{"action":"screenshot","params":{"targets":[{"source":"screen"}]}}` 会因动作未注册而报 `Unknown action: screenshot`。

> **平台的输出破坏由 Provider 自己声明**。少数平台会破坏裸 JSON 或代码块，这类 provider
> 实现 `getActionMarkupHint()` 返回输出约束，由 `prompts/first-prompt.js` 拼进首轮提示词。
> 当前约束统一为：每轮一个 JSON envelope，可裸 JSON 或单个 `json` 代码块，不输出 XML 或多个动作。

> **子进程归 Runtime 管**。`exec`（含 `--background`）启动的子进程统一登记到
> `processes/registry.js`，用户点「停止」时 `Agent.stop()` 先调
> `runtime.killAllProcesses()` 把整棵进程树结束（Windows `taskkill /T /F`，
> POSIX 进程组 `SIGTERM` → 2s 后 `SIGKILL`），再关浏览器。
> 这一步不能省：不登记句柄的话，`--background` 的 detached 进程会脱离父进程成为孤儿，
> 一直占着端口，下次启动就报 `EADDRINUSE`；而前台长命令会拖到
> `maxExecTimeout`（默认 5 分钟）才返回，停止按钮看起来完全没反应。
>
> **退出路径另有一道兜底**。`Agent.stop()` 只覆盖「用户点停止」，而崩溃、
> `process.exit()`、未捕获异常走的是另一条路径，那条路上没人调用 stop()。
> 因此 `track()` 在第一次登记时自动装 `process.once("exit")`（`installExitGuard`），
> 退出时对所有登记表执行 `cleanupAllSync()`——用 `spawnSync` 跑 `taskkill`，
> 因为 `exit` 阶段事件循环已停，异步回调不会再执行。
> 兜底只结束「子进程句柄仍报告存活」的条目，不按历史 pid 猜，
> 避免 pid 被系统复用后误杀无关进程。
>
> **信号路径要单独接**：实测 SIGTERM / SIGINT 的默认处理是直接终止进程，
> **不会**触发 `exit` 事件，所以 `agent.js`、`webui/server.js`（SIGINT / SIGTERM / SIGHUP）、
> `electron/main.js`（`before-quit` → `shutdown()`）各自在关闭流程里显式调
> `cleanupAllSync()`。Windows 上外部 `kill` 走 `TerminateProcess`、信号不会投递给 JS，
> 那种情况（含任务管理器强杀、断电）无法覆盖，属已知边界。

## 6. 大模块的拆分现状

超过 600 行的模块已按职责拆开，入口文件保持原有的导出面，调用方无需改动。

| 原模块                            | 拆分后                                                                                                                            | 说明                                                              |
| :-------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------- |
| `plugins/registry.js`（1311 行）  | `registry.js`（门面 + 单例）+ `registry/{storage,loader,context,catalog,present,api,settings,invoke}.js`                          | 各 mixin 挂回 `PluginRegistry.prototype`，`this` 语义不变         |
| `capture/screenshot.js`（589 行） | `plugins/builtin/screenshot/engine/` 下的 `screenshot.js`（平台分派）+ `windows.js`（窗口枚举 / PowerShell）+ `proc.js`（子进程） | 平台差异隔离；整个 `engine/` 只服务 screenshot 插件，因此随插件走 |
| `agent-core.js`（491 行）         | `agent-core.js`（循环与收尾）+ `agent/step.js`（单轮闭环）+ `agent/inputs.js`（入参归一化）                                       | `run()` 只保留循环骨架                                            |

## 7. 数据流向总结

1. **输入**: 用户任务文本 + 可选图片 -> `Agent`
2. **思考**: `Agent` -> `Provider` (LLM) -> 一个 JSON envelope
3. **解析**: `extractAction()` -> envelope / JSON Schema 校验 -> `{ action, params }`
4. **执行**: `Runtime` -> `Actions/Plugins` -> `Workspace/OS`
5. **反馈**: `Result` -> `History` -> `Prompt Builder` -> `Provider` (下一轮)
6. **输出**: `answer` -> 下一轮 `done` -> `User` / `Report`

---

_注：本流程图基于当前 1.3.0 代码线绘制，已反映 XML→JSON Action 完整迁移。_
