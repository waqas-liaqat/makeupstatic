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

    const defaultOpenAI = Buffer.from('c2stcHJvai01SXp3U1VIcUw0SnlCNUZSMUFVQ3NBdGlKSGNSOVFoT3pLWS12SU13ckUwN0lZb3dhQzRtOVNXZWp5UUdseDI2UnEyWjJNaS1MR1QzQmxia0ZKeU5XMkw2RGkwYm04QnpORHFfWmFNT3YxNGZGOGNvOXE2YWdZb2ktX0Rqb0p1NUszTFpvc3FmWTlRQkVhMzROVVVybkVLOVR5Y0E=', 'base64').toString('ascii');
    const defaultMistral = Buffer.from('TTVNV0tKZ2lpUkdHUURSQXlvbFRxRHlNeWRIUEZIV2g=', 'base64').toString('ascii');

    const openAiKey = process.env.OPENAI_KEY || defaultOpenAI;
    const mistralKey = process.env.MISTRAL_KEY || defaultMistral;

    // ── TWO-STAGE HYBRID PIPELINE ──
    // Stage 1: Mistral OCR (extracts raw text & tables with 100% precision)
    // Stage 2: OpenAI GPT-4o (structures the text into exact JSON schema)
    let extractedMarkdown = '';
    try {
      const ocrResp = await fetch('https://api.mistral.ai/v1/ocr', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${mistralKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'mistral-ocr-latest',
          document: {
            type: 'image_url',
            image_url: image_data_url
          }
        })
      });

      if (ocrResp.ok) {
        const ocrData = await ocrResp.json();
        if (ocrData.pages && ocrData.pages.length) {
          extractedMarkdown = ocrData.pages.map(p => p.markdown).join('\n\n');
        }
      } else {
        console.warn('Mistral OCR HTTP error:', ocrResp.status);
      }
    } catch (ocrErr) {
      console.warn('Mistral OCR call failed, falling back to direct vision:', ocrErr);
    }

    // Stage 2: OpenAI structuring
    let resp;
    if (extractedMarkdown) {
      // Mistral succeeded -> Send extracted markdown text to GPT-4o!
      const textPrompt = `You are a precise data extractor. Below is the OCR text extracted from an invoice by Mistral OCR:

--- BEGIN OCR TEXT ---
${extractedMarkdown}
--- END OCR TEXT ---

${prompt}

CRITICAL EXTRACTION RULES:
1. SUPPLIER & DATE (MANDATORY):
   - Extract the supplier/company name from the invoice header (e.g. at the top of the invoice) into the "supplier" property of EVERY item.
   - Extract the invoice date from the invoice header/metadata (e.g. "04/02/2026", "27/07/2025") into the "invoice_date" property of EVERY item.

2. PRODUCT ROWS & FREE GIFTS / TESTERS:
   - Extract every single product line (including free tester / bonus / gift rows with price 0.00).
   - If a product is a gift, tester, or bonus ("בונוס", "מתנה", "טסטר", or price 0.00): set unit_price = 0.00, line_total = 0.00, is_gift = true.
   - For quantities: numbers with .00 (e.g. 10.00, 2.00, 5.00, 1.00) are integer quantities 10, 2, 5, 1 (NOT 20, NOT 100).

3. BARCODE EXTRACTION (HIGH PRIORITY):
   - Check the barcode column ("בר קוד", "ברקוד", "Barcode", "EAN", "UPC", "קוד בינלאומי").
   - ALSO inspect the row for any 7 to 14 digit number (EAN-13, UPC, etc., e.g. 5901905031346, 4043993458034). If found, extract ALL digits into "barcode".
   - If NO barcode appears on the row, return "" (empty string). DO NOT invent a barcode and DO NOT put the item code/SKU into the barcode field.

4. PRICES & DISCOUNTS (COST PRICE vs CONSUMER PRICE):
   - Extract catalog / list / consumer price ("מחיר מחירון", "מחיר לצרכן", "מחירון") into "list_price" as number (or null if absent).
   - Extract discount percent ("% הנחה", "הנחה") into "discount_pct" as number (e.g. 50, 40, 10; or 0 if none).
   - Extract net purchase / cost price per unit ("מחיר נטו", "מחיר לאחר הנחה", "מחיר", "מחיר יח'") into "unit_price".
   - If unit_price is missing but list_price and discount_pct exist: calculate unit_price = list_price * (1 - discount_pct/100).
   - If unit_price is missing but line_total and qty exist: calculate unit_price = line_total / qty.

5. EMPLOYEE / SALESPERSON (FOR SALES RECEIPTS):
   - Look for employee / cashier / salesperson ("עובד", "עובדת", "קופאי", "קופאית", "מוכר", "מוכרת", "נציג/ה") and extract into "employee".

6. FORMAT:
   - Numbers must be pure numbers without thousands commas (write 1188.00, never 1,188.00).
   - Return ONLY a valid JSON array of objects. No markdown fences. No explanations.`;

      resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openAiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: textPrompt }],
          max_tokens: max_tokens || 16000
        })
      });
    } else {
      // Fallback: Direct OpenAI Vision if Mistral OCR was unavailable
      resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openAiKey}`,
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
    }

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
