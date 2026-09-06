
const path = require('path');
const { spawn } = require('child_process');

// 模拟 WebUI 的 API 测试
async function testWebUIOutput() {
    console.log('=== Testing WebUI Output Capture ===\n');

    // 1. 模拟运行 Agent
    console.log('Test 1: Start agent and capture output');

    const workspace = path.resolve(__dirname, '..');
    const task = '分析当前项目结构';

    const args = [
        'agent.js',
        '--workspace', workspace,
        '--provider', 'chatgpt',
        task,
        '--background'
    ];

    console.log('Command: node ' + args.join(' '));

    const agentProcess = spawn('node', args, {
        cwd: workspace,
        shell: true,
        env: process.env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
    });

    let outputLines = [];
    let hasAIResponse = false;
    let hasRuntimeStatus = false;

    agentProcess.stdout.on('data', (data) => {
        const output = data.toString();
        outputLines.push({ type: 'stdout', content: output });
        console.log('[Agent STDOUT]', output.trim());

        // 检测 AI 回复
        if (output.includes('Provider Response') ||
            output.includes('XML Action') ||
            output.includes('Runtime Action') ||
            output.includes('Agent Step')) {
            hasRuntimeStatus = true;
            console.log('✅ Detected Runtime status');
        }

        // 检测 AI 回复内容
        if (output.includes('Agent Answer') ||
            output.includes('Final Answer') ||
            output.includes('answer')) {
            hasAIResponse = true;
            console.log('✅ Detected AI response');
        }
    });

    agentProcess.stderr.on('data', (data) => {
        const output = data.toString();
        outputLines.push({ type: 'stderr', content: output });
        console.error('[Agent STDERR]', output.trim());
    });

    agentProcess.on('close', (code) => {
        console.log('\nAgent exited with code:', code);
        console.log('Total output lines:', outputLines.length);
        console.log('Has AI Response:', hasAIResponse);
        console.log('Has Runtime Status:', hasRuntimeStatus);

        // 显示最后几行输出
        console.log('\nLast 10 output lines:');
        const lastLines = outputLines.slice(-10);
        lastLines.forEach(function (line, i) {
            const preview = line.content.substring(0, 100);
            console.log(' [' + i + '] ' + line.type + ': ' + preview + '...');
        });

        process.exit(0);
    });

    // 等待 30 秒后强制退出
    setTimeout(function () {
        console.log('\n⏱️ Test timeout after 30s, killing agent...');
        agentProcess.kill('SIGINT');
        process.exit(1);
    }, 30000);

    // 让进程独立运行
    agentProcess.unref();
}

testWebUIOutput().catch(console.error);
