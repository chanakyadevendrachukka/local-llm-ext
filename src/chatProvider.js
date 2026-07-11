const vscode = require('vscode');
const { loadConfig, getConfigYamlTemplate } = require('./config');
const { createChatCompletion, testConnection } = require('./llmClient');

class ChatViewProvider {
  static viewType = 'local-llm-chat.chatView';

  constructor(extensionUri) {
    this._extensionUri = extensionUri;
    this._view = undefined;
    this._models = [];
    this._messages = [];
    this._abortController = undefined;
    this._selectedModelIndex = 0;
  }

  resolveWebviewView(webviewView, _context, _token) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this._getHtml();

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'ready':
          this._loadModels();
          break;
        case 'sendMessage':
          await this._handleSendMessage(data.text);
          break;
        case 'selectModel':
          this._selectedModelIndex = data.index;
          break;
        case 'newChat':
          this._messages = [];
          this._postMessage({ type: 'clearMessages' });
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

  _loadModels() {
    const workspaceRoot = vscode.workspace.workspaceFolders
      ? vscode.workspace.workspaceFolders[0].uri.fsPath
      : undefined;
    const config = loadConfig(workspaceRoot);
    this._models = config.models;

    this._postMessage({
      type: 'setModels',
      models: this._models.map((m) => ({
        name: m.name,
        apiBase: m.apiBase,
        model: m.model,
      })),
      selectedIndex: this._selectedModelIndex,
    });
  }

  async _handleSendMessage(text) {
    if (!text.trim()) return;

    const model = this._models[this._selectedModelIndex];
    if (!model) {
      vscode.window.showWarningMessage(
        'No model selected. Configure models in .vscode/local-llm-models.yaml'
      );
      return;
    }

    const userMessage = { role: 'user', content: text };
    this._messages.push(userMessage);

    this._postMessage({ type: 'addMessage', role: 'user', content: text });
    this._postMessage({ type: 'generating', isGenerating: true });

    this._abortController = new AbortController();

    try {
      const assistantMessage = { role: 'assistant', content: '' };
      this._messages.push(assistantMessage);

      const messageId = Date.now().toString();
      this._postMessage({
        type: 'addMessage',
        role: 'assistant',
        content: '',
        messageId,
      });

      const fullContent = await createChatCompletion(
        model,
        this._messages,
        (chunk) => {
          this._postMessage({
            type: 'appendToMessage',
            messageId,
            content: chunk,
          });
        },
        this._abortController.signal
      );

      assistantMessage.content = fullContent;
    } catch (err) {
      if (err.message === 'Request aborted') {
        this._postMessage({
          type: 'appendToMessage',
          messageId: '',
          content: '\n\n[Generation stopped]',
        });
      } else {
        this._postMessage({
          type: 'addMessage',
          role: 'assistant',
          content: `Error: ${err.message}`,
        });
      }
    }

    this._postMessage({ type: 'generating', isGenerating: false });
  }

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

  async _openConfigFile() {
    const workspaceRoot = vscode.workspace.workspaceFolders
      ? vscode.workspace.workspaceFolders[0].uri
      : undefined;

    if (!workspaceRoot) {
      vscode.window.showInformationMessage(
        'Open a workspace first, or create ~/.local-llm-models.yaml'
      );
      return;
    }

    const configDir = vscode.Uri.joinPath(workspaceRoot, '.vscode');
    const configFile = vscode.Uri.joinPath(
      workspaceRoot,
      '.vscode',
      'local-llm-models.yaml'
    );

    try {
      await vscode.workspace.fs.stat(configDir);
    } catch {
      await vscode.workspace.fs.createDirectory(configDir);
    }

    try {
      await vscode.workspace.fs.stat(configFile);
    } catch {
      await vscode.workspace.fs.writeFile(
        configFile,
        Buffer.from(getConfigYamlTemplate(), 'utf-8')
      );
    }

    const doc = await vscode.workspace.openTextDocument(configFile);
    vscode.window.showTextDocument(doc);
  }

  _postMessage(message) {
    if (this._view) {
      this._view.webview.postMessage(message);
    }
  }

  refreshModels() {
    this._loadModels();
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
      --border: #3c3c3c;
      --text: #cccccc;
      --text-muted: #808080;
      --accent: #0078d4;
      --user-bg: #094771;
      --bot-bg: #2d2d2d;
      --danger: #f14c4c;
      --success: #4ec94e;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Ubuntu, sans-serif;
      background: var(--bg);
      color: var(--text);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
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
    }
    .toolbar button:hover { background: var(--surface-hover); }
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
      max-width: 85%;
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 13px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-wrap: break-word;
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
    .hidden { display: none; }
  </style>
</head>
<body>
  <div class="toolbar">
    <select id="modelSelect">
      <option value="">-- Select a model --</option>
    </select>
    <span class="conn-status unknown" id="connStatus" title="Connection status"></span>
    <button id="testBtn" title="Test connection">&#9889;</button>
    <button id="newChatBtn" title="New chat">&#65291;</button>
    <button id="configBtn" title="Open config file">&#9881;</button>
  </div>

  <div id="emptyModels" class="empty-models hidden">
    <p>No models configured.</p>
    <p style="font-size:11px;">Create a <code>.vscode/local-llm-models.yaml</code> file to add models.</p>
    <button id="openConfigBtn">Create Config File</button>
  </div>

  <div id="messages" class="messages"></div>

  <div class="input-area" id="inputArea">
    <textarea id="input" rows="1" placeholder="Type a message..." disabled></textarea>
    <button id="sendBtn" disabled>Send</button>
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
      const inputArea = document.getElementById('inputArea');

      let isGenerating = false;
      let models = [];
      let modelNames = {};

      function autoResize() {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
      }

      input.addEventListener('input', autoResize);

      input.addEventListener('keydown', (e) => {
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

      modelSelect.addEventListener('change', () => {
        const idx = modelSelect.selectedIndex - 1;
        vscode.postMessage({ type: 'selectModel', index: idx });
        updateConnStatus(idx);
      });

      testBtn.addEventListener('click', () => {
        const idx = modelSelect.selectedIndex - 1;
        if (idx >= 0) {
          vscode.postMessage({ type: 'testConnection', index: idx });
        }
      });

      newChatBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'newChat' });
      });

      configBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'openConfig' });
      });

      openConfigBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'openConfig' });
      });

      function updateConnStatus(idx) {
        connStatus.className = 'conn-status unknown';
        if (idx < 0 || idx >= models.length) return;
        const m = models[idx];
        if (modelNames[m.name + m.apiBase]) {
          connStatus.className = 'conn-status ' + modelNames[m.name + m.apiBase];
        }
      }

      window.addEventListener('message', (event) => {
        const data = event.data;
        switch (data.type) {
          case 'setModels':
            modelSelect.innerHTML = '<option value="">-- Select a model --</option>';
            models = data.models || [];
            modelNames = {};
            models.forEach((m, i) => {
              const opt = document.createElement('option');
              opt.textContent = m.name + ' (' + m.apiBase + ')';
              modelSelect.appendChild(opt);
              if (i === data.selectedIndex) {
                modelSelect.selectedIndex = i + 1;
              }
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

          case 'connectionStatus': {
            const idx = data.index;
            const m = models[idx];
            if (m) {
              modelNames[m.name + m.apiBase] = data.status;
              if (modelSelect.selectedIndex - 1 === idx) {
                connStatus.className = 'conn-status ' + data.status;
              }
            }
            break;
          }

          case 'addMessage': {
            const msgDiv = document.createElement('div');
            msgDiv.className = 'message ' + data.role;
            if (data.messageId) {
              msgDiv.dataset.messageId = data.messageId;
            }
            const label = document.createElement('div');
            label.className = 'label';
            label.textContent = data.role === 'user' ? 'You' : 'Assistant';
            msgDiv.appendChild(label);
            const contentDiv = document.createElement('div');
            contentDiv.className = 'content';
            contentDiv.textContent = data.content || '';
            msgDiv.appendChild(contentDiv);
            messagesEl.appendChild(msgDiv);
            messagesEl.scrollTop = messagesEl.scrollHeight;
            break;
          }

          case 'appendToMessage': {
            const msgs = messagesEl.querySelectorAll('.message.assistant');
            let target;
            if (data.messageId) {
              target = messagesEl.querySelector('[data-message-id="' + data.messageId + '"]');
            } else {
              target = msgs[msgs.length - 1];
            }
            if (target) {
              target.querySelector('.content').textContent += data.content;
              messagesEl.scrollTop = messagesEl.scrollHeight;
            }
            break;
          }

          case 'clearMessages':
            messagesEl.innerHTML = '';
            break;

          case 'generating':
            isGenerating = data.isGenerating;
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
