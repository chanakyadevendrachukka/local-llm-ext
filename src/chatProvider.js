const vscode = require('vscode');
const path = require('path');
const { loadConfig, getConfigYamlTemplate } = require('./config');
const { createChatCompletion, testConnection } = require('./llmClient');

const STORAGE_KEY = 'local-llm-chat.conversations';

class ChatViewProvider {
  static viewType = 'local-llm-chat.chatView';

  constructor(context, outputChannel) {
    this.context = context;
    this.output = outputChannel;
    this.view = undefined;
    this.models = [];
    this.selectedModelIndex = 0;
    this.abortController = undefined;
    this.conversations = [];
    this.currentId = null;
    this.loadConversations();
  }

  // ── Conversation persistence ──

  loadConversations() {
    const stored = this.context.globalState.get(STORAGE_KEY);
    if (Array.isArray(stored)) {
      this.conversations = stored;
      this.currentId = stored.length > 0 ? stored[stored.length - 1].id : null;
    }
    if (!this.currentId) {
      this.newConversation();
    }
  }

  async saveConversations() {
    await this.context.globalState.update(STORAGE_KEY, this.conversations);
  }

  getConversationList() {
    return this.conversations.map(c => ({
      id: c.id,
      title: c.title,
      messageCount: c.messages.length,
    }));
  }

  getCurrentConversation() {
    return this.conversations.find(c => c.id === this.currentId);
  }

  newConversation() {
    const conv = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: 'New Chat',
      messages: [],
      createdAt: Date.now(),
    };
    this.conversations.push(conv);
    this.currentId = conv.id;
    this.saveConversations();
    this.sendMessages();
  }

  deleteConversation(id) {
    this.conversations = this.conversations.filter(c => c.id !== id);
    if (this.conversations.length === 0) this.newConversation();
    else if (this.currentId === id) this.currentId = this.conversations[this.conversations.length - 1].id;
    this.saveConversations();
    this.sendConversations();
  }

  switchConversation(id) {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = undefined;
    }
    this.currentId = id;
    this.sendConversations();
    this.sendMessages();
  }

  updateCurrentTitle(title) {
    const conv = this.getCurrentConversation();
    if (conv && conv.title === 'New Chat' && title) {
      conv.title = title.length > 60 ? title.slice(0, 60) + '...' : title;
      this.saveConversations();
      this.sendConversations();
    }
  }

  // ── Model loading ──

  loadModels() {
    const workspaceRoot = vscode.workspace.workspaceFolders
      ? vscode.workspace.workspaceFolders[0].uri.fsPath
      : undefined;
    const config = loadConfig(workspaceRoot);
    this.models = config.models || [];
    this.output.appendLine('Loaded ' + this.models.length + ' models' + (config.configPath ? ' from ' + config.configPath : ''));

    this.postMessage({
      type: 'setModels',
      models: this.models.map(m => ({ name: m.name, apiBase: m.apiBase, model: m.model })),
      selectedIndex: this.selectedModelIndex,
    });

    if (this.models.length === 0) {
      const paths = [];
      if (workspaceRoot) {
        paths.push(path.join(workspaceRoot, '.vscode', 'local-llm-models.yaml'));
      }
      paths.push(path.join(
        process.env.HOME || process.env.USERPROFILE || '',
        '.local-llm-models.yaml'
      ));
      this.postMessage({
        type: 'configStatus',
        pathsChecked: paths,
        workspaceOpen: !!workspaceRoot,
      });
    }
  }

  refreshModels() {
    this.loadModels();
  }

  // ── WebView lifecycle ──

  resolveWebviewView(webviewView, _context, _token) {
    this.output.appendLine('resolveWebviewView called');
    this.view = webviewView;

    webviewView.webview.options = { enableScripts: true };

    try {
      const html = this.getHtml();
      webviewView.webview.html = html;
      this.output.appendLine('HTML set, length: ' + html.length);
    } catch (err) {
      this.output.appendLine('ERROR in getHtml: ' + err.message);
      webviewView.webview.html = this.getErrorHtml(err.message);
      return;
    }

    this.loadModels();
    this.sendConversations();

    webviewView.webview.onDidReceiveMessage(data => {
      this.handleMessage(data);
    });
  }

  // ── Message handler ──

  handleMessage(data) {
    switch (data.type) {
      case 'ready':
        this.loadModels();
        this.sendConversations();
        break;
      case 'sendMessage':
        this.handleSendMessage(data.text);
        break;
      case 'selectModel':
        this.selectedModelIndex = data.index;
        break;
      case 'newChat':
        if (this.abortController) {
          this.abortController.abort();
          this.abortController = undefined;
        }
        this.newConversation();
        this.postMessage({ type: 'clearMessages' });
        this.postMessage({ type: 'generating', isGenerating: false });
        break;
      case 'switchConversation':
        this.switchConversation(data.id);
        break;
      case 'deleteConversation':
        this.deleteConversation(data.id);
        break;
      case 'stopGeneration':
        if (this.abortController) {
          this.abortController.abort();
          this.abortController = undefined;
        }
        break;
      case 'openConfig':
        this.openConfigFile();
        break;
      case 'testConnection':
        this.handleTestConnection(data.index);
        break;
      case 'webviewError':
        this.output.appendLine('WebView error: ' + data.message);
        if (data.stack) this.output.appendLine(data.stack);
        break;
    }
  }

  // ── Send message ──

  async handleSendMessage(text) {
    if (!text.trim()) return;

    const current = this.getCurrentConversation();
    if (current && current.messages.length === 0) {
      this.updateCurrentTitle(text);
    }

    const model = this.models[this.selectedModelIndex];
    if (!model) {
      vscode.window.showWarningMessage('No model selected');
      return;
    }

    const userMsg = { role: 'user', content: text };
    if (current) current.messages.push(userMsg);
    this.saveConversations();

    this.postMessage({
      type: 'addMessage',
      role: 'user',
      content: text,
    });

    this.postMessage({ type: 'generating', isGenerating: true });

    const messageId = 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    this.postMessage({
      type: 'addMessage',
      role: 'assistant',
      content: '',
      messageId: messageId,
    });

    this.abortController = new AbortController();

    try {
      await createChatCompletion(
        model,
        current ? current.messages : [{ role: 'user', content: text }],
        (chunk) => {
          this.postMessage({
            type: 'appendToMessage',
            messageId: messageId,
            content: chunk,
          });
        },
        this.abortController.signal
      );

      if (current) {
        const lastMsg = current.messages[current.messages.length - 1];
        if (lastMsg && lastMsg.role === 'assistant') {
          // Already pushed below
        } else {
          current.messages.push({ role: 'assistant', content: '' });
        }
      }

      this.saveConversations();
    } catch (err) {
      const errorText = err.message === 'Request aborted'
        ? '\n\n[Stopped]'
        : '\n\nError: ' + err.message;
      this.postMessage({
        type: 'appendToMessage',
        messageId: messageId,
        content: errorText,
      });
    }

    this.postMessage({ type: 'generating', isGenerating: false });
  }

  // ── Test connection ──

  async handleTestConnection(index) {
    const model = this.models[index];
    if (!model) return;
    this.postMessage({ type: 'connectionStatus', index: index, status: 'testing' });
    try {
      await testConnection(model);
      this.postMessage({ type: 'connectionStatus', index: index, status: 'connected' });
    } catch (_) {
      this.postMessage({ type: 'connectionStatus', index: index, status: 'failed' });
    }
  }

  // ── Config file management ──

  async openConfigFile() {
    const workspaceRoot = vscode.workspace.workspaceFolders
      ? vscode.workspace.workspaceFolders[0].uri.fsPath
      : undefined;

    let configDir, configFile;

    if (workspaceRoot) {
      configDir = vscode.Uri.file(path.join(workspaceRoot, '.vscode'));
      configFile = vscode.Uri.file(path.join(workspaceRoot, '.vscode', 'local-llm-models.yaml'));
    } else {
      const home = process.env.HOME || process.env.USERPROFILE || '';
      configDir = vscode.Uri.file(home);
      configFile = vscode.Uri.file(path.join(home, '.local-llm-models.yaml'));
    }

    try {
      await vscode.workspace.fs.stat(configFile);
    } catch (_) {
      try {
        await vscode.workspace.fs.createDirectory(configDir);
      } catch (_) {}
      await vscode.workspace.fs.writeFile(
        configFile,
        Buffer.from(getConfigYamlTemplate(), 'utf-8')
      );
    }

    const doc = await vscode.workspace.openTextDocument(configFile);
    await vscode.window.showTextDocument(doc);
    this.loadModels();
  }

  // ── Post message to WebView ──

  postMessage(message) {
    if (this.view) {
      this.view.webview.postMessage(message);
    }
  }

  sendConversations() {
    this.postMessage({
      type: 'setConversations',
      conversations: this.getConversationList(),
      currentId: this.currentId,
    });
  }

  sendMessages() {
    this.postMessage({ type: 'clearMessages' });
    const conv = this.getCurrentConversation();
    if (conv && conv.messages.length > 0) {
      for (const msg of conv.messages) {
        this.postMessage({ type: 'addMessage', role: msg.role, content: msg.content });
      }
    }
  }

  // ── Error HTML ──

  getErrorHtml(msg) {
    return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Error</title></head><body style="background:#1e1e1e;color:#ccc;font-family:sans-serif;padding:16px;"><h2 style="color:#f14c4c;">Local LLM Chat - Error</h2><pre style="background:#252526;padding:8px;border-radius:4px;">' + msg + '</pre><p>Check the VS Code Developer Tools console (Help &rarr; Toggle Developer Tools) for details.</p></body></html>';
  }

  // ── HTML generator ──

  getHtml() {
    return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<style>\n' +
      '* { box-sizing: border-box; margin: 0; padding: 0; }\n' +
      ':root { --bg:#1e1e1e; --surface:#252526; --surface-hover:#2d2d2d; --surface-active:#333; --border:#3c3c3c; --text:#ccc; --text-muted:#808080; --accent:#0078d4; --user-bg:#094771; --bot-bg:#2d2d2d; --danger:#f14c4c; --success:#4ec94e; --sidebar-w:200px; }\n' +
      'html,body { height:100%; }\n' +
      'body { font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Ubuntu,sans-serif; background:var(--bg); color:var(--text); display:flex; flex-direction:column; overflow:hidden; font-size:13px; }\n' +
      '#toolbar { display:flex; align-items:center; gap:4px; padding:4px 8px; border-bottom:1px solid var(--border); flex-shrink:0; }\n' +
      '#toolbar select { flex:1; background:var(--surface); color:var(--text); border:1px solid var(--border); padding:3px 6px; border-radius:3px; font-size:12px; }\n' +
      '#toolbar button { background:var(--surface); color:var(--text); border:1px solid var(--border); padding:3px 8px; border-radius:3px; cursor:pointer; font-size:13px; }\n' +
      '#toolbar button:hover { background:var(--surface-hover); }\n' +
      '#connStatus { width:8px;height:8px;border-radius:50%;display:inline-block;flex-shrink:0; }\n' +
      '#connStatus.unknown { background:var(--text-muted); }\n' +
      '#connStatus.testing { background:orange; }\n' +
      '#connStatus.connected { background:var(--success); }\n' +
      '#connStatus.failed { background:var(--danger); }\n' +
      '#main { flex:1; display:flex; overflow:hidden; }\n' +
      '#sidebar { width:var(--sidebar-w); min-width:0; flex-shrink:0; background:var(--surface); border-right:1px solid var(--border); display:flex; flex-direction:column; overflow:hidden; }\n' +
      '#sidebar.collapsed { width:0 !important; min-width:0 !important; padding:0 !important; border:none !important; overflow:hidden !important; }\n' +
      '#sidebarHeader { display:flex; align-items:center; justify-content:space-between; padding:6px 8px; border-bottom:1px solid var(--border); flex-shrink:0; }\n' +
      '#sidebarHeader span { font-weight:600; font-size:11px; text-transform:uppercase; color:var(--text-muted); }\n' +
      '#sidebarHeader button { background:none; border:none; color:var(--text-muted); cursor:pointer; font-size:14px; padding:2px 4px; }\n' +
      '#sidebarHeader button:hover { color:var(--text); }\n' +
      '#convList { flex:1; overflow-y:auto; padding:4px; }\n' +
      '.conv-item { display:flex; align-items:center; padding:5px 8px; border-radius:3px; cursor:pointer; gap:4px; margin-bottom:2px; }\n' +
      '.conv-item:hover { background:var(--surface-hover); }\n' +
      '.conv-item.active { background:var(--surface-active); }\n' +
      '.conv-item .title { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; }\n' +
      '.conv-item .count { color:var(--text-muted); font-size:10px; flex-shrink:0; }\n' +
      '.conv-item .del { background:none; border:none; color:var(--text-muted); cursor:pointer; font-size:10px; padding:0 2px; opacity:0; }\n' +
      '.conv-item:hover .del { opacity:1; }\n' +
      '.conv-item .del:hover { color:var(--danger); }\n' +
      '#chatArea { flex:1; display:flex; flex-direction:column; overflow:hidden; }\n' +
      '#messages { flex:1; overflow-y:auto; padding:12px; display:flex; flex-direction:column; gap:8px; }\n' +
      '#messages:empty::after { content:\'Send a message to start chatting\'; color:var(--text-muted); text-align:center; margin-top:40px; font-style:italic; display:block; }\n' +
      '.msg { max-width:92%; padding:8px 12px; border-radius:8px; font-size:13px; line-height:1.55; word-wrap:break-word; }\n' +
      '.msg.user { align-self:flex-end; background:var(--user-bg); border-bottom-right-radius:2px; }\n' +
      '.msg.bot { align-self:flex-start; background:var(--bot-bg); border-bottom-left-radius:2px; }\n' +
      '.msg .label { font-size:10px; color:var(--text-muted); margin-bottom:3px; text-transform:uppercase; }\n' +
      '.msg h1,.msg h2,.msg h3,.msg h4,.msg h5,.msg h6 { margin:6px 0 3px; line-height:1.3; }\n' +
      '.msg h1 { font-size:16px; } .msg h2 { font-size:15px; } .msg h3 { font-size:14px; }\n' +
      '.msg p { margin:3px 0; }\n' +
      '.msg ul,.msg ol { margin:3px 0; padding-left:20px; }\n' +
      '.msg li { margin:2px 0; }\n' +
      '.msg code { background:#3c3c3c; padding:1px 4px; border-radius:3px; font-size:12px; font-family:Consolas,monospace; }\n' +
      '.msg pre { margin:6px 0; background:#1a1a1a; border-radius:3px; overflow-x:auto; }\n' +
      '.msg pre code { display:block; padding:8px; background:none; font-size:12px; }\n' +
      '.msg blockquote { margin:3px 0; padding:3px 8px; border-left:3px solid var(--accent); color:var(--text-muted); }\n' +
      '.msg a { color:var(--accent); text-decoration:none; }\n' +
      '.msg a:hover { text-decoration:underline; }\n' +
      '.msg img { max-width:100%; border-radius:4px; }\n' +
      '#inputArea { display:flex; gap:6px; padding:6px 8px; border-top:1px solid var(--border); flex-shrink:0; }\n' +
      '#inputArea textarea { flex:1; background:var(--surface); color:var(--text); border:1px solid var(--border); border-radius:3px; padding:6px 8px; font-size:13px; font-family:inherit; resize:none; min-height:32px; max-height:120px; }\n' +
      '#inputArea textarea:focus { outline:1px solid var(--accent); }\n' +
      '#inputArea button { background:var(--accent); color:#fff; border:none; border-radius:3px; padding:6px 14px; cursor:pointer; font-size:13px; }\n' +
      '#inputArea button:hover { opacity:0.9; }\n' +
      '#inputArea button:disabled { opacity:0.4; cursor:not-allowed; }\n' +
      '#emptyModels { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:20px; text-align:center; color:var(--text-muted); gap:10px; }\n' +
      '#emptyModels p { font-size:13px; }\n' +
      '#emptyModels pre { font-size:10px; text-align:left; background:#1a1a1a; padding:6px; border-radius:3px; overflow:auto; max-height:140px; margin:6px 0; word-break:break-all; }\n' +
      '#emptyModels button { background:var(--accent); color:#fff; border:none; border-radius:3px; padding:6px 14px; cursor:pointer; font-size:13px; }\n' +
      '#emptyModels button:hover { opacity:0.9; }\n' +
      '.hidden { display:none !important; }\n' +
      '</style>\n</head>\n<body>\n' +
      '<div id="toolbar">\n' +
      '  <button id="sidebarToggle">&#9776;</button>\n' +
      '  <select id="modelSelect"><option value="">-- Select a model --</option></select>\n' +
      '  <span id="connStatus" class="unknown"></span>\n' +
      '  <button id="testBtn">&#9889;</button>\n' +
      '  <button id="newChatBtn">+</button>\n' +
      '  <button id="configBtn">&#9881;</button>\n' +
      '</div>\n' +
      '<div id="main">\n' +
      '  <div id="sidebar" class="collapsed">\n' +
      '    <div id="sidebarHeader"><span>Conversations</span><button id="closeSidebar">&times;</button></div>\n' +
      '    <div id="convList"></div>\n' +
      '  </div>\n' +
      '  <div id="chatArea">\n' +
      '    <div id="emptyModels" class="hidden">\n' +
      '      <p>No models configured.</p>\n' +
      '      <p style="font-size:11px;">Create a config file in .vscode/ or ~/.local-llm-models.yaml</p>\n' +
      '      <pre id="configDebug" class="hidden"></pre>\n' +
      '      <button id="openConfigBtn">Create Config File</button>\n' +
      '    </div>\n' +
      '    <div id="messages"></div>\n' +
      '    <div id="inputArea">\n' +
      '      <textarea id="input" rows="1" placeholder="Type a message..." disabled></textarea>\n' +
      '      <button id="sendBtn" disabled>Send</button>\n' +
      '    </div>\n' +
      '  </div>\n' +
      '</div>\n' +
      '<script>\n' +
      this.getWebViewScript() +
      '</script>\n</body>\n</html>';
  }

  // ── WebView JavaScript ──
  // IMPORTANT: Backticks inside this method must use \` to avoid closing the outer template

  getWebViewScript() {
    return `
(function() {
  'use strict';
  var vscode = acquireVsCodeApi();

  // Error boundary
  var origOnError = window.onerror;
  window.onerror = function(msg, url, line, col, err) {
    vscode.postMessage({ type: 'webviewError', message: msg, stack: err && err.stack ? err.stack : '' });
    if (origOnError) origOnError.apply(this, arguments);
    return true;
  };

  var messagesEl = document.getElementById('messages');
  var input = document.getElementById('input');
  var sendBtn = document.getElementById('sendBtn');
  var modelSelect = document.getElementById('modelSelect');
  var connStatus = document.getElementById('connStatus');
  var testBtn = document.getElementById('testBtn');
  var newChatBtn = document.getElementById('newChatBtn');
  var configBtn = document.getElementById('configBtn');
  var openConfigBtn = document.getElementById('openConfigBtn');
  var emptyModels = document.getElementById('emptyModels');
  var configDebug = document.getElementById('configDebug');
  var sidebar = document.getElementById('sidebar');
  var convList = document.getElementById('convList');
  var sidebarToggle = document.getElementById('sidebarToggle');
  var closeSidebar = document.getElementById('closeSidebar');

  if (!messagesEl || !input || !sendBtn) {
    vscode.postMessage({ type: 'webviewError', message: 'Required DOM elements not found' });
    return;
  }

  var isGenerating = false;
  var models = [];
  var conversations = [];
  var currentConvId = null;
  var messageBuffers = {};

  // Auto-resize
  input.addEventListener('input', function() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });

  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  sendBtn.addEventListener('click', sendMessage);

  function sendMessage() {
    var text = input.value.trim();
    if (!text || isGenerating) return;
    input.value = '';
    input.style.height = 'auto';
    vscode.postMessage({ type: 'sendMessage', text: text });
  }

  modelSelect.addEventListener('change', function() {
    var idx = modelSelect.selectedIndex - 1;
    vscode.postMessage({ type: 'selectModel', index: idx });
    updateConnStatus(idx);
  });

  testBtn.addEventListener('click', function() {
    var idx = modelSelect.selectedIndex - 1;
    if (idx >= 0) vscode.postMessage({ type: 'testConnection', index: idx });
  });

  newChatBtn.addEventListener('click', function() {
    vscode.postMessage({ type: 'newChat' });
  });

  configBtn.addEventListener('click', function() {
    vscode.postMessage({ type: 'openConfig' });
  });

  openConfigBtn.addEventListener('click', function() {
    vscode.postMessage({ type: 'openConfig' });
  });

  sidebarToggle.addEventListener('click', function() {
    sidebar.classList.toggle('collapsed');
  });

  closeSidebar.addEventListener('click', function() {
    sidebar.classList.add('collapsed');
  });

  function updateConnStatus(idx) {
    connStatus.className = 'conn-status unknown';
    if (idx < 0 || idx >= models.length) return;
    var name = (models[idx].name || '') + (models[idx].apiBase || '');
    if (modelStatuses && modelStatuses[name]) {
      connStatus.className = 'conn-status ' + modelStatuses[name];
    }
  }

  var modelStatuses = {};

  function renderConversations() {
    convList.innerHTML = '';
    if (!conversations || conversations.length === 0) {
      var empty = document.createElement('div');
      empty.style.cssText = 'padding:12px;color:var(--text-muted);font-size:11px;text-align:center;';
      empty.textContent = 'No conversations';
      convList.appendChild(empty);
      return;
    }
    conversations.forEach(function(conv) {
      var item = document.createElement('div');
      item.className = 'conv-item' + (conv.id === currentConvId ? ' active' : '');

      var title = document.createElement('span');
      title.className = 'title';
      title.textContent = conv.title;
      item.appendChild(title);

      var count = document.createElement('span');
      count.className = 'count';
      count.textContent = conv.messageCount;
      item.appendChild(count);

      var del = document.createElement('button');
      del.className = 'del';
      del.textContent = '\\u2715';
      del.title = 'Delete';
      del.addEventListener('click', function(e) {
        e.stopPropagation();
        vscode.postMessage({ type: 'deleteConversation', id: conv.id });
      });
      item.appendChild(del);

      item.addEventListener('click', function() {
        vscode.postMessage({ type: 'switchConversation', id: conv.id });
      });

      convList.appendChild(item);
    });
  }

  // ── Markdown renderer ──

  function esc(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderMarkdown(text) {
    if (!text) return '';
    var lines = text.split('\\n');
    var html = '';
    var i = 0;

    function renderInline(t) {
      if (!t) return '';
      var r = esc(t);
      // Images
      r = r.replace(/!\\[([^\\]]*)\\]\\(([^)]+)\\)/g, '<img src="$2" alt="$1" style="max-width:100%;border-radius:4px;">');
      // Links
      r = r.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>');
      // Inline code (using backtick)
      r = r.replace(\`\`([^\\x60]+)\`\`/g, '<code>$1</code>');
      // Bold
      r = r.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
      r = r.replace(/__([^_]+)__/g, '<strong>$1</strong>');
      // Italic
      r = r.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
      r = r.replace(/_([^_]+)_/g, '<em>$1</em>');
      // Strikethrough
      r = r.replace(/~~([^~]+)~~/g, '<del>$1</del>');
      return r;
    }

    while (i < lines.length) {
      var line = lines[i];

      // Code blocks
      if (line.trimStart().slice(0, 3) === '\`\`\`') {
        var lang = line.trimStart().slice(3).trim();
        var codeLines = [];
        i++;
        while (i < lines.length && lines[i].trimStart().slice(0, 3) !== '\`\`\`') {
          codeLines.push(lines[i]);
          i++;
        }
        i++;
        html += '<pre><code' + (lang ? ' class="language-' + esc(lang) + '"' : '') + '>' + esc(codeLines.join('\\n')) + '<\/code><\/pre>\\n';
        continue;
      }

      // Blockquotes
      if (line.trimStart().indexOf('> ') === 0) {
        var qLines = [];
        while (i < lines.length && lines[i].trimStart().indexOf('> ') === 0) {
          qLines.push(lines[i].trimStart().slice(2));
          i++;
        }
        html += '<blockquote>' + renderInline(qLines.join('\\n')) + '<\/blockquote>\\n';
        continue;
      }

      // Unordered lists
      if (/^\\s*[-*+]\\s/.test(line)) {
        html += '<ul>\\n';
        while (i < lines.length && /^\\s*[-*+]\\s/.test(lines[i])) {
          html += '<li>' + renderInline(lines[i].replace(/^\\s*[-*+]\\s/, '')) + '<\/li>\\n';
          i++;
        }
        html += '<\/ul>\\n';
        continue;
      }

      // Ordered lists
      if (/^\\s*\\d+\\.\\s/.test(line)) {
        html += '<ol>\\n';
        while (i < lines.length && /^\\s*\\d+\\.\\s/.test(lines[i])) {
          html += '<li>' + renderInline(lines[i].replace(/^\\s*\\d+\\.\\s/, '')) + '<\/li>\\n';
          i++;
        }
        html += '<\/ol>\\n';
        continue;
      }

      // Headings
      var hMatch = line.match(/^(#{1,6})\\s+(.+)$/);
      if (hMatch) {
        html += '<h' + hMatch[1].length + '>' + renderInline(hMatch[2]) + '<\/h' + hMatch[1].length + '>\\n';
        i++;
        continue;
      }

      if (line.trim() === '') { i++; continue; }

      // Paragraphs
      var paraLines = [];
      while (i < lines.length && lines[i].trim() !== '' &&
             lines[i].trimStart().slice(0, 3) !== '\`\`\`' &&
             lines[i].trimStart().indexOf('> ') !== 0 &&
             !/^\\s*[-*+]\\s/.test(lines[i]) &&
             !/^\\s*\\d+\\.\\s/.test(lines[i]) &&
             !/^#{1,6}\\s/.test(lines[i])) {
        paraLines.push(lines[i]);
        i++;
      }
      html += '<p>' + renderInline(paraLines.join('\\n')) + '<\/p>\\n';
    }
    return html;
  }

  // ── Message helpers ──

  function createMessageEl(role, content, messageId) {
    if (messageId && messageBuffers[messageId] === undefined) {
      messageBuffers[messageId] = content || '';
    }
    var el = document.createElement('div');
    el.className = 'msg ' + (role === 'user' ? 'user' : 'bot');
    if (messageId) el.dataset.messageId = messageId;

    var label = document.createElement('div');
    label.className = 'label';
    label.textContent = role === 'user' ? 'You' : 'Assistant';
    el.appendChild(label);

    var contentEl = document.createElement('div');
    contentEl.className = 'content';
    contentEl.innerHTML = renderMarkdown(content || '');
    el.appendChild(contentEl);

    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  function updateMessageContent(messageId) {
    var content = messageBuffers[messageId] || '';
    var el = messagesEl.querySelector('[data-message-id="' + messageId + '"]');
    if (el) {
      el.querySelector('.content').innerHTML = renderMarkdown(content);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  // ── Message event handling ──

  window.addEventListener('message', function(event) {
    var d = event.data;

    try {
      switch (d.type) {
        case 'setModels':
          modelSelect.innerHTML = '<option value="">-- Select a model --</option>';
          models = d.models || [];
          models.forEach(function(m, i) {
            var opt = document.createElement('option');
            opt.textContent = m.name + ' (' + m.apiBase + ')';
            modelSelect.appendChild(opt);
            if (i === d.selectedIndex) modelSelect.selectedIndex = i + 1;
          });
          if (models.length > 0) {
            emptyModels.classList.add('hidden');
            input.disabled = false;
            sendBtn.disabled = false;
          } else {
            emptyModels.classList.remove('hidden');
            input.disabled = true;
            sendBtn.disabled = true;
          }
          updateConnStatus(modelSelect.selectedIndex - 1);
          break;

        case 'configStatus':
          configDebug.classList.remove('hidden');
          var txt = (d.workspaceOpen ? 'Workspace open' : 'No workspace open') + '\\n';
          if (d.pathsChecked) {
            d.pathsChecked.forEach(function(p) {
              txt += '  Checked: ' + p + '\\n';
            });
          }
          configDebug.textContent = txt;
          break;

        case 'setConversations':
          conversations = d.conversations || [];
          currentConvId = d.currentId;
          renderConversations();
          break;

        case 'addMessage':
          if (d.messageId) {
            messageBuffers[d.messageId] = d.content || '';
            createMessageEl(d.role, d.content, d.messageId);
          } else {
            createMessageEl(d.role, d.content);
          }
          break;

        case 'appendToMessage':
          if (d.messageId && messageBuffers[d.messageId] !== undefined) {
            messageBuffers[d.messageId] += d.content;
            updateMessageContent(d.messageId);
          }
          break;

        case 'clearMessages':
          messagesEl.innerHTML = '';
          messageBuffers = {};
          break;

        case 'generating':
          isGenerating = d.isGenerating;
          sendBtn.textContent = isGenerating ? 'Stop' : 'Send';
          sendBtn.disabled = false;
          input.disabled = isGenerating;
          if (!isGenerating) input.focus();
          break;

        case 'connectionStatus':
          var idx = d.index;
          var m = models[idx];
          if (m) {
            modelStatuses[m.name + m.apiBase] = d.status;
            if (modelSelect.selectedIndex - 1 === idx) {
              connStatus.className = 'conn-status ' + d.status;
            }
          }
          break;
      }
    } catch (e) {
      vscode.postMessage({ type: 'webviewError', message: 'Handler error: ' + e.message, stack: e.stack || '' });
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
`;
  }
}

module.exports = { ChatViewProvider };
