
const playwright = require('playwright');

(async () => {
    try {
        const browser = await playwright.chromium.connectOverCDP('http://127.0.0.1:9222');
        const contexts = browser.contexts();
        if (!contexts.length) {
            console.log('No browser context found');
            await browser.close();
            return;
        }

        const pages = contexts[0].pages();
        let found = false;

        for (const page of pages) {
            const url = page.url();
            if (url.includes('chatgpt.com')) {
                found = true;
                console.log('Found ChatGPT page:', url);
                console.log('');

                const testSelectors = [
                    { name: 'div[role="textbox"]', selector: 'div[role="textbox"]' },
                    { name: '.ProseMirror', selector: '.ProseMirror' },
                    { name: '#prompt-textarea', selector: '#prompt-textarea' },
                    { name: '[contenteditable="true"]', selector: '[contenteditable="true"]' },
                ];

                const testMessage = '这是测试消息 - ' + new Date().toISOString();

                for (const item of testSelectors) {
                    console.log('=== 测试选择器: ' + item.name + ' ===');
                    try {
                        const locator = page.locator(item.selector);
                        const count = await locator.count();
                        if (count === 0) {
                            console.log(' 选择器不存在，跳过');
                            console.log('');
                            continue;
                        }

                        const input = locator.first();

                        // 1. 检查可见性
                        const visible = await input.isVisible().catch(() => false);
                        if (!visible) {
                            console.log(' 元素不可见，跳过');
                            console.log('');
                            continue;
                        }

                        console.log(' 元素可见');

                        // 2. 点击获取焦点
                        await input.click({ force: true });
                        console.log(' 点击成功');

                        // 3. 清空现有内容
                        await input.fill('');
                        await page.keyboard.press('Control+a');
                        await page.keyboard.press('Backspace');
                        console.log(' 清空成功');

                        // 4. 输入消息
                        await input.fill(testMessage);
                        console.log(' 填充消息: "' + testMessage + '"');

                        // 5. 验证输入内容
                        const actualValue = await input.textContent() || '';
                        console.log(' 实际内容: "' + actualValue + '"');

                        if (actualValue === testMessage) {
                            console.log(' ✅ 输入验证成功');
                        } else {
                            console.log(' ⚠️ 输入验证失败，尝试备用方法');
                            // 备用方法：使用键盘输入
                            await input.click({ force: true });
                            await page.keyboard.type(testMessage);
                            const newValue = await input.textContent() || '';
                            console.log(' 键盘输入后内容: "' + newValue + '"');
                        }

                        // 6. 测试发送 - 按 Enter
                        await page.keyboard.press('Enter');
                        console.log(' 按 Enter 发送');

                        // 7. 检查输入框是否清空
                        await page.waitForTimeout(500);
                        const afterSend = await input.textContent() || '';
                        console.log(' 发送后内容: "' + afterSend + '"');
                        if (afterSend === '') {
                            console.log(' ✅ 发送成功（输入框已清空）');
                        } else {
                            console.log(' ⚠️ 输入框未清空，可能需要其他发送方式');
                            // 尝试 Ctrl+Enter
                            await input.click({ force: true });
                            await input.fill(testMessage);
                            await page.keyboard.press('Control+Enter');
                            console.log(' 尝试 Ctrl+Enter 发送');
                        }

                        console.log('');
                    } catch (error) {
                        console.log(' 错误: ' + error.message);
                        console.log('');
                    }
                }

                // 等待一会查看结果
                await page.waitForTimeout(2000);
                break;
            }
        }

        if (!found) {
            console.log('ChatGPT page not found');
            console.log('Available pages:');
            for (const page of pages) {
                console.log(' -', page.url());
            }
        }

        await browser.close();
        console.log('测试完成');
    } catch (error) {
        console.error('Error:', error.message);
    }
})();
