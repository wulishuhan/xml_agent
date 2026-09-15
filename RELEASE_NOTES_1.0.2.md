XML Agent 1.0.2

下载（三选一）

XMLAgent-Setup-1.0.2-x64.exe（推荐）
Windows 安装程序。支持自定义安装目录，自动创建桌面与开始菜单快捷方式，可在控制面板卸载。

XMLAgent-Portable-1.0.2-x64.exe
免安装单文件版。双击即用，不写注册表，适合放在 U 盘里携带。

XMLAgent-1.0.2-x64.zip
zip 免安装压缩包。解压到任意目录后双击 XMLAgent.exe 运行，
适合内网 / 离线部署或需要自己控制解压位置的场景。

运行要求

Windows 10 / 11（x64）

本机已安装 Google Chrome（Agent 通过 CDP 复用 Chrome，不自带浏览器）

使用 ChatGPT / DeepSeek / Qwen 时需要有对应账号并已在 Chrome 中登录

1.0.2 更新内容

会话存储上限与磁盘占用管理

新增会话数量上限与磁盘占用上限，避免长期使用后会话无限累积占满磁盘。

配置项位于 config/agent-config.js 的 session 块：
maxSessions 最多保存的会话数量，默认 100
maxDiskBytes 会话存储目录最大占用，默认 200MB
warnThreshold 告警阈值，默认 0.8（达到上限的 80% 开始告警）

达到上限后创建新会话会返回明确提示（错误码 MAX_SESSIONS / MAX_DISK），
引导用户先删除旧会话；删除会话会同步清理磁盘文件并释放名额。

WebUI 侧边栏新增存储占用告警条与占用指示条，
达到阈值时显示橙色提示，悬停可查看会话数、磁盘占用与存储目录路径。

支持环境变量覆盖：WEBUI_MAX_SESSIONS、WEBUI_MAX_DISK_BYTES、WEBUI_WARN_THRESHOLD。

新增存储相关接口：GET /api/storage、POST /api/storage/clean；
启动时会自动清理上次异常退出遗留的 .tmp 临时文件。

Final Answer 显示优化

去掉 Final Answer 卡片的内部滚动条，改为完整展开，
滚动统一交给外层容器，解决“内外双滚动条”的问题。

Final Answer 字体从 13px 增大到 15px，行高调整为 1.85，更醒目易读。

代码风格统一

合并 .prettierrc 与 .prettierrc.json 为单一配置，消除规则冲突。

修正 .editorconfig 中的语法错误与缩进冲突。

.vscode/settings.json 为常见语言显式指定 Prettier 默认格式化器，
并新增 .vscode/extensions.json 推荐 Prettier 扩展，
修复 ALT+SHIFT+F 无法格式化的问题。

package.json 新增脚本：npm run format、npm run format:check。

无用代码清理

删除无引用的冗余文件：debug-chatgpt.js、main.js（旧版重复实现）、
providers/chatgpt-fixed.js、webui 中未使用的 AgentStatus.vue 与 SessionInfo.vue。

清理 package.json 中指向不存在文件的失效脚本，项目结构更简洁。

新增测试

test/test-session-limit.js：会话数量上限、磁盘上限、删除释放、统计与格式化用例。

test/test-storage-api.js：验证 /api/storage 与 /api/sessions 返回结构。
