import { spawn } from 'node:child_process';
import { loadConfig } from '../server/config.mjs';

const children = [spawn(process.execPath, ['--watch', 'server/index.mjs'], { stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit', env: { ...process.env,
    BACKEND_URL: process.env.BACKEND_URL || `http://127.0.0.1:${loadConfig().port}` } })];
function stop() { for (const child of children) child.kill('SIGTERM'); }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
for (const child of children) child.on('exit', code => { if (code) { stop(); process.exitCode = code; } });
