# XML Agent 1.0.5

## 下载（三选一）

XMLAgent-Setup-1.0.5-x64.exe（推荐）
Windows 安装程序。支持自定义安装目录，自动创建桌面与开始菜单快捷方式，可在控制面板卸载。
XMLAgent-Portable-1.0.5-x64.exe
免安装单文件版。双击即用，不写注册表，适合放在 U 盘里携带。
XMLAgent-1.0.5-x64.zip
zip 免安装压缩包。解压到任意目录后双击 XMLAgent.exe 运行，
适合内网 / 离线部署或需要自己控制解压位置的场景。
运行要求

## Windows 10 / 11（x64）

本机已安装 Google Chrome 或 Microsoft Edge（Agent 通过 CDP 复用浏览器，不自带浏览器）
使用 ChatGPT / DeepSeek / Qwen / GLM 时需要有对应账号并已在浏览器中登录

## 1.0.5 更新内容

1. 浏览器选择与切换
   Chrome 与 Edge 使用独立 CDP 端口（Chrome 9222 / Edge 9223），避免互相占用。
   桌面版 Settings 支持真正的浏览器切换（browser:switch）：切换时先关闭旧浏览器进程（Windows 使用 taskkill /T /F 关闭进程树），再在目标浏览器的独立端口启动新浏览器。
   状态区显示实际连接的浏览器类型；当与所选不一致时提示，并提供 "Switch to Chrome/Edge now" 一键切换。
   设置持久化支持 cdpUrls: { chrome, edge } 分别保存端口，采用原子写入；旧版仅含 cdpUrl 的配置自动迁移。

2. 同一会话多次运行（resume）
   同一 conversation 再次运行任务时复用同一个 session（sessionId 不变），侧边栏不再每次新增会话条目。
   新增 AgentSession.resume(task)：在同一 session 内继续一次新运行，更新任务、重置运行状态、追加输出，runCount 递增。
   会话回复累积在同一 session，便于 History 与 Trace 回看。

3. Agent Activity 按运行分段
   Agent Activity 以 agent.started 事件为边界，将输出拆分为 Run 1、Run 2……
   默认只显示最近一次运行，Final Answer 也只基于当前运行计算，新任务开始后立即切换到本次运行，不再停留在上一次的 answer。

4. 工具栏新增 "All runs / Current run" 切换查看全部历史运行，顶部显示 "Run N · current"。

5. 回复历史（History）
   顶部新增 "History"：打开当前所选 session 的回复历史。
   按 session 查看回复时间线（Reply 1、Reply 2……，含时间、标题、预览、状态），点击查看完整内容，Markdown 自动渲染。
   同一会话的多条回复各自保留，不会互相覆盖；每条回复的标题基于其自身内容生成，不再出现多条相同标题。
   去除了多余的会话选择栏，打开即聚焦当前会话。

6. 执行轨迹（Trace）
   顶部新增 "Trace"：查看当前 session 的执行轨迹。
   按"每次运行"分段（Run 1、Run 2……），每个 Run 内部按 step 展示 Action parsed / Runtime result / Provider 交互 / 错误重试等。
   agent.\* 生命周期事件记录在 Run 级别；可展开 Details 查看事件完整 JSON，支持 Expand all / Collapse all、Refresh。

7. 其他

8. 修复 AgentConsole 模板中 button 标签闭合问题导致的编译错误。

9. 更新 readme，补充浏览器切换、会话 resume、History、Trace 等章节。

10. 回归测试
    npm run webui:build 前端构建通过。
    会话持久化、Electron 设置、浏览器探测、Edge 设置等既有测试保持通过。
