export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const token = process.env.AIRTABLE_API_KEY || process.env.AT_TOKEN || process.env.AIRTABLE_TOKEN;
  const base = process.env.AIRTABLE_BASE_ID || 'appivKVm0EYXvid1p';

  if (!token) {
    return res.status(500).json({
      error: 'AIRTABLE_API_KEY is not configured in Vercel environment variables.'
    });
  }

  const { table, recordId, ...queryParams } = req.query || {};

  if (!table) {
    return res.status(400).json({ error: 'Missing required "table" parameter' });
  }

  let airtableUrl = `https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}`;
  if (recordId) {
    airtableUrl += `/${encodeURIComponent(recordId)}`;
  }

  const url = new URL(airtableUrl);
  for (const [key, value] of Object.entries(queryParams)) {
    if (value !== undefined && value !== null) {
      if (Array.isArray(value)) {
        value.forEach(v => url.searchParams.append(key, v));
      } else {
        url.searchParams.set(key, value);
      }
    }
  }

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  try {
    const fetchOptions = {
      method: req.method,
      headers
    };

    if (req.method === 'POST' || req.method === 'PATCH') {
      fetchOptions.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
    }

    const atResponse = await fetch(url.toString(), fetchOptions);
    const contentType = atResponse.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      const data = await atResponse.json();
      return res.status(atResponse.status).json(data);
    } else {
      const text = await atResponse.text();
      return res.status(atResponse.status).send(text);
    }
  } catch (err) {
    console.error('Airtable proxy error:', err);
    return res.status(500).json({ error: 'Proxy request failed: ' + err.message });
  }
}
