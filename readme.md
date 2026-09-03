# 🤖 XML Agent

**基于 Node.js + Chrome CDP + XML Runtime 的极简 Coding Agent**

XML Agent 是一个实验性的 Coding Agent 项目。它的核心理念是：**让 LLM 负责思考与决策，让 Runtime 负责执行与反馈。**

本项目**不依赖任何 OpenAI API Token**，而是通过本地 Chrome 浏览器的 CDP (Chrome DevTools Protocol) 连接已经登录的 LLM Web 端（如 ChatGPT、Qwen Web），让大模型通过极简的 XML 指令操作用户指定的本地项目目录（Workspace）。

---

## ✨ 核心特性

- 🆓 **零 API 成本**：复用本地浏览器已登录的 Web 端，无需配置 API Key。
- 🔌 **多模型支持**：通过 Provider 机制，支持 ChatGPT、Qwen 等多种 Web 端模型（见 `index.js`）。
- 📦 **极简 XML 协议**：摒弃复杂的 Tool 定义，仅使用 `read`、`write`、`exec`、`answer`、`done` 5 个基础 XML Action。
- 🛡️ **Workspace 安全隔离**：严格的路径校验机制，禁止绝对路径和 `../../` 越界访问，保护本地环境安全。
- 🧭 **渐进式探索**：Agent 按需读取目录和文件，避免大型项目一次性撑爆 LLM 上下文。
- 🔄 **自我纠错闭环**：Runtime 将真实的报错信息（如语法错误、缺依赖）直接返回给 LLM，由 LLM 自主分析并修复。
- 📝 **执行报告追踪**：自动在 Workspace 下生成 `.agent/history.json` 和 `.agent/report.md`，记录完整的思考与执行链路。

---

## 🏗️ 核心架构

```text
       User Task
           │
           ▼
   ┌───────────────┐
   │   agent.js    │ ◄── Agent Loop (状态机 & 提示词构建)
   └───────┬───────┘
           │ Prompt / XML
           ▼
   ┌───────────────┐
   │  Provider.js  │ ◄── Chrome CDP (Playwright)
   └───────┬───────┘
           │
           ▼
   ┌───────────────┐
   │  LLM Web UI   │ ◄── ChatGPT / Qwen (本地浏览器)
   └───────┬───────┘
           │ XML Action
           ▼
   ┌───────────────┐
   │  runtime.js   │ ◄── 解析 XML & 执行本地操作
   └───────┬───────┘
           │ Result (JSON)
           ▼
   ┌───────────────┐
   │   Workspace   │ ◄── 用户指定的目标项目目录
   └───────────────┘
```

## 快速开始
1. 安装依赖
```bash
npm install
```
(确保已安装 Playwright 及对应的浏览器驱动)

2. 启动专用 Chrome
为了保证 Agent 能够稳定连接并复用登录状态，需要以调试模式启动 Chrome：

Windows (PowerShell):

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$PWD\chrome-agent-profile"
```

3. 运行 Agent

```bash
node agent.js --workspace "D:\project\my-vue-app" --provider chatgpt "分析这个项目，并告诉我它的主要技术栈"
```

## 📜 XML Action 协议

Agent 与 Runtime 之间完全通过 XML 进行通信。LLM 每次只能输出一个 XML Action。

1. 读取 (read)
支持读取文件内容或探索目录结构。

```
<!-- 读取文件 -->
<read path="package.json"/>

<!-- 探索目录 -->
<read path="src/components"/>
```

2. 写入 (write)
创建或覆盖文件。内容必须包裹在 <![CDATA[ ... ]]> 中，Runtime 会自动创建不存在的父目录。
```
<write path="src/utils/helper.js"><![CDATA[
export function add(a, b) {
  return a + b;
}
]]></write>
```

3. 执行 (exec)
在 Workspace 根目录下执行系统命令。

```
<exec command="npm install vue-router"/>
<exec command="npm run build"/>
```

4. 回答 (answer)
任务完成或需要向用户反馈时，输出最终答案（支持 Markdown）。

```
<answer><![CDATA[
项目分析完成。这是一个基于 Vue 3 + Vite 的前端项目，入口文件在 `src/main.js`。
]]></answer>
```

5. 结束 (done)
通知 Agent Loop 终止生命周期。

```
<done/>
```

## 🛡️ 设计原则
1. LLM 决策，Runtime 执行
Runtime 绝不替 LLM 做决定（如：不硬编码“遇到 ModuleNotFoundError 就执行 pip install”）。Runtime 只负责返回真实的 stdout/stderr，由 LLM 自行理解错误并生成修复的 XML。
2. Workspace 绝对隔离
Agent 自身的代码目录与目标 Workspace 完全解耦。Runtime 会拦截所有试图通过 ../ 或绝对路径跳出 Workspace 的恶意/错误请求。
3. 渐进式探索 (Progressive Disclosure)
禁止一次性将项目所有文件塞入 Prompt。Agent 必须先 <read path="."/> 获取 Manifest，再根据任务需要逐步深入读取具体文件，保护上下文窗口。
4. 工具极简主义
不追求几十个复杂的 Tool。read 兼顾了文件读取与目录 list 的功能，保持协议极度精简。

## 📂 目录结构说明

```
xml_agent/
├── agent.js          # 核心 Agent Loop，解析参数，构建 Prompt，处理状态机
├── runtime.js        # XML 解析器与本地文件系统/命令执行沙箱
├── index.js          # Provider 工厂，管理不同的 LLM Web 接入点
├── chatgpt.js        # ChatGPT Web 端的 DOM 交互与状态监听
├── qwen.js           # Qwen Web 端的 DOM 交互 (示例)
├── package.json
└── chrome-agent-profile/ # 专用 Chrome 用户数据目录 (保存登录态)

[Target Workspace]/  # 用户指定的目标项目
├── src/
├── package.json
└── .agent/          # Agent 自动生成的执行记录
    ├── history.json # 完整的 XML 交互历史
    └── report.md    # 人类可读的执行报告
```

## 💡 典型工作流示例
用户任务：“创建一个 hello.py，输出 Hello World，然后运行它验证结果”
1. Agent: 
`<write path="hello.py"><![CDATA[print("Hello World")]]></write>`
2. Runtime: 返回 
`{ "ok": true, "action": "write" ... }`
3. Agent: 
`<exec command="python hello.py"/>`
4. Runtime: 返回
`{ "ok": true, "stdout": "Hello World" ... }`
5. Agent:   
`<answer><![CDATA[
   已创建 hello.py 并成功运行，输出结果为：Hello World。
   ]]></answer>`
6. Agent: 
`<done/>` (生命周期结束)

## ⚠️ 注意事项
运行期间请勿手动关闭用于调试的 Chrome 窗口。
如果 LLM Web 端出现验证码或网络波动，Agent 可能会超时，请确保网络畅通。
exec 命令具有超时限制（默认 120 秒），请勿用于执行需要长时间阻塞且无输出的交互式命令。