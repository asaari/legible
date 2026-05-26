// api/confirm-payment.js
// Called from success.html after Stripe redirect
// Verifies the session, runs full audit, emails report, stores customer in Supabase
// Env vars: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY,
//           ANTHROPIC_API_KEY, FIRECRAWL_API_KEY, RESEND_API_KEY

// ── Supabase ─────────────────────────────────────────────────
async function dbInsert(table, data) {
  var res = await fetch(process.env.SUPABASE_URL + '/rest/v1/' + table, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': process.env.SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(data)
  });
  return res.json();
}

async function dbQuery(table, filter) {
  var qs = Object.keys(filter).map(function(k){
    return k + '=eq.' + encodeURIComponent(filter[k]);
  }).join('&');
  var res = await fetch(process.env.SUPABASE_URL + '/rest/v1/' + table + '?' + qs, {
    headers: {
      'apikey': process.env.SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY
    }
  });
  return res.json();
}

// ── Stripe session verification ───────────────────────────────
async function getStripeSession(sessionId) {
  var res = await fetch('https://api.stripe.com/v1/checkout/sessions/' + sessionId, {
    headers: { 'Authorization': 'Bearer ' + process.env.STRIPE_SECRET_KEY }
  });
  if (!res.ok) throw new Error('Stripe session fetch failed');
  return res.json();
}

// ── Crawl + Score ─────────────────────────────────────────────
function detectSchema(content) {
  var score = 0;
  if (content.includes('application/ld+json')) score += 50;
  if (content.includes('"@type"'))             score += 15;
  if (content.includes('og:title') || content.includes('og:description')) score += 20;
  if (content.includes('og:image'))            score += 10;
  if (content.includes('twitter:card'))        score += 5;
  return Math.min(score, 100);
}

function gradeFromScores(scores) {
  var avg = Object.values(scores).reduce(function(a,b){return a+b;},0) / 6;
  return { grade: avg>=80?'A':avg>=65?'B':avg>=50?'C':avg>=35?'D':'F', score: Math.round(avg) };
}

function makeLlmsTxt(url, analysis) {
  var g = gradeFromScores(analysis.scores);
  return '# ' + analysis.entity_name + '\n\n> ' + analysis.entity_description +
    '\n\n## Key Facts\n' + analysis.key_facts.map(function(f){return '- '+f;}).join('\n') +
    '\n\n## Source\n' + url +
    '\n\n---\nStructured by Legible (https://legiblesite.app) · Grade: ' + g.grade + ' · Score: ' + g.score + '/100';
}

async function crawl(url) {
  var res = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.FIRECRAWL_API_KEY },
    body: JSON.stringify({ url: url, formats: ['markdown'], excludeTags: ['nav','footer','script','style','head'], timeout: 20000 })
  });
  if (!res.ok) throw new Error('Firecrawl ' + res.status);
  var d = await res.json();
  return (d && d.data && (d.data.markdown || d.data.content)) || '';
}

async function scoreUrl(url, content) {
  var prompt = 'Score this website for LLM discoverability using exact point criteria.\n\nURL: ' + url +
    '\n\nCONTENT:\n' + content.slice(0, 9000) +
    '\n\nReturn ONLY valid JSON:\n{"scores":{"entity_clarity":<0-100>,"factual_density":<0-100>,"internal_consistency":<0-100>,"schema_presence":0,"freshness_signals":<0-100>,"claim_verifiability":<0-100>},"issues":[{"severity":"critical","description":"<specific>"},{"severity":"critical","description":"<specific>"},{"severity":"warning","description":"<specific>"}],"entity_name":"<name>","entity_description":"<2 sentences>","key_facts":["<fact>","<fact>","<fact>","<fact>","<fact>"]}';

  var res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024, temperature: 0, messages: [{ role: 'user', content: prompt }] })
  });
  if (!res.ok) throw new Error('Claude ' + res.status);
  var d = await res.json();
  var text = d.content[0].text.trim().replace(/^```json\n?/,'').replace(/\n?```$/,'').trim();
  return JSON.parse(text);
}

async function generateMonitoringQueries(entityName, description, url) {
  var res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001', max_tokens: 512, temperature: 0,
      messages: [{ role: 'user', content: 'Generate 8 realistic queries someone would type into an AI assistant to find this business.\nBusiness: ' + entityName + '\nDescription: ' + description + '\nURL: ' + url + '\nReturn ONLY JSON: {"queries":["<q1>","<q2>","<q3>","<q4>","<q5>","<q6>","<q7>","<q8>"]}' }]
    })
  });
  var d = await res.json();
  try {
    var text = d.content[0].text.trim().replace(/^```json\n?/,'').replace(/\n?```$/,'').trim();
    return JSON.parse(text).queries || [];
  } catch(e) { return []; }
}

// ── Email ─────────────────────────────────────────────────────
function scoreFill(s) {
  var c = s>=70?'#1a7a3a':s>=45?'#c8900a':'#c8000a';
  return '<div style="background:#eee;border-radius:2px;height:4px;width:100%;margin-top:6px"><div style="background:'+c+';height:4px;border-radius:2px;width:'+s+'%"></div></div>';
}

async function sendFullReport(email, url, analysis, llmsTxt, plan) {
  var g  = gradeFromScores(analysis.scores);
  var gc = {A:'#1a7a3a',B:'#2d8a4e',C:'#c8900a',D:'#c85000',F:'#c8000a'}[g.grade]||'#666';
  var domain = new URL(url).hostname;

  var scoreRows = [
    ['Entity Clarity',analysis.scores.entity_clarity],
    ['Factual Density',analysis.scores.factual_density],
    ['Internal Consistency',analysis.scores.internal_consistency],
    ['Schema Presence',analysis.scores.schema_presence],
    ['Freshness Signals',analysis.scores.freshness_signals],
    ['Claim Verifiability',analysis.scores.claim_verifiability]
  ].map(function(p){
    return '<tr><td style="padding:9px 0;font-family:monospace;font-size:12px;color:#666;border-bottom:1px solid #f0f0f0;width:60%">'+p[0]+'</td><td style="padding:9px 0;font-family:monospace;font-size:12px;color:#333;border-bottom:1px solid #f0f0f0;text-align:right">'+p[1]+'/100</td></tr><tr><td colspan="2" style="padding-bottom:4px">'+scoreFill(p[1])+'</td></tr>';
  }).join('');

  var issueRows = analysis.issues.map(function(i){
    return '<tr><td style="padding:11px 0;font-size:13px;color:#444;line-height:1.6;border-bottom:1px solid #f5f5f5"><span style="font-family:monospace;font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:'+(i.severity==='critical'?'#c8000a':'#c8900a')+';margin-right:8px">'+i.severity+'</span>'+i.description+'</td></tr>';
  }).join('');

  var monitoringMsg = (plan === 'standard' || plan === 'pro')
    ? '<p style="color:rgba(255,255,255,0.5);font-size:14px;line-height:1.65;margin:0 0 20px">Your weekly monitoring is now active. First citation report arrives next Monday.</p>'
    : '<a href="https://legiblesite.app/#pricing" style="display:inline-block;background:#e8a23a;color:#16120e;font-family:monospace;font-size:12px;font-weight:600;letter-spacing:0.07em;text-transform:uppercase;padding:13px 26px;border-radius:3px;text-decoration:none">Start Monitoring &#8212; $49/month</a>';

  var html = '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f2f1ed;font-family:-apple-system,sans-serif">'+
    '<div style="max-width:580px;margin:0 auto;padding:24px 16px">'+
    '<div style="background:#16120e;padding:16px 24px;border-radius:6px 6px 0 0"><span style="font-family:monospace;font-weight:600;letter-spacing:0.08em;color:white">legible</span><span style="font-family:monospace;font-size:11px;color:rgba(255,255,255,0.3);float:right">'+domain+'</span></div>'+
    '<div style="background:white;padding:36px 24px;text-align:center;border-left:1px solid #ddd;border-right:1px solid #ddd">'+
    '<div style="font-family:monospace;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#aaa;margin-bottom:10px">Legibility Score</div>'+
    '<div style="font-size:100px;font-weight:700;line-height:1;color:'+gc+';font-family:Georgia,serif">'+g.grade+'</div>'+
    '<div style="font-family:monospace;font-size:12px;color:#bbb;margin-top:4px">'+g.score+' / 100</div></div>'+
    '<div style="background:white;padding:22px 24px;border-left:1px solid #ddd;border-right:1px solid #ddd;border-top:1px solid #f0f0f0">'+
    '<div style="font-family:monospace;font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:#aaa;margin-bottom:14px">Dimension Scores</div>'+
    '<table style="width:100%;border-collapse:collapse">'+scoreRows+'</table></div>'+
    '<div style="background:white;padding:22px 24px;border-left:1px solid #ddd;border-right:1px solid #ddd;border-top:1px solid #f0f0f0">'+
    '<div style="font-family:monospace;font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:#aaa;margin-bottom:14px">All Issues</div>'+
    '<table style="width:100%;border-collapse:collapse">'+issueRows+'</table></div>'+
    '<div style="background:white;padding:22px 24px;border-left:1px solid #ddd;border-right:1px solid #ddd;border-top:1px solid #f0f0f0">'+
    '<div style="font-family:monospace;font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:#aaa;margin-bottom:10px">Your llms.txt &#8212; upload to yoursite.com/llms.txt</div>'+
    '<pre style="background:#f8f8f6;padding:14px;font-family:monospace;font-size:11px;line-height:1.75;color:#555;border-radius:4px;white-space:pre-wrap;margin:0">'+llmsTxt+'</pre></div>'+
    '<div style="background:#16120e;padding:28px 24px;text-align:center;border-radius:0 0 6px 6px">'+monitoringMsg+
    '<p style="color:rgba(255,255,255,0.2);font-size:11px;margin:20px 0 0;font-family:monospace">legiblesite.app &#183; hello@legible.ai</p></div>'+
    '</div></body></html>';

  var res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY },
    body: JSON.stringify({ from: 'Legible <audit@legiblesite.app>', to: email, subject: 'Your Legibility Report: ' + g.grade + ' (' + g.score + '/100) — ' + domain, html: html })
  });
  if (!res.ok) throw new Error('Resend: ' + (await res.text()));
}

// ── Main handler ─────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  var sessionId = req.query && req.query.session_id;
  if (!sessionId) return res.status(400).json({ error: 'session_id required' });

  try {
    // 1. Verify payment with Stripe
    var session = await getStripeSession(sessionId);
    if (session.payment_status !== 'paid' && session.status !== 'complete') {
      return res.status(400).json({ error: 'Payment not completed' });
    }

    var email   = session.customer_email || (session.customer_details && session.customer_details.email);
    var siteUrl = session.metadata && session.metadata.site_url;
    var plan    = session.metadata && session.metadata.plan;

    if (!email || !siteUrl) {
      return res.status(400).json({ error: 'Missing email or site URL from session' });
    }

    // 2. Check if already processed (idempotency)
    var existing = await dbQuery('customers', { stripe_customer_id: session.customer });
    if (Array.isArray(existing) && existing.length > 0) {
      return res.status(200).json({ success: true, already_processed: true, grade: null });
    }

    // 3. Run full audit
    var content  = await crawl(siteUrl);
    if (!content || content.length < 50) throw new Error('Could not crawl ' + siteUrl);

    var analysis = await scoreUrl(siteUrl, content);
    analysis.scores.schema_presence = detectSchema(content);
    var llmsTxt  = makeLlmsTxt(siteUrl, analysis);
    var g        = gradeFromScores(analysis.scores);

    // 4. Store customer in Supabase
    var customers = await dbInsert('customers', {
      email:                   email,
      url:                     siteUrl,
      plan:                    plan,
      stripe_customer_id:      session.customer,
      stripe_subscription_id:  session.subscription || null,
      active:                  true
    });
    var customer = Array.isArray(customers) ? customers[0] : customers;

    // 5. Store audit
    if (customer && customer.id) {
      await dbInsert('audits', {
        customer_id:  customer.id,
        url:          siteUrl,
        grade:        g.grade,
        score:        g.score,
        scores:       analysis.scores,
        issues:       analysis.issues,
        llms_txt:     llmsTxt,
        entity_name:  analysis.entity_name
      });

      // 6. Generate monitoring queries for recurring plans
      if (plan === 'standard' || plan === 'pro') {
        var queries = await generateMonitoringQueries(analysis.entity_name, analysis.entity_description, siteUrl);
        for (var i = 0; i < queries.length; i++) {
          await dbInsert('monitoring_queries', { customer_id: customer.id, query: queries[i] });
        }
      }
    }

    // 7. Send full report email
    await sendFullReport(email, siteUrl, analysis, llmsTxt, plan);

    return res.status(200).json({ success: true, grade: g.grade, score: g.score });

  } catch(err) {
    console.error('[confirm-payment error]', err.message);
    return res.status(500).json({ error: err.message });
  }
};
