

# XML Agent 1.0.7 发布说明
本版本包含 4 项更新：新增 exec 权限控制按钮、侧边栏菜单改版、GLM 默认地址调整、发布说明文档迁移到 docs/ 目录。


## 一、新增：exec 权限控制按钮（WORKSPACE / ALL）

### 功能说明
任务输入区（Run Agent 旁）新增一个带锁形图标（🔒）的权限下拉按钮，用户可以在两个权限级别之间切换：

 WORKSPACE（默认）：Agent 的 read / write / screenshot 等文件操作被限制在当前工作区内，禁止绝对路径与 `../` 越权访问，与以往版本的安全边界一致。
 ALL：允许 Agent 通过绝对路径访问整台机器上的文件（仍保留基本安全检查，例如禁止包含 `..` 的不安全路径），适合需要跨目录读写文件的任务。


### 交互细节
 按钮实时显示当前权限级别（WORKSPACE / ALL），下拉菜单中高亮选中项。
 每次发送任务时，权限级别随 `/api/run` 请求传给后端；新任务开始后会自动重置回 WORKSPACE，避免上一次的高权限设置被无意延续。


### 实现链路
 `webui/frontend/src/components/TaskComposer.vue`：新增权限下拉按钮组件（permission dropdown），emit `update:execScope`。
 `webui/frontend/src/App.vue`：维护 `execScope` 状态（默认 workspace），随 payload 传给 `/api/run`，任务结束后重置。
 `webui/session/agent-session.js`：AgentSession 接收并保存 `execScope`，resume 时可更新，getInfo 中返回。
 `agent-core.js`：接收 `execScope` 并传给 Runtime。
 `runtime.js`：`Runtime(workspace, execScope)`，`resolvePath()` 按权限级别决定是否允许绝对路径；exec 命令的工作目录仍固定为 workspace。


### 安全提示
ALL 模式下 Agent 可以读写机器上任意合法路径，请在 trusted 任务中使用；日常任务建议保持默认的 WORKSPACE 模式。


## 二、优化：侧边栏菜单显示方式
侧边栏由平铺列表改为**按工作区分组**展示：

 每个工作区是一个可展开 / 折叠的分组，组头显示工作区名称与会话数量，点击箭头展开或收起。
 组头右侧 hover 显示"+"按钮，可直接在该工作区下新建会话。
 会话条目显示状态点（running 蓝色呼吸动画 / completed 绿色 / error 红色 / stopped 灰色 / interrupted 琥珀色）、任务标题（超长省略）、provider 与创建时间。
 会话条目 hover 显示删除按钮，删除前弹出二次确认对话框。
 底部保留存储占用指示条（会话数 / 磁盘占用），超限时会显示告警横幅。


## 三、调整：GLM 默认 URL
`config/agent-config.js` 中 GLM 的默认访问地址由 `https://chat.z.ai` 调整为 `https://zchat.z.ai`：

js
   
 

 
targetUrls: {
    deepseek: "https://chat.deepseek.com",
    qwen: "https://chat.qwen.ai",
    chatgpt: "https://chatgpt.com",
    glm: "https://zchat.z.ai",
}

 
 

使用 GLM 的用户请在新地址登录后再运行任务。如需覆盖，可通过修改该配置或环境变量完成。会话识别逻辑保持兼容（provider 的页面匹配同时覆盖新旧域名）。


## 四、调整：发布说明迁移到 docs/ 目录
全部版本发布说明（RELEASE_NOTES_1.0.1.md ~ 1.0.7.md）从仓库根目录迁移到 `docs/` 目录，根目录只保留 readme.md，项目结构更清晰。readme 的"更新日志"一节已同步指向新路径。


## 五、升级提示
 直接覆盖安装即可，用户设置与会话数据保存在 %APPDATA%/XMLAgent 下，不会被清除。
 升级前请先退出正在运行的旧版本（旧版 XMLAgent.exe 会占用 release/win-unpacked 下的文件）。
 如果你依赖 GLM，请确认在新地址 https://zchat.z.ai 已登录。
 默认权限级别为 WORKSPACE，行为与旧版本一致；需要跨目录操作时再手动切换到 ALL。
