const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { loadConfig, getConfigYamlTemplate } = require('./config');
const { createChatCompletion, testConnection } = require('./llmClient');

const STORAGE_KEY = 'local-llm-chat.conversations';
const MAX_FILE_SIZE = 64000;

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
      for (const c of this.conversations) {
        if (!c.contextFilePaths) c.contextFilePaths = [];
      }
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
      contextFilePaths: [],
    };
    this.conversations.push(conv);
    this.currentId = conv.id;
    this.saveConversations();
    this.sendConversations();
    this.sendContextFiles();
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
    this.sendContextFiles();
  }

  updateCurrentTitle(title) {
    const conv = this.getCurrentConversation();
    if (conv && conv.title === 'New Chat' && title) {
      conv.title = title.length > 60 ? title.slice(0, 60) + '...' : title;
      this.saveConversations();
      this.sendConversations();
    }
  }

  getWorkspaceRoot() {
    return vscode.workspace.workspaceFolders
      ? vscode.workspace.workspaceFolders[0].uri.fsPath
      : undefined;
  }

  getContextFiles() {
    const conv = this.getCurrentConversation();
    if (!conv || !conv.contextFilePaths || conv.contextFilePaths.length === 0) return [];

    const root = this.getWorkspaceRoot();
    if (!root) return [];

    return conv.contextFilePaths.map(p => {
      const absPath = path.isAbsolute(p) ? p : path.join(root, p);
      try {
        const uri = vscode.Uri.file(absPath);
        const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
        let content = doc ? doc.getText() : fs.readFileSync(absPath, 'utf-8');
        if (content.length > MAX_FILE_SIZE) {
          content = content.slice(0, MAX_FILE_SIZE) + '\n\n... [file truncated at ' + MAX_FILE_SIZE + ' characters]';
        }
        return { path: p, content: content };
      } catch (_) {
        return null;
      }
    }).filter(Boolean);
  }

  getContextFilePaths() {
    const conv = this.getCurrentConversation();
    if (!conv) return [];
    conv.contextFilePaths = conv.contextFilePaths || [];
    return conv.contextFilePaths;
  }

  sendContextFiles() {
    const files = this.getContextFiles();
    this.postMessage({
      type: 'contextFiles',
      files: files.map(f => ({ path: f.path })),
    });
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
      models: this.models.map(m => ({
        name: m.name,
        apiBase: m.apiBase,
        model: m.model,
        provider: m.provider,
        maxTokens: m.maxTokens,
        temperature: m.temperature,
      })),
      selectedIndex: this.selectedModelIndex,
    });

    if (this.models.length === 0) {
      const paths = [];
      if (workspaceRoot) {
        paths.push(path.join(workspaceRoot, 'config.yaml'));
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
    this.sendContextFiles();

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
        this.sendContextFiles();
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
      case 'addContextFile':
        this.handleAddContextFile(data.path);
        break;
      case 'removeContextFile':
        this.handleRemoveContextFile(data.path);
        break;
      case 'pickContextFile':
        this.handlePickContextFile();
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

    const contextFiles = this.getContextFiles();
    let messagesForApi;
    if (current) {
      messagesForApi = current.messages.slice();
    } else {
      messagesForApi = [{ role: 'user', content: text }];
    }
    if (contextFiles.length > 0) {
      const ctxBlocks = contextFiles.map(f =>
        '## ' + f.path + '\n```\n' + f.content + '\n```'
      ).join('\n\n');
      const ctxMsg = {
        role: 'system',
        content: 'The user has provided the following files for context:\n\n' + ctxBlocks,
      };
      messagesForApi.unshift(ctxMsg);
    }

    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    try {
      let fullContent = '';
      let fullThinking = '';
      await createChatCompletion(
        model,
        messagesForApi,
        (chunk) => {
          if (chunk.type === 'thinking') {
            fullThinking += chunk.content;
            this.postMessage({ type: 'appendThinking', messageId: messageId, content: chunk.content });
          } else if (chunk.type === 'content') {
            fullContent += chunk.content;
            this.postMessage({ type: 'appendToMessage', messageId: messageId, content: chunk.content });
          }
        },
        signal
      );

      if (signal.aborted) return;

      if (current) {
        const assistantMsg = { role: 'assistant', content: fullContent };
        if (fullThinking) assistantMsg.thinkingContent = fullThinking;
        current.messages.push(assistantMsg);
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

  handleAddContextFile(filePath) {
    const root = this.getWorkspaceRoot();
    if (!root) return;

    let targetPath = filePath;
    if (filePath === '__active_editor__') {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      targetPath = path.relative(root, editor.document.uri.fsPath);
    }

    const absPath = path.isAbsolute(targetPath) ? targetPath : path.join(root, targetPath);
    const relPath = path.relative(root, absPath);

    const conv = this.getCurrentConversation();
    if (!conv) return;
    conv.contextFilePaths = conv.contextFilePaths || [];
    if (conv.contextFilePaths.includes(relPath)) return;

    try {
      fs.accessSync(absPath);
    } catch (_) {
      this.output.appendLine('File not found: ' + relPath);
      return;
    }

    conv.contextFilePaths.push(relPath);
    this.saveConversations();
    this.sendContextFiles();
    this.output.appendLine('Added context file: ' + relPath);
  }

  handleRemoveContextFile(filePath) {
    const conv = this.getCurrentConversation();
    if (!conv) return;
    conv.contextFilePaths = (conv.contextFilePaths || []).filter(p => p !== filePath);
    this.saveConversations();
    this.sendContextFiles();
    this.output.appendLine('Removed context file: ' + filePath);
  }

  async handlePickContextFile() {
    const root = this.getWorkspaceRoot();
    if (!root) return;

    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFiles: true,
      canSelectFolders: false,
      defaultUri: vscode.Uri.file(root),
    });
    if (!uris) return;

    for (const uri of uris) {
      const relPath = path.relative(root, uri.fsPath);
      this.handleAddContextFile(relPath);
    }
  }

  async openConfigFile() {
    const workspaceRoot = vscode.workspace.workspaceFolders
      ? vscode.workspace.workspaceFolders[0].uri.fsPath
      : undefined;

    let configDir, configFile;

    if (workspaceRoot) {
      configDir = vscode.Uri.file(workspaceRoot);
      configFile = vscode.Uri.file(path.join(workspaceRoot, 'config.yaml'));
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
        this.postMessage({ type: 'addMessage', role: msg.role, content: msg.content, thinkingContent: msg.thinkingContent });
      }
    }
  }

  getErrorHtml(msg) {
    return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Error</title></head><body style="background:#1e1e1e;color:#ccc;font-family:sans-serif;padding:16px;"><h2 style="color:#f14c4c;">Local LLM Chat - Error</h2><pre style="background:#252526;padding:8px;border-radius:4px;">' + msg.replace(/</g,'&lt;') + '</pre><p>Check the Output panel (View &rarr; Output &rarr; Local LLM Chat) for details.</p></body></html>';
  }
}

module.exports = { ChatViewProvider };
