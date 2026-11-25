# XML Agent 快速上手指南

本文档旨在帮助新人快速理解项目架构、核心概念及开发流程。

## 1. 项目简介

XML Agent 是一个基于 Node.js 实现的工程型 AI Agent Framework。
**核心理念**：

- **LLM 负责思考**：理解任务、规划步骤。
- **Runtime 负责执行**：安全地操作文件系统、执行命令。
- **JSON Action 负责通信**：Agent 与 Runtime 之间通过 `{action, params}` envelope 交互。
- **Workspace 负责目标环境**：文件类动作限制在指定工作目录内；`exec` 以该目录为起始目录，但不是安全沙箱。

当前版本：**1.3.0**（项目名 XML Agent 保留为历史名称）。

## 2. 核心架构

```mermaid
graph TD
    A[User Task] --> B(Agent Core)
    B -->|Prompt| C{LLM Provider}
    C -->|JSON Action| D(extractAction + JSON Schema)
    D -->|Action| E(Runtime)
    E -->|Read/Write/Edit| F[Workspace]
    E -->|Exec| G[Command Line]
    E -->|Result| B
    B -->|Answer/Done| H[Final Output]
```

### 关键模块

- **Agent (`agent.js`, `agent-core.js`, `agent/step.js`)**: 编排者，负责加载 Provider、构建 Prompt、提取并校验 LLM 返回的 JSON Action、调用 Runtime。
- **Runtime (`runtime.js`)**: 执行者，负责 Workspace 路径校验、动作分发、超时与子进程生命周期。
- **Provider (`providers/`)**: 模型后端适配器，支持 ChatGPT, Qwen, DeepSeek, GLM, Gemini 等。
- **Plugins (`plugins/`)**: 扩展系统，支持新增 JSON 动作、Hook、Provider 和 UI 面板。
- **WebUI (`webui/`)**: 基于 Vue3 的前端界面和 Express 后端服务。
- **Electron (`electron/`)**: 桌面应用封装。

## 3. 快速开始

### 3.1 环境要求

- Node.js >= 20.19
- Windows 10/11 (x64)
- Google Chrome 或 Microsoft Edge (用于 CDP 自动化)

### 3.2 安装与运行

```bash
git clone https://github.com/wulishuhan/xml_agent.git
cd xml_agent
npm install

# 启动 WebUI (推荐)
npm run webui
# 访问 http://localhost:3000/xml_agent_web/

# 命令行模式
node agent.js --workspace "D:\code\my-project" "创建一个简单的 Node.js Hello World 项目"
```

### 3.3 浏览器配置

Agent 通过 CDP (Chrome DevTools Protocol) 控制浏览器。

- **默认**: Edge (端口 9223)
- **切换**: 在 WebUI 右上角 Settings -> Browser Settings 中可切换为 Chrome (端口 9222)。
- **手动启动**:
    ```powershell
    & "C:\Program Files\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9223 --user-data-dir="$PWD\edge-profile"
    ```

## 4. JSON Action 协议

LLM 每轮只输出一个 JSON envelope，例如：

```json
{ "action": "read", "params": { "path": "." } }
```

可以输出裸 JSON 或单个 `json` 代码块，不要混入说明、XML 或多个动作。顶层 `action` 是字符串，`params` 是对象；内置动作与插件动作都使用这一结构。

文件读取支持 `offset` 与 `limit`（1–4000 字符）。返回 `truncated=true` 时，把 `nextOffset` 作为下一次 read 的 `offset`，直到 `truncated=false`，避免技能文档等长文件只读到开头。

`parse/json-action.js` 的 `extractAction()` 负责提取与分发前的校验，`parse/action-schema.js` 用 JSON Schema 校验 envelope 和内置动作参数；插件参数由 `plugins/registry/catalog.js` 校验。旧 XML parser、CDATA、`attrs` 与 `fastPath` 已移除。

### 内置动作

| 动作     | 描述                    | 示例                                                                                   |
| :------- | :---------------------- | :------------------------------------------------------------------------------------- |
| `read`   | 读取文件或目录          | `{"action":"read","params":{"path":"package.json"}}`                                   |
| `write`  | 写入文件 (自动创建目录) | `{"action":"write","params":{"path":"src/app.js","content":"console.log(\"hi\");\n"}}` |
| `edit`   | 局部修改已存在文件      | `{"action":"edit","params":{"path":"src/app.js","changes":[{"old":"a","new":"b"}]}}`   |
| `exec`   | 执行命令                | `{"action":"exec","params":{"command":"npm install"}}`                                 |
| `answer` | 返回最终答案            | `{"action":"answer","params":{"content":"任务完成"}}`                                  |
| `done`   | 结束任务                | `{"action":"done","params":{}}`                                                        |

`screenshot` 不是内置动作，而是内置插件动作：

```json
{ "action": "screenshot", "params": { "targets": [{ "source": "screen", "path": "shot.png" }] } }
```

### 插件动作

插件可以新增自定义 JSON 动作。例如内置的 `fetch` 动作：

```json
{ "action": "fetch", "params": { "url": "http://127.0.0.1:3000/api", "method": "GET" } }
```

## 5. 插件系统

插件允许在不修改核心代码的情况下扩展 Agent 能力。

### 插件类型

1. **Action**: 新增 JSON 动作 (如 `fetch`)。
2. **Hook**: 监听生命周期事件 (如 `audit-log` 记录审计日志)。
3. **Provider**: 新增模型后端支持。
4. **UI**: 声明式前端面板。

### 开发一个简单的 Action 插件

1. 创建目录 `~/.xml-agent/plugins/echo/`
2. `plugin.json`:
    ```json
    {
        "name": "echo",
        "version": "1.0.0",
        "kind": "action",
        "apiVersion": 1,
        "permissions": []
    }
    ```
3. `index.js`:
    ```js
    module.exports = {
        setup(ctx) {
            ctx.actions.register({
                name: "echo",
                schema: {
                    type: "object",
                    additionalProperties: false,
                    required: ["text"],
                    properties: {
                        text: { type: "string", minLength: 1, pattern: "\\S" },
                    },
                },
                run(params, ctx) {
                    return { ok: true, action: "echo", text: ctx.params.text };
                },
                meta: {
                    prompt: {
                        group: "plugin",
                        usage: '{"action":"echo","params":{"text":"hello"}}',
                    },
                },
            });
        },
    };
    ```
4. 重启服务或调用 `POST /api/plugins/reload`。

详细 API 参见 [PLUGIN_API.md](./PLUGIN_API.md) 和 [PLUGIN_DESIGN.md](./PLUGIN_DESIGN.md)。

## 6. 项目结构概览

xml_agent/
├── actions/ # 内置动作定义 (read/write/edit/exec/answer/done)
├── plugins/ # 插件系统内核及内置插件
├── providers/ # 模型后端适配器
├── config/ # 配置管理 (schema.js 为单一来源)
├── parse/ # JSON Action 提取与 JSON Schema 参数校验
├── prompts/ # 系统提示词构建
├── webui/ # Web 界面与服务端
│ ├── frontend/ # Vue3 前端
│ ├── routes/ # API 路由
│ └── server.js # Express 入口
├── electron/ # 桌面应用主进程
├── docs/ # 详细设计文档
└── test/ # 测试用例

## 7. 常用命令

```bash
# 代码格式化
npm run format

# 运行测试
npm run test:core       # 核心功能测试
npm run test:plugins    # 插件系统测试
npm run test:offline    # 离线测试套件

# Electron 开发
npm run electron:dev

# 构建安装包
npm run electron:build
```

## 8. 学习路径建议

1. **阅读 `readme.md`**: 了解整体功能和使用方法。
2. **阅读 `docs/PLUGIN_DESIGN.md`**: 深入理解架构设计、重构背景和插件系统原理。
3. **阅读 `docs/PLUGIN_API.md`**: 掌握插件开发的具体 API。
4. **查看 `plugins/builtin/`**: 参考内置插件 (`fetch`, `audit-log`, `screenshot`) 的实现。
5. **尝试编写一个插件**: 从最简单的 `echo` 插件开始。

## 9. 注意事项

- **安全边界**: Runtime 校验文件类动作的 Workspace 路径；`exec` 只把 Workspace 当作起始目录，shell 不受工作区沙箱限制。
- **JSON 字符串**: `write.content`、`answer.content` 等正文必须按 JSON 规则转义双引号、反斜杠和换行。
- **插件信任**: 插件拥有 Node.js 完整权限，请仅安装可信插件。
- **浏览器依赖**: 确保 Chrome/Edge 已安装且 CDP 端口未被占用。

---

_最后更新: 2026-11（XML→JSON Action 完整迁移）_
