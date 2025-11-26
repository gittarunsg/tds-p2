// api/solve.js
import axios from "axios";

// Secret from Vercel Environment Variables
const SECRET = process.env.TDS_SECRET || "";

function safeCompare(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST only" });
  }

  let body;
  try {
    body = req.body;
  } catch (e) {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  const { email, secret, url } = body;

  if (!email || !secret || !url)
    return res.status(400).json({ error: "Missing fields" });

  if (!safeCompare(secret, SECRET))
    return res.status(403).json({ error: "Invalid secret" });

  try {
    const solveResult = await solveQuiz(url, email, secret);
    return res.status(200).json({ ok: true, result: solveResult });
  } catch (err) {
    return res.status(200).json({ ok: false, error: String(err) });
  }
}

async function solveQuiz(quizUrl, email, secret) {
  // Download raw HTML
  const htmlResp = await axios.get(quizUrl, { timeout: 20000 });
  const html = htmlResp.data;

  // Extract base64 if atob(`...`)
  const b64 = extractBase64(html);

  let answer = null;

  if (b64) {
    try {
      const decoded = Buffer.from(b64, "base64").toString("utf8");
      answer = { decoded };
    } catch (_) {
      answer = { raw_base64: b64 };
    }
  }

  // Fallback: return some text
  if (!answer) {
    answer = {
      info: "No base64 found, returning HTML snippet",
      snippet: html.slice(0, 2000)
    };
  }

  const submitUrl = extractSubmitUrl(html);

  let submitResp = null;
  if (submitUrl) {
    const payload = {
      email,
      secret,
      url: quizUrl,
      answer
    };

    const post = await axios.post(submitUrl, payload, {
      timeout: 20000,
    }).catch(e => ({ error: e.toString(), data: e.response?.data }));

    submitResp = post.data ?? post;
  }

  return {
    submitUrl,
    answer,
    submit_response: submitResp
  };
}

function extractBase64(html) {
  const m = html.match(/atob\((?:`|')([\s\S]+?)(?:`|')\)/i);
  if (!m) return null;
  return m[1].replace(/\s+/g, "");
}

function extractSubmitUrl(html) {
  const m = html.match(/https?:\/\/[^\s"'<>]+\/submit[^\s"'<>]*/i);
  return m ? m[0] : null;
}
