# XML Agent

一个基于 Node.js 实现的工程型 AI Agent Framework。

核心设计理念：

> LLM 负责理解任务和规划，Runtime 负责安全执行，XML Action 作为 Agent 与 Workspace 之间的通信协议。

项目目标是构建一个类似 Claude Code、OpenHands 的轻量级工程 Agent Harness。

---

# 快速开始

## git仓库代码并安装依赖

环境：

```
Node.js >= 16
```

```bash
git clone https://github.com/wulishuhan/xml_agent.git
cd xml_agent
npm install
```

## 使用webUI

安装依赖
```
cd xml_agent/webui
npm install

```
配置chrome.exe路径
配置文件xml_agent/config/agent-config.js

```
  browser: {
    ...
    // Chrome.exe Path
    chromePath: "C:/Users/hunte/AppData/Local/Google/Chrome/Application/chrome.exe
    ...
  },

```


启动服务器agent服务器
```
cd xml_agent
npm run webui
```
另外一个终端启动dev页面
```
cd xml_agent
npm run webui:dev
```

访问页面
```
http://localhost:5173
```

---

## 手动调用
## 启动 Chrome CDP 提供网页版使用

XML Agent 通过 Chrome DevTools Protocol 连接已经运行的 Chrome。

Windows 示例：

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$PWD\chrome-agent-profile"
```

如果你的chrome.exe不是上述目录，请找到chrome浏览器图标，点击右键选择属性，点击打开文件所在目录既可找到

```
& "your_path\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$PWD\chrome-agent-profile"
```

启动后，在这个 Chrome 中打开，下列网页版进行登录操作：

```text
https://chatgpt.com
```

或者：

```text
https://chat.qwen.ai
```

**_注意：_** 完成登录后不要关闭这个浏览器，等待使用，该浏览器在9222端口运行

Agent 默认连接：

```text
http://127.0.0.1:9222
```

Agent 连接的是用户启动的 Chrome，因此不会主动关闭整个 Chrome 浏览器。

## 运行

- **_参数解释_**
  - **_--provider_** : 可选，默认是chatgpt，提供chatgpt/qwen。
  - **_--workspace_** : 必填，工作目录：注意目录必须存在

默认gpt

```
cd xml_agent
node agent.js --workspace "D:\code\vue\ppl" "创建一个vue项目，是关于泡泡龙的游戏"
```

手动选择provider

```
cd xml_agent
node agent.js --provider qwen --workspace "D:\code\vue\ppl" "创建一个vue项目，是关于泡泡龙的游戏"
```

---

# 项目架构

整体流程：

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
(read/write)      (exec)
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
```

---

# 核心模块

## Agent

入口：

```
agent.js
```

负责：

- 接收用户任务
- 初始化 Workspace
- 加载 Provider
- 调用 LLM
- 解析 XML Action
- 调用 Runtime
- 管理 Agent 生命周期

执行流程：

```
用户任务
    |
    v
生成 First Prompt
    |
    v
调用 Provider
    |
    v
解析 XML
    |
    v
执行 Runtime
    |
    v
根据结果继续推理
    |
    v
answer / done
```

---

# Runtime

文件：

```
runtime.js
```

Runtime 是整个系统的执行核心。

LLM 不直接操作电脑。

所有操作必须通过 XML Action。

支持：

## read

读取 Workspace 文件或者目录。

示例：

```xml
<read path="package.json"/>
```

目录：

```xml
<read path="src"/>
```

返回：

```json
{
  "ok": true,
  "action": "read",
  "type": "file",
  "content": "..."
}
```

---

## write

写入文件。

示例：

```xml
<write path="src/test.js"><![CDATA[
console.log("hello");
]]></write>
```

特点：

- 自动创建目录
- 限制文件大小
- 只能写入 Workspace 内

---

## exec

执行命令。

示例：

```xml
<exec command="npm test"/>
```

特点：

- 工作目录固定为 Workspace
- 支持 node/npm/shell 命令
- 有执行超时限制

---

## answer

返回用户最终答案。

示例：

```xml
<answer><![CDATA[
项目分析完成。
]]></answer>
```

---

## done

结束 Agent 生命周期。

示例：

```xml
<done/>
```

---

# Provider

目录：

```
providers/
```

负责接入不同大模型。

当前支持：

```
ChatGPT
DeepSeek
Qwen
```

统一接口：

```javascript
createProvider(name);
```

例如：

```javascript
const provider = createProvider("chatgpt");
```

Agent 不关心具体模型实现。

---

# Prompt 系统

目录：

```
prompts/
```

负责控制 Agent 行为。

包含：

```
system-prompt.js
first-prompt.js
runtime-prompt.js
xml-error-prompt.js
send-error-prompt.js
done-prompt.js
```

作用：

## system-prompt

定义 Agent 基础能力和规则。

例如：

- 必须使用 XML Action
- 不允许直接修改系统
- 必须根据 Runtime 返回继续工作

---

## first-prompt

第一次调用模型时生成任务上下文。

包含：

- Workspace
- Manifest
- 用户任务

---

## runtime-prompt

根据 Runtime 返回结果生成下一轮 Prompt。

例如：

Runtime:

```json
{
  "action": "read",
  "content": "..."
}
```

Agent:

继续分析文件。

---

# Workspace

Agent 操作目标目录。

例如：

```
D:/project/demo
```

Runtime 所有路径：

必须是 Workspace 相对路径。

允许：

```
package.json
src/index.js
```

禁止：

```
C:/xxx
../../xxx
```

避免 Agent 越权访问。

---

# History

目录：

```
workspace/
```

保存 Agent 执行记录。

包括：

- step
- action
- runtime result

方便：

- 调试
- 回放
- 分析 Agent 行为

---

# Report

任务完成后生成执行报告。

包含：

- 用户任务
- Workspace
- Agent 执行信息

---

# 安装

环境：

```
Node.js >= 16
```

安装依赖：

```bash
npm install
```

---

# 使用

## CLI

示例：

```bash
node agent.js \
--workspace D:/project/demo \
--provider chatgpt \
创建一个 hello.js 文件
```

Windows:

```bash
node agent.js --workspace D:/project/demo --provider qwen "分析当前项目"
```

---

# XML Action 协议

Agent 与 Runtime 使用 XML 通信。

例如：

模型输出：

```xml
<read path="src"/>
```

Runtime 执行：

```
读取目录
```

返回：

```json
{
  "ok": true,
  "entries": ["index.js"]
}
```

模型继续：

```xml
<read path="src/index.js"/>
```

直到：

```xml
<answer>
任务完成
</answer>
```

然后：

```xml
<done/>
```

---

# 设计原则

## 1. LLM 不直接执行

错误方式：

```
LLM
 |
直接运行shell
```

风险：

- 权限过大
- 不可控

当前方式：

```
LLM
 |
XML Action
 |
Runtime
 |
执行
```

---

## 2. Runtime 是安全边界

Runtime 控制：

- 文件访问
- 命令执行
- 路径权限
- 超时

---

## 3. Provider 与 Agent 解耦

未来可以增加：

- Claude
- Gemini
- 本地模型
- Ollama

无需修改 Agent。

---

# 当前能力

目前已经具备：

- ✅ XML Agent 协议
- ✅ Workspace 管理
- ✅ 文件读取
- ✅ 文件写入
- ✅ 命令执行
- ✅ 多模型 Provider
- ✅ Runtime 错误恢复
- ✅ XML 错误恢复
- ✅ History 记录
- ✅ Report 生成

---

# 后续规划

## Runtime 增强

- exec 流式输出
- 命令权限控制
- Docker Sandbox
- Git 操作

## Agent 增强

- 长期 Memory
- Plan / Execute 模式
- 多 Agent 协作
- Tool Registry

## 服务化

增加：

```
server/
```

提供：

```
POST /agent/run
```

让 Agent 作为后台服务运行。

---

# 总结

XML Agent 是一个轻量级工程 AI Agent Harness。

核心思想：

```
模型负责思考

Runtime负责执行

XML负责通信

Workspace负责目标环境
```

通过这种架构，可以构建安全、可扩展、可审计的工程型 AI Agent。
