XML Agent 1.0.3

下载（三选一）

XMLAgent-Setup-1.0.3-x64.exe（推荐）
Windows 安装程序。支持自定义安装目录，自动创建桌面与开始菜单快捷方式，可在控制面板卸载。

XMLAgent-Portable-1.0.3-x64.exe
免安装单文件版。双击即用，不写注册表，适合放在 U 盘里携带。

XMLAgent-1.0.3-x64.zip
zip 免安装压缩包。解压到任意目录后双击 XMLAgent.exe 运行，
适合内网 / 离线部署或需要自己控制解压位置的场景。

运行要求

Windows 10 / 11（x64）

本机已安装 Google Chrome（Agent 通过 CDP 复用 Chrome，不自带浏览器）

使用 ChatGPT / DeepSeek / Qwen / GLM 时需要有对应账号并已在 Chrome 中登录

1.0.3 更新内容

新增 GLM（Z.ai）Provider

新增 providers/glm.js，接入 https://chat.z.ai 聊天页面。

会话 URL 形如 https://chat.z.ai/c/<uuid>，支持从已有会话继续对话。

在 providers/index.js 中注册 glm，与 chatgpt / deepseek / qwen 共用统一接口。

可通过 --provider glm 使用，或在 WebUI 里选择 GLM。

Qwen Provider 稳定性大幅提升

修复长内容被截断问题：
之前用 DOM innerText 提取 Qwen 回复，Qwen 前端使用 Monaco 编辑器做虚拟滚动，
DOM 里只保留视口内的行，长代码 / 长文档会被截断。
新方案改为从 React fiber 的 props.content 提取完整原始文本，绕过 DOM 虚拟滚动。

修复长回复被拆成多条消息的问题：
Qwen 长输出有时会被页面拆成多个 assistant 消息节点。
getLastResponse 现在会从最后一条消息开始，如果最后一条不含 XML Action，
会向前回溯最多 3 条 assistant 消息，按顺序拼接后再尝试提取 XML Action。

fiber 遍历范围修复：
之前用 full BFS（child + sibling + return）会向上爬到更早的对话节点甚至用户 prompt，
抓到的是历史内容而不是最新回复。
改为只沿 child 向下遍历，确保拿到的是"最后这条消息"自身的内容。

候选字符串打分策略：
Action 特征优先，深度浅优先，长度次要。
确保优先选中最新一条消息里的 XML Action。

生成结束判定改进：
之前用"文本稳定 X 秒"判断生成结束，模型中途思考时会误判为已完成。
新方案以 Qwen 页面的「发送 / 停止」按钮状态为主信号：
生成中：停止按钮可见、发送按钮不可见
生成结束：发送按钮恢复、停止按钮消失
再用 waitForStableResponse 做二次确认，避免误判截断。

DOM 保护：
buildFromDom 用 cloneNode(true) 复制一份后再处理，所有 remove / 遍历只作用在克隆体上，
不再污染用户看到的页面真实 DOM。

Markdown 围栏配平：
新增 balanceMarkdownFences，处理模型漏写或多余代码块围栏的情况：
孤立的闭围栏（前面没有开围栏）删除
未闭合的开围栏在文件末尾补一个闭围栏
避免文件里出现"结束打到最后"或"某个代码块吞掉后面一大段"的问题。

NBSP 归一化：
Qwen 页面渲染代码块时会用不间断空格 U+00A0 代替普通空格。
新增归一化处理，把 U+00A0 转回 U+0020，避免字符串匹配失败和代码执行问题。

XML Parser 修复 CDATA 内容冲突

修复 readme 类文档更新失败的问题。

背景：readme 正文里常包含多个 XML Action 示例（read、write、exec、answer、done），
这些示例里的 CDATA 结束标记会提前结束外层 write 的 CDATA，
导致 fast-xml-parser 顶层解析出多个 action，报
"Exactly one XML Action is required, but received N"。

新增 tryExtractWriteManually 前置处理：
在调用 fast-xml-parser 之前先尝试手动提取 write action。
如果文本以 write 开头标签开始、以 write 结束标签收尾，
就把开标签和闭标签之间的全部内容作为 CDATA 正文，不参与 XML 解析。
手动提取成功就直接返回，完全绕过 fast-xml-parser。
手动提取失败时才走原有 XML 解析路径。

该改动只影响 write action，对 read / exec / answer / done 无影响。

新增测试

test/test-qwen-comprehensive.js：
Qwen 综合测试，覆盖 8 个场景：read action、exec action、answer action、
短 md、长 md、长代码（218 行）、JSON 文件、特殊字符（中文 / 反斜杠 / emoji / 尖括号）。
真实 CDP 端到端测试，8/8 全部通过。

test/test-qwen-readme-update.js：
让 Qwen 更新 readme.md 的完整 Agent 流程测试，4 步（read → write → answer → done）全部通过。

test/test-xml-parse-cdata.js：
XML Parser 单元测试，覆盖 9 个场景：简单 write、write 内容含 XML 示例、
write 内容含 CDATA 结束标记、简单 read、带 markdown 代码块包裹的 write、
手动提取直接调用、空 write 内容被拒绝。9/9 全部通过。

回归

test/test-xml.js 全部通过，原有 read / write / exec / answer / done 行为无退化。

已知限制

Qwen 长回复中后段可能省略第二个及之后代码块的 markdown 围栏和语言标识，
这属于模型自身生成质量问题，DOM 和 fiber 里都没有这个信息，无法恢复。

Qwen 模型偶尔会输出畸形的 XML（如漏写 CDATA 闭合、重复 write 标签），
这时 extractXML 会报错，agent-core 会走 xml-error 重试路径，让模型重发。
