const vscode = require('vscode');
const { ChatViewProvider } = require('./chatProvider');

function activate(context) {
  const chatProvider = new ChatViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chatProvider
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('local-llm-chat.openChat', () => {
      vscode.commands.executeCommand(
        'workbench.view.extension.local-llm-chat'
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('local-llm-chat.refreshModels', () => {
      chatProvider.refreshModels();
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
