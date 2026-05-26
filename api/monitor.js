// api/monitor.js
// Runs every Monday 07:00 UTC via Vercel Cron
// For each active Standard/Pro customer:
//   1. Re-crawl and re-audit their site
//   2. Run citation probes
//   3. Check competitor sites for changes (Pro only)
//   4. Send weekly email digest
//   5. Send product insight email to hello@legiblesite.app
// Manual trigger: POST with { "secret": CRON_SECRET }
// Env vars: ANTHROPIC_API_KEY, FIRECRAWL_API_KEY, RESEND_API_KEY,
//           SUPABASE_URL, SUPABASE_SERVICE_KEY, CRON_SECRET

// ── Supabase ─────────────────────────────────────────────────
async function db(path, method, body) {
  var opts = {
    method: method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'apikey': process.env.SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
      'Prefer': 'return=representation'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  var res = await fetch(process.env.SUPABASE_URL + '/rest/v1/' + path, opts);
  var text = await res.text();
  try { return JSON.parse(text); } catch(e) { return text; }
}

// ── Claude ───────────────────────────────────────────────────
async function claude(prompt, maxTokens) {
  var res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens || 512, temperature: 0, messages: [{ role: 'user', content: prompt }] })
  });
  var d = await res.json();
  return d.content[0].text.trim();
}

async function claudeJSON(prompt) {
  var text = await claude(prompt, 1024);
  return JSON.parse(text.replace(/^```json\n?/,'').replace(/\n?```$/,'').trim());
}

// ── Firecrawl ────────────────────────────────────────────────
async function crawl(url) {
  var res = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.FIRECRAWL_API_KEY },
    body: JSON.stringify({ url: url, formats: ['markdown'], excludeTags: ['nav','footer','script','style'], timeout: 20000 })
  });
  if (!res.ok) return '';
  var d = await res.json();
  return (d && d.data && (d.data.markdown || d.data.content)) || '';
}

// ── Schema + Grade ────────────────────────────────────────────
function detectSchema(content) {
  var s = 0;
  if (content.includes('application/ld+json')) s += 50;
  if (content.includes('"@type"')) s += 15;
  if (content.includes('og:title') || content.includes('og:description')) s += 20;
  if (content.includes('og:image')) s += 10;
  if (content.includes('twitter:card')) s += 5;
  return Math.min(s, 100);
}

function gradeFromScores(scores) {
  var avg = Object.values(scores).reduce(function(a,b){return a+b;},0)/6;
  return { grade: avg>=80?'A':avg>=65?'B':avg>=50?'C':avg>=35?'D':'F', score: Math.round(avg) };
}

// ── Re-audit ─────────────────────────────────────────────────
async function reAudit(url, content) {
  var result = await claudeJSON(
    'Score this website for LLM discoverability. URL: ' + url + '\n\nCONTENT:\n' + content.slice(0,9000) +
    '\n\nReturn ONLY valid JSON:\n{"scores":{"entity_clarity":<0-100>,"factual_density":<0-100>,"internal_consistency":<0-100>,"schema_presence":0,"freshness_signals":<0-100>,"claim_verifiability":<0-100>},"issues":[{"severity":"critical","description":"<specific>"}],"entity_name":"<name>","entity_description":"<2 sentences>"}'
  );
  result.scores.schema_presence = detectSchema(content);
  return result;
}

// ── Citation probe ────────────────────────────────────────────
async function probeCitation(siteUrl, siteSummary, query) {
  return claudeJSON(
    'Would an AI assistant cite this website when answering the following query?\n\n' +
    'Website: ' + siteUrl + '\nSummary: ' + siteSummary + '\nQuery: "' + query + '"\n\n' +
    'Return ONLY JSON: {"cited":true/false,"confidence":"high"/"medium"/"low","reason":"<one sentence>"}'
  );
}

// ── Competitor diff ───────────────────────────────────────────
async function diffCompetitor(oldContent, newContent) {
  if (!oldContent || Math.abs(oldContent.length - newContent.length) < 100) return null;
  var summary = await claude(
    'Compare these two versions of a competitor website. Describe what changed in 2-3 bullet points. ' +
    'Focus on: new/removed services, pricing changes, new content, messaging shifts.\n\n' +
    'PREVIOUS:\n' + oldContent.slice(0,3000) + '\n\nCURRENT:\n' + newContent.slice(0,3000) + '\n\n' +
    'If no meaningful changes, respond with exactly: NO_CHANGE\nOtherwise use bullet points starting with •',
    512
  );
  return summary === 'NO_CHANGE' ? null : summary;
}

// ── Weekly email ─────────────────────────────────────────────
async function sendWeeklyDigest(customer, auditResult, citationResults, competitorResults, previousGrade) {
  var g = gradeFromScores(auditResult.scores);
  var domain = new URL(customer.url).hostname;
  var weekOf = new Date().toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' });
  var gradeChange = previousGrade && g.grade !== previousGrade ? ' (was ' + previousGrade + ')' : '';
  var gc = {A:'#1a7a3a',B:'#2d8a4e',C:'#c8900a',D:'#c85000',F:'#c8000a'}[g.grade]||'#666';

  // Citation breakdown by platform
  var byPlatform = {};
  citationResults.forEach(function(r) {
    if (!byPlatform[r.platform]) byPlatform[r.platform] = { cited: 0, total: 0 };
    byPlatform[r.platform].total++;
    if (r.cited) byPlatform[r.platform].cited++;
  });

  var platformRows = Object.keys(byPlatform).map(function(p) {
    var s = byPlatform[p];
    var c = s.cited > 0 ? '#1a7a3a' : '#aaa';
    return '<tr><td style="padding:9px 0;font-family:monospace;font-size:12px;color:#666;border-bottom:1px solid #f5f5f5;text-transform:capitalize">' + p + '</td>' +
      '<td style="padding:9px 0;font-family:monospace;font-size:12px;color:'+c+';text-align:right;border-bottom:1px solid #f5f5f5;font-weight:600">' + s.cited + '/' + s.total + ' queries</td></tr>';
  }).join('');

  var citedQueries = citationResults.filter(function(r){return r.cited;}).slice(0,5).map(function(r){
    return '<li style="margin-bottom:6px;font-size:13px;color:#555">&ldquo;' + r.query + '&rdquo; <span style="font-family:monospace;font-size:10px;color:#aaa">via ' + r.platform + '</span></li>';
  }).join('');
  if (!citedQueries) citedQueries = '<li style="font-size:13px;color:#aaa">No citations detected this week. Review your issues list for improvements.</li>';

  var compSection = '';
  if (competitorResults && competitorResults.length > 0) {
    var compRows = competitorResults.map(function(c) {
      return '<div style="margin-bottom:12px;padding:14px;background:#f8f8f6;border-radius:4px">' +
        '<div style="font-family:monospace;font-size:11px;color:#888;margin-bottom:6px">' + c.name + '</div>' +
        '<div style="font-size:13px;color:#444;line-height:1.6;white-space:pre-line">' + (c.changes || 'No meaningful changes detected.') + '</div></div>';
    }).join('');
    compSection = '<div style="background:white;padding:22px 24px;border-left:1px solid #ddd;border-right:1px solid #ddd;border-top:1px solid #f0f0f0">' +
      '<div style="font-family:monospace;font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:#aaa;margin-bottom:14px">Competitor Watch</div>' +
      compRows + '</div>';
  }

  var html = '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f2f1ed;font-family:-apple-system,sans-serif">' +
    '<div style="max-width:580px;margin:0 auto;padding:24px 16px">' +
    '<div style="background:#16120e;padding:16px 24px;border-radius:6px 6px 0 0"><span style="font-family:monospace;font-weight:600;letter-spacing:0.08em;color:white">legible</span><span style="font-family:monospace;font-size:11px;color:rgba(255,255,255,0.3);float:right">Weekly Report &middot; ' + weekOf + '</span></div>' +
    '<div style="background:white;padding:28px 24px;border-left:1px solid #ddd;border-right:1px solid #ddd">' +
    '<div style="font-family:monospace;font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:#aaa;margin-bottom:8px">Legibility Score</div>' +
    '<div style="font-size:64px;font-weight:700;line-height:1;color:'+gc+';font-family:Georgia,serif">'+g.grade+'</div>' +
    '<div style="font-family:monospace;font-size:12px;color:#aaa">'+g.score+'/100'+gradeChange+'</div></div>' +
    '<div style="background:white;padding:22px 24px;border-left:1px solid #ddd;border-right:1px solid #ddd;border-top:1px solid #f0f0f0">' +
    '<div style="font-family:monospace;font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:#aaa;margin-bottom:14px">AI Citation Status</div>' +
    '<table style="width:100%;border-collapse:collapse">' + platformRows + '</table></div>' +
    '<div style="background:white;padding:22px 24px;border-left:1px solid #ddd;border-right:1px solid #ddd;border-top:1px solid #f0f0f0">' +
    '<div style="font-family:monospace;font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:#aaa;margin-bottom:12px">Queries That Cited You</div>' +
    '<ul style="list-style:none;margin:0;padding:0">' + citedQueries + '</ul></div>' +
    compSection +
    '<div style="background:#16120e;padding:24px;text-align:center;border-radius:0 0 6px 6px">' +
    '<a href="https://legiblesite.app/dashboard?email=' + encodeURIComponent(customer.email) + '" style="display:inline-block;background:#e8a23a;color:#16120e;font-family:monospace;font-size:12px;font-weight:600;letter-spacing:0.07em;text-transform:uppercase;padding:11px 24px;border-radius:3px;text-decoration:none">View Full Dashboard</a>' +
    '<p style="color:rgba(255,255,255,0.2);font-size:11px;margin:16px 0 0;font-family:monospace">legiblesite.app</p></div>' +
    '</div></body></html>';

  var res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY },
    body: JSON.stringify({ from: 'Legible <monitor@legiblesite.app>', to: customer.email, subject: 'Your weekly AI citation report — ' + domain, html: html })
  });
  if (!res.ok) throw new Error('Resend: ' + (await res.text()));
}

// ── Product insight email ─────────────────────────────────────
async function sendInsightEmail(audits, monitoring) {
  if (audits.length < 5) return; // not enough data yet

  var brief = await claude(
    'You are analysing Legible, an LLM visibility product. Based on this data, answer 3 questions:\n\n' +
    'RECENT AUDITS (sample): ' + JSON.stringify(audits.slice(0,30)) + '\n\n' +
    'CITATION RESULTS (sample): ' + JSON.stringify(monitoring.slice(0,50)) + '\n\n' +
    '1. Which of the 6 scoring dimensions best predicts actual citation? Which is least predictive?\n' +
    '2. What structural patterns do cited sites share that uncited ones lack?\n' +
    '3. What ONE change to the scoring rubric would most improve its accuracy?\n\n' +
    'Be specific. Reference actual numbers. Max 250 words total.',
    600
  );

  var html = '<html><body style="font-family:monospace;font-size:13px;line-height:1.7;color:#333;padding:32px;max-width:600px"><h2 style="font-size:16px;margin-bottom:20px">Legible Weekly Product Insight</h2><pre style="white-space:pre-wrap;font-size:13px;line-height:1.7">' + brief + '</pre><p style="color:#aaa;font-size:11px;margin-top:24px">Update scoring prompt at: Supabase &rarr; config table &rarr; scoring_prompt row</p></body></html>';

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY },
    body: JSON.stringify({ from: 'Legible <monitor@legiblesite.app>', to: 'hello@legiblesite.app', subject: 'Weekly product insight — ' + new Date().toLocaleDateString('en-GB'), html: html })
  });
}

// ── Main handler ─────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // Allow Vercel Cron (GET) or manual POST with secret
  if (req.method === 'POST') {
    var body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) {} }
    if (!body || body.secret !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  var weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1);
  var weekStartStr = weekStart.toISOString().split('T')[0];

  var customers = await db('customers?active=eq.true&plan=not.eq.report&select=*');
  if (!Array.isArray(customers)) customers = [];

  var processed = 0;
  var errors    = 0;

  for (var i = 0; i < customers.length; i++) {
    var customer = customers[i];
    try {
      // 1. Re-crawl
      var content = await crawl(customer.url);
      if (!content || content.length < 50) continue;

      // 2. Re-audit
      var auditResult = await reAudit(customer.url, content);
      var g = gradeFromScores(auditResult.scores);

      await db('audits', 'POST', {
        customer_id: customer.id, url: customer.url,
        grade: g.grade, score: g.score,
        scores: auditResult.scores, issues: auditResult.issues,
        entity_name: auditResult.entity_name
      });

      var prevAudits = await db('audits?customer_id=eq.' + customer.id + '&order=created_at.desc&limit=2&select=grade');
      var previousGrade = prevAudits && prevAudits[1] ? prevAudits[1].grade : null;

      // 3. Citation probes
      var queries = await db('monitoring_queries?customer_id=eq.' + customer.id + '&select=query');
      var citationResults = [];
      var siteSummary = auditResult.entity_name + '. ' + (auditResult.entity_description || '');

      for (var q = 0; q < Math.min((queries||[]).length, 8); q++) {
        try {
          var probe = await probeCitation(customer.url, siteSummary, queries[q].query);
          citationResults.push({ platform: 'claude', query: queries[q].query, cited: probe.cited, response_snippet: probe.reason });
          await db('monitoring_results', 'POST', {
            customer_id: customer.id, platform: 'claude',
            query: queries[q].query, cited: probe.cited,
            response_snippet: probe.reason, week_start: weekStartStr
          });
        } catch(e) { /* skip failed probe */ }
      }

      // 4. Competitor watch (Pro only)
      var competitorResults = [];
      if (customer.plan === 'pro') {
        var competitors = await db('competitors?customer_id=eq.' + customer.id + '&select=*');
        if (Array.isArray(competitors)) {
          for (var c = 0; c < competitors.length; c++) {
            var comp = competitors[c];
            try {
              var newContent = await crawl(comp.url);
              var changes = await diffCompetitor(comp.last_crawl, newContent);
              if (changes) {
                await db('competitor_changes', 'POST', { competitor_id: comp.id, summary: changes, week_start: weekStartStr });
              }
              await db('competitors?id=eq.' + comp.id, 'PATCH', { last_crawl: newContent.slice(0, 8000) });
              competitorResults.push({ name: comp.name || comp.url, changes: changes });
            } catch(e) { /* skip */ }
          }
        }
      }

      // 5. Send weekly digest
      await sendWeeklyDigest(customer, auditResult, citationResults, competitorResults, previousGrade);
      processed++;

    } catch(err) {
      console.error('[monitor] customer ' + customer.id + ':', err.message);
      errors++;
    }
  }

  // 6. Product insight email (runs regardless of customer count)
  try {
    var allAudits  = await db('audits?order=created_at.desc&limit=100&select=*');
    var allMonitor = await db('monitoring_results?order=created_at.desc&limit=200&select=*');
    await sendInsightEmail(allAudits || [], allMonitor || []);
  } catch(e) { console.error('[insight]', e.message); }

  return res.status(200).json({ processed: processed, errors: errors, week: weekStartStr });
};
