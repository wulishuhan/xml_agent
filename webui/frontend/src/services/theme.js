/**

主题管理：dark（默认）与 light 两套皮肤。

通过 <html data-theme="..."> 切换，CSS 变量随之改变。

用户选择持久化到 localStorage。

首次访问时若未设置，跟随系统 prefers-color-scheme。
*/

const STORAGE_KEY = "xml-agent:theme";
export const THEMES = ["dark", "light"];

export function normalizeTheme(value) {
    return THEMES.includes(value) ? value : "dark";
}

export function getStoredTheme() {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw) {
            return normalizeTheme(raw);
        }
    } catch (error) {
        // localStorage 不可用
    }
    return null;
}

export function getSystemTheme() {
    try {
        if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) {
            return "light";
        }
    } catch (error) {
        // matchMedia 不可用
    }
    return "dark";
}

export function resolveInitialTheme() {
    return getStoredTheme() || getSystemTheme();
}

export function applyTheme(theme) {
    const normalized = normalizeTheme(theme);
    try {
        document.documentElement.setAttribute("data-theme", normalized);
    } catch (error) {
        // document 不可用
    }
    return normalized;
}

export function persistTheme(theme) {
    try {
        window.localStorage.setItem(STORAGE_KEY, normalizeTheme(theme));
    } catch (error) {
        // 忽略持久化失败
    }
}

// 在应用挂载前尽早应用，避免主题闪烁。
export function initTheme() {
    const theme = applyTheme(resolveInitialTheme());
    return theme;
}
