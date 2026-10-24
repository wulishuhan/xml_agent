

# XML Agent 1.0.7 发布说明
本版本修复了 1.0.6 中"桌面端选好图片但 DeepSeek 收不到图片"的关键 bug。

## 一、修复：用户附带图片未透传到 Agent（关键）

### 问题现象
在 1.0.6 中，桌面端点击 Attach images 选择图片后，界面能正确显示图片列表（如 1.PNG、2.PNG），任务也能正常发送，但 CDP 浏览器里的 DeepSeek 从头到尾没有收到这些图片，模型只能看到提示词文本。

### 根因
`webui/session/session-manager.js` 的 `create()` 方法形参里遗漏了 `images`：
js

```
create({ workspace, provider, task, conversationId }) { ... }
```

而 `webui/server.js` 的 `/api/run` 调用时传入了 images：
js

```
session = sessionManager.create({ workspace, provider, task, conversationId, images: imagePaths });
```

于是 images 在 create 这一步被静默丢弃。AgentSession 构造时 images 为空数组，Agent 拿到的也是空数组，`uploadPresetImages()` 直接 return。
这也解释了为什么直接 `new Agent({ images })` 的单元测试是成功的——它绕过了 SessionManager；而真实 `electron:dev` 或打包后的应用走的是 `/api/run → SessionManager.create → AgentSession → Agent`，断在 create。

### 修复
- `session-manager.js` 的 `create()` 增加 `images = []` 参数，并透传给 `AgentSession`
- `session-manager.js` 的 `restore()` 恢复历史会话时不再传 images（图片上传是一次性运行时动作，历史会话不应重复上传旧图）
- 新增回归测试 `test/test-session-manager-images.js`（5 个用例），覆盖：
  - session.images 已透传
  - getInfo().images 已透传
  - 未传 images 时为空数组
  - resume 后 images 被更新
  - images 是拷贝而非共享引用

## 二、包含 1.0.6 的全部功能
如果你从 1.0.5 或更早版本升级，本版本同时包含：
- 截图能力：`<screenshot>` 支持 screen / window / browser_page，支持一次截多张，截图后自动上传给模型
- 用户手动上传图片：桌面端原生对话框（dialog:pickImages），Web 端 POST /api/uploads
- Agent 启动后、首条 prompt 前自动上传用户附带图片
- Markdown 渲染修复：breaks:true 保留换行，protectInlineSpaces 保留连续空格与缩进
- 任务结束后输入框自动清空
- Attach images 按钮移到 Run Agent 旁，高度与对齐统一
- 截图相关的稳健性修复（PowerShell 脚本、DPI、失败残留文件、超时进程树）

## 三、验证
- test/test-session-manager-images.js：5/5 通过
- test/test-agent-preset-images.js：16/16 通过
- test/test-upload-api.js：13/13 通过
- test/test-desktop-absolute-images.js：真实 CDP + DeepSeek，使用 2 张本地图片，uploadCount=2，模型正确描述了图片内容
- npm run webui:build 通过
- npm run electron:build 通过（nsis / portable / zip 三个目标全部生成）

## 四、升级提示
- 1.0.6 的安装包包含本次修复的 bug，请务必升级到 1.0.7。
- 直接覆盖安装即可，用户设置与会话数据保存在 %APPDATA%/XMLAgent 下，不会被清除。
- 升级前请先退出正在运行的 1.0.6（旧版 XMLAgent.exe 会占用 release/win-unpacked 下的文件）。
