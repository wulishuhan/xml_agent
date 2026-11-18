/**
 * 浏览器会话并发闸门（FIFO 队列 + 槽位）。
 *
 * 为什么需要它：DeepSeek/ChatGPT 等网页版对单账号的高频请求敏感，
 * 多个会话在同一浏览器上同时跑会把请求速率推高到"不像人"的水平。
 * 默认 browser.maxConcurrentSessions=1：第二个会话进入排队，
 * 等前一个会话结束（完成/失败/停止）后自动启动。
 *
 * 队列只存在于进程内存：进程重启后排队信息丢失，会话会回到 created 状态。
 */

const { EventEmitter } = require("events");

class RunGate extends EventEmitter {
    constructor() {
        super();
        // 已获得槽位的 session id
        this.held = new Set();
        // FIFO 队列：[{ id, resume }]
        this.waiting = [];
    }

    /**
     * 当前允许并发的会话数。0 表示不限。
     * 每次判定都重读配置：运行中调小会立刻挡住新的 acquire；调大则在下一次
     * acquire / release 触发 _drain 时才生效（配置改动建议重启 WebUI）。
     */
    limit() {
        let raw = null;
        try {
            const agentConfig = require("../../config/agent-config");
            raw = agentConfig.browser.maxConcurrentSessions;
        } catch (error) {
            raw = null;
        }
        const value = Number(raw);
        if (!Number.isFinite(value) || value <= 0) {
            return 0;
        }
        return Math.floor(value);
    }

    activeCount() {
        return this.held.size;
    }

    queuedCount() {
        return this.waiting.length;
    }

    isHeld(id) {
        return this.held.has(id);
    }

    isQueued(id) {
        return this.waiting.some((item) => item.id === id);
    }

    /**
     * @returns {number|null} 队列位置（从 1 开始），未排队返回 null
     */
    positionOf(id) {
        const idx = this.waiting.findIndex((item) => item.id === id);
        return idx === -1 ? null : idx + 1;
    }

    /**
     * 尝试获取一个槽位。已持有则直接成功（幂等）。
     * @returns {boolean} 是否获得槽位
     */
    acquire(id) {
        if (this.held.has(id)) {
            return true;
        }
        const limit = this.limit();
        if (limit === 0 || this.held.size < limit) {
            this.held.add(id);
            return true;
        }
        return false;
    }

    /**
     * 登记排队；槽位释放时自动调用 resume。
     */
    enqueue(id, resume) {
        const existing = this.waiting.findIndex((item) => item.id === id);
        if (existing !== -1) {
            if (typeof resume === "function") {
                this.waiting[existing].resume = resume;
            }
            return;
        }
        this.waiting.push({ id, resume: typeof resume === "function" ? resume : null });
    }

    /**
     * 释放槽位并尝试唤醒下一个排队会话。幂等。
     * @returns {string|null} 被唤醒的 session id
     */
    release(id) {
        const wasHeld = this.held.delete(id);
        const idx = this.waiting.findIndex((item) => item.id === id);
        if (idx !== -1) {
            this.waiting.splice(idx, 1);
        }
        if (!wasHeld && idx === -1) {
            return null;
        }
        return this._drain();
    }

    /**
     * 依次取出排队中的会话授予槽位并唤醒。返回最后一个被唤醒的 id。
     */
    _drain() {
        let last = null;
        while (this.waiting.length) {
            const limit = this.limit();
            if (limit !== 0 && this.held.size >= limit) {
                break;
            }
            // position 必须在 shift 之前取：出队后 positionOf 恒为 null。
            const position = this.positionOf(this.waiting[0].id) || 1;
            const next = this.waiting.shift();
            if (!next || this.held.has(next.id)) {
                continue;
            }
            this.held.add(next.id);
            this.emit("acquired", { id: next.id, position });
            last = next.id;
            if (typeof next.resume !== "function") {
                // 没有启动回调却占着槽位会让队列永久卡死，直接回收。
                this.held.delete(next.id);
                this.emit("resume.error", { id: next.id, message: "missing resume handler" });
                continue;
            }
            try {
                next.resume();
            } catch (error) {
                // 唤醒回调抛错不能冒泡到 release()（否则会打断上一个会话的
                // finally），也不能让这个 id 占着槽位；回收后继续唤醒下一个。
                this.held.delete(next.id);
                this.emit("resume.error", { id: next.id, message: error.message });
            }
        }
        return last;
    }
}

const runGate = new RunGate();

module.exports = { RunGate, runGate };
