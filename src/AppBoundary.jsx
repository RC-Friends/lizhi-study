import React, { Component } from 'react';
import { AlertCircle, Copy, RefreshCw, ShieldCheck } from 'lucide-react';
import { saveMatch, saveSession } from './api.js';
import { version } from '../package.json';
import './recovery.css';

function safeMessage(value) {
  return String(value || '')
    .replace(/Bearer\s+[^\s)]+/gi, 'Bearer [omitted]')
    .replace(/\bsk-[\w@.-]+/g, '[key omitted]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[token omitted]')
    .replace(/https?:\/\/[^\s)]+/g, raw => {
      try { const url = new URL(raw); return `${url.origin}${url.pathname}`; }
      catch { return '[url omitted]'; }
    }).slice(0, 1600);
}

function diagnostic(error) {
  return JSON.stringify({
    version,
    browser: navigator.userAgent,
    route: window.location.hash.match(/^#(?:admin|record|match|history|skill)(?=\/|$)/)?.[0] || '/',
    error: safeMessage(error?.name),
    message: safeMessage(error?.message),
    stack: safeMessage(error?.stack),
  }, null, 2);
}

export default class AppBoundary extends Component {
  state = { error: null, copied: false, copyFailed: false };

  static getDerivedStateFromError(error) { return { error }; }

  copy = async () => {
    try {
      await navigator.clipboard.writeText(diagnostic(this.state.error));
      this.setState({ copied: true, copyFailed: false });
    } catch { this.setState({ copyFailed: true, copied: false }); }
  };

  guest = () => {
    // Only this device's login and resume pointer change. Study data stays on
    // the server, and ordinary reloads retain both local values.
    try { saveSession(null); saveMatch(null); }
    catch { this.setState({ copyFailed: true }); return; }
    window.location.assign(window.location.pathname + window.location.search);
  };

  render() {
    if (!this.state.error) return this.props.children;
    return <main className="app-recovery" aria-labelledby="recovery-title">
      <section className="app-recovery-card">
        <span className="app-recovery-icon"><AlertCircle size={28} /></span>
        <span className="app-recovery-brand">栗知自习室</span>
        <h1 id="recovery-title">页面显示出了点问题</h1>
        <p>可以重新加载，继续已保存的学习进度。若仍然打不开，复制诊断信息发给管理员。</p>
        <div className="app-recovery-actions">
          <button className="button primary" onClick={() => window.location.reload()}><RefreshCw size={16} />重新加载</button>
          <button className="button ghost" onClick={this.copy}><Copy size={16} />{this.state.copied ? '已复制诊断信息' : '复制诊断信息'}</button>
        </div>
        <details open={this.state.copied || this.state.copyFailed}>
          <summary>查看诊断信息</summary>
          <p>只读取版本、浏览器和页面异常，不读取登录凭据或学习笔记。</p>
          {this.state.copyFailed && <p role="status">无法自动复制时，可选中下方文字复制。</p>}
          <textarea aria-label="页面诊断信息" readOnly value={diagnostic(this.state.error)} />
        </details>
        <button className="text-button" onClick={this.guest}><ShieldCheck size={14} />返回游客页面</button>
      </section>
    </main>;
  }
}
