# XML Agent 1.1.1 发布说明

这是一版以"补齐 + 加固"为主的更新：**新增 Gemini（网页版）provider**，并把 1.1.0 上线后
通过真机复测与对抗性测试暴露出来的一批问题收干净 —— 沙箱逃逸、子进程遗留、插件生命周期、
运行超时兜底都在这一版修掉。协议与插件 API 无破坏性变更（`apiVersion` 仍为 `1`）。

## 一、新增：Gemini（网页版）

Provider 列表里的第 5 项，走 `gemini.google.com`，与其他 provider 共用同一套
`BrowserChatProvider` 模板方法与页面自愈机制。

| 能力     | 说明                                                                    |
| -------- | ----------------------------------------------------------------------- |
| 会话续接 | 地址 `/app/<id>`，id 放宽到 8 位以上字母数字（官方改过一次格式）        |
| 回复解析 | `<model-response>` → Markdown，剪掉 thinking 面板 / 复制按钮 / 引用角标 |
| 代码块   | 还原成带语言围栏；语言标签在装饰条上，`<code>` 里常常没有 `language-*`  |
| 表格     | 转管道表，行序按文档顺序（不是栈序，否则表头会跑到表尾）                |
| 图片输入 | `supportsImages: true`                                                  |

实现上踩过、也已处理的两个坑：

1. **Quill 输入框水合**：页面刚加载时只有骨架 `textarea`，`.ql-editor` 要等 Angular 水合；
   写入后必须**重新查 DOM 读值**，复用旧 locator 会在水合/发送后一直阻塞到超时。
2. **平台会删掉裸 XML**：实测 `<answer>收到</answer>` 渲染后 DOM 里只剩
   `<p><span>收到</span></p>`，标签根本不存在、无法从页面还原。因此新增可选 provider 钩子
   `getActionMarkupHint()`，由 `agent-core` 交给 `prompts/first-prompt.js` 拼进首轮提示词，
   要求模型把动作放进代码块。**未声明该钩子的 provider 提示词逐字不变**（有单测钉住）。

> 首次使用需要在弹出的浏览器窗口里登录一次 Google 账号（沿用独立配置目录，登录状态会保留）。

## 二、修复：进程与退出路径

1.0.x 起"停止会话"已经能结束子进程，但**进程自己退出**时不会：

- 崩溃 / 未捕获异常 → 已登记的子进程（`exec --background`、浏览器自动化子进程）全部遗留；
- 显式 `process.exit()`、`SIGINT` / `SIGTERM`（Ctrl+C、任务管理器结束、Electron 退出）
  同样遗留。

现在 `processes/registry.js` 在 `exit` / `SIGINT` / `SIGTERM` / `uncaughtException` /
`unhandledRejection` 上统一收摊，WebUI 与 Electron 主进程走同一路径。

**已知边界**：任务管理器"结束任务"（`TerminateProcess`）与断电不触发任何用户态钩子，
这类场景无法回收子进程；Electron 侧通过 `before-quit` 尽早收摊降低概率。

## 三、插件系统加固

1.1.0 的插件系统是一次性大改，1.1.1 把这些边角补上：

| 问题                                    | 修复                                                                          |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| 坏插件在 UI 完全不可见（只进 `errors`） | 用目录名建占位记录（`sdk.brokenManifest`），`status:"error"` + 原因           |
| `setup` 期可以在没有权限时读密钥        | `_canReadSecrets` 与 run 期同一判据；未授权返回空门面 + 告警一次              |
| 热重载对子模块无效、定时器泄漏          | 递归清理插件目录的 require 缓存；新增 `ctx.onDispose` / `dispose`             |
| 提交冲突后资源不释放                    | `_commit` 失败时当场 `_disposeRecord`，`_disposeAll` 逆序执行                 |
| 每次配置读取都重新读盘                  | `_readJsonCached`（mtime + size）+ 写后回填                                   |
| 插件自定义接口可能永不返回              | `runWithTimeout` + `AbortController`，默认 15s，超时 504 `PLUGIN_API_TIMEOUT` |
| 插件 provider 重名被静默丢弃            | 与内置 id（`BUILTIN_PROVIDER_IDS`）、插件之间重名都**加载期报错**             |
| 符号链接插件目录加载不到                | `isSymbolicLink()` 后再 stat 一次                                             |

配套新增（WebUI）：

- `GET / PUT / DELETE /api/plugins/secrets`：**只回 key 与长度，不回明文**，落盘 `0600`；
- Plugins 面板新增 secrets 区块；
- `meta.mutating` 真正落地：内置动作与插件动作的执行结果都带该标记，`audit-log` 记录。

## 四、安全与健壮性（对抗性测试发现）

以下每一条都先复现、再修、再补回归断言（`test-hardening.js` 21 项 + `test-gemini-overlay.js` 8 项）。

**工作区沙箱**

- 路径校验只比字符串前缀 → 工作区内建一个 junction（`mklink /J`）就能读写到工作区外。
  改为在字符串校验之后，再按 `realpath` 校验最近的已存在祖先。
- 拒绝 Windows 保留设备名（`CON` / `NUL` / `COM1`…）与 NTFS 数据流写法（`a.txt:stream`）：
  前者"写入成功"但文件不存在，后者抛裸 `EINVAL`。

**exec**

- 输出超过 `maxBuffer` 时 `stdoutTruncated` 仍是 `false`（模型拿到 1MB 却被告知没截断），
  且只保留头部 —— 失败摘要通常在尾部。改为如实标记 + **首尾截断**；
  子进程缓冲上限提到 `8 × maxExecOutputSize`，只有超过缓冲才明确提示"其余输出已丢弃"。
- 命令任意位置出现 ` --background` 就被当后台任务并删掉这段文本
  （`node -e "console.log(' --background')"` 实测变后台）→ 只认命令结尾的标记。

**write / read**

- 快速解析路径不解码属性实体，与 read、通用解析路径不一致（写进 `a&amp;b.txt`，按
  `a&amp;b.txt` 读不到）→ 补实体解码。
- 写目标是已存在目录时抛裸 `EPERM`（错误里带临时文件名）→ 改为可读错误。
- read 把含 NUL 的二进制当文本塞进提示词 → 拒绝并标记 `binary`。

**超时与错误**

- `runWithTimeout` 的定时器被 `unref()`：等待期间若没有其它活跃句柄，Node 直接 `exit 0`，
  既不超时也不报错 → 去掉 `unref`。
- 运行超时只在两步之间检查，某步卡在 CDP 调用时整轮远超上限 → 改为**硬看门狗**
  （到点直接关 provider，`runStep` 见状态非 running 即收敛）。
- `emitHook` 对抛错的 handler 不计数 → 修正。
- `configSchema` 只有类型没有范围（`keepDays:-5` 能通过校验）→ 支持 `min` / `max`。
- WebUI 坏 JSON 请求体回一页带堆栈与本机绝对路径的 HTML → 改为 400 JSON。

**Provider 真机问题**

- **Qwen**：标签页被关后 `connectOverCDP` 撞 404，重开的页面停在 `#splash-screen`，
  点击被"intercepts pointer events"拦 30s → 新增 `normalizeCdpUrl`（去掉 CDP URL 末尾斜杠，
  根因是 Playwright 会拼出 `/json/version/`）、`connectCdp` 三次退避重试、三个写入入口
  先等遮罩消失，遮挡错误就地重试一次。
- **Gemini**：引导弹窗（"解锁最适合你的 Gemini / 关联 Google 应用"）的 CDK backdrop 盖住
  发送按钮，点击被吞、回车无效，而 `afterDelivered` 只 warn 就去等回复 → 真机卡 7 分钟。
  修法：`dismissBlockingOverlay()`（优先点"不关联"）+ 未清空重试提交 + 仍失败直接抛错。

## 五、构建

打包输出目录支持 `XML_AGENT_RELEASE_DIR` 覆盖（默认仍为 `release/`），
用于绕开 `win-unpacked` 被占用导致的 `EBUSY`。

## 六、新增配置项

```
agent.runTimeoutMs          整轮任务硬超时，默认 1800000（30 分钟），0 = 不限
                            env: AGENT_RUN_TIMEOUT_MS
plugins.apiTimeoutMs        插件自定义 HTTP 接口超时，默认 15000
                            env: XML_AGENT_PLUGIN_API_TIMEOUT_MS
```

## 七、验证

```
npm run test:offline     # 664 PASS / 0 FAIL（21 + 7 + 4 个用例文件全绿）
npm run format:check     # 全绿
npm run webui:build      # 前端产物
```

新增/重写的回归测试：

| 文件                                   | 项数 | 覆盖                                                  |
| -------------------------------------- | ---- | ----------------------------------------------------- |
| `test/unit/test-plugin-lifecycle.js`   | 25   | 坏插件可见、热重载、dispose 逆序、冲突释放、缓存      |
| `test/unit/test-plugin-secrets-api.js` | 10   | secrets 接口（起临时 storeRoot 真跑 HTTP）            |
| `test/unit/test-hardening.js`          | 21   | 沙箱逃逸、exec 截断、协议边界、错误路径               |
| `test/unit/test-gemini-message.js`     | 23   | DOM → Markdown（thinking / 代码块 / 表格 / 引用角标） |
| `test/unit/test-gemini-overlay.js`     | 8    | 引导弹窗遮挡、提交重试、失败抛错                      |
| `test/unit/test-first-prompt.js`       | 9    | `getActionMarkupHint` 注入；未声明时提示词逐字不变    |
| `test/unit/test-qwen-splash.js`        | 8    | splash 遮挡等待与重试                                 |
| `test/unit/test-cdp-connect.js`        | 4    | CDP URL 归一化与重连                                  |
| `test/unit/test-run-timeout.js`        | 5    | 硬看门狗到点收敛                                      |
| `test/unit/test-write-content.js`      | 5    | CDATA 前导换行、属性实体                              |
| `test/unit/test-exit-cleanup.js`       | 16   | exit / SIGINT / SIGTERM / uncaught 路径的子进程回收   |
| `test/test-plugin-hooks-smoke.js`      | 重写 | 原先读错目录、永不失败                                |

真机对照（已登录的 Chrome / Edge，CDP）：

- Gemini：5 步完成同一任务，span 51.5s，9 条隐藏用例 9/9；
- Qwen：5 步，span 58.9s，9 条隐藏用例 9/9（首轮因 splash 遮挡失败，修复后通过）。

## 八、升级提示

- 直接覆盖安装即可；用户设置、会话数据、插件状态（`~/.xml-agent/`）不受影响。
- 无破坏性变更：XML 协议、插件 `apiVersion: 1`、既有配置字段全部兼容。
- `--background` 语义与 1.1.0 一致：随会话停止一起结束（含进程自身退出）。
- 打包版请使用 1.1.1 的安装包：旧 exe 不含 `plugins/` 与 `providers/gemini.js`。
