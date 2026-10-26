# XML Agent 1.0.1

下载（三选一）

XMLAgent-Setup-1.0.1-x64.exe（推荐）
Windows 安装程序。支持自定义安装目录，自动创建桌面与开始菜单快捷方式，可在控制面板卸载。

XMLAgent-Portable-1.0.1-x64.exe
免安装单文件版。双击即用，不写注册表，适合放在 U 盘里携带。

XMLAgent-1.0.1-x64.zip
zip 免安装压缩包。解压到任意目录后双击 XMLAgent.exe 运行，
适合内网 / 离线部署或需要自己控制解压位置的场景。

运行要求

Windows 10 / 11（x64）

本机已安装 Google Chrome（Agent 通过 CDP 复用 Chrome，不自带浏览器）

使用 ChatGPT / DeepSeek / Qwen 时需要有对应账号并已在 Chrome 中登录

1.0.1 更新内容
会话持久化

WebUI 会话不再只存在内存里，重启后自动恢复。

会话数据保存在用户主目录：~/.xml-agent/webui-sessions/

运行中的会话在进程被杀后重启会标记为 interrupted，历史输出仍保留。

Agent 产物不再污染工作区

history.json / report.md 从 <workspace>/.agent/ 迁移到
用户主目录：~/.xml-agent/workspaces/<hash>/

不会在别人的代码仓库里产生额外文件。

Provider 页面自愈

BrowserAgent 新增 ensurePageAlive()：
Chrome 崩溃、标签页被关闭、CDP 断连后会自动重连并恢复会话页面，
不再直接报 "xxx page is not available" 连续失败。

DeepSeek / Qwen / ChatGPT 的 send() 都会先尝试自动恢复。

构建与打包

支持离线打包：把 winCodeSign / nsis / nsis-resources 的 .7z 放到 download/，
运行 npm run electron:offline-cache 后即可离线构建，无需访问 GitHub。

打包前自动结束残留的 XMLAgent.exe 进程，避免 EBUSY 文件占用错误。

同时产出安装版、便携版、zip 免安装包三种产物，命名互不冲突。

界面

WebUI 整体视觉优化：统一色板、会话项高亮、运行状态呼吸动画、
输入区聚焦光晕、日志时间轴与事件卡片动效等。
