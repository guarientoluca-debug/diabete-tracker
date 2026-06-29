const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;


function isCEST(d) {
  const y = d.getUTCFullYear();
  const marchLast = new Date(Date.UTC(y, 2, 31));
  while (marchLast.getUTCDay() !== 0) marchLast.setUTCDate(marchLast.getUTCDate() - 1);
  marchLast.setUTCHours(1);
  const octLast = new Date(Date.UTC(y, 9, 31));
  while (octLast.getUTCDay() !== 0) octLast.setUTCDate(octLast.getUTCDate() - 1);
  octLast.setUTCHours(1);
  return d >= marchLast && d < octLast;
}
function toUTC(localDate) {
  const offsetH = isCEST(localDate) ? 2 : 1;
  return new Date(localDate.getTime() - offsetH * 3600000);
}

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function request(hostname, path, method, extraHeaders, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      'User-Agent': 'LibreLinkUp/4.16.0 CFNetwork/1492.0.1 Darwin/23.3.0',
      'Content-Type': 'application/json',
      'version': '4.16.0',
      'product': 'llu.ios',
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip, deflate',
      ...extraHeaders,
      ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
    };
    const req = https.request({ hostname, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const encoding = res.headers['content-encoding'];
        const parse = (buf) => {
          try { return { status: res.statusCode, data: JSON.parse(buf.toString()) }; }
          catch(e) { return { status: res.statusCode, raw: buf.toString().substring(0, 500) }; }
        };
        if (encoding === 'gzip') zlib.gunzip(buffer, (err, d) => resolve(err ? { status: res.statusCode, raw: 'gzip error' } : parse(d)));
        else if (encoding === 'deflate') zlib.inflate(buffer, (err, d) => resolve(err ? { status: res.statusCode, raw: 'deflate error' } : parse(d)));
        else resolve(parse(buffer));
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { email, password, user_id } = JSON.parse(event.body || '{}');
    if (!email || !password || !user_id) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'email, password e user_id richiesti' }) };
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Login LibreLink Up
    let REGION = '';
    let accountIdHash = '';

    const host = () => REGION ? `api-${REGION}.libreview.io` : 'api.libreview.io';

    let res = await request(host(), '/llu/auth/login', 'POST', {}, { email, password });

    if (res.data?.data?.redirect && res.data?.data?.region) {
      REGION = res.data.data.region;
      res = await request(host(), '/llu/auth/login', 'POST', {}, { email, password });
    }

    const token = res.data?.data?.authTicket?.token;
    const userId = res.data?.data?.user?.id || '';

    if (!token) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Credenziali LibreLink non valide' }) };
    }

    if (userId) accountIdHash = sha256(userId);

    // Get connections
    const connRes = await request(host(), '/llu/connections', 'GET', {
      'Authorization': `Bearer ${token}`,
      'account-id': accountIdHash,
    });

    const connections = Array.isArray(connRes.data?.data) ? connRes.data.data : [];
    if (connections.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, added: 0, message: 'Nessuna connessione trovata' }) };
    }

    const patient = connections[0];
    const patientId = patient.patientId || patient.id;

    // Get graph data
    const graphRes = await request(host(), `/llu/connections/${patientId}/graph`, 'GET', {
      'Authorization': `Bearer ${token}`,
      'account-id': accountIdHash,
    });

    const graphData = graphRes.data?.data?.graphData || graphRes.data?.graphData || [];

    if (!Array.isArray(graphData) || graphData.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, added: 0, message: 'Nessun dato dal sensore' }) };
    }

    // Fetch existing readings from Supabase to avoid duplicates
    const { data: existing } = await supabase
      .from('libre_data')
      .select('date')
      .eq('user_id', user_id)
      .order('date', { ascending: false })
      .limit(1);

    const lastTimestamp = existing?.[0]?.date ? new Date(existing[0].date).getTime() : 0;
    const INTERVAL_MS = 10 * 60 * 1000; // 10 min spacing anti-duplicato
    let lastTime = lastTimestamp;
    const toInsert = [];

    for (const g of graphData) {
      const ts = g.Timestamp || g.timestamp || g.FactoryTimestamp;
      if (!ts) continue;
      const dt = new Date(ts);
      if (isNaN(dt.getTime())) continue;
      const val = parseInt(g.Value || g.value);
      if (!val || val < 30 || val > 500) continue;
      if (dt.getTime() - lastTime < INTERVAL_MS) continue;
      toInsert.push({
        id: dt.getTime(),
        user_id,
        value: val,
        date: toUTC(dt).toISOString(),
      });
      lastTime = dt.getTime();
    }

    if (toInsert.length > 0) {
      const { error } = await supabase.from('libre_data').insert(toInsert);
      if (error) throw new Error(error.message);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, added: toInsert.length, total: graphData.length })
    };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
