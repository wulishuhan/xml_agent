/**
技能管理 API（Web 版与桌面版共用）

GET    /api/skills?workspace=            技能列表（含来源、启用状态、是否可读）
GET    /api/skills/:id?workspace=        读取一个技能的完整文档
PUT    /api/skills/:id                   保存文档（{ content, workspace? }，builtin 只读）
POST   /api/skills/:id/enabled           启用/禁用（{ enabled, workspace? }）
POST   /api/skills/:id/install           复制到工作区（{ workspace }）
DELETE /api/skills/:id?workspace=        从工作区移除

id 形如 `builtin:novel-writing` / `workspace:novel-writing`，由 skills/index.js 生成。
列表接口会顺带给出 `workspacePath`：只有非空才代表模型用 read 真能读到
（read 被沙箱限制在工作区内），前端据此显示"安装到工作区"按钮。
*/

const skills = require("../../skills");

function statusForError(error) {
    const code = (error && error.code) || "";
    if (code === "SKILL_NOT_FOUND") {
        return 404;
    }
    if (code === "SKILL_INVALID_ID") {
        return 400;
    }
    if (code === "SKILL_NOT_REMOVABLE" || code === "WORKSPACE_REQUIRED") {
        return 400;
    }
    if (code === "SKILL_READONLY") {
        return 403;
    }
    if (code === "SKILL_INVALID_CONTENT") {
        return 400;
    }
    if (code === "SKILL_TOO_LARGE") {
        return 413;
    }
    if (code === "WORKSPACE_NOT_FOUND") {
        return 400;
    }
    return 500;
}

function readWorkspace(source) {
    const value = source && typeof source === "string" ? source.trim() : "";
    return value;
}

function registerSkillRoutes(app) {
    /**
    包装一层：统一错误响应。
    label 会写进函数名 —— Express 把处理器注册成中间件层之后，路由表测试
    仍然能按名字认出它是谁。
    */
    function withSkills(handler, label) {
        const wrapped = async (req, res) => {
            try {
                return await handler(req, res);
            } catch (error) {
                return res.status(statusForError(error)).json({
                    error: error.message,
                    code: (error && error.code) || null,
                });
            }
        };
        if (label) {
            Object.defineProperty(wrapped, "name", { value: label });
        }
        return wrapped;
    }

    app.get(
        "/api/skills",
        withSkills((req, res) => {
            const workspace = readWorkspace(req.query && req.query.workspace);
            return res.json({
                workspace: workspace || null,
                sources: skills.SKILL_SOURCES,
                skills: skills.listSkills({ workspace: workspace || undefined }),
            });
        }, "listSkills")
    );

    app.get(
        "/api/skills/:id",
        withSkills((req, res) => {
            const workspace = readWorkspace(req.query && req.query.workspace);
            return res.json(skills.readSkill(req.params.id, { workspace: workspace || undefined }));
        }, "readSkill")
    );

    app.put(
        "/api/skills/:id",
        withSkills((req, res) => {
            const body = req.body || {};
            const workspace = readWorkspace(body.workspace);
            const result = skills.writeSkill(req.params.id, body.content, {
                workspace: workspace || undefined,
            });
            // writeSkill 自己带 message，这里不要再 Object.assign 一层去覆盖它
            return res.json(result);
        }, "writeSkill")
    );

    app.post(
        "/api/skills/:id/enabled",
        withSkills((req, res) => {
            const body = req.body || {};
            const workspace = readWorkspace(body.workspace);
            const enabled = body.enabled !== false;
            const result = skills.setSkillEnabled(req.params.id, enabled, {
                workspace: workspace || undefined,
            });
            return res.json(Object.assign({ message: "Skill state updated" }, result));
        }, "setSkillEnabled")
    );

    app.post(
        "/api/skills/:id/install",
        withSkills((req, res) => {
            const body = req.body || {};
            const workspace = readWorkspace(body.workspace);
            const result = skills.installSkill(req.params.id, workspace);
            return res.json(result);
        }, "installSkill")
    );

    app.delete(
        "/api/skills/:id",
        withSkills((req, res) => {
            const workspace = readWorkspace(req.query && req.query.workspace);
            const result = skills.removeSkill(req.params.id, workspace);
            return res.json(result);
        }, "removeSkill")
    );
}

module.exports = {
    registerSkillRoutes,
};
