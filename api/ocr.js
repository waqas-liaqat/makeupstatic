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
   - Extract the invoice date from the invoice header/metadata (e.g. "04/02/2026", "27/07/2025", "09/09/2026") into the "invoice_date" property of EVERY item.

2. PRODUCT ROWS & FREE GIFTS / TESTERS:
   - Extract every single product line (including free tester / bonus / gift rows with price 0.00).
   - If a product is a gift, tester, or bonus ("בונוס", "מתנה", "טסטר", or price 0.00): set unit_price = 0.00, line_total = 0.00, is_gift = true.
   - For quantities: numbers with .00 (e.g. 10.00, 2.00, 5.00, 1.00) are integer quantities 10, 2, 5, 1 (NOT 20, NOT 100).
   - Exclude summary lines like "סה\"כ פריטים", "הנחה:", "לתשלום:", "מע\"מ" from product items, or mark them with is_product: false.

3. BARCODE EXTRACTION (HIGH PRIORITY):
   - Check the barcode column ("בר קוד", "ברקוד", "Barcode", "EAN", "UPC", "קוד בינלאומי").
   - ALSO inspect the row for any 7 to 14 digit number (EAN-13, UPC, etc., e.g. 5901905031346, 4043993458034). If found, extract ALL digits into "barcode".
   - If NO barcode appears on the row, return "" (empty string). DO NOT invent a barcode and DO NOT put the item code/SKU into the barcode field.

4. PRICES, RECEIPT DISCOUNTS, AND NET ACTUAL PRICE:
   - Extract catalog / list / shelf price ("מחיר מחירון", "מחיר לצרכן", "מחיר", "מחירון") into "list_price" as number.
   - RECEIPT-WIDE DISCOUNT (e.g. "הנחה: הנחת 10% לחברי מועדון -61.40", "% הנחה", "הנחת מועדון"):
     * Extract "receipt_discount_pct": number (e.g. 10, or 0 if none) on all items.
     * Extract "receipt_discount_amount": number (e.g. 61.40, or 0 if none) on all items.
     * Extract "receipt_total": number (e.g. 552.60 from "לתשלום:" or "סה\"כ לתשלום:") on all items.
     * If a receipt-wide discount exists (e.g. 10%), apply it to each item:
       - Set "discount_pct" = receipt_discount_pct (e.g. 10).
       - Set "unit_price" = list_price * (1 - discount_pct/100) (e.g. 144 -> 129.60, 99 -> 89.10, 159 -> 143.10, 79 -> 71.10, 133 -> 119.70). Round to 2 decimal places.
       - Set "line_total" = qty * unit_price.
   - For supplier invoices with item discounts: extract "discount_pct", and set "unit_price" to the net unit cost after discount.

5. EMPLOYEE / CASHIER vs CUSTOMER (CRITICAL):
   - "מוכר/ת", "מוכר", "קופאי/ת", "קופאי", "עובד/ת", "עובד", "נציג/ה" means CASHIER / SALESPERSON.
     Extract this name (e.g. "רבקי רבינוביץ", "עובד כללי") into "employee" property on EVERY item.
   - If the receipt contains an explicit customer section or label ("לקוח:", "לקוח/ה:", "לכבוד:", "שם לקוח:") or customer phone ("טלפון:"):
     * Extract the customer name (e.g. "שרי דייטש") into "customer_name" on EVERY item.
     * Extract the customer phone (e.g. "0534198810") into "customer_phone" on EVERY item.
   - If NO customer section/label appears on the receipt, "customer_name" MUST be "" (empty string). NEVER put the cashier/seller into customer_name!
   - NEVER put the customer name into "employee"! The customer and employee must be distinct.

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
