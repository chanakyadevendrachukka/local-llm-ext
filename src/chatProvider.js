const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { loadConfig, getConfigYamlTemplate } = require('./config');
const { createChatCompletion, testConnection } = require('./llmClient');


const STORAGE_KEY = 'local-llm-chat.conversations';

class ChatViewProvider {
  static viewType = 'local-llm-chat.chatView';

  constructor(context) {
    console.log('Local LLM Chat: ChatViewProvider constructor');
    this._context = context;
    this._view = undefined;
    this._models = [];
    this._abortController = undefined;
    this._selectedModelIndex = 0;

    this._conversations = [];
    this._currentId = null;
    this._loadConversations();
    console.log('Local LLM Chat: ChatViewProvider constructed, conversations:', this._conversations.length);
  }

  // ── Conversation Persistence ─────────────────────────────

  _loadConversations() {
    const stored = this._context.globalState.get(STORAGE_KEY, []);
    this._conversations = Array.isArray(stored) ? stored : [];
    if (this._conversations.length === 0) {
      this._newConversation();
    } else {
      this._currentId = this._conversations[0].id;
    }
  }

  async _saveConversations() {
    await this._context.globalState.update(STORAGE_KEY, this._conversations);
  }

  _getConversationList() {
    return this._conversations.map((c) => ({
      id: c.id,
      title: c.title,
      timestamp: c.timestamp,
      messageCount: c.messages.length,
    }));
  }

  _getCurrentConversation() {
    return this._conversations.find((c) => c.id === this._currentId);
  }

  _newConversation() {
    const conv = {
      id: Date.now().toString(),
      title: 'New Chat',
      timestamp: Date.now(),
      messages: [],
      modelIndex: this._selectedModelIndex,
    };
    this._conversations.unshift(conv);
    this._currentId = conv.id;
    this._saveConversations();
    return conv;
  }

  _switchConversation(id) {
    const conv = this._conversations.find((c) => c.id === id);
    if (!conv) return;

    if (this._abortController) {
      this._abortController.abort();
      this._abortController = undefined;
    }

    const current = this._getCurrentConversation();
    if (current) {
      current.modelIndex = this._selectedModelIndex;
      this._saveConversations();
    }

    this._currentId = id;
    this._selectedModelIndex = conv.modelIndex || 0;
    this._postMessage({ type: 'generating', isGenerating: false });
    this._postMessage({
      type: 'setConversations',
      conversations: this._getConversationList(),
      currentId: this._currentId,
    });
    this._postMessage({
      type: 'loadConversation',
      messages: conv.messages,
      modelIndex: this._selectedModelIndex,
    });
  }

  _deleteConversation(id) {
    this._conversations = this._conversations.filter((c) => c.id !== id);
    if (this._conversations.length === 0) {
      this._newConversation();
    } else if (this._currentId === id) {
      this._currentId = this._conversations[0].id;
      const conv = this._conversations[0];
      this._selectedModelIndex = conv.modelIndex || 0;
      this._postMessage({
        type: 'loadConversation',
        messages: conv.messages,
        modelIndex: this._selectedModelIndex,
      });
    }
    this._saveConversations();
    this._postMessage({
      type: 'setConversations',
      conversations: this._getConversationList(),
      currentId: this._currentId,
    });
  }

  _updateCurrentTitle(title) {
    const conv = this._getCurrentConversation();
    if (conv && conv.title === 'New Chat' && title) {
      conv.title = title.length > 60 ? title.slice(0, 60) + '...' : title;
      this._saveConversations();
      this._postMessage({
        type: 'setConversations',
        conversations: this._getConversationList(),
        currentId: this._currentId,
      });
    }
  }

  // ── WebView Lifecycle ────────────────────────────────────

  resolveWebviewView(webviewView, _context, _token) {
    console.log('Local LLM Chat: resolveWebviewView called');
    this._view = webviewView;

    webviewView.webview.options = { enableScripts: true };

    // Try to set the main HTML; fall back to diagnostic page on error
    try {
      const html = this._getHtml();
      console.log('Local LLM Chat: HTML generated, length:', html.length);
      webviewView.webview.html = html;
    } catch (err) {
      console.error('Local LLM Chat: _getHtml() failed', err);
      webviewView.webview.html = this._getFallbackHtml('_getHtml() error: ' + err.message);
      return;
    }

    // Send initial data immediately (don't wait for 'ready')
    this._loadModels();
    this._postMessage({
      type: 'setConversations',
      conversations: this._getConversationList(),
      currentId: this._currentId,
    });

    console.log('Local LLM Chat: resolveWebviewView complete, models:', this._models.length);

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'ready':
          console.log('Local LLM Chat: WebView ready');
          // Re-send in case WebView missed the initial messages
          this._loadModels();
          this._postMessage({
            type: 'setConversations',
            conversations: this._getConversationList(),
            currentId: this._currentId,
          });
          break;
        case 'sendMessage':
          await this._handleSendMessage(data.text);
          break;
        case 'selectModel':
          this._selectedModelIndex = data.index;
          break;
        case 'newChat':
          this._newConversation();
          this._postMessage({ type: 'generating', isGenerating: false });
          this._postMessage({ type: 'clearMessages' });
          this._postMessage({
            type: 'setConversations',
            conversations: this._getConversationList(),
            currentId: this._currentId,
          });
          break;
        case 'switchConversation':
          this._switchConversation(data.id);
          break;
        case 'deleteConversation':
          this._deleteConversation(data.id);
          break;
        case 'stopGeneration':
          if (this._abortController) {
            this._abortController.abort();
          }
          break;
        case 'openConfig':
          await this._openConfigFile();
          break;
        case 'testConnection':
          await this._handleTestConnection(data.index);
          break;
      }
    });
  }

  // ── Model Loading ────────────────────────────────────────

  _loadModels() {
    const workspaceRoot = vscode.workspace.workspaceFolders
      ? vscode.workspace.workspaceFolders[0].uri.fsPath
      : undefined;
    const config = loadConfig(workspaceRoot);
    this._models = config.models || [];

    this._postMessage({
      type: 'setModels',
      models: this._models.map((m) => ({
        name: m.name,
        apiBase: m.apiBase,
        model: m.model,
      })),
      selectedIndex: this._selectedModelIndex,
    });

    this._postMessage({
      type: 'configDebug',
      debug: config._debug || null,
    });
  }

  // ── Send Message ─────────────────────────────────────────

  async _handleSendMessage(text) {
    if (!text.trim()) return;

    // Auto-title from first message
    const current = this._getCurrentConversation();
    if (current && current.messages.length === 0) {
      this._updateCurrentTitle(text);
    }

    const model = this._models[this._selectedModelIndex];
    if (!model) {
      vscode.window.showWarningMessage(
        'No model selected. Configure models in .vscode/local-llm-models.yaml'
      );
      return;
    }

    // Add user message
    const userMsg = { role: 'user', content: text };
    if (current) current.messages.push(userMsg);
    await this._saveConversations();

    this._postMessage({
      type: 'addMessage',
      role: 'user',
      content: text,
    });

    this._postMessage({ type: 'generating', isGenerating: true });

      this._abortController = new AbortController();

    let messageId;

    try {
      const assistantMsg = { role: 'assistant', content: '' };
      if (current) current.messages.push(assistantMsg);

      messageId = Date.now().toString();
      this._postMessage({
        type: 'addMessage',
        role: 'assistant',
        content: '',
        messageId,
      });

      const fullContent = await createChatCompletion(
        model,
        current ? current.messages.slice(0, -1) : [{ role: 'user', content: text }],
        (chunk) => {
          this._postMessage({
            type: 'appendToMessage',
            messageId,
            content: chunk,
          });
        },
        this._abortController.signal
      );

      assistantMsg.content = fullContent;
      this._updateCurrentTitle(
        current && current.messages.length > 0 ? current.messages[0].content : text
      );
      await this._saveConversations();
    } catch (err) {
      const errorText =
        err.message === 'Request aborted'
          ? '\n\n[Generation stopped]'
          : `Error: ${err.message}`;
      this._postMessage({
        type: 'appendToMessage',
        messageId: typeof messageId !== 'undefined' ? messageId : '',
        content: errorText,
      });
    }

    this._postMessage({ type: 'generating', isGenerating: false });
  }

  // ── Connection Test ──────────────────────────────────────

  async _handleTestConnection(index) {
    const model = this._models[index];
    if (!model) return;

    this._postMessage({
      type: 'connectionStatus',
      index,
      status: 'testing',
    });

    const ok = await testConnection(model);
    this._postMessage({
      type: 'connectionStatus',
      index,
      status: ok ? 'connected' : 'failed',
    });
  }

  // ── Config File ──────────────────────────────────────────

  async _openConfigFile() {
    let configFile;

    const workspaceRoot = vscode.workspace.workspaceFolders
      ? vscode.workspace.workspaceFolders[0].uri
      : undefined;

    if (workspaceRoot) {
      configFile = vscode.Uri.joinPath(
        workspaceRoot,
        '.vscode',
        'local-llm-models.yaml'
      );
      const configDir = vscode.Uri.joinPath(workspaceRoot, '.vscode');
      try {
        await vscode.workspace.fs.stat(configDir);
      } catch {
        await vscode.workspace.fs.createDirectory(configDir);
      }
    } else {
      const homeDir = process.env.HOME || process.env.USERPROFILE || '';
      configFile = vscode.Uri.file(
        path.join(homeDir, '.local-llm-models.yaml')
      );
    }

    try {
      await vscode.workspace.fs.stat(configFile);
    } catch {
      await vscode.workspace.fs.writeFile(
        configFile,
        Buffer.from(getConfigYamlTemplate(), 'utf-8')
      );
      this._loadModels();
    }

    const doc = await vscode.workspace.openTextDocument(configFile);
    vscode.window.showTextDocument(doc);
  }

  // ── Helpers ──────────────────────────────────────────────

  _postMessage(message) {
    if (this._view) {
      this._view.webview.postMessage(message);
    }
  }

  refreshModels() {
    this._loadModels();
  }

  // ── WebView HTML ─────────────────────────────────────────

  _getFallbackHtml(errorMsg) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Chat</title>
  <style>
    body { font-family: sans-serif; padding: 16px; background: #1e1e1e; color: #ccc; }
    h2 { color: #f14c4c; }
    pre { background: #252526; padding: 8px; border-radius: 4px; overflow: auto; font-size: 12px; }
    button { background: #0078d4; color: #fff; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; }
  </style>
</head>
<body>
  <h2>Local LLM Chat - Error</h2>
  <p>Failed to load the chat interface.</p>
  <pre>${errorMsg}</pre>
  <p>Check the VS Code Developer Tools console (Help &rarr; Toggle Developer Tools) for details.</p>
</body>
</html>`;
  }

  _getHtml() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #1e1e1e;
      --surface: #252526;
      --surface-hover: #2d2d2d;
      --surface-active: #333;
      --border: #3c3c3c;
      --text: #cccccc;
      --text-muted: #808080;
      --accent: #0078d4;
      --user-bg: #094771;
      --bot-bg: #2d2d2d;
      --danger: #f14c4c;
      --success: #4ec94e;
      --sidebar-w: 220px;
    }
    html, body { height: 100%; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Ubuntu, sans-serif;
      background: var(--bg);
      color: var(--text);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      font-size: 13px;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .toolbar select {
      flex: 1;
      background: var(--surface);
      color: var(--text);
      border: 1px solid var(--border);
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      cursor: pointer;
    }
    .toolbar select:focus { outline: 1px solid var(--accent); }
    .toolbar button {
      background: var(--surface);
      color: var(--text);
      border: 1px solid var(--border);
      padding: 4px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 4px;
      white-space: nowrap;
    }
    .toolbar button:hover { background: var(--surface-hover); }
    .toolbar button.active { background: var(--accent); border-color: var(--accent); }
    .conn-status {
      width: 8px; height: 8px;
      border-radius: 50%;
      display: inline-block;
      flex-shrink: 0;
    }
    .conn-status.unknown { background: var(--text-muted); }
    .conn-status.testing { background: orange; animation: pulse 0.5s infinite; }
    .conn-status.connected { background: var(--success); }
    .conn-status.failed { background: var(--danger); }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

    /* ── Sidebar layout ── */
    .main-area {
      flex: 1;
      display: flex;
      overflow: hidden;
    }
    .sidebar {
      width: var(--sidebar-w);
      min-width: 0;
      flex-shrink: 0;
      background: var(--surface);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      transition: width 0.15s ease, padding 0.15s ease, border 0.15s ease;
    }
    .sidebar.collapsed {
      width: 0 !important;
      min-width: 0 !important;
      padding: 0 !important;
      border: none !important;
      overflow: hidden !important;
    }
    .sidebar-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .sidebar-header span {
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
    }
    .sidebar-header button {
      background: none;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 14px;
      padding: 2px 4px;
    }
    .sidebar-header button:hover { color: var(--text); }
    .conv-list {
      flex: 1;
      overflow-y: auto;
      padding: 4px;
    }
    .conv-item {
      display: flex;
      align-items: center;
      padding: 6px 8px;
      border-radius: 4px;
      cursor: pointer;
      gap: 6px;
      margin-bottom: 2px;
    }
    .conv-item:hover { background: var(--surface-hover); }
    .conv-item.active { background: var(--surface-active); }
    .conv-item .conv-title {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
    }
    .conv-item .conv-count {
      color: var(--text-muted);
      font-size: 10px;
      flex-shrink: 0;
    }
    .conv-item .conv-del {
      background: none;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 11px;
      padding: 0 2px;
      opacity: 0;
    }
    .conv-item:hover .conv-del { opacity: 1; }
    .conv-item .conv-del:hover { color: var(--danger); }

    /* ── Chat area ── */
    .chat-area {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .messages:empty::after {
      content: 'Send a message to start chatting';
      color: var(--text-muted);
      text-align: center;
      margin-top: 40px;
      font-style: italic;
    }
    .message {
      max-width: 92%;
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 13px;
      line-height: 1.55;
      word-wrap: break-word;
      overflow-wrap: break-word;
    }
    .message.user {
      align-self: flex-end;
      background: var(--user-bg);
      border-bottom-right-radius: 2px;
    }
    .message.assistant {
      align-self: flex-start;
      background: var(--bot-bg);
      border-bottom-left-radius: 2px;
    }
    .message .label {
      font-size: 10px;
      color: var(--text-muted);
      margin-bottom: 4px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    /* Markdown styles */
    .message h1, .message h2, .message h3,
    .message h4, .message h5, .message h6 {
      margin: 8px 0 4px;
      line-height: 1.3;
    }
    .message h1 { font-size: 16px; }
    .message h2 { font-size: 15px; }
    .message h3 { font-size: 14px; }
    .message p { margin: 4px 0; }
    .message p:first-child { margin-top: 0; }
    .message p:last-child { margin-bottom: 0; }
    .message ul, .message ol { margin: 4px 0; padding-left: 20px; }
    .message li { margin: 2px 0; }
    .message code {
      background: #3c3c3c;
      padding: 1px 4px;
      border-radius: 3px;
      font-size: 12px;
      font-family: 'Consolas', 'Courier New', monospace;
    }
    .message pre {
      margin: 8px 0;
      background: #1a1a1a;
      border-radius: 4px;
      overflow-x: auto;
    }
    .message pre code {
      display: block;
      padding: 10px;
      background: none;
      font-size: 12px;
      line-height: 1.45;
    }
    .message blockquote {
      margin: 4px 0;
      padding: 4px 8px;
      border-left: 3px solid var(--accent);
      color: var(--text-muted);
    }
    .message a { color: var(--accent); text-decoration: none; }
    .message a:hover { text-decoration: underline; }
    .message hr { border: none; border-top: 1px solid var(--border); margin: 8px 0; }
    .message img { max-width: 100%; border-radius: 4px; margin: 4px 0; }
    .message del { opacity: 0.6; }
    .message table {
      border-collapse: collapse;
      margin: 4px 0;
      font-size: 12px;
    }
    .message th, .message td {
      border: 1px solid var(--border);
      padding: 4px 8px;
      text-align: left;
    }
    .message th { background: var(--surface); }

    /* ── Input area ── */
    .input-area {
      display: flex;
      gap: 8px;
      padding: 8px;
      border-top: 1px solid var(--border);
      flex-shrink: 0;
    }
    .input-area textarea {
      flex: 1;
      background: var(--surface);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 8px;
      font-size: 13px;
      font-family: inherit;
      resize: none;
      min-height: 36px;
      max-height: 120px;
    }
    .input-area textarea:focus { outline: 1px solid var(--accent); }
    .input-area textarea::placeholder { color: var(--text-muted); }
    .input-area button {
      background: var(--accent);
      color: white;
      border: none;
      border-radius: 4px;
      padding: 8px 16px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
    }
    .input-area button:hover { opacity: 0.9; }
    .input-area button:disabled { opacity: 0.4; cursor: not-allowed; }

    .empty-models {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 20px;
      text-align: center;
      color: var(--text-muted);
      gap: 12px;
    }
    .empty-models p { font-size: 13px; }
    .empty-models button {
      background: var(--accent);
      color: white;
      border: none;
      border-radius: 4px;
      padding: 8px 16px;
      cursor: pointer;
      font-size: 13px;
    }
    .empty-models button:hover { opacity: 0.9; }
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <div class="toolbar">
    <button id="sidebarToggle" title="Toggle conversation list">&#9776;</button>
    <select id="modelSelect">
      <option value="">-- Select a model --</option>
    </select>
    <span class="conn-status unknown" id="connStatus" title="Connection status"></span>
    <button id="testBtn" title="Test connection">&#9889;</button>
    <button id="newChatBtn" title="New chat">&#65291;</button>
    <button id="configBtn" title="Open config file">&#9881;</button>
  </div>

  <div class="main-area">
    <div class="sidebar collapsed" id="sidebar">
      <div class="sidebar-header">
        <span>Conversations</span>
        <button id="closeSidebar">&times;</button>
      </div>
      <div class="conv-list" id="convList"></div>
    </div>

    <div class="chat-area">
      <div id="emptyModels" class="empty-models hidden">
        <p>No models configured.</p>
        <p style="font-size:11px;">Create a <code>.vscode/local-llm-models.yaml</code> file in your workspace, or <code>~/.local-llm-models.yaml</code> globally.</p>
        <pre id="configDebug" style="font-size:10px;text-align:left;background:#1a1a1a;padding:6px;border-radius:4px;overflow:auto;max-height:140px;margin:8px 0;word-break:break-all;"></pre>
        <button id="openConfigBtn">Create Config File</button>
      </div>

      <div id="messages" class="messages"></div>

      <div class="input-area" id="inputArea">
        <textarea id="input" rows="1" placeholder="Type a message..." disabled></textarea>
        <button id="sendBtn" disabled>Send</button>
      </div>
    </div>
  </div>

  <script>
    (function() {
      const vscode = acquireVsCodeApi();
      const messagesEl = document.getElementById('messages');
      const input = document.getElementById('input');
      const sendBtn = document.getElementById('sendBtn');
      const modelSelect = document.getElementById('modelSelect');
      const connStatus = document.getElementById('connStatus');
      const testBtn = document.getElementById('testBtn');
      const newChatBtn = document.getElementById('newChatBtn');
      const configBtn = document.getElementById('configBtn');
      const openConfigBtn = document.getElementById('openConfigBtn');
      const emptyModels = document.getElementById('emptyModels');
      const sidebar = document.getElementById('sidebar');
      const convList = document.getElementById('convList');
      const sidebarToggle = document.getElementById('sidebarToggle');
      const closeSidebar = document.getElementById('closeSidebar');

      let isGenerating = false;
      let models = [];
      let modelNames = {};
      let conversations = [];
      let currentConvId = null;
      let messageBuffers = {};

      // ── Auto-resize ──
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
        const text = input.value.trim();
        if (!text || isGenerating) return;
        input.value = '';
        input.style.height = 'auto';
        vscode.postMessage({ type: 'sendMessage', text });
      }

      // ── Model select ──
      modelSelect.addEventListener('change', function() {
        const idx = modelSelect.selectedIndex - 1;
        vscode.postMessage({ type: 'selectModel', index: idx });
        updateConnStatus(idx);
      });

      function updateConnStatus(idx) {
        connStatus.className = 'conn-status unknown';
        if (idx < 0 || idx >= models.length) return;
        const m = models[idx];
        if (modelNames[m.name + m.apiBase]) {
          connStatus.className = 'conn-status ' + modelNames[m.name + m.apiBase];
        }
      }

      // ── Toolbar buttons ──
      testBtn.addEventListener('click', function() {
        const idx = modelSelect.selectedIndex - 1;
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

      // ── Sidebar toggle ──
      sidebarToggle.addEventListener('click', function() {
        sidebar.classList.toggle('collapsed');
      });
      closeSidebar.addEventListener('click', function() {
        sidebar.classList.add('collapsed');
      });

      // ── Render conversation list ──
      function renderConversations() {
        convList.innerHTML = '';
        if (!conversations || conversations.length === 0) {
          const empty = document.createElement('div');
          empty.style.cssText = 'padding:12px;color:var(--text-muted);font-size:11px;text-align:center;';
          empty.textContent = 'No conversations';
          convList.appendChild(empty);
          return;
        }
        for (const conv of conversations) {
          const item = document.createElement('div');
          item.className = 'conv-item' + (conv.id === currentConvId ? ' active' : '');

          const title = document.createElement('span');
          title.className = 'conv-title';
          title.textContent = conv.title;
          item.appendChild(title);

          const count = document.createElement('span');
          count.className = 'conv-count';
          count.textContent = conv.messageCount;
          item.appendChild(count);

          const del = document.createElement('button');
          del.className = 'conv-del';
          del.textContent = '\u2715';
          del.title = 'Delete conversation';
          del.addEventListener('click', function(e) {
            e.stopPropagation();
            vscode.postMessage({ type: 'deleteConversation', id: conv.id });
          });
          item.appendChild(del);

          item.addEventListener('click', function() {
            vscode.postMessage({ type: 'switchConversation', id: conv.id });
          });

          convList.appendChild(item);
        }
      }

      // ── Markdown renderer ──
      function escapeHtml(text) {
        return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      }

      function renderMarkdown(text) {
        if (!text) return '';
        const lines = text.split('\n');
        let html = '';
        let i = 0;

        function renderInline(t) {
          if (!t) return '';
          let r = escapeHtml(t);
          r = r.replace(/!\\[([^\\]]*)\\]\\(([^)]+)\\)/g, '<img src="$2" alt="$1" style="max-width:100%;border-radius:4px;">');
          r = r.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>');
          r = r.replace(/\x60([^\x60]+)\x60/g, '<code>$1</code>');
          r = r.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
          r = r.replace(/__([^_]+)__/g, '<strong>$1</strong>');
          r = r.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
          r = r.replace(/_([^_]+)_/g, '<em>$1</em>');
          r = r.replace(/~~([^~]+)~~/g, '<del>$1</del>');
          return r;
        }

        while (i < lines.length) {
          const line = lines[i];

          if (line.trimStart().startsWith('\x60\x60\x60')) {
            const lang = line.trimStart().slice(3).trim();
            const codeLines = [];
            i++;
            while (i < lines.length && !lines[i].trimStart().startsWith('\x60\x60\x60')) {
              codeLines.push(lines[i]);
              i++;
            }
            i++;
            const code = escapeHtml(codeLines.join('\n'));
            html += '<pre><code' + (lang ? ' class="language-' + escapeHtml(lang) + '"' : '') + '>' + code + '</code></pre>\n';
            continue;
          }

          if (line.trimStart().startsWith('> ')) {
            const qLines = [];
            while (i < lines.length && lines[i].trimStart().startsWith('> ')) {
              qLines.push(lines[i].trimStart().slice(2));
              i++;
            }
            html += '<blockquote>' + renderInline(qLines.join('\n')) + '</blockquote>\n';
            continue;
          }

          if (/^\\s*[-*+]\\s/.test(line)) {
            html += '<ul>\n';
            while (i < lines.length && /^\\s*[-*+]\\s/.test(lines[i])) {
              html += '<li>' + renderInline(lines[i].replace(/^\\s*[-*+]\\s/, '')) + '</li>\n';
              i++;
            }
            html += '</ul>\n';
            continue;
          }

          if (/^\\s*\\d+\\.\\s/.test(line)) {
            html += '<ol>\n';
            while (i < lines.length && /^\\s*\\d+\\.\\s/.test(lines[i])) {
              html += '<li>' + renderInline(lines[i].replace(/^\\s*\\d+\\.\\s/, '')) + '</li>\n';
              i++;
            }
            html += '</ol>\n';
            continue;
          }

          const hMatch = line.match(/^(#{1,6})\\s+(.+)$/);
          if (hMatch) {
            html += '<h' + hMatch[1].length + '>' + renderInline(hMatch[2]) + '</h' + hMatch[1].length + '>\n';
            i++;
            continue;
          }

          if (line.trim() === '') { i++; continue; }

          const paraLines = [];
          while (i < lines.length && lines[i].trim() !== '' &&
                 !lines[i].trimStart().startsWith('\x60\x60\x60') &&
                 !lines[i].trimStart().startsWith('> ') &&
                 !/^\\s*[-*+]\\s/.test(lines[i]) &&
                 !/^\\s*\\d+\\.\\s/.test(lines[i]) &&
                 !/^#{1,6}\\s/.test(lines[i])) {
            paraLines.push(lines[i]);
            i++;
          }
          html += '<p>' + renderInline(paraLines.join('\n')) + '</p>\n';
        }
        return html;
      }

      // ── Message rendering helpers ──
      function createMessageEl(role, content, messageId) {
        const msgDiv = document.createElement('div');
        msgDiv.className = 'message ' + role;
        if (messageId) msgDiv.dataset.messageId = messageId;
        const label = document.createElement('div');
        label.className = 'label';
        label.textContent = role === 'user' ? 'You' : 'Assistant';
        msgDiv.appendChild(label);
        const contentDiv = document.createElement('div');
        contentDiv.className = 'content';
        contentDiv.innerHTML = renderMarkdown(content || '');
        msgDiv.appendChild(contentDiv);
        messagesEl.appendChild(msgDiv);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        return msgDiv;
      }

      function updateMessageContent(messageId) {
        const el = messagesEl.querySelector('[data-message-id="' + messageId + '"]');
        if (el) {
          el.querySelector('.content').innerHTML = renderMarkdown(messageBuffers[messageId] || '');
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }
      }

      // ── Message event handling ──
      window.addEventListener('message', function(event) {
        const d = event.data;

        switch (d.type) {
          case 'setModels':
            modelSelect.innerHTML = '<option value="">-- Select a model --</option>';
            models = d.models || [];
            modelNames = {};
            models.forEach(function(m, i) {
              const opt = document.createElement('option');
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

          case 'configDebug':
            if (d.debug) {
              var debugEl = document.getElementById('configDebug');
              if (debugEl) {
                var txt = '';
                (d.debug.pathsChecked || []).forEach(function(p, i) {
                  txt += (i === 0 ? 'Workspace: ' : 'Global:    ') + p + '\n';
                });
                if (d.debug.found) {
                  txt += 'Found: ' + d.debug.found + '\n';
                }
                if (d.debug.error) {
                  txt += 'Error: ' + d.debug.error;
                }
                debugEl.textContent = txt;
              }
            }
            break;

          case 'setConversations':
            conversations = d.conversations || [];
            currentConvId = d.currentId;
            renderConversations();
            break;

          case 'loadConversation':
            messagesEl.innerHTML = '';
            messageBuffers = {};
            if (d.modelIndex !== undefined) {
              modelSelect.selectedIndex = d.modelIndex + 1;
              updateConnStatus(d.modelIndex);
            }
            if (d.messages) {
              d.messages.forEach(function(msg, idx) {
                const mid = 'stored-' + idx + '-' + Date.now();
                messageBuffers[mid] = msg.content || '';
                createMessageEl(msg.role, msg.content, mid);
              });
            }
            break;

          case 'connectionStatus': {
            const idx = d.index;
            const m = models[idx];
            if (m) {
              modelNames[m.name + m.apiBase] = d.status;
              if (modelSelect.selectedIndex - 1 === idx) {
                connStatus.className = 'conn-status ' + d.status;
              }
            }
            break;
          }

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
            } else if (!d.messageId) {
              const msgs = messagesEl.querySelectorAll('.message.assistant');
              const target = msgs[msgs.length - 1];
              if (target) {
                const cur = target.querySelector('.content').textContent + d.content;
                target.querySelector('.content').innerHTML = renderMarkdown(cur);
                messagesEl.scrollTop = messagesEl.scrollHeight;
              }
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
        }
      });

      vscode.postMessage({ type: 'ready' });
    })();
  </script>
</body>
</html>`;
  }
}

module.exports = { ChatViewProvider };
