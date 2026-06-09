// sync-libre.js - Scarica dati Freestyle Libre e aggiorna libre-data.json
const https = require('https');
const fs = require('fs');

const EMAIL = process.env.LIBRE_EMAIL;
const PASSWORD = process.env.LIBRE_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error('❌ LIBRE_EMAIL e LIBRE_PASSWORD sono richiesti');
  process.exit(1);
}

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function login() {
  console.log('🔐 Login LibreLinkUp...');
  const res = await request({
    hostname: 'api.libreview.io',
    path: '/llu/auth/login',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'version': '4.7',
      'product': 'llu.ios',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
    }
  }, { email: EMAIL, password: PASSWORD });

  if (res.data?.data?.authTicket?.token) {
    console.log('✅ Login OK');
    return res.data.data.authTicket.token;
  }
  // Redirect region
  if (res.data?.data?.redirect && res.data?.data?.region) {
    const region = res.data.data.region;
    console.log(`🌍 Redirect a regione: ${region}`);
    const res2 = await request({
      hostname: `api-${region}.libreview.io`,
      path: '/llu/auth/login',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'version': '4.7',
        'product': 'llu.ios',
      }
    }, { email: EMAIL, password: PASSWORD });
    if (res2.data?.data?.authTicket?.token) {
      console.log('✅ Login OK (regione)');
      process.env.LIBRE_REGION = region;
      return res2.data.data.authTicket.token;
    }
  }
  throw new Error('Login fallito: ' + JSON.stringify(res.data));
}

async function getConnections(token) {
  const region = process.env.LIBRE_REGION || '';
  const hostname = region ? `api-${region}.libreview.io` : 'api.libreview.io';
  const res = await request({
    hostname,
    path: '/llu/connections',
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'version': '4.7',
      'product': 'llu.ios',
    }
  });
  return res.data?.data || [];
}

async function getGlucose(token, patientId) {
  const region = process.env.LIBRE_REGION || '';
  const hostname = region ? `api-${region}.libreview.io` : 'api.libreview.io';
  const res = await request({
    hostname,
    path: `/llu/connections/${patientId}/graph`,
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'version': '4.7',
      'product': 'llu.ios',
    }
  });
  return res.data?.data?.graphData || [];
}

async function main() {
  try {
    const token = await login();
    const connections = await getConnections(token);

    let patientId;
    if (connections.length > 0) {
      patientId = connections[0].patientId;
      console.log(`👤 Paziente: ${connections[0].firstName || 'N/A'}`);
    } else {
      // Prova dati propri
      console.log('ℹ️ Nessuna connessione trovata, uso dati propri');
      patientId = 'self';
    }

    const graphData = patientId !== 'self' 
      ? await getGlucose(token, patientId)
      : [];

    // Leggi dati esistenti
    let existing = [];
    if (fs.existsSync('libre-data.json')) {
      try { existing = JSON.parse(fs.readFileSync('libre-data.json', 'utf8')); } catch(e) {}
    }

    // Converti nuove letture
    const INTERVAL_MS = 150 * 60 * 1000;
    let lastTime = existing.length > 0 ? new Date(existing[existing.length-1].date).getTime() : 0;
    
    const newReadings = [];
    for (const g of graphData) {
      const dt = new Date(g.Timestamp || g.timestamp || g.FactoryTimestamp);
      if (isNaN(dt.getTime())) continue;
      const val = g.Value || g.value;
      if (!val || val < 30 || val > 500) continue;
      if (dt.getTime() - lastTime < INTERVAL_MS) continue;
      newReadings.push({ id: dt.getTime(), value: val, date: dt.toISOString() });
      lastTime = dt.getTime();
    }

    const merged = [...existing, ...newReadings]
      .sort((a,b) => new Date(a.date) - new Date(b.date))
      .filter((r,i,arr) => i===0 || r.id !== arr[i-1].id);

    fs.writeFileSync('libre-data.json', JSON.stringify(merged, null, 2));
    console.log(`✅ Aggiunte ${newReadings.length} nuove letture (tot. ${merged.length})`);
    
    // Scrivi output per GitHub Actions
    fs.writeFileSync(process.env.GITHUB_OUTPUT || '/dev/null', 
      `new_readings=${newReadings.length}\ntotal=${merged.length}\n`);

  } catch(err) {
    console.error('❌ Errore:', err.message);
    process.exit(1);
  }
}

main();
