# XML Agent

一个基于 Node.js 实现的工程型 AI Agent Framework。

当前版本：**1.0.2**

核心设计理念：

> LLM 负责理解任务和规划，Runtime 负责安全执行，XML Action 作为 Agent 与 Workspace 之间的通信协议。

---

# 快速开始

## 环境要求

- Node.js >= 20.19
- Windows 10 / 11 (x64) - 桌面版/打包版
- Google Chrome (Agent 通过 CDP 复用浏览器，不自带内核)

## 安装

```bash
git clone https://github.com/wulishuhan/xml_agent.git
cd xml_agent
npm install
```

## 使用 WebUI

### 配置 Chrome 路径

编辑 `config/agent-config.js`：

```javascript
browser: {
  // Chrome.exe Path
  chromePath: "C:/Users/hunte/AppData/Local/Google/Chrome/Application/chrome.exe",
}
```

### 启动服务

生产模式：

```bash
npm run webui
```

访问：http://localhost:3000/xml_agent_web/

开发模式：

```bash
npm run webui:dev
```

访问：http://localhost:5173

## 命令行调用

参数说明：

- `--provider`: 可选，默认 chatgpt，支持 chatgpt / qwen / deepseek
- `--workspace`: 必填，工作目录（必须存在）

示例：

```bash
node agent.js --workspace "D:\code\vue\ppl" "创建一个vue项目，是关于泡泡龙的游戏"

node agent.js --provider qwen --workspace "D:\code\vue\ppl" "创建一个vue项目，是关于泡泡龙的游戏"
```

## 手动启动 Chrome CDP

XML Agent 通过 Chrome DevTools Protocol 连接已运行的 Chrome。

Windows PowerShell 示例：

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$PWD\chrome-agent-profile"
```

如果路径不同，请右键 Chrome 快捷方式 → 属性 → 打开文件所在位置获取真实路径。

启动后在该 Chrome 中登录以下任一平台：

- https://chatgpt.com
- https://chat.qwen.ai

**注意：** 登录后不要关闭该浏览器窗口，Agent 默认连接 http://127.0.0.1:9222

## 桌面应用（Electron）

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

---

# 项目架构

整体流程：

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
| |
v v
Workspace Command
(read/write) (exec)
|
v
Runtime Result
|
v
Agent Continue
|
+---- answer
|
+---- done

---

# 核心模块

## Agent

入口：`agent.js`

职责：

- 接收用户任务
- 初始化 Workspace
- 加载 Provider
- 调用 LLM
- 解析 XML Action
- 调用 Runtime
- 管理 Agent 生命周期

## Runtime

文件：`runtime.js`

Runtime 是系统的执行核心，LLM 不直接操作电脑，所有操作必须通过 XML Action。

支持的 Action：

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

执行命令（工作目录固定为 Workspace，有超时限制）：

```xml
<exec command="npm test"/>
```

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

目录：`providers/`

统一接口：

```javascript
const provider = createProvider("chatgpt");
```

当前支持：ChatGPT、DeepSeek、Qwen、GLM。

BrowserAgent 内置页面自愈机制（ensurePageAlive），Chrome 崩溃或标签页关闭时会自动重连恢复会话。

## Prompt 系统

目录：`prompts/`

包含：

- `system-prompt.js`：定义 Agent 基础能力与规则
- `first-prompt.js`：首次调用时注入 Workspace、Manifest、用户任务
- `runtime-prompt.js`：根据 Runtime 返回生成下一轮 Prompt
- `xml-error-prompt.js` / `send-error-prompt.js` / `done-prompt.js`：异常与终止处理

## Workspace

Agent 操作的目标目录，所有路径必须是相对路径，禁止绝对路径或 `../` 越权访问。

## History & Report

- 会话数据保存在 `~/.xml-agent/webui-sessions/`
- 工作区产物迁移至 `~/.xml-agent/workspaces/<hash>/`，不再污染代码仓库
- 任务完成后自动生成执行报告

---

# 会话与存储管理（v1.0.2）

配置项位于 `config/agent-config.js` 的 `session` 块：

| 字段          | 默认值 | 说明                    |
| ------------- | ------ | ----------------------- |
| maxSessions   | 100    | 最多保存的会话数量      |
| maxDiskBytes  | 200MB  | 会话存储目录最大占用    |
| warnThreshold | 0.8    | 达到上限 80% 时触发告警 |

达到上限后创建新会话会返回明确提示（错误码 MAX_SESSIONS / MAX_DISK），需先删除旧会话。

WebUI 侧边栏提供存储占用指示条与告警提示，悬停可查看详细信息。

支持环境变量覆盖：

- WEBUI_MAX_SESSIONS
- WEBUI_MAX_DISK_BYTES
- WEBUI_WARN_THRESHOLD

API：

- GET `/api/storage`：查询存储状态
- POST `/api/storage/clean`：清理临时文件与释放空间

启动时自动清理上次异常退出遗留的 `.tmp` 文件。

---

# 代码质量

格式化：

```bash
npm run format        # 格式化代码
npm run format:check  # 检查格式
```

测试：

```bash
npm run test:electron           # Electron 相关测试
npm run test:conversation       # 会话测试
npm run test:conversation:all   # 全量会话测试
```

---

# 设计原则

1. **LLM 不直接执行**：所有操作通过 XML Action 交由 Runtime 执行，避免权限失控。
2. **Runtime 是安全边界**：控制文件访问、命令执行、路径权限与超时。
3. **Provider 与 Agent 解耦**：新增模型无需修改 Agent 核心逻辑。
4. **可审计**：History 与 Report 完整记录 Agent 行为，便于调试与回放。

---

# 当前能力

- ✅ XML Agent 协议
- ✅ Workspace 安全管理
- ✅ 文件读写与命令执行
- ✅ 多模型 Provider（ChatGPT / DeepSeek / Qwen / GLM）
- ✅ Runtime 与 XML 错误恢复
- ✅ BrowserAgent 页面自愈
- ✅ 会话持久化与存储上限管理
- ✅ History 记录与 Report 生成
- ✅ WebUI 视觉优化与 Final Answer 显示改进
- ✅ Electron 桌面端（安装版 / 便携版 / zip）
- ✅ 离线打包支持
- ✅ Prettier 代码风格统一

---

# 更新日志

详见：

- [RELEASE_NOTES_1.0.1.md](./RELEASE_NOTES_1.0.1.md)
- [RELEASE_NOTES_1.0.2.md](./RELEASE_NOTES_1.0.2.md)

---

# 总结

XML Agent 是一个轻量级工程 AI Agent Harness。

核心思想：

模型负责思考
Runtime 负责执行
XML 负责通信
Workspace 负责目标环境

通过这种架构，可以构建安全、可扩展、可审计的工程型 AI Agent。
