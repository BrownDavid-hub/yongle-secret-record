// 《永乐秘闻录》本地服务端：托管静态文件 + 代理 DeepSeek API。
// API 密钥仅从本机的 config.local.js 或环境变量 DEEPSEEK_API_KEY 读取，绝不下发到浏览器。
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

function loadApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const cfg = require(path.join(ROOT, 'config.local.js'));
    if (cfg && cfg.deepseekApiKey) return cfg.deepseekApiKey;
  } catch (_) {}
  return null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 256 * 1024) reject(new Error('请求体过大'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function handleGame(req, res) {
  const apiKey = loadApiKey();
  if (!apiKey) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { message: '服务端未配置 API 密钥：请创建 config.local.js 或设置 DEEPSEEK_API_KEY 环境变量' } }));
    return;
  }
  let messages;
  try {
    const body = JSON.parse(await readBody(req));
    if (!Array.isArray(body.messages)) throw new Error('bad request');
    messages = body.messages.slice(0, 20).map((m) => ({
      role: m.role === 'system' ? 'system' : 'user',
      content: String(m.content || '').slice(0, 8000),
    }));
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { message: '请求格式不正确' } }));
    return;
  }
  try {
    const upstream = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        temperature: 0.48,
        max_tokens: 720,
        response_format: { type: 'json_object' },
        messages,
      }),
    });
    const raw = await upstream.text();
    res.writeHead(upstream.status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(raw);
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { message: 'DeepSeek 服务暂时不可用，请稍后重试' } }));
  }
}

const SAVE_FILE = path.join(ROOT, 'save.json');

function handleGetSave(req, res) {
  fs.readFile(SAVE_FILE, 'utf8', (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: 'no save' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(data);
  });
}

async function handlePutSave(req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    if (!Number.isInteger(body.chapter) || !Array.isArray(body.history)) throw new Error('bad');
    const payload = JSON.stringify({ ...body, savedAt: Date.now() });
    fs.writeFileSync(SAVE_FILE, payload, 'utf8');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { message: '存档格式不正确' } }));
  }
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (req.method === 'POST' && url === '/api/game') return handleGame(req, res);
  if (req.method === 'GET' && url === '/api/save') return handleGetSave(req, res);
  if (req.method === 'PUT' && url === '/api/save') return handlePutSave(req, res);
  if (req.method !== 'GET') {
    res.writeHead(405); res.end(); return;
  }
  let filePath = path.normalize(path.join(ROOT, url === '/' ? 'index.html' : url));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  // 禁止泄露密钥：config.local.js 返回空脚本，前端自动回退到服务端代理
  if (/config\.local\.js$/i.test(filePath)) {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    res.end('window.DEEPSEEK_API_KEY = "";');
    return;
  }
  // 禁止直接访问 .env / 存档文件
  if (/\.env|save\.json$/i.test(filePath)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`端口 ${PORT} 已被占用——游戏服务很可能已经在运行，直接打开 http://localhost:${PORT} 即可。`);
  } else {
    console.error('服务端启动失败：', e.message);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`永乐秘闻录本地服务端已启动：http://localhost:${PORT}`);
  const nets = require('os').networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) {
        console.log(`手机/其他设备（同一 Wi-Fi）访问：http://${n.address}:${PORT}`);
      }
    }
  }
  if (!loadApiKey()) console.log('警告：未找到 API 密钥（config.local.js 或 DEEPSEEK_API_KEY）');
});
