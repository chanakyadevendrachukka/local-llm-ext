const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
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
    this.sendConversations();
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
    this.clearAndLoadMessages();
  }

  updateCurrentTitle(title) {
    const conv = this.getCurrentConversation();
    if (conv && conv.title === 'New Chat' && title) {
      conv.title = title.length > 60 ? title.slice(0, 60) + '...' : title;
      this.saveConversations();
      this.sendConversations();
    }
  }

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
      this.postMessage({ type: 'configStatus', pathsChecked: paths, workspaceOpen: !!workspaceRoot });
    }
  }

  refreshModels() {
    this.loadModels();
  }

  resolveWebviewView(webviewView, _context, _token) {
    this.output.appendLine('resolveWebviewView called');
    this.view = webviewView;

    webviewView.webview.options = { enableScripts: true };

    try {
      const htmlPath = path.join(this.context.extensionPath, 'src', 'chatView.html');
      this.output.appendLine('Reading HTML from: ' + htmlPath);
      const html = fs.readFileSync(htmlPath, 'utf-8');
      webviewView.webview.html = html;
      this.output.appendLine('HTML set, length: ' + html.length);
    } catch (err) {
      this.output.appendLine('ERROR reading HTML: ' + err.message);
      webviewView.webview.html = this.getErrorHtml(err.message);
      return;
    }

    this.loadModels();
    this.sendConversations();

    webviewView.webview.onDidReceiveMessage(data => {
      try {
        this.handleMessage(data);
      } catch (err) {
        this.output.appendLine('Error handling message: ' + err.message);
      }
    });
  }

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

  async handleSendMessage(text) {
    if (!text.trim()) return;

    const current = this.getCurrentConversation();
    if (current && current.messages.length === 0) {
      this.updateCurrentTitle(text);
    }

    const model = this.models[this.selectedModelIndex];
    if (!model) {
      vscode.window.showWarningMessage('No model selected');
      this.output.appendLine('No model selected when sending message');
      return;
    }

    const userMsg = { role: 'user', content: text };
    if (current) current.messages.push(userMsg);
    this.saveConversations();

    this.postMessage({ type: 'addMessage', role: 'user', content: text });
    this.postMessage({ type: 'generating', isGenerating: true });

    const messageId = 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    this.postMessage({ type: 'addMessage', role: 'assistant', content: '', messageId: messageId });

    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    try {
      let fullContent = '';
      await createChatCompletion(
        model,
        current ? current.messages : [{ role: 'user', content: text }],
        (chunk) => {
          fullContent += chunk;
          this.postMessage({ type: 'appendToMessage', messageId: messageId, content: chunk });
        },
        signal
      );

      if (signal.aborted) return;

      if (current) {
        current.messages.push({ role: 'assistant', content: fullContent });
      }
      this.saveConversations();
    } catch (err) {
      if (signal.aborted) return;
      const errorText = err.message === 'Request aborted'
        ? '\n\n[Stopped]'
        : '\n\nError: ' + err.message;
      this.postMessage({ type: 'appendToMessage', messageId: messageId, content: errorText });
      this.output.appendLine('Send message error: ' + err.message);
    }

    this.postMessage({ type: 'generating', isGenerating: false });
    this.abortController = undefined;
  }

  async handleTestConnection(index) {
    const model = this.models[index];
    if (!model) return;
    this.postMessage({ type: 'connectionStatus', index: index, status: 'testing' });
    try {
      await testConnection(model);
      this.postMessage({ type: 'connectionStatus', index: index, status: 'connected' });
      this.output.appendLine('Connection test passed for ' + model.name);
    } catch (err) {
      this.postMessage({ type: 'connectionStatus', index: index, status: 'failed' });
      this.output.appendLine('Connection test failed for ' + model.name + ': ' + err.message);
    }
  }

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
      await vscode.workspace.fs.writeFile(configFile, Buffer.from(getConfigYamlTemplate(), 'utf-8'));
    }

    const doc = await vscode.workspace.openTextDocument(configFile);
    await vscode.window.showTextDocument(doc);
    this.loadModels();
  }

  postMessage(message) {
    if (this.view) {
      try {
        this.view.webview.postMessage(message);
      } catch (err) {
        this.output.appendLine('postMessage error: ' + err.message);
      }
    }
  }

  sendConversations() {
    this.postMessage({
      type: 'setConversations',
      conversations: this.getConversationList(),
      currentId: this.currentId,
    });
  }

  clearAndLoadMessages() {
    this.postMessage({ type: 'clearMessages' });
    const conv = this.getCurrentConversation();
    if (conv && conv.messages.length > 0) {
      for (const msg of conv.messages) {
        this.postMessage({ type: 'addMessage', role: msg.role, content: msg.content });
      }
    }
  }

  getErrorHtml(msg) {
    return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Error</title></head><body style="background:#1e1e1e;color:#ccc;font-family:sans-serif;padding:16px;"><h2 style="color:#f14c4c;">Local LLM Chat - Error</h2><pre style="background:#252526;padding:8px;border-radius:4px;">' + msg.replace(/</g,'&lt;') + '</pre><p>Check the Output panel (View &rarr; Output &rarr; Local LLM Chat) for details.</p></body></html>';
  }
}

module.exports = { ChatViewProvider };
