
const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let agentProcess = null;
let agentOutput = [];
let isRunning = false;

app.post('/api/run', (req, res) => {
    const { workspace, provider, task } = req.body;

    if (!workspace || !task) {
        return res.status(400).json({ error: 'Workspace and task are required' });
    }

    if (isRunning) {
        return res.status(400).json({ error: 'Agent is already running' });
    }

    if (!fs.existsSync(workspace)) {
        return res.status(400).json({ error: 'Workspace does not exist: ' + workspace });
    }

    agentOutput = [];
    isRunning = true;

    // 不使用 detached，以便捕获输出
    const args = [
        'agent.js',
        '--workspace', workspace,
        '--provider', provider || 'chatgpt',
        task
    ];

    console.log('[WebUI] Starting agent: node ' + args.join(' '));
    agentOutput.push({ type: 'system', content: '🚀 Starting agent...' });

    agentProcess = spawn('node', args, {
        cwd: path.join(__dirname, '..'),
        shell: true,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
    });

    agentProcess.stdout.on('data', (data) => {
        const output = data.toString();
        console.log('[Agent] ' + output);
        // 按行分割，保留空行
        const lines = output.split('\n');
        for (const line of lines) {
            agentOutput.push({ type: 'stdout', content: line });
        }
    });

    agentProcess.stderr.on('data', (data) => {
        const output = data.toString();
        console.error('[Agent Error] ' + output);
        const lines = output.split('\n');
        for (const line of lines) {
            agentOutput.push({ type: 'stderr', content: line });
        }
    });

    agentProcess.on('close', (code) => {
        isRunning = false;
        agentOutput.push({ type: 'system', content: 'Agent exited with code ' + code });
        console.log('[WebUI] Agent exited with code ' + code);
        agentProcess = null;
    });

    agentProcess.on('error', (err) => {
        isRunning = false;
        agentOutput.push({ type: 'stderr', content: 'Agent process error: ' + err.message });
        console.error('[WebUI] Agent process error:', err);
        agentProcess = null;
    });

    res.json({ message: 'Agent started successfully', pid: agentProcess.pid });
});

app.get('/api/output', (req, res) => {
    res.json({
        running: isRunning,
        output: agentOutput
    });
});

app.post('/api/stop', (req, res) => {
    if (agentProcess) {
        try {
            agentProcess.kill('SIGINT');
            agentOutput.push({ type: 'system', content: '⏹ Agent stopped by user' });
            res.json({ message: 'Agent stopped' });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    } else {
        res.status(400).json({ error: 'No agent running' });
    }
});

app.get('/api/status', (req, res) => {
    res.json({
        running: isRunning,
        outputLength: agentOutput.length
    });
});

const server = app.listen(PORT, () => {
    console.log('[WebUI] Server running at http://localhost:' + PORT);
    console.log('[WebUI] Open your browser to http://localhost:' + PORT);
});

process.on('SIGINT', () => {
    console.log('[WebUI] Shutting down...');
    if (agentProcess) {
        agentProcess.kill('SIGINT');
    }
    server.close(() => {
        process.exit(0);
    });
});
