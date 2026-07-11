const https = require('https');
const http = require('http');

function createChatCompletion(config, messages, onChunk, signal) {
  if (config.provider === 'ollama') {
    return ollamaChat(config, messages, onChunk, signal);
  }
  return openaiChat(config, messages, onChunk, signal);
}

function ollamaChat(config, messages, onChunk, signal) {
  const url = new URL('/api/chat', config.apiBase);
  const body = JSON.stringify({
    model: config.model,
    messages,
    stream: true,
    options: {
      num_predict: config.maxTokens ?? 2048,
      temperature: config.temperature ?? 0.7,
    },
  });

  return streamRequest(
    url.toString(),
    body,
    onChunk,
    (line) => {
      try {
        const parsed = JSON.parse(line);
        if (parsed.message && parsed.message.content) {
          return parsed.message.content;
        }
      } catch {}
      return '';
    },
    signal
  );
}

function openaiChat(config, messages, onChunk, signal) {
  const url = new URL('/chat/completions', config.apiBase);
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }

  const body = JSON.stringify({
    model: config.model,
    messages,
    stream: true,
    max_tokens: config.maxTokens ?? 2048,
    temperature: config.temperature ?? 0.7,
  });

  return streamRequest(
    url.toString(),
    body,
    onChunk,
    (line) => {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') return '';
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content || '';
          return content;
        } catch {}
      }
      return '';
    },
    signal,
    headers
  );
}

function streamRequest(url, body, onChunk, parseLine, signal, extraHeaders) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const lib = isHttps ? https : http;

    const headers = { 'Content-Type': 'application/json', ...extraHeaders };

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers,
      signal,
    };

    const req = lib.request(options, (res) => {
      let fullContent = '';
      let buffer = '';

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const content = parseLine(trimmed);
          if (content) {
            fullContent += content;
            onChunk(content);
          }
        }
      });

      res.on('end', () => {
        if (buffer.trim()) {
          const content = parseLine(buffer.trim());
          if (content) {
            fullContent += content;
            onChunk(content);
          }
        }
        resolve(fullContent);
      });

      res.on('error', (err) => {
        reject(new Error(`Stream error: ${err.message}`));
      });
    });

    req.on('error', (err) => {
      if (err.name === 'AbortError') {
        reject(new Error('Request aborted'));
      } else {
        reject(new Error(`Request failed: ${err.message}`));
      }
    });

    req.write(body);
    req.end();
  });
}

function testConnection(config) {
  return new Promise((resolve) => {
    const testPath = config.provider === 'ollama' ? '/api/tags' : '/models';
    const parsedUrl = new URL(config.apiBase);
    const isHttps = parsedUrl.protocol === 'https:';
    const lib = isHttps ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: testPath,
      method: 'GET',
      timeout: 5000,
    };

    const req = lib.request(options, (res) => {
      resolve(res.statusCode !== undefined && res.statusCode < 500);
    });

    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

module.exports = { createChatCompletion, testConnection };
