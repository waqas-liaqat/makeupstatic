export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { prompt, image_data_url, max_tokens, model } = body;

    if (!prompt || !image_data_url) {
      return res.status(400).json({ error: 'Missing prompt or image_data_url' });
    }

    const defaultKey = Buffer.from('c2stcHJvai01SXp3U1VIcUw0SnlCNUZSMUFVQ3NBdGlKSGNSOVFoT3pLWS12SU13ckUwN0lZb3dhQzRtOVNXZWp5UUdseDI2UnEyWjJNaS1MR1QzQmxia0ZKeU5XMkw2RGkwYm04QnpORHFfWmFNT3YxNGZGOGNvOXE2YWdZb2ktX0Rqb0p1NUszTFpvc3FmWTlRQkVhMzROVVVybkVLOVR5Y0E=', 'base64').toString('ascii');
    const apiKey = process.env.OPENAI_KEY || defaultKey;

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model || 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: image_data_url, detail: 'high' } }
            ]
          }
        ],
        max_tokens: max_tokens || 16000
      })
    });

    if (!resp.ok) {
      const errTxt = await resp.text();
      return res.status(resp.status).json({ error: `OpenAI ${resp.status}: ${errTxt}` });
    }

    const data = await resp.json();
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
