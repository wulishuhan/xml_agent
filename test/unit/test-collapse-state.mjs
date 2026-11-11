/**
collapse-state.js（卡片折叠状态）的单元测试

背景：插件列表和插件贡献的面板都要"点一下记住、刷新还记住"。逻辑抽成
useCollapse() 之后，有两个坑值得钉住：

1. 默认收起时内部存的是 undefined，如果 toggle 写成 !isOpen()，
   第一次点击会算成"收起"，看起来像没反应（改的时候真踩了）；
2. 调用方把整块对象当 key 传进去，所有卡片会挤到 "[object Object]" 这一个键上，
   点一个全开/全关（改的时候也踩了）。

运行：node --no-warnings test/unit/test-collapse-state.mjs
（--no-warnings 只是压掉"检测到 ESM 语法"的提示，这个文件是 ESM，
  而项目 package.json 没有 type:module，Node 会先按 CJS 解析一次。）
*/

import assert from "node:assert";

const { useCollapse } = await import("../../webui/frontend/src/services/collapse-state.js");

const checks = [];
function check(name, fn) {
    checks.push({ name, fn });
}

/** 假 localStorage：只需要 getItem / setItem，外加能看到写入内容 */
function fakeStorage(initial) {
    const store = new Map(Object.entries(initial || {}));
    return {
        getItem(key) {
            return store.has(key) ? store.get(key) : null;
        },
        setItem(key, value) {
            store.set(key, value);
        },
        read(key) {
            const raw = store.get(key);
            return raw === undefined ? null : JSON.parse(raw);
        },
    };
}

function withStorage(storage, fn) {
    globalThis.window = { localStorage: storage };
    return fn();
}

const STORAGE_KEY = "test.collapsed";

// ---------------------------------------------------------------

check("默认收起：没有记录过的 key 都算收起", () => {
    withStorage(fakeStorage(), () => {
        const { isOpen, allOpen } = useCollapse(STORAGE_KEY, () => ["a", "b"]);
        assert.strictEqual(isOpen("a"), false);
        assert.strictEqual(isOpen("b"), false);
        assert.strictEqual(isOpen("没见过的插件"), false);
        assert.strictEqual(allOpen.value, false);
    });
});

check("第一次 toggle 就是展开（不能停在收起）", () => {
    withStorage(fakeStorage(), () => {
        const { isOpen, toggle } = useCollapse(STORAGE_KEY, () => ["a"]);
        toggle("a");
        assert.strictEqual(isOpen("a"), true);
    });
});

check("再 toggle 一次回到收起", () => {
    withStorage(fakeStorage(), () => {
        const { isOpen, toggle } = useCollapse(STORAGE_KEY, () => ["a"]);
        toggle("a");
        toggle("a");
        assert.strictEqual(isOpen("a"), false);
    });
});

check("toggle 只影响自己这一张卡片", () => {
    withStorage(fakeStorage(), () => {
        const { isOpen, toggle } = useCollapse(STORAGE_KEY, () => ["a", "b"]);
        toggle("a");
        assert.strictEqual(isOpen("a"), true);
        assert.strictEqual(isOpen("b"), false);
    });
});

check("传对象当 key 时不改状态并给出告警", () => {
    const storage = fakeStorage();
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (message) => warnings.push(String(message));

    try {
        withStorage(storage, () => {
            const { isOpen, toggle } = useCollapse(STORAGE_KEY, () => ["a", "b"]);
            toggle({ name: "a" });
            assert.strictEqual(isOpen("a"), false, "不能因为传错类型就把卡片打开");
            assert.strictEqual(isOpen("b"), false);
        });
    } finally {
        console.warn = originalWarn;
    }

    assert.strictEqual(warnings.length, 1, "应当告警一次");
    assert.ok(warnings[0].indexOf("字符串 key") !== -1, "告警内容要说明原因");
});

check("allOpen 全部展开才为真", () => {
    withStorage(fakeStorage(), () => {
        const { toggle, allOpen } = useCollapse(STORAGE_KEY, () => ["a", "b"]);
        toggle("a");
        assert.strictEqual(allOpen.value, false);
        toggle("b");
        assert.strictEqual(allOpen.value, true, "两个都展开了，allOpen 应为真");
    });
});

check("key 列表为空时 allOpen 为假（没有可展开的东西）", () => {
    withStorage(fakeStorage(), () => {
        const { allOpen } = useCollapse(STORAGE_KEY, () => []);
        assert.strictEqual(allOpen.value, false);
    });
});

check("toggleAll 从全收起变全展开，再点回全收起", () => {
    withStorage(fakeStorage(), () => {
        const { isOpen, toggleAll, allOpen } = useCollapse(STORAGE_KEY, () => ["a", "b", "c"]);

        toggleAll();
        assert.strictEqual(allOpen.value, true);
        for (const key of ["a", "b", "c"]) {
            assert.strictEqual(isOpen(key), true, key + " 应当展开");
        }

        toggleAll();
        assert.strictEqual(allOpen.value, false);
        for (const key of ["a", "b", "c"]) {
            assert.strictEqual(isOpen(key), false, key + " 应当收起");
        }
    });
});

check("toggleAll 在部分展开时补齐为全展开", () => {
    withStorage(fakeStorage(), () => {
        const { isOpen, toggle, toggleAll, allOpen } = useCollapse(STORAGE_KEY, () => ["a", "b"]);
        toggle("a");
        toggleAll();
        assert.strictEqual(allOpen.value, true);
        assert.strictEqual(isOpen("b"), true, "没展开的也要补上");
    });
});

check("落盘的语义是「收起 = true，展开 = false」", () => {
    const storage = fakeStorage();
    withStorage(storage, () => {
        const { toggle } = useCollapse(STORAGE_KEY, () => ["a"]);
        toggle("a");
        assert.deepStrictEqual(storage.read(STORAGE_KEY), { a: false }, "展开记 false");

        toggle("a");
        assert.deepStrictEqual(storage.read(STORAGE_KEY), { a: true }, "收起记 true");
    });
});

check("restore 套回上次的展开状态", () => {
    const storage = fakeStorage({ [STORAGE_KEY]: JSON.stringify({ a: false, b: true }) });
    withStorage(storage, () => {
        const { isOpen, restore } = useCollapse(STORAGE_KEY, () => ["a", "b", "c"]);
        restore();
        assert.strictEqual(isOpen("a"), true, "a 上次是展开的");
        assert.strictEqual(isOpen("b"), false, "b 上次是收起的");
        assert.strictEqual(isOpen("c"), false, "c 没有记录，按默认收起");
    });
});

check("存储内容损坏时按没有记录处理", () => {
    const storage = fakeStorage({ [STORAGE_KEY]: "{不是 JSON" });
    withStorage(storage, () => {
        const { isOpen, restore } = useCollapse(STORAGE_KEY, () => ["a"]);
        restore();
        assert.strictEqual(isOpen("a"), false);
    });
});

check("localStorage 抛异常时不影响折叠本身", () => {
    const storage = {
        getItem() {
            throw new Error("blocked");
        },
        setItem() {
            throw new Error("quota");
        },
    };

    withStorage(storage, () => {
        const { isOpen, toggle, restore } = useCollapse(STORAGE_KEY, () => ["a"]);
        restore();
        toggle("a");
        assert.strictEqual(isOpen("a"), true, "存不进去也要能展开");
    });
});

// ---------------------------------------------------------------

let failed = 0;
for (const item of checks) {
    try {
        item.fn();
        console.log("PASS - " + item.name);
    } catch (error) {
        failed++;
        console.log("  FAIL " + item.name);
        console.log("       " + (error && error.message));
    }
}
console.log("");
if (failed) {
    console.log("test-collapse-state: " + failed + "/" + checks.length + " FAILED");
    process.exit(1);
}
console.log("test-collapse-state: " + checks.length + "/" + checks.length + " PASS");
