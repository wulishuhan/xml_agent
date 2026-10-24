

# XML Agent 1.0.6 发布说明

## 一、新增：截图能力
- 新增 XML Action：`<screenshot>`，支持三种来源：
  - `screen`：截取整个桌面
  - `window`：按窗口标题截取指定窗口（如 VSCode、Edge）
  - `browser_page`：截取本机 CDP 浏览器页面，可选 `url` / `selector` / `fullPage`
- 支持一次截多张（screenshot 内嵌多个 `<target>`，最多 8 个），返回 `results` 数组与 `succeeded`/`failed` 汇总。
- 截图成功后自动通过 `uploadImages` 一次性上传给大模型，模型下一轮即可"看到"图片。
- Web 版与桌面版共用同一套本地 Node 后端实现，能力一致。
- 新增 `POST /api/screenshot` 接口，供前端或外部调用，路径严格限制在 workspace 内。
- Windows 下使用 PowerShell + PrintWindow(PW_RENDERFULLCONTENT) 截取 Chromium 窗口；支持中文窗口标题；高 DPI 下按物理分辨率截取。

## 二、新增：用户手动上传图片
- 桌面端：`Attach images` 走原生文件对话框（`dialog:pickImages`），直接拿本地绝对路径；若当前 Electron 无该通道，自动降级到文件选择并上传到 workspace。
- Web 端：新增 `POST /api/uploads`（multer），图片落到 `<workspace>/uploads/`，返回相对路径。
- Agent 启动后、发送第一条 prompt 之前，自动把用户附带图片一次性上传给模型。
- 限制：单文件 20MB、一次最多 8 张、扩展名白名单（png/jpg/jpeg/webp/gif/bmp）、文件名安全清洗、路径严格限制在 workspace 内。

## 三、修复
- 修复前端 Markdown 渲染 `breaks:false` 导致换行丢失的问题，改为 `breaks:true`；并新增 `protectInlineSpaces` 保留连续空格与行首缩进（代码围栏内不受影响）。
- 修复 answer 渲染后任务输入框仍保留上一次任务的问题：会话运行结束后清空输入框；切换到已运行过的会话不再回填旧任务。
- 修复 `Attach images` 按钮位置与样式：移到 Run Agent 旁，两个按钮统一高度与对齐。
- 修复 AgentConsole 预览文字粘连问题（`replace(/\s+/g, " ")`）。
- 修复 `getPreview` 只替换第一个空白的问题。
- 修复 PowerShell 脚本被写入管线破坏导致截图失败的问题：C# 源码独立成文件，脚本用占位符书写。
- 修复失败截图残留 0 字节文件的问题。
- 修复浏览器整页截图会改变用户页面滚动位置的问题。

## 四、工程
- 清理无用测试脚本与临时产物目录（test-output-deepseek、vision_test_img 等）。
- 新增截图相关测试：test-screenshot*.js、test-agent-screenshot*.js、test-deepseek-*.js。
- 新增上传相关测试：test-upload-api.js、test-agent-preset-images.js、test-desktop-absolute-images.js。
- 新增 markdown 渲染测试：test-markdown-whitespace.mjs。
- package.json 新增 `capture/**/*` 到构建文件列表，新增 `multer` 依赖。

## 五、升级提示
- 本版本包含新的 Electron preload IPC（`dialog:pickImages`），必须使用重新打包的 exe，旧版 exe 不包含该通道。
- 若你之前使用的是 1.0.5 或更早版本，请卸载后安装 1.0.6，或直接使用 Portable 版本。
