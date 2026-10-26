# XML Agent 1.0.6 发布说明

本版本从 1.0.5 升级，包含截图能力、用户手动上传图片，并修复了一个关键 bug。

## 一、修复：用户附带图片未透传到 Agent（关键）

### 问题现象

桌面端点击 Attach images 选择图片后，界面能正确显示图片列表（如 1.PNG、2.PNG），任务也能正常发送，但 CDP 浏览器里的 DeepSeek 从头到尾没有收到这些图片，模型只能看到提示词文本。

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

## 二、新增：截图能力

- 新增 XML Action：`<screenshot>`，支持三种来源：
    - `screen`：截取整个桌面
    - `window`：按窗口标题截取指定窗口（如 VSCode、Edge）
    - `browser_page`：截取本机 CDP 浏览器页面，可选 `url` / `selector` / `fullPage`
- 支持一次截多张（screenshot 内嵌多个 `<target>`，最多 8 个），返回 `results` 数组与 `succeeded`/`failed` 汇总。
- 截图成功后自动通过 `uploadImages` 一次性上传给大模型，模型下一轮即可"看到"图片。
- Web 版与桌面版共用同一套本地 Node 后端实现，能力一致。
- 新增 `POST /api/screenshot` 接口，供前端或外部调用，路径严格限制在 workspace 内。
- Windows 下使用 PowerShell + PrintWindow(PW_RENDERFULLCONTENT) 截取 Chromium 窗口；支持中文窗口标题；高 DPI 下按物理分辨率截取。

## 三、新增：用户手动上传图片

- 桌面端：`Attach images` 走原生文件对话框（`dialog:pickImages`），直接拿本地绝对路径；若当前 Electron 无该通道，自动降级到文件选择并上传到 workspace。
- Web 端：新增 `POST /api/uploads`（multer），图片落到 `<workspace>/uploads/`，返回相对路径。
- Agent 启动后、发送第一条 prompt 之前，自动把用户附带图片一次性上传给模型。
- 限制：单文件 20MB、一次最多 8 张、扩展名白名单（png/jpg/jpeg/webp/gif/bmp）、文件名安全清洗、路径严格限制在 workspace 内。

## 四、其他修复

- 修复前端 Markdown 渲染 `breaks:false` 导致换行丢失的问题，改为 `breaks:true`；并新增 `protectInlineSpaces` 保留连续空格与行首缩进（代码围栏内不受影响）。
- 修复 answer 渲染后任务输入框仍保留上一次任务的问题：会话运行结束后清空输入框；切换到已运行过的会话不再回填旧任务。
- 修复 `Attach images` 按钮位置与样式：移到 Run Agent 旁，两个按钮统一高度与对齐。
- 修复 AgentConsole 预览文字粘连问题（`replace(/\s+/g, " ")`）。
- 修复 `getPreview` 只替换第一个空白的问题。
- 修复 PowerShell 脚本被写入管线破坏导致截图失败的问题：C# 源码独立成文件，脚本用占位符书写。
- 修复失败截图残留 0 字节文件的问题。
- 修复浏览器整页截图会改变用户页面滚动位置的问题。

## 五、工程

- 清理无用测试脚本与临时产物目录（test-output-deepseek、vision_test_img 等）。
- 新增截图相关测试：test-screenshot*.js、test-agent-screenshot*.js、test-deepseek-\*.js。
- 新增上传相关测试：test-upload-api.js、test-agent-preset-images.js、test-session-manager-images.js、test-desktop-absolute-images.js。
- 新增 markdown 渲染测试：test-markdown-whitespace.mjs。
- package.json 新增 `capture/**/*` 到构建文件列表，新增 `multer` 依赖。

## 六、验证

- test/test-session-manager-images.js：5/5 通过
- test/test-agent-preset-images.js：16/16 通过
- test/test-upload-api.js：13/13 通过
- test/test-desktop-absolute-images.js：真实 CDP + DeepSeek，2 张图 uploadCount=2，模型正确描述图片
- npm run webui:build 通过
- npm run electron:build 通过（nsis / portable / zip 三个目标全部生成）

## 七、升级提示

- 本版本包含新的 Electron preload IPC（`dialog:pickImages`），必须使用重新打包的 exe，旧版 exe 不包含该通道。
- 若你之前使用的是 1.0.5 或更早版本，请卸载后安装 1.0.6，或直接使用 Portable 版本。
- 直接覆盖安装即可，用户设置与会话数据保存在 %APPDATA%/XMLAgent 下，不会被清除。
- 升级前请先退出正在运行的旧版 XMLAgent.exe（旧版会占用 release/win-unpacked 下的文件）。
