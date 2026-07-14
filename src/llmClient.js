const https = require('https');
const http = require('http');

function createChatCompletion(modelConfig, messages, onChunk, signal) {
  return new Promise((resolve, reject) => {
    const msgs = messages.map(m => {
      const msg = { role: m.role, content: m.content };
      return msg;
    });
    const body = JSON.stringify({
      model: modelConfig.model,
      messages: msgs,
      stream: true,
      max_tokens: modelConfig.maxTokens || 2048,
      temperature: modelConfig.temperature ?? 0.7,
    });

    const url = new URL(modelConfig.apiBase + '/chat/completions');
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    if (modelConfig.apiKey) {
      options.headers['Authorization'] = 'Bearer ' + modelConfig.apiKey;
    }

    const req = transport.request(options, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        let errBody = '';
        res.on('data', (chunk) => { errBody += chunk.toString(); });
        res.on('end', () => {
          let msg = 'HTTP ' + res.statusCode;
          try { const e = JSON.parse(errBody); if (e.error && e.error.message) msg += ': ' + e.error.message; } catch (_) {}
          reject(new Error(msg));
        });
        return;
      }

      let buffer = '';

      res.on('data', (chunk) => {
        if (signal && signal.aborted) {
          req.destroy();
          return;
        }
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const jsonStr = trimmed.slice(6);
          if (jsonStr === '[DONE]') continue;
          try {
            const data = JSON.parse(jsonStr);
            const delta = data.choices?.[0]?.delta;
            const content = delta?.content || data.choices?.[0]?.text || '';
            const reasoning = delta?.reasoning_content || delta?.thinking || delta?.thinking_content || '';
            if (onChunk) {
              if (reasoning) onChunk({ type: 'thinking', content: reasoning });
              if (content) onChunk({ type: 'content', content: content });
            }
          } catch (_) {}
        }
      });

      res.on('end', () => {
        resolve();
      });

      res.on('error', (err) => {
        reject(new Error('Response error: ' + err.message));
      });
    });

    req.on('error', (err) => {
      reject(new Error('Request failed: ' + err.message));
    });

    req.write(body);
    req.end();

    if (signal) {
      signal.addEventListener('abort', () => {
        req.destroy();
        reject(new Error('Request aborted'));
      }, { once: true });
    }
  });
}

function testConnection(modelConfig) {
  return new Promise((resolve, reject) => {
    const url = new URL(modelConfig.apiBase + '/chat/completions');
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;

    const body = JSON.stringify({
      model: modelConfig.model,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
      stream: false,
    });

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 5000,
    };

    if (modelConfig.apiKey) {
      options.headers['Authorization'] = 'Bearer ' + modelConfig.apiKey;
    }

    const req = transport.request(options, (res) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        resolve(true);
      } else {
        reject(new Error('Status ' + res.statusCode));
      }
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

module.exports = { createChatCompletion, testConnection };
