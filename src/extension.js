const vscode = require('vscode');
const { ChatViewProvider } = require('./chatProvider');

let outputChannel;

function activate(context) {
  outputChannel = vscode.window.createOutputChannel('Local LLM Chat');
  outputChannel.appendLine('Extension activating...');

  const chatProvider = new ChatViewProvider(context, outputChannel);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chatProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('local-llm-chat.openChat', () => {
      vscode.commands.executeCommand('workbench.view.extension.local-llm-chat');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('local-llm-chat.refreshModels', () => {
      chatProvider.refreshModels();
    })
  );

  outputChannel.appendLine('Extension activated');
}

function deactivate() {}

module.exports = { activate, deactivate };
