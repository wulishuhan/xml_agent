/**
 * 重试退避策略

从 Agent.runStep 里抽出的纯函数：不依赖 Agent、浏览器、事件系统，
因此可以单独断言"第几次连续失败该等多久"，而不必启动整条链路。

指数退避：1s → 2s → 4s → 8s → … → 上限 30s
*/

const DEFAULT_BASE_MS = 1000;
const DEFAULT_MAX_MS = 30000;

/**
 * 第 attempt 次连续失败后应等待的毫秒数（attempt 从 1 开始计数）。
 *
 * @param {number} attempt 连续失败次数，1 表示第一次失败
 * @param {{ baseMs?: number, maxMs?: number }} [options] 覆盖默认步长与上限
 * @returns {number} 建议等待的毫秒数
 */
function nextDelay(attempt, options = {}) {
    const base = options.baseMs || DEFAULT_BASE_MS;
    const max = options.maxMs || DEFAULT_MAX_MS;
    // 防御非法入参：非数字 / 0 / 负数一律按第一次失败处理。
    const normalized = Math.max(1, Math.floor(Number(attempt) || 1));
    return Math.min(base * Math.pow(2, normalized - 1), max);
}

module.exports = {
    nextDelay,
    DEFAULT_BASE_MS,
    DEFAULT_MAX_MS,
};
