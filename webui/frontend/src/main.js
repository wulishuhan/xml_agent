import { createApp } from "vue";
import App from "./App.vue";
import "./styles/app.css";
import { initTheme } from "./services/theme.js";

// 在挂载前尽早应用主题，避免首屏闪烁。
initTheme();

createApp(App).mount("#app");
