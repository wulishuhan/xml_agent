/**
真机用例的公共护栏。

provider.send 内部已经有 responseTimeout 兜底，但那是"单次发送"的上限，
一轮综合测试跑十几条用例时，只靠它很难看出到底是哪一条卡住了。
这里在**用例级别**再加一道上限：超时按失败记录，让后面的用例继续跑，
而不是让整轮测试静默挂死。
*/

const DEFAULT_CASE_TIMEOUT = 9 * 60 * 1000;

async function sendWithTimeout(provider, prompt, timeoutMs) {
    const limit = timeoutMs || DEFAULT_CASE_TIMEOUT;
    const startedAt = Date.now();
    let timer = null;

    const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
            const error = new Error("case timed out after " + (Date.now() - startedAt) + "ms");

            error.code = "CASE_TIMEOUT";
            reject(error);
        }, limit);

        // 不让定时器拖住进程退出
        if (timer && typeof timer.unref === "function") {
            timer.unref();
        }
    });

    try {
        return await Promise.race([provider.send(prompt), timeout]);
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}

module.exports = {
    DEFAULT_CASE_TIMEOUT,
    sendWithTimeout,
};
