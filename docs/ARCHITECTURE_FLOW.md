
# XML Agent 架构流转图

本文档通过 Mermaid 流程图展示 XML Agent 各模块之间的交互与数据流转。

## 1. 整体执行流程 (Agent Core Loop)

```mermaid
graph TD
    User[用户任务] --> Agent[Agent Core]
    Agent -->|1. 初始化 Workspace & Runtime| Runtime[Runtime Engine]
    Agent -->|2. 加载 Provider| Provider[LLM Provider]
    Agent -->|3. 构建 Prompt| Prompts[Prompt Builder]
    Prompts -->|注入 System Prompt + Manifest| Agent
    
    subgraph Execution_Loop [执行循环]
        Agent -->|4. 发送 Prompt| Provider
        Provider -->|5. LLM 思考并返回 XML| Parser[XML Parser]
        Parser -->|6. 解析 Action| Agent
        Agent -->|7. 调用 Runtime.run| Runtime
        Runtime -->|8. 执行动作| Actions[Action Definitions]
        Runtime -->|9. 检查插件注册表| Plugins[Plugin Registry]
        Plugins -->|10. 执行插件动作| PluginActions[Plugin Actions]
        
        Actions -->|11. 返回结果| Runtime
        PluginActions -->|11. 返回结果| Runtime
        Runtime -->|12. 记录 History| History[Session History]
        Runtime -->|13. 触发 Hooks| Hooks[Plugin Hooks]
        
        Runtime -->|14. 结果回传| Agent
        Agent -->|15. 判断是否终止| Decision{Terminal?}
        Decision -->|No: 继续| Prompts
        Decision -->|Yes: Answer/Done| End[任务结束]
    end
    
    End --> Report[生成报告]
```

## 2. 动作分发细节 (Runtime Dispatch)

```mermaid
graph LR
    A[Runtime.run] --> B{动作名是否存在?}
    B -->|是: 内置动作| C[actions/index.js]
    B -->|否: 查询插件| D[plugins/registry.js]
    
    C --> E[获取动作定义 Definition]
    D -->|存在| F[获取插件动作定义]
    D -->|不存在| G[抛出 Unknown Action 错误]
    
    E --> H[权限校验 & 超时控制]
    F --> H
    
    H --> I[执行 run node, ctx]
    I --> J[返回结构化结果 ok, action, error]
    J --> K[触发 afterRun 钩子]
    K --> L[记录审计日志 Audit Log]
```

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

| 模块 | 职责 | 关键文件 |
| :--- | :--- | :--- |
| **Agent Core** | 任务编排、Prompt 构建、循环控制 | `agent-core.js` |
| **Agent Step** | 单轮闭环：发送 → 解析 → 执行 → 决定下一步 | `agent/step.js`, `agent/artifacts.js` |
| **Runtime** | 安全沙箱、动作分发、路径校验 | `runtime.js`, `actions/` |
| **Plugins** | 能力扩展、权限管理、审计日志 | `plugins/registry.js`（门面）, `plugins/registry/*.js`（加载/存储/执行/配置）, `plugins/sdk.js` |
| **Provider** | 模型适配、CDP 连接、会话管理 | `providers/registry.js`, `providers/browser-chat.js`, `providers/browser-agent.js` |
| **Capture** | 截图：平台分派、窗口枚举、子进程 | `capture/take-screenshot.js`, `capture/screenshot.js`, `capture/windows.js`, `capture/proc.js` |
| **Parser** | XML 语法解析、动作校验 | `parse/xml-parse.js` |
| **WebUI** | 用户界面、会话管理、实时反馈 | `webui/server.js`, `webui/frontend/` |

## 6. 大模块的拆分现状

超过 600 行的模块已按职责拆开，入口文件保持原有的导出面，调用方无需改动。

| 原模块 | 拆分后 | 说明 |
| :--- | :--- | :--- |
| `plugins/registry.js`（1311 行） | `registry.js`（门面 + 单例）+ `registry/{storage,loader,context,catalog,present,api,settings,invoke}.js` | 各 mixin 挂回 `PluginRegistry.prototype`，`this` 语义不变 |
| `capture/screenshot.js`（589 行） | `screenshot.js`（平台分派）+ `windows.js`（窗口枚举 / PowerShell）+ `proc.js`（子进程） | 平台差异隔离，工具函数从原文件继续 re-export |
| `agent-core.js`（491 行） | `agent-core.js`（循环与收尾）+ `agent/step.js`（单轮闭环）+ `agent/inputs.js`（入参归一化） | `run()` 只保留循环骨架 |

## 7. 数据流向总结

1. **输入**: 用户任务文本 + 可选图片 -> `Agent`
2. **思考**: `Agent` -> `Provider` (LLM) -> `XML Action`
3. **执行**: `XML Action` -> `Parser` -> `Runtime` -> `Actions/Plugins` -> `Workspace/OS`
4. **反馈**: `Result` -> `History` -> `Prompt Builder` -> `Provider` (下一轮)
5. **输出**: `Answer` -> `User` / `Report`

---
*注：本流程图基于 v1.1.0 版本架构绘制，反映了插件化重构后的模块关系。*
