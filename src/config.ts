import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

export interface ModelConfig {
  name: string;
  provider: string;
  apiBase: string;
  model: string;
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface AppConfig {
  models: ModelConfig[];
}

const CONFIG_FILENAME = '.vscode/local-llm-models.yaml';

export function loadConfig(workspaceRoot?: string): AppConfig {
  const defaultConfig: AppConfig = { models: [] };

  const possiblePaths: string[] = [];

  if (workspaceRoot) {
    possiblePaths.push(path.join(workspaceRoot, CONFIG_FILENAME));
  }

  const homeConfig = path.join(
    process.env.HOME || process.env.USERPROFILE || '',
    '.local-llm-models.yaml'
  );
  possiblePaths.push(homeConfig);

  for (const configPath of possiblePaths) {
    if (fs.existsSync(configPath)) {
      try {
        const content = fs.readFileSync(configPath, 'utf-8');
        const parsed = yaml.load(content) as AppConfig;
        if (parsed && Array.isArray(parsed.models)) {
          return parsed;
        }
      } catch (err) {
        vscode.window.showWarningMessage(
          `Failed to parse config file: ${configPath}`
        );
      }
    }
  }

  return defaultConfig;
}

export function getConfigYamlTemplate(): string {
  return `# Local LLM Chat - Model Configuration
# Place this file at .vscode/local-llm-models.yaml in your workspace
# or at ~/.local-llm-models.yaml for global config

models:
  - name: "Llama 3 (Ollama)"
    provider: "ollama"
    apiBase: "http://localhost:11434"
    model: "llama3"
    maxTokens: 2048
    temperature: 0.7

  - name: "Codestral (OpenAI-compatible)"
    provider: "openai"
    apiBase: "http://localhost:1234/v1"
    model: "codestral"
    apiKey: ""

  - name: "DeepSeek (Ollama)"
    provider: "ollama"
    apiBase: "http://192.168.1.100:11434"
    model: "deepseek-coder:6.7b"
`;
}
