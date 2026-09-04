# 🤖 XML Agent

一个基于 **Node.js + Chrome CDP + Playwright + XML Runtime** 的工程型 AI Agent。

XML Agent 不直接调用大模型 API，而是通过浏览器连接已经打开的 ChatGPT / Qwen Web 页面，让模型按照严格的 XML Action 协议工作。

Agent 负责：

1. 接收用户任务
2. 分析任务并向 LLM 发送 Prompt
3. 解析 LLM 返回的 XML Action
4. 交给 Runtime 执行
5. 将 Runtime 的真实结果继续反馈给 LLM
6. 在任务完成后通过 `<answer>` 返回用户答案
7. 最后通过 `<done/>` 结束 Agent 生命周期

---

## 快速开始

### git仓库代码并安装依赖

```bash
git clone https://github.com/wulishuhan/xml_agent.git
cd xml_agent
npm install
```

###  启动 Chrome CDP 提供网页版使用

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

***注意：*** 完成登录后不要关闭这个浏览器，等待使用，该浏览器在9222端口运行


Agent 默认连接：

```text
http://127.0.0.1:9222
```


Agent 连接的是用户启动的 Chrome，因此不会主动关闭整个 Chrome 浏览器。

### 运行

- ***参数解释***
***--provider*** : 可选，默认是chatgpt，提供chatgpt/qwen。
***--workspace*** : 必填，工作目录：注意目录必须存在

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

## ✨ 核心特点

### 1. 无需直接调用 LLM API

通过 Chrome CDP 连接已经打开的：

* ChatGPT
* Qwen

使用 Playwright 自动完成：

* 输入 Prompt
* 发送消息
* 获取模型回复
* 判断回复是否完成

因此 Agent 本身不需要直接管理大模型 API Key。

---

### 2. Provider 架构

当前 Provider 架构：

```text
Provider Factory
       │
       ├── ChatGPTProvider
       │
       └── QwenProvider
              │
              ▼
        BrowserAgent
              │
              ▼
       Playwright + CDP
```

其中：

* `BrowserAgent`：浏览器 Agent 基础类
* `ChatGPTProvider`：ChatGPT Web Provider
* `QwenProvider`：Qwen Web Provider
* `providers/index.js`：Provider Factory

后续可以继续增加其他 Web LLM Provider。

---

### 3. XML Action Runtime

LLM 不直接操作电脑。

LLM 只能输出 XML Action：

```text
LLM
 │
 │ XML Action
 ▼
Runtime
 │
 │ JSON Result
 ▼
LLM
```

Runtime 负责真正执行：

* 文件读取
* 文件写入
* 命令执行
* 返回答案
* Agent 生命周期结束

---

### 4. Workspace 隔离

Agent 必须显式指定 Workspace。

例如：

```bash
node agent.js --workspace "D:\project\my-project" "分析这个项目"
```

Runtime 中所有文件操作都基于这个 Workspace。

禁止：

* 使用绝对路径操作 Workspace 外部文件
* 使用 `../` 逃逸 Workspace

---

### 5. 渐进式项目探索

Agent 不会一次性读取整个项目。

启动时首先扫描 Workspace 第一层：

```text
Workspace
├── package.json
├── src/
├── README.md
└── ...
```

之后根据任务通过：

```xml
<read path="src"/>
```

逐步探索。

大型项目采用 Progressive Disclosure，可以减少：

* Token 消耗
* 无关上下文
* 大文件读取
* LLM 分析压力

---

### 6. Runtime 结果驱动

Agent 必须根据 Runtime 的真实结果继续工作。

例如：

```text
LLM
 │
 ├── <read path="src"/>
 │
 ▼
Runtime
 │
 ├── entries:
 │      index.js
 │      service/
 │
 ▼
LLM
 │
 ├── <read path="src/service"/>
 │
 ▼
Runtime
 │
 ▼
LLM
```

Agent 不允许：

* 编造文件内容
* 编造项目结构
* 编造命令执行结果
* 假设测试成功
* 假设文件已经修改成功

---

### 7. 执行历史与报告

每一次 XML Action 都会记录：

```text
step
timestamp
xml
result
```

任务结束后生成：

```text
.agent/
├── history.json
└── report.md
```

方便调试和回溯 Agent 执行过程。

---

# 🏗️ 系统架构

```text
                         User
                          │
                          │ Task
                          ▼
                    ┌─────────────┐
                    │  agent.js   │
                    │ Agent Loop  │
                    └──────┬──────┘
                           │
              ┌────────────┴────────────┐
              │                         │
              ▼                         ▼
       ┌──────────────┐          ┌──────────────┐
       │   prompts/   │          │  workspace/  │
       │ Prompt 构建  │          │ Manifest     │
       └──────┬───────┘          │ History      │
              │                  │ Report       │
              │                  └──────────────┘
              ▼
       ┌────────────────────┐
       │ providers/index.js │
       │  Provider Factory  │
       └─────────┬──────────┘
                 │
        ┌────────┴─────────┐
        ▼                  ▼
┌────────────────┐  ┌────────────────┐
│ ChatGPTProvider│  │  QwenProvider  │
└───────┬────────┘  └───────┬────────┘
        │                    │
        └─────────┬──────────┘
                  ▼
          ┌────────────────┐
          │  BrowserAgent  │
          │ Playwright/CDP │
          └───────┬────────┘
                  │
                  ▼
        ChatGPT / Qwen Web UI
                  │
                  │ XML Action
                  ▼
          ┌────────────────┐
          │ parse/xml-parse│
          │  XML Extractor │
          └───────┬────────┘
                  │
                  ▼
          ┌────────────────┐
          │   runtime.js   │
          │  XML Runtime   │
          └───────┬────────┘
                  │
                  │ Result JSON
                  ▼
               Workspace
                  │
                  └──────────► agent.js
                                │
                                ▼
                         下一轮 Prompt
```

---

# 🔄 Agent 工作循环

XML Agent 的核心是一个循环。

```text
                    ┌───────────────┐
                    │   User Task   │
                    └───────┬───────┘
                            ▼
                     ┌────────────┐
                     │   Agent    │
                     └─────┬──────┘
                           ▼
                          LLM
                           │
                           │ XML Action
                           ▼
                        Runtime
                           │
                           │ JSON Result
                           ▼
                          LLM
                           │
                           │ 下一步 XML Action
                           ▼
                        Runtime
                           │
                           ▼
                          ...
                           │
                           ▼
                        answer
                           │
                           ▼
                         done
```

核心原则：

```text
LLM = 决策
XML = 通信协议
Runtime = 执行
Workspace = 操作目标
Agent = 协调器
```

---

# 📁 项目结构

当前 Agent 项目结构：

```text
xml_agent/
├── agent.js
├── package.json
├── package-lock.json
├── readme.md
│
├── parse/
│   └── xml-parse.js
│
├── prompts/
│   ├── index.js
│   ├── system-prompt.js
│   ├── first-prompt.js
│   ├── runtime-prompt.js
│   ├── xml-error-prompt.js
│   └── done-prompt.js
│
├── providers/
│   ├── index.js
│   ├── browser-agent.js
│   ├── chatgpt.js
│   └── qwen.js
│
└── workspace/
    ├── manifest.js
    ├── history.js
    └── report.js
```

---

# 📦 技术栈

项目基于：

```text
Node.js
Playwright
fast-xml-parser
Chrome DevTools Protocol
XML
```

`package.json` 当前主要依赖：

```json
{
  "fast-xml-parser": "^5.11.1",
  "playwright": "^1.62.1"
}
```

---

# 🚀 安装

进入项目目录：

```bash
cd xml_agent
```

安装依赖：

```bash
npm install
```

---

# 🌐 启动 Chrome CDP

XML Agent 通过 Chrome DevTools Protocol 连接已经运行的 Chrome。

Windows 示例：

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$PWD\chrome-agent-profile"
```

启动后，在这个 Chrome 中打开：

```text
https://chatgpt.com
```

或者：

```text
https://chat.qwen.ai
```

Agent 默认连接：

```text
http://127.0.0.1:9222
```

注意：

Agent 连接的是用户启动的 Chrome，因此不会主动关闭整个 Chrome 浏览器。

---

# ▶️ 使用 Agent

## 默认使用 ChatGPT

默认 Provider 是：

```text
chatgpt
```

执行：

```bash
node agent.js --workspace "D:\project\my-project" "分析这个项目"
```

---

## 使用 ChatGPT

```bash
node agent.js \
  --workspace "D:\project\my-project" \
  --provider chatgpt \
  "分析这个项目的技术栈"
```

Windows CMD：

```cmd
node agent.js --workspace "D:\project\my-project" --provider chatgpt "分析这个项目的技术栈"
```

---

## 使用 Qwen

```bash
node agent.js \
  --workspace "D:\project\my-project" \
  --provider qwen \
  "分析这个项目的架构"
```

Windows CMD：

```cmd
node agent.js --workspace "D:\project\my-project" --provider qwen "分析这个项目的架构"
```

---

# 🧩 XML Action Protocol

Agent 与 Runtime 之间使用 XML 作为通信协议。

当前支持 5 个 Action：

```text
read
write
exec
answer
done
```

最重要的协议规则：

> 每一轮只能输出一个 XML Action。

---

# 1. read

用于读取文件或者目录。

读取文件：

```xml
<read path="package.json"/>
```

读取目录：

```xml
<read path="src"/>
```

---

## 读取目录

如果读取：

```xml
<read path="src"/>
```

Runtime 可能返回：

```json
{
  "ok": true,
  "action": "read",
  "path": "src",
  "type": "directory",
  "entries": [
    "controller/",
    "index.js",
    "service/"
  ]
}
```

Agent 必须根据：

```text
entries
```

决定下一步读取什么。

不能自己猜测目录中的文件。

---

## 读取文件

例如：

```xml
<read path="package.json"/>
```

Runtime 返回：

```json
{
  "ok": true,
  "action": "read",
  "path": "package.json",
  "type": "file",
  "size": 395,
  "content": "..."
}
```

---

# 2. write

用于创建或者修改文件。

例如：

```xml
<write path="src/example.js"><![CDATA[
console.log("hello");
]]></write>
```

要求：

* `path` 必须是 Workspace 相对路径
* 文件内容必须放在 CDATA 中
* Runtime 会自动创建父目录
* 不需要执行 `mkdir`

单个文件最大写入：

```text
5 MB
```

---

# 3. exec

用于执行命令。

例如：

```xml
<exec command="npm test"/>
```

或者：

```xml
<exec command="node src/app.js"/>
```

命令执行目录是当前 Workspace。

最大执行时间：

```text
120 秒
```

成功时 Runtime 返回命令输出。

失败时 Runtime 会返回：

```text
exitCode
stdout
stderr
error
```

Agent 必须根据实际返回结果继续处理。

---

# 4. answer

用于向用户返回真正的最终答案。

例如：

```xml
<answer><![CDATA[
这是一个 Node.js 项目。

主要技术栈包括：
Node.js
Playwright
fast-xml-parser

项目采用 Provider + Runtime 的 Agent 架构。
]]></answer>
```

`answer` 是给用户看的。

如果任务要求：

* 分析
* 解释
* 介绍
* 总结
* 回答问题

在完成必要的 `read` / `exec` 后，应使用：

```xml
<answer><![CDATA[
最终答案
]]></answer>
```

---

# 5. done

用于结束 Agent 生命周期。

```xml
<done/>
```

如果需要向用户返回最终答案，必须：

```text
answer
  ↓
done
```

例如：

```xml
<answer><![CDATA[
项目已经修改完成。
]]></answer>
```

然后：

```xml
<done/>
```

注意：

`done` 不能代替 `answer`。

---

# 🔐 Workspace 安全

Workspace 必须通过：

```bash
--workspace
```

显式指定。

例如：

```bash
node agent.js \
  --workspace "D:\project\my-app" \
  "分析项目"
```

Runtime 会保存当前 Workspace。

所有路径都必须是 Workspace 相对路径。

合法：

```xml
<read path="src/index.js"/>
```

非法：

```xml
<read path="D:\other-project\test.js"/>
```

非法：

```xml
<read path="../other-project/test.js"/>
```

这样可以避免 Agent 通过文件操作访问 Workspace 外部的数据。

---

# 🧠 Progressive Exploration

对于大型项目，不应该：

```text
读取整个项目
      ↓
全部发送给 LLM
```

正确方式：

```text
Workspace Manifest
        │
        ▼
      read
        │
        ▼
    发现目录
        │
        ▼
      read
        │
        ▼
    发现目标文件
        │
        ▼
      read
        │
        ▼
    分析目标文件
```

例如：

```text
项目
├── src/
│   ├── controller/
│   ├── service/
│   └── model/
├── package.json
└── README.md
```

如果用户问：

```text
这个项目使用什么数据库？
```

Agent 不需要读取整个项目。

可能只需要：

```text
package.json
↓
config/
↓
database 配置
```

---

# 📝 Prompt 系统

Prompt 统一放在：

```text
prompts/
```

当前包含：

```text
prompts/
├── index.js
├── system-prompt.js
├── first-prompt.js
├── runtime-prompt.js
├── xml-error-prompt.js
└── done-prompt.js
```

---

## system-prompt.js

定义 Agent 的核心行为规范。

主要规定：

```text
LLM 是工程型 AI Agent
        │
        ├── read
        ├── write
        ├── exec
        ├── answer
        └── done
```

同时要求：

* 每次只能输出一个 XML Action
* 不允许假设没有读取过的文件
* 不允许编造 Runtime 结果
* 修改项目后必须进行必要验证
* 根据 Runtime 真实结果继续工作

---

## first-prompt.js

负责生成 Agent 第一次发送给 LLM 的 Prompt。

包含：

```text
System Prompt
+
Workspace
+
Workspace Manifest
+
User Task
```

结构：

```text
System Prompt
       +
Workspace
       +
Workspace Manifest
       +
用户任务
       ↓
First Prompt
```

---

## runtime-prompt.js

负责将 Runtime 的结果反馈给 LLM。

成功：

```text
上一轮 Runtime 已经执行完成

Runtime 返回：
...

请根据这个真实结果继续完成用户任务。
```

失败：

```text
Runtime 执行失败

Runtime 返回：
...

请分析错误并尝试修复。
```

因此 Agent 可以形成：

```text
Action
 ↓
Runtime
 ↓
Result
 ↓
Prompt
 ↓
LLM
 ↓
Action
```

闭环。

---

## xml-error-prompt.js

如果 LLM 没有返回合法 XML Action：

```text
LLM
 ↓
非法 XML
 ↓
extractXML()
 ↓
XML Error
 ↓
xml-error-prompt
 ↓
LLM
```

要求模型重新输出合法 XML Action。

---

## done-prompt.js

当：

```xml
<answer>
```

已经成功生成后，Agent 会发送结束 Prompt：

```text
用户答案已经成功生成。

最终答案已经显示给用户。

现在结束 Agent 生命周期。

只输出：

<done/>
```

这样可以明确区分：

```text
answer = 用户答案
done   = 生命周期结束
```

---

# 🔎 XML Parser

文件：

```text
parse/xml-parse.js
```

主要职责：

```text
Provider Response
       │
       ▼
   extractXML()
       │
       ▼
 XML Action
```

支持：

```xml
<read path="package.json"/>
```

```xml
<write path="test.js"><![CDATA[
console.log("test");
]]></write>
```

```xml
<exec command="npm test"/>
```

```xml
<answer><![CDATA[
任务完成。
]]></answer>
```

```xml
<done/>
```

同时会处理模型返回的 Markdown XML 代码块。

例如模型错误地返回：

````text
```xml
<read path="package.json"/>
```
````

Parser 会尝试去掉 Markdown 包装后继续解析。

---

# ⚙️ Runtime

核心文件：

```text
runtime.js
```

Runtime 使用：

```text
fast-xml-parser
```

解析 XML。

处理流程：

```text
XML
 │
 ▼
XMLParser
 │
 ▼
Action
 │
 ├── read
 ├── write
 ├── exec
 ├── answer
 └── done
 │
 ▼
JSON Result
```

Runtime 不负责：

* 分析用户任务
* 决定下一步做什么
* 调用 LLM
* 生成 Prompt

它只负责执行。

---

# 📏 Runtime 限制

当前限制：

| 功能         |       限制 |
| ---------- | -------: |
| 单文件读取      |     2 MB |
| 单文件写入      |     5 MB |
| 命令执行       |    120 秒 |
| Agent 最大循环 | 50 steps |

这些限制主要用于避免：

* 超大文件进入上下文
* 无限命令执行
* Agent 无限循环

---

# 🗂️ Workspace Manifest

文件：

```text
workspace/manifest.js
```

启动 Agent 后，会扫描 Workspace 第一层目录。

例如：

```text
Workspace
├── package.json
├── src/
├── public/
├── README.md
└── node_modules/
```

Manifest 会忽略：

```text
node_modules
.git
.agent
browser-profile
browser_data
chrome-profile
chrome_data
```

并且只扫描第一层。

例如：

```text
src/
package.json
README.md
```

而不会继续递归：

```text
src/controller/user/UserController.js
```

深层结构由 Agent 根据任务使用 `<read>` 按需探索。

---

# 📝 History

文件：

```text
workspace/history.js
```

每一个 Action 都会生成：

```js
{
  step,
  timestamp,
  xml,
  result
}
```

例如：

```json
{
  "step": 1,
  "timestamp": "2026-09-03T00:00:00.000Z",
  "xml": "<read path=\"package.json\"/>",
  "result": {
    "ok": true,
    "action": "read",
    "path": "package.json"
  }
}
```

任务结束后保存：

```text
.agent/history.json
```

---

# 📊 Execution Report

文件：

```text
workspace/report.js
```

根据 History 自动生成：

```text
.agent/report.md
```

报告包含：

```text
Workspace
任务
执行记录
Step
Timestamp
XML
Runtime Result
```

例如：

```text
# Agent Execution Report

## Workspace

D:\project\my-project

## 任务

分析项目架构

## 执行记录

### Step 1 - read

读取成功：`package.json`

### Step 2 - read

读取成功：`src`

### Step 3 - answer

最终回答：

这是一个 Node.js 项目……
```

---

# 🤖 Provider 体系

Provider 目录：

```text
providers/
├── index.js
├── browser-agent.js
├── chatgpt.js
└── qwen.js
```

---

## BrowserAgent

基础类：

```text
BrowserAgent
```

主要负责：

```text
Chrome CDP
    │
    ▼
Browser
    │
    ▼
Context
    │
    ▼
Page
    │
    ▼
Input
```

提供：

* `start()`
* `getInput()`
* `getInputValue()`
* `insertMessage()`
* `waitForInput()`
* `waitForInputClear()`
* `isPageAlive()`
* `sleep()`
* `close()`

Provider 只需要实现自己的页面匹配和回复获取逻辑。

---

## ChatGPTProvider

```text
ChatGPTProvider
       │
       └── extends BrowserAgent
```

通过：

```text
chatgpt.com
```

识别 ChatGPT 页面。

支持输入：

```text
[contenteditable="true"]
#prompt-textarea
textarea
```

发送消息后等待 Assistant 回复。

---

## QwenProvider

```text
QwenProvider
       │
       └── extends BrowserAgent
```

通过：

```text
chat.qwen.ai
```

识别 Qwen 页面。

通过：

```text
.response-message-content
.qwen-markdown-html
```

读取 Assistant 回复。

---

# 🧠 为什么采用 Provider？

这样 Agent 核心逻辑不需要关心具体使用哪个 LLM。

例如：

```bash
--provider chatgpt
```

或者：

```bash
--provider qwen
```

最终都统一为：

```js
provider.send(prompt)
```

因此：

```text
Agent
  │
  ▼
Provider Interface
  │
  ├── ChatGPT
  ├── Qwen
  └── Future Provider
```

这样后续增加新的 Web LLM Provider 时，不需要修改 Agent Loop。

---

# 🔁 完整执行示例

用户输入：

```text
读取项目结构，然后告诉我这个项目是做什么的。
```

Agent 首先获得：

```text
Workspace
+
Workspace Manifest
+
User Task
```

然后 LLM 可能返回：

```xml
<read path="package.json"/>
```

Runtime 执行：

```text
read package.json
```

返回：

```json
{
  "ok": true,
  "action": "read",
  "path": "package.json",
  "type": "file",
  "content": "..."
}
```

Agent 将真实结果再次发送给 LLM。

LLM 继续：

```xml
<read path="src"/>
```

Runtime 再次返回真实结果。

最终 LLM：

```xml
<answer><![CDATA[
这是一个 Node.js 工程型 AI Agent。

项目通过 Chrome CDP 和 Playwright 连接 ChatGPT / Qwen Web，
然后使用 XML Action 驱动本地 Runtime 操作 Workspace。

核心架构由 Agent、Provider、XML Parser 和 Runtime 组成。
]]></answer>
```

Agent 收到成功结果后继续：

```xml
<done/>
```

最终任务结束。

---

# 🛠️ 修改任务示例

用户：

```text
给这个项目增加一个 test.js。
```

Agent：

```xml
<write path="test.js"><![CDATA[
console.log("hello");
]]></write>
```

Runtime：

```text
write 成功
```

Agent 根据结果继续。

如果需要验证：

```xml
<exec command="node test.js"/>
```

Runtime 返回：

```text
hello
```

然后：

```xml
<answer><![CDATA[
已经创建 test.js，并执行 node test.js 验证成功。
]]></answer>
```

最后：

```xml
<done/>
```

---

# 🎯 设计原则

## 1. LLM 决策，Runtime 执行

LLM：

```text
决定做什么
```

Runtime：

```text
真正执行
```

---

## 2. Agent 是协调层

Agent 不直接操作 Workspace。

结构：

```text
LLM
 ↓
Agent
 ↓
XML
 ↓
Runtime
 ↓
Workspace
```

---

## 3. 一次一个 Action

每一轮只能输出：

```xml
<read .../>
```

或者：

```xml
<write ...>
...
</write>
```

或者：

```xml
<exec .../>
```

或者：

```xml
<answer>...</answer>
```

或者：

```xml
<done/>
```

禁止一次返回多个 Action。

---

## 4. 真实 Runtime 驱动

核心原则：

```text
不要猜
不要编造
不要假设
```

必须：

```text
Action
  ↓
Runtime
  ↓
真实 Result
  ↓
下一步 Action
```

---

## 5. 优先理解现有项目

如果用户要求修改已有项目：

```text
先 read
 ↓
理解现有代码
 ↓
确定修改位置
 ↓
write
 ↓
exec 验证
 ↓
answer
```

而不是直接重建项目。

---

## 6. 最小化工具集合

目前只保留：

```text
read
write
exec
answer
done
```

尽量让 XML Protocol 保持简单。

复杂任务通过多个 Action 组合完成。

---

# 🔮 后续扩展

当前架构可以继续增加 Provider：

```text
providers/
├── browser-agent.js
├── chatgpt.js
├── qwen.js
└── xxx-provider.js
```

也可以增加新的 XML Action，例如：

```xml
<search .../>
```

```xml
<delete .../>
```

```xml
<move .../>
```

```xml
<git .../>
```

```xml
<list .../>
```

但是建议保持 Runtime 简洁。

---

# 📌 核心总结

XML Agent 本质上是一个：

```text
LLM + XML Protocol + Runtime + Workspace
```

组成的工程型 Agent。

完整链路：

```text
User
 │
 ▼
Agent
 │
 ▼
Prompt
 │
 ▼
ChatGPT / Qwen
 │
 │ XML Action
 ▼
XML Parser
 │
 ▼
Runtime
 │
 │ JSON Result
 ▼
Agent
 │
 ├───────────────┐
 │               │
 ▼               │
继续工作          │
 │               │
 └───────┬───────┘
         │
         ▼
       answer
         │
         ▼
        done
```

最终职责划分：

```text
┌──────────────────────────────────────┐
│                 User                 │
│              提出任务                │
└──────────────────┬───────────────────┘
                   │
                   ▼
┌──────────────────────────────────────┐
│                Agent                 │
│          任务协调 / Agent Loop       │
└──────────────────┬───────────────────┘
                   │
                   ▼
┌──────────────────────────────────────┐
│                  LLM                 │
│             分析 / 决策               │
└──────────────────┬───────────────────┘
                   │
                   │ XML Action
                   ▼
┌──────────────────────────────────────┐
│                Runtime               │
│          文件 / 命令 / Workspace      │
└──────────────────┬───────────────────┘
                   │
                   │ JSON Result
                   ▼
┌──────────────────────────────────────┐
│                  LLM                 │
│           根据真实结果继续工作        │
└──────────────────────────────────────┘
```

**LLM 负责思考，XML 负责通信，Runtime 负责执行，Workspace 提供操作目标，Agent 负责协调整个执行循环。**
