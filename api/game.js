// Vercel Serverless Function: DeepSeek API 代理
// 环境变量 DEEPSEEK_API_KEY 在 Vercel 后台设置

module.exports = async function handler(req, res) {
  // 允许跨域（GitHub Pages 等外部域名访问时）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: '仅支持 POST' } });
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: { message: '服务端未配置 DEEPSEEK_API_KEY 环境变量' } });
  }

  let messages;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!Array.isArray(body.messages)) throw new Error('bad request');
    messages = body.messages.slice(0, 20).map((m) => ({
      role: m.role === 'system' ? 'system' : 'user',
      content: String(m.content || '').slice(0, 8000),
    }));
  } catch {
    return res.status(400).json({ error: { message: '请求格式不正确' } });
  }

  try {
    const upstream = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
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
    return res.status(upstream.status).setHeader('Content-Type', 'application/json; charset=utf-8').send(raw);
  } catch (e) {
    console.error('DeepSeek API 错误:', e);
    return res.status(502).json({ error: { message: 'AI 服务暂时不可用，请稍后重试' } });
  }
}
