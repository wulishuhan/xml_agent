<template>
    <div class="history-mask" @click.self="$emit('close')">
        <section
            class="history-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="history-title"
        >
            <header class="history-header">
                <div class="history-heading">
                    <div class="history-icon">★</div>
                    <div>
                        <strong id="history-title">Session Reply History</strong>
                        <span>
                            {{
                                sessionId
                                    ? "Session #" + shortId(sessionId) + " · reply timeline"
                                    : "Reply timeline for the current session"
                            }}
                        </span>
                    </div>
                </div>
                <div class="history-header-actions">
                    <input
                        v-model="keyword"
                        type="text"
                        class="history-search"
                        placeholder="Search replies..."
                    />
                    <button
                        class="icon-button"
                        type="button"
                        aria-label="Close"
                        @click="$emit('close')"
                    >
                        ×
                    </button>
                </div>
            </header>
            <div class="history-body">
                <div v-if="loading" class="history-loading">Loading history...</div>
                <div v-else-if="errorMessage" class="history-error">{{ errorMessage }}</div>
                <div v-else-if="!sessionId" class="history-empty">
                    <div class="history-empty-orb">☆</div>
                    <strong>No session selected</strong>
                    <span>Select a session on the left, then open History.</span>
                </div>
                <div v-else-if="!replies.length" class="history-empty">
                    <div class="history-empty-orb">☆</div>
                    <strong>No replies yet</strong>
                    <span>Replies from this session will appear here once the agent answers.</span>
                </div>
                <div v-else class="history-columns">
                    <!-- 左栏：当前 session 的回复时间线 -->
                    <div class="timeline-column">
                        <div class="timeline-head">
                            <div class="timeline-title">
                                Session <code>#{{ shortId(sessionId) }}</code>
                            </div>
                            <div class="timeline-sub">
                                {{ replies.length }} reply(ies)
                                <span v-if="provider"> · {{ provider }}</span>
                                <span v-if="conversationId">
                                    · conversation
                                    <code>{{ shortId(conversationId) }}</code>
                                </span>
                            </div>
                        </div>
                        <ul class="timeline-list">
                            <li
                                v-for="(reply, replyIndex) in filteredReplies"
                                :key="reply.key"
                                class="timeline-item"
                                :class="{ active: selectedReplyKey === reply.key }"
                                @click="selectReply(reply)"
                            >
                                <div class="timeline-dot"></div>
                                <div class="timeline-content">
                                    <div class="timeline-item-top">
                                        <span class="timeline-order"
                                            >Reply {{ replyIndex + 1 }}</span
                                        >
                                        <span class="timeline-time">{{
                                            formatTime(reply.timestamp)
                                        }}</span>
                                    </div>
                                    <div class="timeline-title-line" :title="reply.title">
                                        {{ reply.title }}
                                    </div>
                                    <div class="timeline-preview">{{ reply.preview }}</div>
                                    <div class="timeline-status">
                                        <span
                                            class="history-status"
                                            :class="'history-status-' + reply.status"
                                            >{{ reply.status }}</span
                                        >
                                    </div>
                                </div>
                            </li>
                            <li v-if="!filteredReplies.length" class="timeline-empty">
                                No replies match "{{ keyword }}".
                            </li>
                        </ul>
                    </div>
                    <!-- 右栏：具体回复详情 -->
                    <div class="detail-column">
                        <div v-if="!selectedReply" class="detail-empty">
                            Select a reply on the left to read the full answer.
                        </div>
                        <template v-else>
                            <div class="detail-head">
                                <div class="detail-title" :title="selectedReply.title">
                                    {{ selectedReply.title }}
                                </div>
                                <div class="detail-sub">
                                    {{ selectedReply.provider }} ·
                                    {{ formatTime(selectedReply.timestamp) }} ·
                                    {{ selectedReply.status }}
                                    <span v-if="selectedReply.conversationId">
                                        · conversation
                                        <code>{{ shortId(selectedReply.conversationId) }}</code>
                                    </span>
                                </div>
                            </div>
                            <div
                                v-if="selectedReplyHtml"
                                class="detail-content markdown-body"
                                v-html="selectedReplyHtml"
                            ></div>
                            <pre v-else class="detail-content">{{ selectedReply.answer }}</pre>
                        </template>
                    </div>
                </div>
            </div>
        </section>
    </div>
</template>
<script setup>
    import { computed, onMounted, ref } from "vue";
    import { marked } from "marked";
    import { getSession, getSessionOutput } from "../services/agent-api.js";
    const props = defineProps({
        // 当前会话 id，History 只展示这个会话的回复。
        initialSessionId: { type: String, default: null },
    });
    const emit = defineEmits(["close"]);
    marked.setOptions({ gfm: true, breaks: false });
    const loading = ref(true);
    const errorMessage = ref("");
    const sessionId = ref(props.initialSessionId || null);
    const provider = ref("");
    const conversationId = ref("");
    const replies = ref([]);
    const keyword = ref("");
    const selectedReplyKey = ref(null);
    function normalizeAnswerEvent(item) {
        const event = item && item.event;
        if (
            event &&
            event.type === "runtime.result" &&
            event.action === "answer" &&
            event.result &&
            typeof event.result.content === "string"
        ) {
            return event.result.content;
        }
        return null;
    }
    function oneLine(text) {
        return String(text || "")
            .split("\n")
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
    }
    function makePreview(text) {
        const line = oneLine(text);
        return line.length > 100 ? line.slice(0, 100) + "..." : line;
    }
    // 每条回复的标题基于其自身内容，避免同一会话内多条回复标题相同。
    function makeReplyTitle(answer) {
        const text = String(answer || "").trim();
        if (!text) {
            return "Untitled reply";
        }
        const lines = text.split("\n");
        for (const line of lines) {
            const trimmed = line.replace(/^#+\s*/, "").trim();
            if (trimmed) {
                return trimmed.length > 70 ? trimmed.slice(0, 70) + "..." : trimmed;
            }
        }
        const line = oneLine(text);
        return line.length > 70 ? line.slice(0, 70) + "..." : line;
    }
    async function loadHistory() {
        if (!sessionId.value) {
            loading.value = false;
            return;
        }
        loading.value = true;
        errorMessage.value = "";
        try {
            const [info, outputResult] = await Promise.all([
                getSession(sessionId.value),
                getSessionOutput(sessionId.value),
            ]);
            provider.value = info.provider || "";
            conversationId.value = info.conversationId || "";
            const collected = [];
            for (const item of outputResult.output || []) {
                const content = normalizeAnswerEvent(item);
                if (content && content.trim()) {
                    const timestamp =
                        (item && item.timestamp) ||
                        info.finishedAt ||
                        info.startedAt ||
                        info.createdAt ||
                        Date.now();
                    collected.push({
                        key: sessionId.value + ":" + timestamp + ":" + collected.length,
                        sessionId: sessionId.value,
                        conversationId: info.conversationId || "",
                        provider: info.provider || "chatgpt",
                        status: info.status || "completed",
                        timestamp,
                        title: makeReplyTitle(content),
                        preview: makePreview(content),
                        answer: content,
                    });
                }
            }
            // 时间线按时间升序
            collected.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
            replies.value = collected;
            // 默认选中最新一条回复
            if (collected.length) {
                selectedReplyKey.value = collected[collected.length - 1].key;
            }
        } catch (error) {
            errorMessage.value = error.message;
        } finally {
            loading.value = false;
        }
    }
    const filteredReplies = computed(() => {
        const kw = keyword.value.trim().toLowerCase();
        if (!kw) {
            return replies.value;
        }
        return replies.value.filter((reply) => {
            if (reply.title.toLowerCase().includes(kw)) {
                return true;
            }
            return reply.answer.toLowerCase().includes(kw);
        });
    });
    const selectedReply = computed(() => {
        return replies.value.find((reply) => reply.key === selectedReplyKey.value) || null;
    });
    const selectedReplyHtml = computed(() => {
        const reply = selectedReply.value;
        if (!reply || !reply.answer.trim()) {
            return "";
        }
        try {
            const html = marked.parse(reply.answer);
            return typeof html === "string" ? html : "";
        } catch (error) {
            return "";
        }
    });
    function selectReply(reply) {
        selectedReplyKey.value = reply.key;
    }
    function shortId(id) {
        return id ? String(id).slice(0, 8) : "";
    }
    function formatTime(timestamp) {
        if (!timestamp) {
            return "";
        }
        return new Date(timestamp).toLocaleString([], {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
        });
    }
    onMounted(loadHistory);
</script>
<style scoped>
    .history-mask {
        position: fixed;
        z-index: 1150;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: var(--c-backdrop);
        backdrop-filter: blur(5px);
    }
    .history-panel {
        display: flex;
        width: min(1080px, 100%);
        height: min(780px, calc(100vh - 48px));
        flex-direction: column;
        overflow: hidden;
        border: 1px solid var(--c-border-strong);
        border-radius: 14px;
        background: var(--c-card-bg);
        box-shadow:
            0 24px 70px var(--c-shadow-strong),
            0 0 0 1px rgb(255 255 255 / 2%);
    }
    .history-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 16px 18px;
        border-bottom: 1px solid var(--c-border);
        background: var(--c-elevated-bg);
    }
    .history-heading {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 12px;
    }
    .history-icon {
        display: grid;
        width: 38px;
        height: 38px;
        flex: 0 0 38px;
        place-items: center;
        border: 1px solid var(--c-border-strong);
        border-radius: 9px;
        background: var(--c-raised-bg);
        font-size: 17px;
    }
    .history-heading strong {
        display: block;
        color: var(--c-text-strong);
        font-size: 14px;
        font-weight: 650;
    }
    .history-heading span {
        display: block;
        margin-top: 3px;
        color: var(--c-text-muted);
        font-size: 11px;
    }
    .history-header-actions {
        display: flex;
        align-items: center;
        gap: 10px;
    }
    .history-search {
        width: 240px;
        padding: 8px 11px;
        border: 1px solid var(--c-border-input);
        border-radius: 8px;
        background: var(--c-input-bg);
        color: var(--c-text);
        font-size: 12px;
        outline: none;
    }
    .history-search:focus {
        border-color: var(--c-accent-2);
    }
    .history-body {
        flex: 1;
        min-height: 0;
        overflow: hidden;
    }
    .history-loading {
        padding: 32px;
        color: var(--c-text-muted);
        text-align: center;
    }
    .history-error {
        margin: 16px 18px;
        padding: 8px 10px;
        border: 1px solid #7f1d1d;
        border-radius: 8px;
        background: rgb(127 29 29 / 22%);
        color: #fca5a5;
        font-size: 12px;
    }
    .history-empty {
        display: flex;
        height: 100%;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 8px;
        color: var(--c-text-muted);
        text-align: center;
    }
    .history-empty-orb {
        font-size: 30px;
        opacity: 0.6;
    }
    .history-empty strong {
        color: var(--c-text-strong);
    }
    .history-columns {
        display: flex;
        height: 100%;
    }

    /* 左栏：时间线 */
    .timeline-column {
        width: 320px;
        flex: 0 0 320px;
        overflow-y: auto;
        border-right: 1px solid var(--c-border-soft);
        background: var(--c-card-bg);
    }
    .timeline-head {
        padding: 12px 14px;
        border-bottom: 1px solid var(--c-border-soft);
        background: var(--c-elevated-bg);
    }
    .timeline-title {
        color: var(--c-text-strong);
        font-size: 13px;
        font-weight: 650;
    }
    .timeline-title code {
        color: var(--c-code);
        font-family: "Cascadia Code", Consolas, monospace;
    }
    .timeline-sub {
        margin-top: 3px;
        color: var(--c-text-muted);
        font-size: 11px;
    }
    .timeline-sub code {
        color: var(--c-code);
        font-family: "Cascadia Code", Consolas, monospace;
    }
    .timeline-list {
        margin: 0;
        padding: 8px 8px 8px 4px;
        list-style: none;
    }
    .timeline-empty {
        padding: 16px;
        color: var(--c-text-muted);
        font-size: 12px;
        text-align: center;
    }
    .timeline-item {
        position: relative;
        display: flex;
        gap: 10px;
        padding: 8px 8px 12px 18px;
        cursor: pointer;
    }
    .timeline-item::before {
        content: "";
        position: absolute;
        left: 8px;
        top: 16px;
        bottom: -4px;
        width: 2px;
        background: var(--c-border-soft);
    }
    .timeline-item:last-child::before {
        display: none;
    }
    .timeline-dot {
        position: absolute;
        left: 4px;
        top: 14px;
        width: 10px;
        height: 10px;
        border: 2px solid var(--c-accent-2);
        border-radius: 50%;
        background: var(--c-card-bg);
    }
    .timeline-content {
        flex: 1;
        min-width: 0;
        padding: 6px 10px;
        border: 1px solid transparent;
        border-radius: 8px;
        transition: background 0.12s ease;
    }
    .timeline-item:hover .timeline-content {
        background: var(--c-hover-bg);
    }
    .timeline-item.active .timeline-content {
        border-color: var(--c-accent-2);
        background: var(--c-elevated-bg);
    }
    .timeline-item-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
    }
    .timeline-order {
        color: var(--c-text-strong);
        font-size: 11px;
        font-weight: 650;
    }
    .timeline-time {
        color: var(--c-text-faint);
        font-size: 10px;
    }
    .timeline-title-line {
        margin-top: 3px;
        color: var(--c-text-strong);
        font-size: 12px;
        font-weight: 600;
        line-height: 1.4;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .timeline-preview {
        margin-top: 2px;
        color: var(--c-text-muted);
        font-size: 11px;
        line-height: 1.4;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .timeline-status {
        margin-top: 5px;
    }
    .history-status {
        padding: 1px 6px;
        border-radius: 4px;
        background: var(--c-raised-bg);
        color: var(--c-text-muted);
        font-size: 10px;
    }
    .history-status-completed {
        color: #4ade80;
    }
    .history-status-error {
        color: #f87171;
    }
    .history-status-stopped {
        color: #fbbf24;
    }

    /* 右栏：详情 */
    .detail-column {
        flex: 1;
        min-width: 0;
        padding: 18px 22px;
        overflow-y: auto;
    }
    .detail-empty {
        padding-top: 60px;
        color: var(--c-text-muted);
        text-align: center;
    }
    .detail-head {
        margin-bottom: 12px;
        padding-bottom: 12px;
        border-bottom: 1px solid var(--c-border-soft);
    }
    .detail-title {
        overflow: hidden;
        max-width: 100%;
        color: var(--c-text-strong);
        font-size: 15px;
        font-weight: 650;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .detail-sub {
        margin-top: 4px;
        color: var(--c-text-muted);
        font-size: 11px;
    }
    .detail-sub code {
        color: var(--c-code);
        font-family: "Cascadia Code", Consolas, monospace;
    }
    .detail-content {
        color: var(--c-text-body);
        font-size: 13px;
        line-height: 1.7;
        white-space: pre-wrap;
        word-break: break-word;
    }
    .detail-content.markdown-body {
        white-space: normal;
    }
    .icon-button {
        width: 32px;
        height: 32px;
        border: 1px solid var(--c-border-strong);
        border-radius: 8px;
        background: transparent;
        color: var(--c-text-muted);
        font-size: 18px;
        line-height: 1;
        cursor: pointer;
    }
    .icon-button:hover {
        background: var(--c-hover-bg);
    }
</style>
