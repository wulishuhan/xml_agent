import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "path";

export default defineConfig({
    root: path.resolve(__dirname),

    plugins: [vue()],

    server: {
        host: "127.0.0.1",
        port: 5173,

        proxy: {
            "/api": {
                target: "http://127.0.0.1:3000",
                changeOrigin: true,
            },
        },
    },
});
