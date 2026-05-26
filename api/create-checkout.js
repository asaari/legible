// api/create-checkout.js
// Creates a Stripe Checkout session and returns the redirect URL
// Env vars required: STRIPE_SECRET_KEY, STRIPE_PRICE_REPORT,
//                    STRIPE_PRICE_STANDARD, STRIPE_PRICE_PRO

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

  var email = body && body.email;
  var url   = body && body.url;
  var plan  = body && body.plan;

  if (!email || !url || !plan) {
    return res.status(400).json({ error: 'email, url, and plan are required' });
  }

  var priceMap = {
    report:   process.env.STRIPE_PRICE_REPORT,
    standard: process.env.STRIPE_PRICE_STANDARD,
    pro:      process.env.STRIPE_PRICE_PRO
  };

  var priceId = priceMap[plan];
  if (!priceId) return res.status(400).json({ error: 'Invalid plan: ' + plan });

  var mode    = plan === 'report' ? 'payment' : 'subscription';
  var baseUrl = 'https://legiblesite.app';

  var params = new URLSearchParams({
    'customer_email':              email,
    'line_items[0][price]':        priceId,
    'line_items[0][quantity]':     '1',
    'mode':                        mode,
    'success_url':                 baseUrl + '/success?session_id={CHECKOUT_SESSION_ID}&plan=' + plan,
    'cancel_url':                  baseUrl + '/?cancelled=1',
    'metadata[site_url]':          url,
    'metadata[plan]':              plan
  });

  var stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.STRIPE_SECRET_KEY,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });

  if (!stripeRes.ok) {
    var err = await stripeRes.json();
    console.error('[checkout]', err);
    return res.status(500).json({ error: err.error && err.error.message || 'Failed to create checkout' });
  }

  var session = await stripeRes.json();
  return res.status(200).json({ url: session.url });
};
