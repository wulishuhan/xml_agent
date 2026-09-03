# XML Agent

一个基于 **Node.js + Chrome + ChatGPT Web + XML Runtime** 的极简 Coding Agent 实验项目。

项目的核心理念：

> **让 LLM 负责思考，让 Runtime 负责执行。**

本项目不依赖 OpenAI API Token，而是通过本地 Chrome 浏览器连接已经登录的 ChatGPT Web，让 LLM 通过 XML 指令操作用户指定的本地项目目录。

---

# 1. 项目目标

这个项目尝试构建一个尽可能简单的 Coding Agent。

Agent 不需要拥有大量复杂的 Tool，只提供最基础的能力：

```xml
<read path="..."/>
```

```xml
<write path="..."><![CDATA[
...
]]></write>
```

```xml
<exec command="..."/>
```

```xml
<answer><![CDATA[
...
]]></answer>
```

```xml
<done/>
```

LLM 自己负责：

* 理解用户需求
* 探索项目
* 阅读代码
* 修改代码
* 执行程序
* 分析错误
* 修复错误
* 安装缺少的依赖
* 决定下一步操作
* 判断任务什么时候完成
* 向用户给出最终答案

Runtime 不负责替 LLM 做决策。

Runtime 的职责主要是：

```text
接收 XML Action
        ↓
解析 Action
        ↓
操作 Workspace
        ↓
返回真实执行结果
```

---

# 2. 核心架构

```text
                         User
                           │
                           ▼
                    ┌─────────────┐
                    │   agent.js  │
                    │ Agent Loop  │
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
                    │  browser.js │
                    │ Chrome CDP  │
                    └──────┬──────┘
                           │
                           ▼
                      ChatGPT Web
                           │
                           │ XML Action
                           ▼
                    ┌─────────────┐
                    │  runtime.js │
                    │ XML Runtime │
                    └──────┬──────┘
                           │
                           ▼
                 User Specified Workspace
```

完整工作循环：

```text
用户任务
   ↓
Agent
   ↓
ChatGPT
   ↓
XML Action
   ↓
Runtime
   ↓
真实执行结果
   ↓
Agent
   ↓
ChatGPT
   ↓
XML Action
   ↓
Runtime
   ↓
...
   ↓
answer
   ↓
done
```

核心思想：

```text
LLM
 ↓
Action
 ↓
Runtime
 ↓
Result
 ↓
LLM
```

---

# 3. Agent 与 Workspace 的关系

这是项目非常重要的设计。

**Agent 自己的目录和 Workspace 不是同一个目录。**

例如：

```text
D:\program\frontend\xml_agent\
│
├── agent.js
├── browser.js
├── runtime.js
├── package.json
├── README.md
└── chrome-agent-profile\
```

而真正需要操作的项目可以是任意目录：

```text
D:\project\my-project\
│
├── package.json
├── src\
├── public\
└── README.md
```

运行 Agent 时，通过：

```powershell
--workspace
```

指定目标项目。

例如：

```powershell
node agent.js --workspace "D:\project\my-project" "分析这个项目"
```

此时：

```text
Agent
│
├── agent.js
├── browser.js
├── runtime.js
└── chrome-agent-profile

              ↓

        Workspace

              ↓

D:\project\my-project
```

Agent 不需要把项目复制到自己的 `workspace/` 目录。

---

# 4. Workspace 参数

启动 Agent 时必须指定 Workspace。

支持：

```powershell
node agent.js --workspace "D:\project\my-project" "分析这个项目"
```

也支持：

```powershell
node agent.js --workspace="D:\project\my-project" "分析这个项目"
```

Workspace 可以是：

* Vue 项目
* React 项目
* Node.js 项目
* Python 项目
* Java 项目
* Go 项目
* C/C++ 项目
* 普通脚本项目
* 其他本地项目

只要 Runtime 能够读取和执行对应项目即可。

---

# 5. XML Action

目前 Agent 与 Runtime 之间主要使用以下 XML Action：

```text
read
write
exec
answer
done
```

---

# 6. read

`read` 用于读取文件以及探索目录。

## 6.1 读取文件

```xml
<read path="src/App.vue"/>
```

Runtime 返回类似：

```json
{
  "ok": true,
  "action": "read",
  "path": "src/App.vue",
  "content": "..."
}
```

---

## 6.2 读取目录

```xml
<read path="src"/>
```

Runtime 可以返回目录中的文件和子目录：

```json
{
  "ok": true,
  "action": "read",
  "path": "src",
  "type": "directory",
  "entries": [
    "components/",
    "views/",
    "App.vue",
    "main.js"
  ]
}
```

因此不需要单独设计：

```xml
<list/>
```

`read` 同时承担：

```text
文件读取
+
目录探索
```

---

## 6.3 读取 Workspace 根目录

```xml
<read path="."/>
```

Agent 可以首先了解项目第一层结构。

然后再根据实际情况继续：

```xml
<read path="package.json"/>
```

```xml
<read path="src"/>
```

```xml
<read path="src/components"/>
```

```xml
<read path="src/components/Header.vue"/>
```

---

# 7. write

`write` 用于创建或者修改文件。

例如：

```xml
<write path="hello.py"><![CDATA[
print("Hello World")
]]></write>
```

Runtime 会将内容写入当前 Workspace：

```text
Workspace/
└── hello.py
```

如果目标目录不存在，Runtime 可以创建对应目录。

---

## 7.1 修改已有文件

修改已有代码之前，Agent 应该优先读取原文件：

```xml
<read path="src/App.vue"/>
```

然后根据实际代码进行修改：

```xml
<write path="src/App.vue"><![CDATA[
...
]]></write>
```

这样可以避免在没有读取代码的情况下凭空修改项目。

---

# 8. exec

`exec` 用于执行系统命令。

例如：

```xml
<exec command="python hello.py"/>
```

Node.js 项目：

```xml
<exec command="npm install"/>
```

```xml
<exec command="npm run build"/>
```

Python：

```xml
<exec command="python -m pip install requests"/>
```

Node：

```xml
<exec command="node --version"/>
```

---

## 8.1 Runtime 执行环境

命令会在当前 Workspace 中执行。

例如：

```text
Workspace:

D:\project\my-project
```

执行：

```xml
<exec command="npm run build"/>
```

相当于在：

```text
D:\project\my-project
```

中执行：

```powershell
npm run build
```

因此 Agent 不需要自己拼接 Workspace 路径。

---

## 8.2 Runtime 返回结果

成功：

```json
{
  "ok": true,
  "action": "exec",
  "command": "python hello.py",
  "exit_code": 0,
  "stdout": "Hello World",
  "stderr": ""
}
```

失败：

```json
{
  "ok": false,
  "action": "exec",
  "command": "python hello.py",
  "exit_code": 1,
  "stdout": "",
  "stderr": "IndentationError..."
}
```

执行结果会重新交给 LLM。

---

# 9. Agent 自我纠错

这是本项目非常重要的能力。

例如用户要求：

```text
创建 hello.py 并运行
```

LLM：

```xml
<write path="hello.py"><![CDATA[
 print("Hello World")
]]></write>
```

Runtime：

```text
write success
```

然后 LLM：

```xml
<exec command="python hello.py"/>
```

Runtime：

```text
IndentationError: unexpected indent
```

Agent 不需要写死：

```javascript
if (error === "IndentationError") {
    ...
}
```

而是将真实错误交给 LLM。

LLM 自己分析：

```text
IndentationError
      ↓
发现代码缩进错误
      ↓
重新 write
      ↓
重新 exec
      ↓
验证结果
```

最终：

```text
Hello World
```

然后：

```xml
<answer><![CDATA[
已经创建 hello.py，并成功运行，输出 Hello World。
]]></answer>
```

最后：

```xml
<done/>
```

---

# 10. answer

`answer` 用于向用户返回最终答案。

例如：

```xml
<answer><![CDATA[
项目分析完成。

这是一个 Vue 2 项目，主要入口位于 src/main.js。
]]></answer>
```

`answer` 和 `done` 的职责不同。

```text
answer
  ↓
告诉用户结果

done
  ↓
结束 Agent 生命周期
```

如果任务需要向用户返回答案，应该：

```text
answer
 ↓
done
```

而不能直接：

```text
done
```

来代替最终答案。

最终答案应该基于 Agent 实际读取、修改和执行得到的结果。

---

# 11. done

`done` 表示 Agent 生命周期结束。

```xml
<done/>
```

Runtime 返回：

```json
{
  "ok": true,
  "action": "done"
}
```

然后 Agent Loop 结束。

典型生命周期：

```text
read
 ↓
read
 ↓
write
 ↓
exec
 ↓
exec
 ↓
answer
 ↓
done
```

---

# 12. Workspace 安全

Runtime 的文件操作基于当前 Workspace。

例如 Workspace：

```text
D:\project\my-project
```

Agent：

```xml
<read path="src/App.vue"/>
```

实际访问：

```text
D:\project\my-project\src\App.vue
```

Runtime 不应该允许 Agent 通过：

```text
../../
```

等路径跳出 Workspace。

例如：

```xml
<read path="../../secret.txt"/>
```

应该被 Runtime 拒绝。

核心原则：

```text
                    Workspace
                       │
             ┌─────────┴─────────┐
             │                   │
          允许访问             禁止越界
             │                   │
       src/App.vue          ../../xxx
```

---

# 13. 渐进式项目探索

Agent 不应该一开始就读取整个项目。

例如一个大型项目：

```text
project/
├── node_modules/
├── .git/
├── dist/
├── src/
├── public/
├── package.json
└── ...
```

如果一次性读取所有文件，会产生非常大的上下文。

因此采用渐进式探索：

```text
read(".")
   ↓
了解第一层结构
   ↓
read("package.json")
   ↓
了解项目配置
   ↓
read("src")
   ↓
了解源码结构
   ↓
read("src/components")
   ↓
定位相关文件
   ↓
read("src/components/A.vue")
   ↓
理解具体代码
```

LLM 自己决定下一步读取什么。

---

# 14. 为什么不一次读取整个项目

大型项目通常包含：

```text
node_modules/
.git/
dist/
build/
缓存文件
日志文件
图片
大量源码
大量依赖
```

如果全部发送给 LLM：

```text
项目
 ↓
大量文件
 ↓
巨大 Prompt
 ↓
上下文压力
 ↓
降低 Agent 效率
```

因此本项目采用：

```text
目录探索
   ↓
定位相关文件
   ↓
读取相关代码
   ↓
理解
   ↓
修改
   ↓
验证
```

---

# 15. Manifest

Agent 启动后会对当前指定 Workspace 建立项目结构信息。

Manifest 的作用是帮助 LLM 快速了解：

```text
当前 Workspace
       ↓
第一层目录 / 文件
       ↓
项目基本结构
```

例如：

```text
Workspace:
D:\project\my-project

Manifest:

package.json
README.md
src/
public/
vite.config.js
```

Manifest 只用于帮助 Agent 建立初步项目认知。

具体代码仍然应该通过：

```xml
<read path="..."/>
```

按需读取。

---

# 16. Agent Loop

Agent 的核心循环可以概括为：

```javascript
for (;;) {

    // 请求 ChatGPT
    response = await browser.send(prompt);

    // 从回复中提取 XML
    action = extractXML(response);

    // Runtime 执行
    result = await execute(action);

    // 完成
    if (result.action === "done") {
        break;
    }

    // 把 Runtime 结果交给 ChatGPT
    prompt = buildRuntimePrompt(result);
}
```

核心模型：

```text
┌─────────┐
│   LLM   │
└────┬────┘
     │
     │ XML Action
     ▼
┌─────────┐
│ Runtime │
└────┬────┘
     │
     │ Result
     ▼
┌─────────┐
│   LLM   │
└─────────┘
```

---

# 17. History

Agent 会记录运行过程。

目标 Workspace 下会生成：

```text
.agent/
├── history.json
└── report.md
```

例如：

```text
D:\project\my-project\
│
├── src/
├── package.json
│
└── .agent/
    ├── history.json
    └── report.md
```

---

## 17.1 history.json

用于记录 Agent 的运行过程，例如：

```text
Step 1
 ↓
read package.json

Step 2
 ↓
read src

Step 3
 ↓
write src/App.vue

Step 4
 ↓
exec npm run build

Step 5
 ↓
answer

Step 6
 ↓
done
```

---

## 17.2 report.md

用于保存本次 Agent 执行的报告信息。

因为 `.agent/` 位于目标 Workspace 内，所以每个项目可以拥有自己的 Agent 执行记录。

---

# 18. Chrome

本项目目前不使用 OpenAI API Token。

Agent 使用：

```text
Node.js
   ↓
Chrome DevTools Protocol
   ↓
Chrome
   ↓
ChatGPT Web
```

`browser.js` 使用 Playwright 连接已经运行的 Chrome。

连接地址：

```text
http://127.0.0.1:9222
```

核心方式：

```javascript
chromium.connectOverCDP(
    "http://127.0.0.1:9222"
);
```

---

# 19. 启动 Chrome

首先关闭普通 Chrome：

```powershell
taskkill /F /IM chrome.exe
```

然后启动专用 Chrome：

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$PWD\chrome-agent-profile"
```

第一次运行时，在 Chrome 中登录 ChatGPT。

登录状态保存在：

```text
chrome-agent-profile/
```

这个目录属于 **Agent 运行环境**，不是 Workspace。

例如：

```text
xml_agent/
├── agent.js
├── browser.js
├── runtime.js
└── chrome-agent-profile/

D:\project\my-project/
├── package.json
├── src/
└── ...
```

二者相互独立。

---

# 20. 安装

进入 Agent 项目：

```powershell
cd D:\program\frontend\xml_agent
```

安装依赖：

```powershell
npm install
```

如果还没有 Playwright：

```powershell
npm install playwright
```

---

# 21. 运行 Agent

首先启动 Chrome：

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$PWD\chrome-agent-profile"
```
进入对应网页，进行登录

然后执行 Agent。

例如：

```powershell
node agent.js `
  --workspace "D:\project\my-project" `
  "分析这个项目是什么项目"
```

或者：

```powershell
node agent.js `
  --workspace "D:\project\my-project" `
  "创建一个 hello.py，输出 Hello World，然后运行它验证结果"
```

---

# 22. 一个完整运行示例

假设：

```text
Workspace:

D:\project\my-project
```

用户：

```text
创建一个 hello.py，输出 Hello World，然后运行它验证结果
```

Agent 第一步：

```xml
<write path="hello.py"><![CDATA[
print("Hello World")
]]></write>
```

Runtime：

```json
{
  "ok": true,
  "action": "write",
  "path": "hello.py"
}
```

Agent 第二步：

```xml
<exec command="python hello.py"/>
```

Runtime：

```json
{
  "ok": true,
  "action": "exec",
  "command": "python hello.py",
  "exit_code": 0,
  "stdout": "Hello World",
  "stderr": ""
}
```

Agent 第三步：

```xml
<answer><![CDATA[
已经创建 hello.py，并成功运行。

运行结果：

Hello World
]]></answer>
```

最后：

```xml
<done/>
```

Agent 生命周期结束。

---

# 23. 项目文件

当前核心结构：

```text
xml_agent/
│
├── agent.js
│   └── Agent Loop
│
├── browser.js
│   └── Chrome / ChatGPT Web 控制
│
├── runtime.js
│   └── XML Action Runtime
│
├── package.json
│
├── README.md
│
└── chrome-agent-profile/
    └── Agent 专用 Chrome Profile
```

目标项目独立存在：

```text
my-project/
│
├── package.json
├── README.md
├── src/
├── public/
│
└── .agent/
    ├── history.json
    └── report.md
```

---

# 24. 设计原则

## 原则一：LLM 决策，Runtime 执行

Runtime 不应该替 LLM 判断：

```text
应该修改哪个文件？
应该安装什么？
应该怎么修复？
应该执行什么？
任务是否完成？
```

这些属于 LLM 的职责。

Runtime 负责：

```text
接收 Action
    ↓
解析
    ↓
执行
    ↓
返回真实结果
```

---

## 原则二：工具保持简单

不追求几十个 Tool。

当前核心 Action：

```text
read
write
exec
answer
done
```

其中：

```text
read
```

同时承担：

```text
文件读取
+
目录探索
```

---

## 原则三：错误也是 Agent 的输入

不要在 Runtime 中针对每一种错误写大量硬编码规则。

例如不应该写成：

```javascript
if (error.includes("ModuleNotFoundError")) {
    installPackage();
}

if (error.includes("IndentationError")) {
    fixIndentation();
}
```

而应该：

```text
Runtime
   ↓
真实错误
   ↓
LLM
   ↓
分析
   ↓
下一步 Action
```

这样 Agent 才能处理没有被提前写死的错误。

---

## 原则四：渐进式探索

不要把整个项目一次性塞给 LLM。

应该：

```text
read(".")
   ↓
read("src")
   ↓
read("src/components")
   ↓
read("src/components/A.vue")
```

LLM 自己决定探索路径。

---

## 原则五：Workspace 与 Agent 解耦

Agent 本身：

```text
agent.js
browser.js
runtime.js
chrome profile
```

与用户项目：

```text
src/
package.json
README.md
...
```

应该保持独立。

用户可以让同一个 Agent 操作不同项目：

```powershell
node agent.js --workspace "D:\project\project-a" "分析项目"
```

然后：

```powershell
node agent.js --workspace "D:\project\project-b" "修复登录问题"
```

无需复制项目。

---

# 25. 当前已经验证的能力

目前已经验证：

* [x] Node.js Agent Loop
* [x] Chrome CDP
* [x] ChatGPT Web
* [x] XML Action
* [x] `read`
* [x] 文件读取
* [x] 目录探索
* [x] `write`
* [x] 文件创建
* [x] 文件修改
* [x] `exec`
* [x] Python 执行
* [x] Node.js 命令执行
* [x] Runtime 错误返回
* [x] LLM 自动分析执行错误
* [x] LLM 自动修改代码
* [x] LLM 自动重新执行
* [x] `answer`
* [x] `done`
* [x] Agent 生命周期控制
* [x] Workspace 参数化
* [x] Workspace 路径限制
* [x] Workspace 渐进式探索
* [x] Agent History
* [x] Agent Report

---

# 26. 当前使用方式总结

最基本的运行方式：

```powershell
node agent.js `
  --workspace "D:\project\my-project" `
  "你的任务"
```

例如：

```powershell
node agent.js `
  --workspace "D:\project\vue-project" `
  "分析这个项目，并告诉我项目的主要结构"
```

或者：

```powershell
node agent.js `
  --workspace "D:\project\vue-project" `
  "找到登录页面，如果存在明显问题就修复并运行项目验证"
```

---

# 27. 当前 Agent 的核心模型

整个项目可以浓缩成：

```text
                  User
                   │
                   ▼
              ┌─────────┐
              │  Agent  │
              └────┬────┘
                   │
                   ▼
               ChatGPT
                   │
                   │ XML
                   ▼
              ┌─────────┐
              │ Runtime │
              └────┬────┘
                   │
          ┌────────┼────────┐
          │        │        │
          ▼        ▼        ▼
        read     write     exec
          │        │        │
          └────────┼────────┘
                   │
                   ▼
               Workspace
                   │
                   ▼
                Result
                   │
                   └──────────────► ChatGPT
```

最终形成：

```text
Observe
   ↓
Think
   ↓
Act
   ↓
Observe
   ↓
Think
   ↓
Act
   ↓
...
   ↓
Answer
   ↓
Done
```

---

# 28. 最终目标

这个项目最终希望形成一个非常简单的 Coding Agent。

LLM 负责：

```text
理解
思考
规划
探索
编码
测试
调试
修复
总结
```

Runtime 负责：

```text
读取
写入
执行
返回真实结果
```

二者之间只通过简单的 XML Action 进行通信：

```text
              LLM
               │
      ┌────────┼────────┐
      │        │        │
     read     write    exec
      │        │        │
      └────────┼────────┘
               │
            Runtime
               │
               ▼
           Workspace
               │
               ▼
            Result
               │
               ▼
              LLM
```

最终：

```text
          Observe
             ↓
           Think
             ↓
            Act
             ↓
          Observe
             ↓
           Think
             ↓
            Act
             ↓
            ...
             ↓
           Answer
             ↓
            Done
```

**这就是本项目最核心的设计思想：**

> **LLM 决策，Runtime 执行。**
>
> **Workspace 可指定，Agent 与项目解耦。**
>
> **通过真实 Runtime 结果驱动 LLM 持续完成任务。**
