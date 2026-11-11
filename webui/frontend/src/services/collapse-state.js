/**
标题：卡片折叠状态（localStorage 持久化）

背景：插件列表、插件贡献的面板这两处都是"一屏塞很多块内容，全展开要滑好几屏"。
行为一致 —— 点一下记住、刷新还记住 —— 所以抽成一个组合式函数，不要各写一份读写。

语义约定：内部一律按"收起"存（true = 收起）。默认就是收起，因此 undefined 与 true
等价，只有用户明确展开过的才记 false。这样新装的插件无需初始化就自动是收起的。

用法：
    const { isOpen, toggle, toggleAll, allOpen, restore } = useCollapse(
        "xml-agent.plugins.collapsed",
        () => plugins.value.map((plugin) => plugin.name)
    );
    restore();                     // 挂载时调用一次，套回上次的状态
    isOpen("fetch");               // 模板里直接用
    toggle("fetch");               // 点一下头部
    toggleAll();                   // 全部展开 / 全部收起
*/

import { computed, reactive } from "vue";

function readStore(storageKey) {
    try {
        const raw = window.localStorage.getItem(storageKey);
        const parsed = raw ? JSON.parse(raw) : null;
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch (error) {
        // localStorage 被禁用（隐私模式）或内容损坏，当作没有记录
        return {};
    }
}

export function useCollapse(storageKey, keySource) {
    const state = reactive({});

    const keys = computed(() => {
        const list = typeof keySource === "function" ? keySource() : keySource;
        return Array.isArray(list) ? list.filter(Boolean) : [];
    });

    const allOpen = computed(
        () => keys.value.length > 0 && keys.value.every((key) => state[key] === false)
    );

    function isOpen(key) {
        return state[key] === false;
    }

    function persist() {
        try {
            const snapshot = {};
            for (const key of Object.keys(state)) {
                snapshot[key] = state[key] === true;
            }
            window.localStorage.setItem(storageKey, JSON.stringify(snapshot));
        } catch (error) {
            // 存不进去只影响"下次还记得"，面板本身照常工作
        }
    }

    /** 把上次记录的折叠状态套回当前卡片；没记录过的保持默认（收起） */
    function restore() {
        const stored = readStore(storageKey);
        for (const key of Object.keys(stored)) {
            state[key] = stored[key] === true;
        }
    }

    function toggle(key) {
        // 传对象进来会全都落到 "[object Object]" 这一个键上，几块卡片一起开合。
        // 默认值 undefined 也算收起，所以不能写 !isOpen()：那样第一次点击会停在"收起"。
        if (typeof key !== "string") {
            console.warn("[collapse-state] toggle() 需要字符串 key，收到 " + typeof key);
            return;
        }
        state[key] = isOpen(key);
        persist();
    }

    function toggleAll() {
        const expand = !allOpen.value;
        for (const key of keys.value) {
            state[key] = !expand;
        }
        persist();
    }

    return { isOpen, toggle, toggleAll, allOpen, restore };
}
