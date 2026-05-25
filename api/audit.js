// api/audit.js — Legible Audit Engine
// CommonJS — no npm dependencies required

const SCORING_PROMPT = `You are an expert in LLM discoverability and generative engine optimization.

Analyze the following website content and score it on 6 dimensions that determine how well AI models like ChatGPT, Claude, and Perplexity can understand, trust, and cite this website.

WEBSITE URL: {{URL}}

WEBSITE CONTENT:
{{CONTENT}}

Score each dimension 0-100:

1. ENTITY_CLARITY: How consistently and clearly is the organisation described across all pages? Consistent name, location, services = high. Vague or contradictory = low.

2. FACTUAL_DENSITY: Specific verifiable facts (numbers, dates, credentials, named people) = high. Generic marketing language = low.

3. INTERNAL_CONSISTENCY: Pages agree with each other = high. Contradictions between pages = low.

4. SCHEMA_PRESENCE: Comprehensive JSON-LD and Open Graph = high. No structured data = low.

5. FRESHNESS_SIGNALS: Clear dates, recent years, timestamps = high. Undated content = low.

6. CLAIM_VERIFIABILITY: Specific verifiable claims = high. Unverifiable claims like "best in class" = low.

Respond ONLY with valid JSON, no markdown, no explanation:
{
  "scores": {
    "entity_clarity": <0-100>,
    "factual_density": <0-100>,
    "internal_consistency": <0-100>,
    "schema_presence": <0-100>,
    "freshness_signals": <0-100>,
    "claim_verifiability": <0-100>
  },
  "issues": [
    {"severity": "critical", "description": "<specific issue>"},
    {"severity": "critical", "description": "<specific issue>"},
    {"severity": "warning", "description": "<specific issue>"}
  ],
  "entity_name": "<name>",
  "entity_description": "<2 sentences>",
  "key_facts": ["<fact 1>", "<fact 2>", "<fact 3>", "<fact 4>", "<fact 5>"]
}`;

function gradeFromScores(scores) {
  const avg = Object.values(scores).reduce((a, b) => a + b, 0) / 6;
  const score = Math.round(avg);
  const grade = avg >= 80 ? 'A' : avg >= 65 ? 'B' : avg >= 50 ? 'C' : avg >= 35 ? 'D' : 'F';
  return { grade, score };
}

function gradeColor(grade) {
  const map = { A: '#1a7a3a', B: '#2d8a4e', C: '#c8900a', D: '#c85000', F: '#c8000a' };
  return map[grade] || '#666';
}

function scoreFill(score) {
  const color = score >= 70 ? '#1a7a3a' : score >= 45 ? '#c8900a' : '#c8000a';
  return `<div style="background:#eee;border-radius:2px;height:4px;width:100%;margin-top:6px"><div style="background:${color};height:4px;border-radius:2px;width:${score}%"></div></div>`;
}

function makeLlmsTxt(url, analysis) {
  const { grade, score } = gradeFromScores(analysis.scores);
  const facts = analysis.key_facts.map(function(f) { return '- ' + f; }).join('\n');
  return '# ' + analysis.entity_name + '\n\n> ' + analysis.entity_description + '\n\n## Key Facts\n' + facts + '\n\n## Source\n' + url + '\n\n---\nStructured for LLM discoverability by Legible (https://legiblesite.app)\nLegibility Grade: ' + grade + ' - Score: ' + score + '/100';
}

function buildEmail(url, analysis, llmsTxt) {
  const gradeInfo = gradeFromScores(analysis.scores);
  const domain = new URL(url).hostname;

  var scoreRows = [
    ['Entity Clarity', analysis.scores.entity_clarity],
    ['Factual Density', analysis.scores.factual_density],
    ['Internal Consistency', analysis.scores.internal_consistency],
    ['Schema Presence', analysis.scores.schema_presence],
    ['Freshness Signals', analysis.scores.freshness_signals],
    ['Claim Verifiability', analysis.scores.claim_verifiability]
  ].map(function(pair) {
    return '<tr><td style="padding:10px 0;font-family:monospace;font-size:12px;color:#666;border-bottom:1px solid #f0f0f0;width:60%">' + pair[0] + '</td><td style="padding:10px 0;font-family:monospace;font-size:12px;color:#333;border-bottom:1px solid #f0f0f0;text-align:right">' + pair[1] + '/100</td></tr><tr><td colspan="2" style="padding-bottom:4px">' + scoreFill(pair[1]) + '</td></tr>';
  }).join('');

  var issueRows = analysis.issues.map(function(i) {
    return '<tr><td style="padding:12px 0;font-size:13px;color:#444;line-height:1.6;border-bottom:1px solid #f5f5f5"><span style="font-family:monospace;font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:' + (i.severity === 'critical' ? '#c8000a' : '#c8900a') + ';margin-right:8px">&#9658; ' + i.severity + '</span>' + i.description + '</td></tr>';
  }).join('');

  return '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#f2f1ed;font-family:-apple-system,BlinkMacSystemFont,sans-serif"><div style="max-width:580px;margin:0 auto;padding:28px 16px"><div style="background:#0f0f0f;padding:18px 24px;border-radius:6px 6px 0 0"><span style="font-family:monospace;font-size:13px;font-weight:600;letter-spacing:0.08em;color:white">legible</span><span style="font-family:monospace;font-size:11px;color:rgba(255,255,255,0.3);float:right">' + domain + '</span></div><div style="background:white;padding:40px 24px;text-align:center;border-left:1px solid #ddd;border-right:1px solid #ddd"><div style="font-family:monospace;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#aaa;margin-bottom:12px">Legibility Score</div><div style="font-size:108px;font-weight:700;line-height:1;color:' + gradeColor(gradeInfo.grade) + ';font-family:Georgia,serif">' + gradeInfo.grade + '</div><div style="font-family:monospace;font-size:13px;color:#bbb;margin-top:6px">' + gradeInfo.score + ' out of 100</div></div><div style="background:white;padding:24px;border-left:1px solid #ddd;border-right:1px solid #ddd;border-top:1px solid #f0f0f0"><div style="font-family:monospace;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#aaa;margin-bottom:16px">Dimension Scores</div><table style="width:100%;border-collapse:collapse">' + scoreRows + '</table></div><div style="background:white;padding:24px;border-left:1px solid #ddd;border-right:1px solid #ddd;border-top:1px solid #f0f0f0"><div style="font-family:monospace;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#aaa;margin-bottom:12px">Issues Found</div><table style="width:100%;border-collapse:collapse">' + issueRows + '</table></div><div style="background:white;padding:24px;border-left:1px solid #ddd;border-right:1px solid #ddd;border-top:1px solid #f0f0f0"><div style="font-family:monospace;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#aaa;margin-bottom:12px">Your Generated llms.txt</div><pre style="background:#f8f8f6;padding:16px;font-family:monospace;font-size:11px;line-height:1.75;color:#555;border-radius:4px;overflow-x:auto;white-space:pre-wrap;margin:0">' + llmsTxt + '</pre><p style="font-size:12px;color:#aaa;margin:10px 0 0">Save as llms.txt and upload to the root of your website.</p></div><div style="background:#0f0f0f;padding:32px 24px;text-align:center;border-radius:0 0 6px 6px"><p style="color:rgba(255,255,255,0.5);font-size:14px;line-height:1.65;margin:0 0 20px">Want Legible to fix these issues automatically and monitor your AI citations weekly?</p><a href="https://legiblesite.app/#pricing" style="display:inline-block;background:#c4f054;color:#0f0f0f;font-family:monospace;font-size:12px;font-weight:600;letter-spacing:0.07em;text-transform:uppercase;padding:13px 26px;border-radius:3px;text-decoration:none">Start Standard Plan - $49/month</a><p style="color:rgba(255,255,255,0.2);font-size:11px;margin:20px 0 0;font-family:monospace">legiblesite.app - hello@legible.ai</p></div></div></body></html>';
}

async function crawl(url) {
  const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + process.env.FIRECRAWL_API_KEY
    },
    body: JSON.stringify({
      url: url,
      formats: ['markdown'],
      excludeTags: ['nav', 'footer', 'script', 'style', 'head'],
      timeout: 20000
    })
  });
  if (!res.ok) throw new Error('Firecrawl error: ' + res.status);
  const data = await res.json();
  return data && data.data && (data.data.markdown || data.data.content) || '';
}

async function scoreWithClaude(url, content) {
  const prompt = SCORING_PROMPT
    .replace('{{URL}}', url)
    .replace('{{CONTENT}}', content.slice(0, 9000));

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!res.ok) throw new Error('Claude error: ' + res.status);
  const data = await res.json();
  const text = data.content[0].text.trim().replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
  return JSON.parse(text);
}

async function sendEmail(to, url, analysis, llmsTxt) {
  const gradeInfo = gradeFromScores(analysis.scores);
  const domain = new URL(url).hostname;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + process.env.RESEND_API_KEY
    },
    body: JSON.stringify({
      from: 'Legible <audit@legiblesite.app>',
      to: to,
      subject: 'Legibility Score: ' + gradeInfo.grade + ' (' + gradeInfo.score + '/100) — ' + domain,
      html: buildEmail(url, analysis, llmsTxt)
    })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error('Resend error: ' + err);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch(e) { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  var url = body && body.url;
  var email = body && body.email;

  if (!url || !email) return res.status(400).json({ error: 'url and email are required' });

  var parsed;
  try { parsed = new URL(url); } catch(e) { return res.status(400).json({ error: 'Invalid URL' }); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return res.status(400).json({ error: 'URL must start with http:// or https://' });
  }

  try {
    const content = await crawl(url);
    if (!content || content.length < 50) {
      return res.status(422).json({ error: 'Could not read this URL. Is it publicly accessible?' });
    }
    const analysis = await scoreWithClaude(url, content);
    const llmsTxt = makeLlmsTxt(url, analysis);
    await sendEmail(email, url, analysis, llmsTxt);
    const gradeInfo = gradeFromScores(analysis.scores);
    return res.status(200).json({ success: true, grade: gradeInfo.grade, score: gradeInfo.score, scores: analysis.scores });
  } catch(err) {
    console.error('[audit error]', err.message);
    return res.status(500).json({ error: 'Audit failed: ' + err.message });
  }
};
