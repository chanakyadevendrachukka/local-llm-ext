const fs = require('fs');
const path = require('path');

function parseYaml(text) {
  const lines = text.split('\n');
  const result = {};
  const stack = [{ obj: result, indent: -1 }];

  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ');
    if (line.trim() === '' || line.trim().startsWith('#')) continue;

    const indent = line.search(/\S/);
    const content = line.trim();

    const colonIdx = content.indexOf(':');
    if (colonIdx === -1) continue;

    const key = content.slice(0, colonIdx).trim();
    let val = content.slice(colonIdx + 1).trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].obj;

    if (val === '') {
      const newObj = Array.isArray(parent) ? {} : {};
      if (Array.isArray(parent)) {
        parent.push(newObj);
      } else if (key.startsWith('- ')) {
        if (!Array.isArray(parent)) {
          const arrKey = key.slice(2);
          const arr = [];
          parent[arrKey] = arr;
          stack.push({ obj: arr, indent });
          continue;
        }
      } else {
        parent[key] = newObj;
      }
      stack.push({ obj: newObj, indent });
    } else if (key.startsWith('- ')) {
      // List item with value
      if (!Array.isArray(parent)) {
        // Should not happen in well-formed YAML
        parent[key.slice(2)] = parseScalar(val);
      } else {
        parent.push(parseScalar(val));
      }
    } else {
      parent[key] = parseScalar(val);
    }
  }

  return result;
}

function parseScalar(val) {
  if (val === 'true') return true;
  if (val === 'false') return false;
  if (val === 'null' || val === '~') return null;
  const num = Number(val);
  if (!isNaN(num) && val.trim() !== '') return num;
  if ((val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  return val;
}

const CONFIG_FILENAME = '.vscode/local-llm-models.yaml';

function loadConfig(workspaceRoot) {
  const defaultConfig = { models: [] };

  const possiblePaths = [];

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
        const parsed = parseYaml(content);
        if (parsed && Array.isArray(parsed.models)) {
          return parsed;
        }
      } catch (err) {
        // Silently skip invalid configs
      }
    }
  }

  return defaultConfig;
}

function getConfigYamlTemplate() {
  return `# Local LLM Chat - Model Configuration
models:
  - name: "Llama 3 (Ollama)"
    provider: "ollama"
    apiBase: "http://localhost:11434"
    model: "llama3"
    maxTokens: 2048
    temperature: 0.7
  - name: "Mistral (OpenAI-compatible)"
    provider: "openai"
    apiBase: "http://localhost:1234/v1"
    model: "mistral"
    apiKey: ""
  - name: "DeepSeek (Ollama)"
    provider: "ollama"
    apiBase: "http://192.168.1.100:11434"
    model: "deepseek-coder:6.7b"
`;
}

module.exports = { loadConfig, getConfigYamlTemplate };
