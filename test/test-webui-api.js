
const http = require('http');
const path = require('path');

// 测试 WebUI API 是否能正确捕获输出
async function testWebUIAPI() {
    console.log('=== Testing WebUI API Output ===\n');

    const workspace = path.resolve(__dirname, '..');
    const task = '分析当前项目结构';

    // 1. 启动 Agent
    console.log('Test 1: Start agent via API');
    const startData = JSON.stringify({
        workspace: workspace,
        provider: 'chatgpt',
        task: task
    });

    const startOptions = {
        hostname: 'localhost',
        port: 3000,
        path: '/api/run',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(startData)
        }
    };

    const startResult = await new Promise((resolve, reject) => {
        const req = http.request(startOptions, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    resolve({ error: 'Parse error', raw: data });
                }
            });
        });
        req.on('error', reject);
        req.write(startData);
        req.end();
    });

    console.log('Start result:', startResult);

    if (startResult.error) {
        console.log('❌ Failed to start agent:', startResult.error);
        return;
    }

    // 2. 轮询输出
    console.log('\nTest 2: Poll output');
    let hasOutput = false;
    let pollCount = 0;
    const maxPolls = 30;

    while (pollCount < maxPolls) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        pollCount++;

        const outputResult = await new Promise((resolve, reject) => {
            const req = http.get('http://localhost:3000/api/output', (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        resolve({ error: 'Parse error', raw: data });
                    }
                });
            });
            req.on('error', reject);
        });

        if (outputResult.output && outputResult.output.length > 0) {
            hasOutput = true;
            console.log('📝 Output received, count:', outputResult.output.length);

            // 显示最后几条输出
            const lastItems = outputResult.output.slice(-5);
            for (const item of lastItems) {
                const preview = item.content.substring(0, 80);
                console.log(' [' + item.type + '] ' + preview + '...');
            }
        }

        if (outputResult.running === false && pollCount > 3) {
            console.log('✅ Agent finished');
            break;
        }
    }

    console.log('\n=== Test Results ===');
    console.log('Has output:', hasOutput);
    console.log('Poll count:', pollCount);

    if (hasOutput) {
        console.log('✅ WebUI API successfully captures output');
    } else {
        console.log('❌ WebUI API did not capture output');
    }
}

testWebUIAPI().catch(console.error);
