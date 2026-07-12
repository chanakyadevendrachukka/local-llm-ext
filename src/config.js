const fs = require('fs');
const path = require('path');

const CONFIG_FILENAME = '.vscode/local-llm-models.yaml';

function parseYaml(text) {
  const rawLines = text.split('\n').map(l => l.replace(/\t/g, '  '));
  const lines = [];
  for (const l of rawLines) {
    const t = l.trim();
    if (t === '' || t.startsWith('#')) continue;
    lines.push(l);
  }

  let pos = 0;

  function peekIndent() {
    if (pos >= lines.length) return -1;
    const m = lines[pos].match(/^(\s*)/);
    return m ? m[1].length : 0;
  }

  function parseMapping(indent) {
    const obj = {};
    while (pos < lines.length) {
      const lineIndent = peekIndent();
      if (lineIndent < indent) break;
      if (lineIndent > indent) break;

      const line = lines[pos++];
      const content = line.trim();
      const colonIdx = content.indexOf(':');
      if (colonIdx === -1) continue;

      const key = content.slice(0, colonIdx).trim();
      const val = content.slice(colonIdx + 1).trim();

      if (val === '') {
        obj[key] = parseValue();
      } else {
        obj[key] = parseScalar(val);
      }
    }
    return obj;
  }

  function parseArray(indent) {
    const arr = [];
    while (pos < lines.length && peekIndent() >= indent) {
      const lineIndent = peekIndent();
      if (lineIndent !== indent) break;

      const line = lines[pos++];
      const content = line.trim();
      if (!content.startsWith('- ')) break;

      const rest = content.slice(2).trim();
      const colonIdx = rest.indexOf(':');
      if (colonIdx !== -1) {
        const key = rest.slice(0, colonIdx).trim();
        const val = rest.slice(colonIdx + 1).trim();
        const item = {};

        if (val !== '') {
          item[key] = parseScalar(val);
        }

        const subIndent = peekIndent();
        if (subIndent > lineIndent) {
          const subObj = parseMapping(subIndent);
          Object.assign(item, subObj);
        }
        arr.push(item);
      } else {
        arr.push(parseScalar(rest));
      }
    }
    return arr;
  }

  function parseValue() {
    if (pos >= lines.length) return null;
    const indent = peekIndent();
    if (indent < 0) return null;

    const content = lines[pos].trim();
    if (content.startsWith('- ')) {
      return parseArray(indent);
    }
    if (content.includes(':')) {
      return parseMapping(indent);
    }
    return null;
  }

  return parseMapping(0);
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

function getConfigPaths(workspaceRoot) {
  const paths = [];
  if (workspaceRoot) {
    paths.push(path.join(workspaceRoot, CONFIG_FILENAME));
  }
  paths.push(path.join(
    process.env.HOME || process.env.USERPROFILE || '/tmp',
    '.local-llm-models.yaml'
  ));
  return paths;
}

function loadConfig(workspaceRoot) {
  const paths = getConfigPaths(workspaceRoot);
  for (const configPath of paths) {
    if (fs.existsSync(configPath)) {
      try {
        const content = fs.readFileSync(configPath, 'utf-8');
        const parsed = parseYaml(content);
        if (parsed && Array.isArray(parsed.models)) {
          return { models: parsed.models, configPath: configPath };
        }
      } catch (_) {}
    }
  }
  return { models: [], configPath: null };
}

function getConfigYamlTemplate() {
  return '# Local LLM Chat - Model Configuration\nmodels:\n  - name: "Llama 3 (Ollama)"\n    provider: "ollama"\n    apiBase: "http://localhost:11434"\n    model: "llama3"\n    maxTokens: 2048\n    temperature: 0.7\n  - name: "Mistral (OpenAI-compatible)"\n    provider: "openai"\n    apiBase: "http://localhost:1234/v1"\n    model: "mistral"\n    apiKey: ""\n';
}

module.exports = { loadConfig, getConfigYamlTemplate, getConfigPaths };
