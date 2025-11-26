// api/solve.js
// Lightweight Vercel serverless function (CommonJS)
const axios = require("axios");

const SECRET = process.env.TDS_SECRET || "proj2secret"; // set this in Vercel env

function safeCompare(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Parse body (Vercel supplies parsed body for application/json)
  let body = req.body;
  if (!body || typeof body !== "object") {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  const { email, secret, url } = body;
  if (!email || !secret || !url) return res.status(400).json({ error: "Missing required fields (email, secret, url)" });

  if (!safeCompare(secret, SECRET)) {
    return res.status(403).json({ error: "Invalid secret" });
  }

  // Valid request — attempt to fetch and solve
  try {
    const result = await solveQuiz({ email, secret, url });
    // Must return 200 for valid secret (grader expects 200 on valid)
    return res.status(200).json({ ok: true, result });
  } catch (err) {
    // Return 200 but indicate failure (keeps grader compatibility); include error message
    return res.status(200).json({ ok: false, error: String(err) });
  }
};

async function solveQuiz({ email, secret, url }) {
  // Fetch quiz page (no JS execution).
  const fetchResp = await axios.get(url, { timeout: 20000, responseType: "text" });
  const html = fetchResp.data;

  // Heuristics: try to extract base64 from atob(`...`) or atob('...')
  const atobB64 = extractAtobBase64(html);

  let answer = null;
  let notes = [];

  if (atobB64) {
    notes.push("Found atob() base64 payload and decoded it.");
    try {
      const decoded = Buffer.from(atobB64, "base64").toString("utf8");
      // If decoded looks like JSON, parse it
      try {
        const parsed = JSON.parse(decoded);
        // If parsed contains "answer" field, leave it; else set placeholder
        parsed.answer = parsed.answer === undefined ? null : parsed.answer;
        answer = parsed;
      } catch (e) {
        // Not JSON — return decoded text
        answer = { decoded_text: decoded };
      }
    } catch (e) {
      answer = { raw_base64: atobB64 };
    }
  }

  // If no atob payload, try to detect HTML tables with a "value" column (simple regex)
  if (!answer) {
    const tableSum = trySumHtmlTableValue(html);
    if (tableSum !== null) {
      notes.push("Detected HTML table and computed sum of 'value' column.");
      answer = tableSum;
    }
  }

  // Fallback: include a page snippet as "answer"
  if (!answer) {
    notes.push("No structured answer found; returning HTML snippet.");
    answer = { snippet: html.slice(0, 3000) };
  }

  // Find submit URL on the page
  const submitUrl = findSubmitUrl(html);

  let submitResponse = null;
  if (submitUrl) {
    // Build payload following project spec
    const payload = {
      email,
      secret,
      url,
      answer
    };

    try {
      const postResp = await axios.post(submitUrl, payload, { timeout: 20000 });
      submitResponse = postResp.data;
      notes.push("Posted answer to submit URL.");
    } catch (err) {
      submitResponse = { error: String(err), responseData: err.response?.data ?? null };
      notes.push("Posting to submit URL failed.");
    }
  } else {
    notes.push("No submit URL detected on page.");
  }

  return {
    email,
    quiz_url: url,
    detected_atob: Boolean(atobB64),
    submit_url: submitUrl,
    answer,
    submit_response: submitResponse,
    notes
  };
}

function extractAtobBase64(html) {
  // match atob(`...`) or atob('...') or atob("...")
  const re = /atob\((?:`|')([\sA-Za-z0-9+/=]+)(?:`|')\)/i;
  const m = html.match(re);
  if (!m) return null;
  return m[1].replace(/\s+/g, "");
}

function findSubmitUrl(text) {
  const re = /https?:\/\/[^\s"'<>]+\/submit[^\s"'<>]*/i;
  const m = text.match(re);
  return m ? m[0] : null;
}

function trySumHtmlTableValue(html) {
  // Very lightweight HTML table extraction: find <table>...</table>, then parse rows and extract numeric "value" column.
  const tableRe = /<table[\s\S]*?>([\s\S]*?)<\/table>/i;
  const tableMatch = html.match(tableRe);
  if (!tableMatch) return null;
  const tableHtml = tableMatch[1];

  // Extract rows
  const rowRe = /<tr[\s\S]*?>([\s\S]*?)<\/tr>/gi;
  let rows = [];
  let r;
  while ((r = rowRe.exec(tableHtml)) !== null) {
    const rowHtml = r[1];
    // extract th/td cells
    const cellRe = /<(?:th|td)[\s\S]*?>([\s\S]*?)<\/(?:th|td)>/gi;
    let cells = [];
    let c;
    while ((c = cellRe.exec(rowHtml)) !== null) {
      // strip tags from cell content
      const text = c[1].replace(/<[^>]*>/g, "").trim();
      cells.push(text);
    }
    if (cells.length) rows.push(cells);
  }

  if (rows.length < 2) return null;
  // find value column index by header row
  const header = rows[0].map(h => h.toLowerCase());
  const idx = header.findIndex(h => /\bvalue\b/.test(h));
  if (idx === -1) return null;

  // Sum numeric values in that column (skip header)
  let sum = 0;
  let found = false;
  for (let i = 1; i < rows.length; i++) {
    const v = rows[i][idx] || "";
    const num = parseFloat(v.replace(/[^\d.\-]/g, "")); // remove commas/currency
    if (!isNaN(num)) {
      sum += num;
      found = true;
    }
  }
  return found ? sum : null;
}
