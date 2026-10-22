# XML Agent 新功能说明

本文档说明 v1.0.5 之后新增的两项能力：Markdown 代码块清洗与围栏平衡、任务完成桌面通知。

## 一、Markdown 代码块清洗与围栏平衡

### 1. 背景

Agent 通过浏览器读取第三方大模型页面时，页面里的代码块往往带有工具栏按钮（复制、下载、Copy、Download 等）。这些按钮文字会被一起抓进回复内容，导致：

- 回答里出现 "复制"、"下载"、"text" 之类的无关行；
- Markdown 三反引号围栏数量不配对，渲染错乱。

为此新增两个纯函数工具模块，位于 `providers/` 目录。

### 2. providers/markdown-code-clean.js

职责：从文本中剔除代码块工具栏标签行。
导出的内容：

名称类型说明CODE_TOOLBAR_LABELSstring[]需要剔除的工具栏标签集合isToolbarLine(line)boolean判断某行是否为工具栏标签行stripCodeToolbarLabels(text)string删除工具栏标签行，并折叠多余空行
CODE_TOOLBAR_LABELS 包含：`、`、`、`、`、`、``。
处理规则：

- 逐行扫描，只有"整行 trim 后恰好等于上述标签之一"才删除，不会误删正文中的同名词。
- 空行不视为工具栏行。
- 删除后把 3 个及以上连续换行折叠为 2 个，避免留下大片空白。

实现细节：为避免写入管线破坏反斜杠与美元符，逻辑刻意不用复杂正则，改用 split / join 逐行处理；换行符用 `String.fromCharCode(10)` 构造。

### 3. providers/markdown-fence-utils.js

职责：修复 Markdown 围栏（```）不配对，并从候选文本中提取 XML Action。
导出的内容：

名称类型说明FENCEstring三反引号围栏标记balanceMarkdownFences(value)string让围栏数量变为偶数（配对）extractXmlFromCandidate(value)string | null从候选文本中提取 XML Action
balanceMarkdownFences 规则- 统计文本中 `FENCE` 出现次数；为 0 或偶数则原样返回。

- 为奇数时取最后一个围栏：
    - 若该围栏所在行后面还有内容（非空白），说明它是代码块起始，则在末尾补一个围栏；
    - 否则若后续内容看起来像代码（含 const/let/var/function/return/class/import/export/if/for/while 等关键字，或含 `; { } ( ) [ ] \ < > =` 等代码符号，或有缩进行），补一个围栏；
    - 都不满足则把最后一个围栏删掉。

extractXmlFromCandidate 规则- 去掉开头连续的围栏，并去掉紧跟的 `xml` 语言标记；

- 去掉结尾连续的围栏；
- 用 `<(read|write|exec|answer|done)...>` 匹配 XML Action 起始位置，把前面的多余文字裁掉；
- 找不到 Action 返回 null，否则返回裁剪后的文本。

同样用 `String.fromCharCode(96)`、`String.fromCharCode(92)` 构造反引号与反斜杠，规避写入管线影响。

### 4. 相关测试

- `test/test-deepseek-codeblock-toolbar.js`：验证工具栏标签行被正确剔除、正文不受影响。

## 二、任务完成桌面通知

### 1. 背景

Agent 任务可能运行较久，用户切到其它窗口后不知道任务何时结束。桌面版（Electron）因此在任务真正完成时弹出 Windows 系统通知。

### 2. 前端：webui/frontend/src/services/desktop-notify.js

- 仅在 Electron 桌面版生效：检测 `window.xmlAgentDesktop.isElectron === true` 且存在 `notifications` 桥接；Web 版静默跳过。
- `isTaskCompleted(status)`：判断 status 是否等于 `completed`。
- `notifyTaskCompleted(sessionInfo)`：仅当状态为 completed 时调用 `desktop.notifications.taskDone(info)`，返回是否投递成功；异常时打印警告并返回 false。
- 设计上只在"真正完成"时通知，用户主动停止或出错不打扰。

### 3. 主进程：electron/notifier.js

名称说明MESSAGES文案常量（completed: 任务完成了；error: 任务执行出错）buildNotificationPayload(input)归一化标题/正文，空值回退默认，避免 Toast 异常shouldNotify(status)仅 completed 返回 truebuildTaskNotification(sessionInfo)生成通知内容：标题 "XML Agent · 任务完成"，正文为任务摘要（超 60 字截断）加 providernotify(options)发送通知；支持注入 send 函数用于测试，否则使用 Electron Notification
notify 的行为：

- 若传入 `options.send` 函数，用它发送（便于单元测试，不真的弹窗）。
- 否则尝试 `require("electron").Notification`；不可用则跳过。
- 检查 `Notification.isSupported()`，不支持则跳过。
- 创建并 show() 通知，异常时打印警告并返回 false。

### 4. 相关测试

- `test/test-desktop-notify.js`：验证通知内容构建、状态判断与注入式发送。

## 三、与既有功能的关系

- 代码块清洗在 Provider 读取回复后生效，改善回答质量，不影响 XML Action 解析流程。
- 围栏平衡与 XML 提取共同保证：即使页面回复里围栏错乱，也能稳定提取出 `<read>` / `<write>` / `<exec>` / `<answer>` / `<done>`。
- 桌面通知是纯增强能力，Web 版无需任何配置；桌面版会自动在任务完成时提醒。
