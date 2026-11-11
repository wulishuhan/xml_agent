/**

多语言：en（默认）与 zh。

为什么默认英文：这是个开源项目，README、issue、release notes 都是英文，
海外用户打开界面不该先看到中文；中文用户可以一键切换，选择会记在
localStorage 里，下次打开还是中文。

约定：
- 键名用 "模块.用途"，方便一次看清某个面板用了哪些文案。
- t() 缺键时依次回退：当前语言 → 默认语言（en）→ 键名本身。
  回退到键名是有意的：开发时界面上直接显示 skills.foo，一眼能看出漏了哪条，
  比显示空白或抛错好排查。
- 插值用 {name} 占位，避免拼字符串时语序错乱（英文语序和中文不一样）。

用户选择持久化到 localStorage。
*/

import { ref } from "vue";

const STORAGE_KEY = "xml-agent:lang";
export const LANGS = ["en", "zh"];
// 首次打开、或 localStorage 里存了非法值时的兜底语言
export const DEFAULT_LANG = "en";

const DICT = {
    zh: {
        // ---------- 顶栏 ----------
        "app.trace": "轨迹",
        "app.traceTitle": "查看本会话的逐步执行过程",
        "app.history": "历史",
        "app.historyTitle": "查看本会话的历史回复",
        "app.plugins": "插件",
        "app.pluginsTitle": "管理插件、权限与插件配置",
        "app.skills": "技能",
        "app.skillsTitle": "浏览技能文档，并可安装到当前工作区",
        "app.settings": "设置",
        "app.browserSettings": "浏览器设置",
        "app.settingsTitle": "桌面端设置",
        "app.browserSettingsTitle": "浏览器端设置",
        "app.themeDarkLabel": "深色",
        "app.themeLightLabel": "浅色",
        "app.themeToLight": "切换到浅色主题",
        "app.themeToDark": "切换到深色主题",
        "app.langTitle": "切换到英文界面",
        "app.langSwitchTo": "English",
        "app.workspace": "工作区",
        "app.provider": "模型",
        "app.session": "会话",
        "app.conversation": "对话",
        "app.port": "端口",
        "app.agentError": "执行出错",
        // ---------- 上下文预算提醒 ----------
        "context.bannerTitle": "上下文已用 {percent}%",
        "context.bannerBody":
            "约 {used} / {limit} token。再往后平台会开始丢掉早期内容。转到新会话只带一页工作摘要，旧记录留在本会话。",
        "context.transfer": "转移并新开",
        "context.transferStop": "停止并转移",
        "context.transferring": "转移中…",
        "context.later": "稍后",
        "context.transferFailed": "记忆转移失败",
        "context.pluginDisabled":
            "记忆转移插件未启用：到 Plugins 面板启用 memory-transfer 后可用。",
        // 没到阈值也想换会话时的手动入口
        "context.usageLabel": "上下文",
        "context.usageHint": "这个会话在平台窗口里用掉了多少",
        "context.manual": "转移会话",
        "context.manualTitle": "转到新会话",
        "context.manualDigest": "只带摘要",
        "context.manualDigestBody": "任务、改过的文件、关键命令，最轻",
        "context.manualRecords": "带上完整记录",
        "context.manualRecordsBody": "旧记录全搬过去，新会话从新对话开始",
        "context.manualRunning": "会话正在运行，转移会先把它停掉",
        "context.manualCancel": "取消",
        "app.newSession": "新建会话",
        "app.newAgentSession": "新建 Agent 会话",
        "app.selectWorkspaceHint": "请先在左侧选择一个工作区",
        "app.status.created": "就绪",
        "app.status.running": "运行中",
        "app.status.completed": "已完成",
        "app.status.stopped": "已停止",
        "app.status.interrupted": "已中断",
        "app.status.error": "出错",
        "app.error.noWorkspace": "请先在左侧选择一个工作区，再运行 Agent。",
        "app.error.noTask": "请先描述任务，再运行 Agent。",

        // ---------- 左侧边栏 ----------
        "sidebar.newWorkspace": "新建工作区",
        "sidebar.workspaces": "工作区",
        "sidebar.storageFull": "会话存储已满",
        "sidebar.storageHigh": "会话存储偏高",
        "sidebar.storageHint": "请先删除旧会话腾出空间，再新建会话。",
        "sidebar.sessionsCount": "{n} 个会话",
        "sidebar.noWorkspaces": "还没有工作区",
        "sidebar.noWorkspacesHint": "添加一个工作区就能开始。",
        "sidebar.newSessionTitle": "在此工作区新建会话",
        "sidebar.deleteSession": "删除会话",
        "sidebar.localRuntime": "本地运行",
        "sidebar.storageTitle":
            "会话：{sessions}/{maxSessions} · 磁盘：{bytes}/{maxBytes} · 位置：{root}",
        "sidebar.deleteTitle": "删除这个会话？",
        "sidebar.deleteHint": "会一并删除它的历史与输出，无法撤销。",
        "sidebar.cancel": "取消",
        "sidebar.delete": "删除",

        // ---------- 任务输入框 ----------
        "composer.task": "任务",
        "composer.hint": "描述希望 Agent 在这个工作区做什么",
        "composer.continueLabel": "继续已有对话（可选）",
        "composer.continuePlaceholder": "粘贴会话 URL 或 id，以保持记忆连贯",
        "composer.clear": "清除",
        "composer.willContinue": "将接续对话：{id}",
        "composer.placeholder": "让 Agent 检查、修改、测试或解释你的项目…",
        "composer.removeImage": "移除图片",
        "composer.shortcutRun": "运行",
        "composer.attachFromDisk": "从磁盘选择图片",
        "composer.attachUpload": "上传图片到工作区",
        "composer.uploading": "上传中…",
        "composer.attach": "添加图片",
        "composer.previewImage": "查看原图",
        "composer.attachNoWorkspace": "请先选择工作区，再添加图片。",
        "composer.attachBadType": "{name} 不是支持的图片格式（png / jpg / webp / gif / bmp）",
        "composer.attachTooLarge": "{name} 超过 {size} MB，未添加",
        "composer.attachLimit": "最多 {max} 张图片，已忽略 {count} 张",
        "composer.attachSeparator": "；",
        "composer.attachFailed": "图片上传失败：{reason}",
        "composer.scopeWorkspaceTitle": "exec 限制在工作区内（安全）",
        "composer.scopeAllTitle": "exec 允许访问任意位置（不安全）",
        "composer.scopeWorkspaceOption": "工作区（安全）",
        "composer.scopeAllOption": "全部（不安全）",
        "composer.permissionWorkspace": "工作区",
        "composer.permissionAll": "全部",
        "composer.stop": "停止",
        "composer.run": "运行 Agent",

        // ---------- 输出区 ----------
        "console.title": "Agent 活动",
        "console.events": "{n} 条事件",
        "console.currentRunBadge": "第 {n} 次运行 · 当前",
        "console.onlyCurrentTitle": "只看本次运行",
        "console.allRunsTitle": "查看全部运行",
        "console.currentRun": "本次运行",
        "console.allRuns": "全部运行",
        "console.collapseAll": "全部折叠",
        "console.expandAll": "全部展开",
        "console.clear": "清空",
        "console.emptyNoSession": "开始一个新会话",
        "console.emptyNoSessionHint": "在下方描述任务并运行 Agent。",
        "console.emptyWaiting": "等待 Agent 输出",
        "console.emptyWaitingHint": "Agent 事件、运行时动作与结果会显示在这里。",
        "console.runLabel": "第 {n} 次",
        "console.current": "当前",
        "console.label.system": "系统",
        "console.label.error": "错误",
        "console.label.answer": "回答",
        "console.label.agent": "Agent",
        "console.label.event": "事件",

        // ---------- 选择工作区 ----------
        "picker.title": "选择工作区",
        "picker.subtitle": "选择一个项目目录",
        "picker.close": "关闭",
        "picker.location": "位置",
        "picker.loading": "读取中…",
        "picker.up": "← 上一层",
        "picker.drives": "磁盘",
        "picker.newFolder": "新建文件夹",
        "picker.select": "选择此目录",
        "picker.folderName": "文件夹名称",
        "picker.creating": "创建中…",
        "picker.create": "创建",
        "picker.cancel": "取消",
        "picker.browseError": "无法浏览",
        "picker.loadingFolders": "正在读取目录…",
        "picker.noSubdirs": "没有子目录",
        "picker.noSubdirsHint": "这个文件夹里没有任何子目录。",
        "picker.selectDrive": "选择一个磁盘来浏览项目",
        "picker.thisPc": "此电脑",
        "picker.onlyDirs": "只显示目录",
        "picker.noDoubleClick": "无需双击进入",

        // ---------- 技能面板 ----------
        "skills.title": "技能",
        "skills.loading": "正在读取技能…",
        "skills.summaryLoading": "读取中…",
        "skills.summaryEmpty": "没有技能",
        "skills.summary": "{total} 份文档 · {active} 个生效 · {workspace}",
        "skills.noWorkspaceShort": "未选择工作区",
        "skills.reload": "重新读取",
        "skills.reloadTitle": "从磁盘重新扫描技能",
        "skills.finishEditingFirst": "请先保存或取消编辑",
        "skills.working": "处理中…",
        "skills.close": "关闭",
        "skills.noWorkspaceTitle": "还没有选择工作区",
        "skills.noWorkspaceBody":
            "技能放在工作区里。请先在左侧选一个工作区再回来 —— 否则模型没有可读的文件。",
        "skills.emptyTitle": "没有找到技能",
        "skills.emptyBody":
            "把 Markdown 文件放进 <workspace>/.agent/skills/（或 ~/.xml-agent/skills/），再点“重新读取”。",
        "skills.group.workspace": "工作区",
        "skills.group.workspaceHint": ".agent/skills — 模型可读",
        "skills.group.user": "用户",
        "skills.group.userHint": "~/.xml-agent/skills",
        "skills.group.builtin": "内置",
        "skills.group.builtinHint": "随应用分发",
        "skills.selectHint": "在左侧选择一个技能即可查看全文。",
        "skills.flag.active": "生效中",
        "skills.flag.disabled": "已禁用",
        "skills.flag.overridden": "被覆盖",
        "skills.flag.activeTitle": "已进入首轮提示词",
        "skills.flag.disabledTitle": "不进入首轮提示词",
        "skills.flag.overriddenTitle": "{source} 层有一份同名副本优先级更高",
        "skills.badge.overridden": "被 {source} 覆盖",
        "skills.badge.disabled": "已禁用",
        "skills.toggle.enabled": "已启用",
        "skills.toggle.disabled": "已禁用",
        "skills.toggleTitle": "是否放进首轮提示词",
        "skills.edit": "编辑",
        "skills.copyEdit": "复制并编辑",
        "skills.editTitle": "直接修改这份文档",
        "skills.editBuiltinTitle": "内置技能只读 —— 先复制到工作区，再改那份副本",
        "skills.editNoWorkspaceTitle": "请先选择工作区 —— 内置技能是只读的",
        "skills.install": "安装到工作区",
        "skills.installTitle": "复制到 <workspace>/.agent/skills/，模型才能读到",
        "skills.installNeedsWorkspace": "请先选择工作区",
        "skills.remove": "移除",
        "skills.save": "保存",
        "skills.saveTitle": "保存（Ctrl/⌘+S）",
        "skills.cancel": "取消",
        "skills.unsaved": "未保存",
        "skills.meta.path": "路径",
        "skills.meta.readable": "模型可读",
        "skills.meta.notInWorkspace": "不在当前工作区内 —— 安装后才能被读取",
        "skills.meta.updated": "更新时间",
        "skills.meta.tags": "标签",
        "skills.editorStats": "{chars} 字符 · {lines} 行",
        "skills.editorHint": "Ctrl/⌘+S 保存 · 会整篇覆盖原文件",
        "skills.truncated": "文件超过 1 MB，内容已截断。",

        "skills.notice.saved": "已保存 —— 模型下一轮就会读到新版本",
        "skills.notice.copied": "已复制到工作区 —— 正在编辑那份副本",
        "skills.notice.installed": "已安装到工作区",
        "skills.notice.removed": "已从工作区移除",
        "skills.error.needWorkspace": "请先选择工作区 —— 内置技能是只读的。",
    },

    en: {
        // ---------- header ----------
        "app.trace": "Trace",
        "app.traceTitle": "View step-by-step action trace for this session",
        "app.history": "History",
        "app.historyTitle": "View reply history for this session",
        "app.plugins": "Plugins",
        "app.pluginsTitle": "Manage plugins, permissions and plugin configuration",
        "app.skills": "Skills",
        "app.skillsTitle": "Browse skill documents (and install them into this workspace)",
        "app.settings": "Settings",
        "app.browserSettings": "Browser Settings",
        "app.settingsTitle": "Desktop settings",
        "app.browserSettingsTitle": "Browser settings",
        "app.themeDarkLabel": "Dark",
        "app.themeLightLabel": "Light",
        "app.themeToLight": "Switch to light theme",
        "app.themeToDark": "Switch to dark theme",
        "app.langTitle": "Switch to Chinese interface",
        "app.langSwitchTo": "中文",
        "app.workspace": "Workspace",
        "app.provider": "Provider",
        "app.session": "Session",
        "app.conversation": "Conversation",
        "app.port": "Port",
        "app.agentError": "Agent error",
        // ---------- context budget ----------
        "context.bannerTitle": "Context {percent}% full",
        "context.bannerBody":
            "~{used} / {limit} tokens. Past this point the platform starts dropping earlier turns. Transferring brings a one-page work summary; the old records stay in this session.",
        "context.transfer": "Transfer to new session",
        "context.transferStop": "Stop and transfer",
        "context.transferring": "Transferring…",
        "context.later": "Later",
        "context.transferFailed": "Memory transfer failed",
        "context.pluginDisabled":
            "The memory-transfer plugin is not enabled. Turn it on in the Plugins panel.",
        // 没到阈值也想换会话时的手动入口
        "context.usageLabel": "Context",
        "context.usageHint": "How much of the platform window this session has used",
        "context.manual": "Move session",
        "context.manualTitle": "Move to a new session",
        "context.manualDigest": "Summary only",
        "context.manualDigestBody": "Task, touched files, key commands — the lightest option",
        "context.manualRecords": "With full records",
        "context.manualRecordsBody":
            "Copy every record over; the new session starts a fresh conversation",
        "context.manualRunning": "This session is running — moving it stops it first",
        "context.manualCancel": "Cancel",
        "app.newSession": "New Session",
        "app.newAgentSession": "New Agent Session",
        "app.selectWorkspaceHint": "Please select a workspace to begin",
        "app.status.created": "Ready",
        "app.status.running": "Running",
        "app.status.completed": "Completed",
        "app.status.stopped": "Stopped",
        "app.status.interrupted": "Interrupted",
        "app.status.error": "Error",
        "app.error.noWorkspace":
            "Please select a workspace from the sidebar before running the agent.",
        "app.error.noTask": "Please describe the task before running the agent.",

        // ---------- sidebar ----------
        "sidebar.newWorkspace": "New workspace",
        "sidebar.workspaces": "Workspaces",
        "sidebar.storageFull": "Session storage full",
        "sidebar.storageHigh": "Session storage high",
        "sidebar.storageHint": "Delete old sessions to free space before creating new ones.",
        "sidebar.sessionsCount": "{n} session(s)",
        "sidebar.noWorkspaces": "No workspaces",
        "sidebar.noWorkspacesHint": "Add a workspace to start working.",
        "sidebar.newSessionTitle": "New session in this workspace",
        "sidebar.deleteSession": "Delete session",
        "sidebar.localRuntime": "Local Runtime",
        "sidebar.storageTitle":
            "Sessions: {sessions}/{maxSessions} - Disk: {bytes}/{maxBytes} - Location: {root}",
        "sidebar.deleteTitle": "Delete this session?",
        "sidebar.deleteHint":
            "This removes its history and output from local storage. It cannot be undone.",
        "sidebar.cancel": "Cancel",
        "sidebar.delete": "Delete",

        // ---------- composer ----------
        "composer.task": "Task",
        "composer.hint": "Describe what the agent should do in this workspace",
        "composer.continueLabel": "Continue from conversation (optional)",
        "composer.continuePlaceholder":
            "Paste an existing conversation URL or id to keep memory in sync",
        "composer.clear": "Clear",
        "composer.willContinue": "Will continue conversation: {id}",
        "composer.placeholder":
            "Ask the agent to inspect, modify, test, or explain your project...",
        "composer.removeImage": "Remove image",
        "composer.shortcutRun": "to run",
        "composer.attachFromDisk": "Attach images from disk",
        "composer.attachUpload": "Upload images to workspace",
        "composer.uploading": "Uploading...",
        "composer.attach": "Attach images",
        "composer.previewImage": "Open the original image",
        "composer.attachNoWorkspace": "Select a workspace before attaching images.",
        "composer.attachBadType":
            "{name} is not a supported image type (png / jpg / webp / gif / bmp)",
        "composer.attachTooLarge": "{name} is larger than {size} MB and was skipped",
        "composer.attachLimit": "Up to {max} images — {count} skipped",
        "composer.attachSeparator": "; ",
        "composer.attachFailed": "Image upload failed: {reason}",
        "composer.scopeWorkspaceTitle": "Exec restricted to workspace (safe)",
        "composer.scopeAllTitle": "Exec allowed everywhere (unsafe)",
        "composer.scopeWorkspaceOption": "WORKSPACE (Safe)",
        "composer.scopeAllOption": "ALL (Unsafe)",
        "composer.permissionWorkspace": "WORKSPACE",
        "composer.permissionAll": "ALL",
        "composer.stop": "Stop",
        "composer.run": "Run Agent",

        // ---------- console ----------
        "console.title": "Agent Activity",
        "console.events": "{n} events",
        "console.currentRunBadge": "Run {n} · current",
        "console.onlyCurrentTitle": "Show only current run",
        "console.allRunsTitle": "Show all runs",
        "console.currentRun": "Current run",
        "console.allRuns": "All runs",
        "console.collapseAll": "Collapse all",
        "console.expandAll": "Expand all",
        "console.clear": "Clear",
        "console.emptyNoSession": "Start a new session",
        "console.emptyNoSessionHint": "Describe your task below and run the agent.",
        "console.emptyWaiting": "Waiting for agent activity",
        "console.emptyWaitingHint": "Agent events, runtime actions and results will appear here.",
        "console.runLabel": "Run {n}",
        "console.current": "current",
        "console.label.system": "System",
        "console.label.error": "Error",
        "console.label.answer": "Answer",
        "console.label.agent": "Agent",
        "console.label.event": "Event",

        // ---------- workspace picker ----------
        "picker.title": "Select Workspace",
        "picker.subtitle": "Choose a project directory",
        "picker.close": "Close",
        "picker.location": "Location",
        "picker.loading": "Loading...",
        "picker.up": "← Up",
        "picker.drives": "Drives",
        "picker.newFolder": "New Folder",
        "picker.select": "Select this folder",
        "picker.folderName": "Folder name",
        "picker.creating": "Creating...",
        "picker.create": "Create",
        "picker.cancel": "Cancel",
        "picker.browseError": "Unable to browse",
        "picker.loadingFolders": "Loading folders...",
        "picker.noSubdirs": "No subdirectories",
        "picker.noSubdirsHint": "This folder does not contain any directories.",
        "picker.selectDrive": "Select a drive to browse projects",
        "picker.thisPc": "This PC",
        "picker.onlyDirs": "Only directories are shown",
        "picker.noDoubleClick": "Double-click navigation is not required",

        // ---------- skills ----------
        "skills.title": "Skills",
        "skills.loading": "Loading skills...",
        "skills.summaryLoading": "Loading...",
        "skills.summaryEmpty": "No skills",
        "skills.summary": "{total} document(s) · {active} active · {workspace}",
        "skills.noWorkspaceShort": "no workspace",
        "skills.reload": "Reload",
        "skills.reloadTitle": "Reload skills from disk",
        "skills.finishEditingFirst": "Finish or cancel editing first",
        "skills.working": "Working...",
        "skills.close": "Close",
        "skills.noWorkspaceTitle": "No workspace selected",
        "skills.noWorkspaceBody":
            "Skills live inside a workspace. Pick a workspace on the left, then come back — otherwise the agent has nothing to read.",
        "skills.emptyTitle": "No skills found",
        "skills.emptyBody":
            "Drop a Markdown file into <workspace>/.agent/skills/ (or ~/.xml-agent/skills/), then press Reload.",
        "skills.group.workspace": "Workspace",
        "skills.group.workspaceHint": ".agent/skills — readable",
        "skills.group.user": "User",
        "skills.group.userHint": "~/.xml-agent/skills",
        "skills.group.builtin": "Built-in",
        "skills.group.builtinHint": "shipped with the app",
        "skills.selectHint": "Select a skill on the left to read it.",
        "skills.flag.active": "active",
        "skills.flag.disabled": "disabled",
        "skills.flag.overridden": "overridden",
        "skills.flag.activeTitle": "Used in the first prompt",
        "skills.flag.disabledTitle": "Excluded from the first prompt",
        "skills.flag.overriddenTitle": "A copy in {source} takes precedence",
        "skills.badge.overridden": "overridden by {source}",
        "skills.badge.disabled": "disabled",
        "skills.toggle.enabled": "Enabled",
        "skills.toggle.disabled": "Disabled",
        "skills.toggleTitle": "Include in prompt",
        "skills.edit": "Edit",
        "skills.copyEdit": "Copy & edit",
        "skills.editTitle": "Edit this document in place",
        "skills.editBuiltinTitle":
            "Built-in skills are read-only — copy it into the workspace and edit that copy",
        "skills.editNoWorkspaceTitle": "Select a workspace first — built-in skills are read-only",
        "skills.install": "Install to workspace",
        "skills.installTitle": "Copy into <workspace>/.agent/skills/ so the agent can read it",
        "skills.installNeedsWorkspace": "Select a workspace first",
        "skills.remove": "Remove",
        "skills.save": "Save",
        "skills.saveTitle": "Save (Ctrl/⌘+S)",
        "skills.cancel": "Cancel",
        "skills.unsaved": "unsaved",
        "skills.meta.path": "Path",
        "skills.meta.readable": "Readable by agent",
        "skills.meta.notInWorkspace": "not inside this workspace — install it to use it",
        "skills.meta.updated": "Updated",
        "skills.meta.tags": "Tags",
        "skills.editorStats": "{chars} chars · {lines} lines",
        "skills.editorHint": "Ctrl/⌘+S saves · the whole file is replaced",
        "skills.truncated": "File is larger than 1 MB — content truncated.",

        "skills.notice.saved": "Saved — the agent reads the new version on its next turn",
        "skills.notice.copied": "Copied into the workspace — editing that copy",
        "skills.notice.installed": "Installed into the workspace",
        "skills.notice.removed": "Removed from workspace",
        "skills.error.needWorkspace": "Select a workspace first — built-in skills are read-only.",
    },
};

export function normalizeLang(value) {
    return LANGS.includes(value) ? value : DEFAULT_LANG;
}

export function getStoredLang() {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw) {
            return normalizeLang(raw);
        }
    } catch (error) {
        // localStorage 不可用
    }
    return null;
}

export function resolveInitialLang() {
    return getStoredLang() || DEFAULT_LANG;
}

// 用 ref 是为了切语言时界面立刻跟着变（模板里读 lang.value 会建立依赖）
export const lang = ref(resolveInitialLang());

export function setLang(next) {
    const normalized = normalizeLang(next);
    lang.value = normalized;
    try {
        window.localStorage.setItem(STORAGE_KEY, normalized);
    } catch (error) {
        // 忽略持久化失败
    }
    try {
        document.documentElement.setAttribute("lang", normalized === "zh" ? "zh-CN" : "en");
    } catch (error) {
        // document 不可用
    }
    return normalized;
}

export function toggleLang() {
    return setLang(lang.value === "zh" ? "en" : "zh");
}

// 在应用挂载前把 <html lang> 设好（影响屏幕阅读器与浏览器断词规则）
export function initLang() {
    try {
        document.documentElement.setAttribute("lang", lang.value === "zh" ? "zh-CN" : "en");
    } catch (error) {
        // document 不可用
    }
    return lang.value;
}

/**
取文案。vars 里的值替换 {name} 占位。
缺键回退到默认语言（en），再回退到键名本身（见文件头说明）。
*/
export function t(key, vars) {
    const table = DICT[lang.value] || DICT[DEFAULT_LANG];
    let text = table[key];

    if (text === undefined) {
        text = DICT[DEFAULT_LANG][key];
    }
    if (text === undefined) {
        return key;
    }
    if (!vars) {
        return text;
    }
    return text.replace(/\{(\w+)\}/g, (match, name) => {
        return vars[name] === undefined ? match : String(vars[name]);
    });
}
