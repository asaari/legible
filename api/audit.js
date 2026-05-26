// api/audit.js — Legible Audit Engine v3
// Consistency fixes: temperature=0, mechanical scoring rubric,
// programmatic schema detection, email optional for preview

const SCORING_PROMPT = `You are scoring a website for LLM discoverability. Use ONLY the content provided. Be precise — count, do not estimate.

URL: {{URL}}
CONTENT:
{{CONTENT}}

Score each dimension using ONLY the exact point criteria below. Add up the points. Do not use judgment — count what is present.

ENTITY_CLARITY (max 100):
+25 if the organisation name appears in the same form consistently throughout
+20 if there is a clear 1-2 sentence description of what the organisation does
+20 if a specific location (city/country) or service area is stated
+20 if founding year, years operating, or a key credential is mentioned
+15 if contact details (email, phone, or address) are present

FACTUAL_DENSITY (max 100):
Count each unique instance of: named person with title, specific date (not "recently"), specific number with unit (e.g. "500 clients", "12 years"), named certification or award, named client or partner organisation.
Score = min(count x 8, 100)

INTERNAL_CONSISTENCY (max 100):
+30 if service descriptions are consistent across all pages visible
+30 if pricing or offering information does not contradict itself
+20 if the company description is consistent throughout
+20 if there are no factual contradictions (different employee counts, founding years, etc)

SCHEMA_PRESENCE: set to 0 — this is calculated separately, do not score it

FRESHNESS_SIGNALS (max 100):
+30 if 2025 or 2026 is mentioned in content
+25 if specific recent dates appear (blog posts, news, press releases)
+25 if publication dates or timestamps are visible
+20 if recent events, current technology, or up-to-date references appear

CLAIM_VERIFIABILITY (max 100):
Count verifiable claims: named certifications, statistics with context, named awards, quoted third parties, specific client or partner names.
Score = min(count x 12, 80)
Then deduct 5 per marketing superlative found ("best", "leading", "industry-leading", "world-class", "premier", "innovative") up to a maximum deduction of 20.
Floor at 0.

For ISSUES: find the 3 most impactful specific problems. Reference actual content you observed — not generic advice.

Respond ONLY with valid JSON, no markdown, no explanation:
{
  "scores": {
    "entity_clarity": <0-100>,
    "factual_density": <0-100>,
    "internal_consistency": <0-100>,
    "schema_presence": 0,
    "freshness_signals": <0-100>,
    "claim_verifiability": <0-100>
  },
  "issues": [
    {"severity": "critical", "description": "<specific issue referencing actual content>"},
    {"severity": "critical", "description": "<specific issue>"},
    {"severity": "warning", "description": "<specific issue>"}
  ],
  "entity_name": "<organisation name>",
  "entity_description": "<2 sentences: what they do and who they serve>",
  "key_facts": ["<fact 1>", "<fact 2>", "<fact 3>", "<fact 4>", "<fact 5>"]
}`;

// ── Schema presence: programmatic, not via LLM ───────────────
function detectSchema(content) {
  var score = 0;
  if (content.includes('application/ld+json')) score += 50;
  if (content.includes('"@type"'))             score += 15;
  if (content.includes('og:title') || content.includes('og:description')) score += 20;
  if (content.includes('og:image'))            score += 10;
  if (content.includes('twitter:card'))        score += 5;
  return Math.min(score, 100);
}

// ── Grade ────────────────────────────────────────────────────
function gradeFromScores(scores) {
  var avg = Object.values(scores).reduce(function(a,b){return a+b;},0) / 6;
  var score = Math.round(avg);
  var grade = avg >= 80 ? 'A' : avg >= 65 ? 'B' : avg >= 50 ? 'C' : avg >= 35 ? 'D' : 'F';
  return { grade: grade, score: score };
}

function gradeColor(grade) {
  var map = { A:'#1a7a3a', B:'#2d8a4e', C:'#c8900a', D:'#c85000', F:'#c8000a' };
  return map[grade] || '#666';
}

function scoreFill(score) {
  var color = score >= 70 ? '#1a7a3a' : score >= 45 ? '#c8900a' : '#c8000a';
  return '<div style="background:#eee;border-radius:2px;height:4px;width:100%;margin-top:6px">' +
    '<div style="background:' + color + ';height:4px;border-radius:2px;width:' + score + '%"></div></div>';
}

// ── llms.txt ─────────────────────────────────────────────────
function makeLlmsTxt(url, analysis) {
  var g = gradeFromScores(analysis.scores);
  var facts = analysis.key_facts.map(function(f){ return '- ' + f; }).join('\n');
  return '# ' + analysis.entity_name +
    '\n\n> ' + analysis.entity_description +
    '\n\n## Key Facts\n' + facts +
    '\n\n## Source\n' + url +
    '\n\n---\nStructured for LLM discoverability by Legible (https://legiblesite.app)\nLegibility Grade: ' + g.grade + ' - Score: ' + g.score + '/100';
}

// ── Email HTML ───────────────────────────────────────────────
function buildEmail(url, analysis, llmsTxt, plan) {
  var g = gradeFromScores(analysis.scores);
  var domain = new URL(url).hostname;

  var scoreRows = [
    ['Entity Clarity',       analysis.scores.entity_clarity],
    ['Factual Density',      analysis.scores.factual_density],
    ['Internal Consistency', analysis.scores.internal_consistency],
    ['Schema Presence',      analysis.scores.schema_presence],
    ['Freshness Signals',    analysis.scores.freshness_signals],
    ['Claim Verifiability',  analysis.scores.claim_verifiability]
  ].map(function(pair) {
    var s = pair[1];
    var c = s >= 70 ? '#1a7a3a' : s >= 45 ? '#c8900a' : '#c8000a';
    return '<tr><td style="padding:9px 0;font-family:monospace;font-size:12px;color:#666;border-bottom:1px solid #f0f0f0;width:60%">' + pair[0] + '</td>' +
      '<td style="padding:9px 0;font-family:monospace;font-size:12px;color:#333;border-bottom:1px solid #f0f0f0;text-align:right">' + s + '/100</td></tr>' +
      '<tr><td colspan="2" style="padding-bottom:4px">' + scoreFill(s) + '</td></tr>';
  }).join('');

  var issueRows = analysis.issues.map(function(i) {
    return '<tr><td style="padding:11px 0;font-size:13px;color:#444;line-height:1.6;border-bottom:1px solid #f5f5f5">' +
      '<span style="font-family:monospace;font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:' +
      (i.severity === 'critical' ? '#c8000a' : '#c8900a') + ';margin-right:8px">' + i.severity + '</span>' +
      i.description + '</td></tr>';
  }).join('');

  var gc = {A:'#1a7a3a',B:'#2d8a4e',C:'#c8900a',D:'#c85000',F:'#c8000a'}[g.grade] || '#666';

  var upgradeCta = (plan === 'standard' || plan === 'pro')
    ? '<p style="color:rgba(255,255,255,0.5);font-size:14px;line-height:1.65;margin:0 0 20px">Your weekly monitoring is active. First citation report arrives next Monday.</p>'
    : '<p style="color:rgba(255,255,255,0.5);font-size:14px;line-height:1.65;margin:0 0 20px">Monitor your AI citations weekly and get alerted when they change.</p>' +
      '<a href="https://legiblesite.app/#pricing" style="display:inline-block;background:#e8a23a;color:#16120e;font-family:monospace;font-size:12px;font-weight:600;letter-spacing:0.07em;text-transform:uppercase;padding:13px 26px;border-radius:3px;text-decoration:none">Start Monitoring &#8212; $49/month</a>';

  return '<!DOCTYPE html><html><head><meta charset="UTF-8"></head>' +
    '<body style="margin:0;padding:0;background:#f2f1ed;font-family:-apple-system,BlinkMacSystemFont,sans-serif">' +
    '<div style="max-width:580px;margin:0 auto;padding:24px 16px">' +
    '<div style="background:#16120e;padding:16px 24px;border-radius:6px 6px 0 0">' +
    '<span style="font-family:monospace;font-size:13px;font-weight:600;letter-spacing:0.08em;color:white">legible</span>' +
    '<span style="font-family:monospace;font-size:11px;color:rgba(255,255,255,0.3);float:right">' + domain + '</span></div>' +
    '<div style="background:white;padding:36px 24px;text-align:center;border-left:1px solid #ddd;border-right:1px solid #ddd">' +
    '<div style="font-family:monospace;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#aaa;margin-bottom:10px">Legibility Score</div>' +
    '<div style="font-size:100px;font-weight:700;line-height:1;color:' + gc + ';font-family:Georgia,serif">' + g.grade + '</div>' +
    '<div style="font-family:monospace;font-size:12px;color:#bbb;margin-top:4px">' + g.score + ' / 100</div></div>' +
    '<div style="background:white;padding:22px 24px;border-left:1px solid #ddd;border-right:1px solid #ddd;border-top:1px solid #f0f0f0">' +
    '<div style="font-family:monospace;font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:#aaa;margin-bottom:14px">Scores</div>' +
    '<table style="width:100%;border-collapse:collapse">' + scoreRows + '</table></div>' +
    '<div style="background:white;padding:22px 24px;border-left:1px solid #ddd;border-right:1px solid #ddd;border-top:1px solid #f0f0f0">' +
    '<div style="font-family:monospace;font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:#aaa;margin-bottom:14px">All Issues</div>' +
    '<table style="width:100%;border-collapse:collapse">' + issueRows + '</table></div>' +
    '<div style="background:white;padding:22px 24px;border-left:1px solid #ddd;border-right:1px solid #ddd;border-top:1px solid #f0f0f0">' +
    '<div style="font-family:monospace;font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:#aaa;margin-bottom:10px">Your llms.txt &#8212; upload to yoursite.com/llms.txt</div>' +
    '<pre style="background:#f8f8f6;padding:14px;font-family:monospace;font-size:11px;line-height:1.75;color:#555;border-radius:4px;white-space:pre-wrap;margin:0">' + llmsTxt + '</pre></div>' +
    '<div style="background:#16120e;padding:28px 24px;text-align:center;border-radius:0 0 6px 6px">' + upgradeCta +
    '<p style="color:rgba(255,255,255,0.2);font-size:11px;margin:20px 0 0;font-family:monospace">legiblesite.app &#183; hello@legible.ai</p></div>' +
    '</div></body></html>';
}

// ── Crawl ────────────────────────────────────────────────────
async function crawl(url) {
  var res = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.FIRECRAWL_API_KEY },
    body: JSON.stringify({ url: url, formats: ['markdown'], excludeTags: ['nav','footer','script','style','head'], timeout: 20000 })
  });
  if (!res.ok) throw new Error('Firecrawl error: ' + res.status);
  var data = await res.json();
  return (data && data.data && (data.data.markdown || data.data.content)) || '';
}

// ── Score via Claude ─────────────────────────────────────────
async function scoreWithClaude(url, content) {
  var prompt = SCORING_PROMPT
    .replace('{{URL}}', url)
    .replace('{{CONTENT}}', content.slice(0, 9000));

  var res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!res.ok) throw new Error('Claude error: ' + res.status);
  var data = await res.json();
  var text = data.content[0].text.trim()
    .replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
  return JSON.parse(text);
}

// ── Send email ───────────────────────────────────────────────
async function sendEmail(to, url, analysis, llmsTxt, plan) {
  var g = gradeFromScores(analysis.scores);
  var domain = new URL(url).hostname;
  var res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY },
    body: JSON.stringify({
      from: 'Legible <audit@legiblesite.app>',
      to: to,
      subject: 'Legibility Score: ' + g.grade + ' (' + g.score + '/100) — ' + domain,
      html: buildEmail(url, analysis, llmsTxt, plan || 'report')
    })
  });
  if (!res.ok) throw new Error('Resend error: ' + (await res.text()));
}

// ── Handler ──────────────────────────────────────────────────
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

  var url   = body && body.url;
  var email = body && body.email; // optional for preview

  if (!url) return res.status(400).json({ error: 'url is required' });

  var parsed;
  try { parsed = new URL(url); } catch(e) { return res.status(400).json({ error: 'Invalid URL' }); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return res.status(400).json({ error: 'URL must start with http:// or https://' });
  }

  try {
    var content = await crawl(url);
    if (!content || content.length < 50) {
      return res.status(422).json({ error: 'Could not read this URL. Is it publicly accessible?' });
    }

    var analysis = await scoreWithClaude(url, content);

    // Override schema_presence with programmatic detection
    analysis.scores.schema_presence = detectSchema(content);

    var llmsTxt = makeLlmsTxt(url, analysis);

    if (email) {
      await sendEmail(email, url, analysis, llmsTxt, body.plan || 'report');
    }

    var g = gradeFromScores(analysis.scores);
    return res.status(200).json({
      success: true,
      grade:       g.grade,
      score:       g.score,
      scores:      analysis.scores,
      issues:      analysis.issues,
      entity_name: analysis.entity_name,
      llms_txt:    llmsTxt
    });

  } catch(err) {
    console.error('[audit error]', err.message);
    return res.status(500).json({ error: 'Audit failed: ' + err.message });
  }
};
