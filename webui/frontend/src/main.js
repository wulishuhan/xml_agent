import { createApp } from "vue";
import App from "./App.vue";
import "./styles/app.css";
import { initTheme } from "./services/theme.js";
import { initLang } from "./services/i18n.js";

// 在挂载前尽早应用主题与语言，避免首屏闪烁 / 语言错位。
initTheme();
initLang();

createApp(App).mount("#app");
