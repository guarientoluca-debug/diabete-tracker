const https = require('https');
const fs = require('fs');
const nodemailer = require('nodemailer');

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASSWORD = process.env.GMAIL_PASSWORD;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!GMAIL_USER || !GMAIL_PASSWORD || !ANTHROPIC_API_KEY) {
  console.error('❌ Variabili mancanti');
  process.exit(1);
}

function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    });
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    let data = '';
    const req = https.request(options, (res) => {
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.content?.[0]?.text || '');
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(payload);
    req.end();
  });
}

function getZone(v) {
  if (v < 70)  return 'ipoglicemia';
  if (v <= 99) return 'normale';
  if (v <= 125) return 'pre-diabete';
  if (v <= 180) return 'alta';
  return 'iperglicemia';
}

async function main() {
  // Leggi dati salvati
  let userData = { readings: [], insulin: [], meals: [], libreData: [], insulinConfig: {} };
  if (fs.existsSync('user-data.json')) {
    try { userData = JSON.parse(fs.readFileSync('user-data.json', 'utf8')); } catch(e) {}
  }

  const { readings = [], insulin = [], meals = [], libreData = [], insulinConfig = {} } = userData;

  // Filtra ultimi 7 giorni
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600000);
  const weekReadings = readings.filter(r => new Date(r.date) >= weekAgo);
  const weekInsulin = insulin.filter(i => new Date(i.date) >= weekAgo);
  const weekMeals = meals.filter(m => new Date(m.date) >= weekAgo);
  const weekLibre = libreData.filter(r => new Date(r.date) >= weekAgo);

  // Combina glicemie (glucometro + libre)
  const allGlucose = [
    ...weekReadings.map(r => r.value),
    ...weekLibre.map(r => r.value)
  ];

  if (allGlucose.length === 0) {
    console.log('⚠️ Nessun dato questa settimana, email non inviata');
    return;
  }

  const avg = Math.round(allGlucose.reduce((a,b) => a+b, 0) / allGlucose.length);
  const minV = Math.min(...allGlucose);
  const maxV = Math.max(...allGlucose);
  const tir = Math.round(allGlucose.filter(v => v >= 70 && v <= 180).length / allGlucose.length * 100);
  const ipo = allGlucose.filter(v => v < 70).length;
  const iper = allGlucose.filter(v => v > 180).length;

  // Analisi pasti con risultati glicemici
  const mealResults = weekMeals.map(m => {
    const mealTime = new Date(m.date).getTime();
    const postGlucose = weekReadings
      .filter(r => r.timing === 'post-pasto' && new Date(r.date).getTime() > mealTime && new Date(r.date).getTime() - mealTime <= 3*3600000)
      .sort((a,b) => new Date(a.date) - new Date(b.date))[0];
    const dose = weekInsulin
      .filter(i => i.type === 'rapida' && Math.abs(new Date(i.date).getTime() - mealTime) <= 30*60000)
      .sort((a,b) => Math.abs(new Date(a.date).getTime()-mealTime) - Math.abs(new Date(b.date).getTime()-mealTime))[0];
    return { timing: m.timing, carbs: m.carbs, dose: dose?.units, postGlucose: postGlucose?.value, date: m.date.slice(0,10) };
  }).filter(m => m.carbs > 0);

  // Rapida per tipo pasto
  const rapidaPerPasto = weekInsulin.filter(i => i.type === 'rapida');
  const lenta = weekInsulin.filter(i => i.type === 'lenta');

  // Prompt per Claude
  const prompt = `Sei un diabetologo che analizza i dati settimanali di un paziente diabetico e scrive un report in italiano chiaro e incoraggiante.

DATI SETTIMANA (${new Date(weekAgo).toLocaleDateString('it-IT')} - ${new Date().toLocaleDateString('it-IT')}):

📊 GLICEMIA (${allGlucose.length} misurazioni totali):
- Media: ${avg} mg/dL
- Min: ${minV} | Max: ${maxV} mg/dL  
- TIR (70-180): ${tir}%
- Episodi ipoglicemia (<70): ${ipo}
- Episodi iperglicemia (>180): ${iper}

💉 INSULINA:
- Dosi rapide: ${rapidaPerPasto.length} (media ${rapidaPerPasto.length ? (rapidaPerPasto.reduce((a,b)=>a+b.units,0)/rapidaPerPasto.length).toFixed(1) : 0}U)
- Dosi lente: ${lenta.length}

🍽️ PASTI CON DATI:
${mealResults.slice(0,10).map(m => `- ${m.date} ${m.timing}: ${m.carbs}g carbo${m.dose ? ` → ${m.dose}U insulina` : ''}${m.postGlucose ? ` → glicemia post ${m.postGlucose} mg/dL` : ''}`).join('\n')}

⚙️ CONFIGURAZIONE ATTUALE:
- Rapporto insulina/carbo: ${insulinConfig.carbRatio || 'non configurato'}g per 1U
- Target glicemia: ${insulinConfig.targetGlucose || 120} mg/dL
- ISF: ${insulinConfig.isf || 50} mg/dL per U
- Dosi prescritte: colazione ${insulinConfig.dosePerPasto?.colazione || '?'}U, pranzo ${insulinConfig.dosePerPasto?.pranzo || '?'}U, cena ${insulinConfig.dosePerPasto?.cena || '?'}U

Scrivi un report settimanale in HTML con:
1. Un titolo con emoji e valutazione generale (ottima/buona/nella norma/difficile settimana)
2. Sezione "I tuoi numeri" con i dati chiave in modo visivo
3. Sezione "Cosa sta funzionando" (punti positivi)
4. Sezione "Aree di miglioramento" (se necessario, con suggerimenti pratici)
5. Se hai dati sufficienti sui pasti, valuta se il rapporto insulina/carbo sembra adeguato
6. Chiudi con un messaggio motivazionale

Usa un tono caldo, incoraggiante e pratico. Non sostituisce il parere medico — ricordalo brevemente. Rispondi SOLO con HTML (no markdown, no backtick).`;

  console.log('🤖 Chiamo Claude per analisi...');
  const reportHtml = await callClaude(prompt);

  // Email HTML completa
  const emailHtml = `
<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<style>
  body { font-family: -apple-system, 'Segoe UI', sans-serif; background:#f0f4f8; margin:0; padding:20px; color:#1e293b; }
  .container { max-width:600px; margin:0 auto; background:#fff; border-radius:16px; overflow:hidden; box-shadow:0 4px 20px rgba(0,0,0,.1); }
  .header { background:linear-gradient(135deg,#3b82f6,#8b5cf6); padding:24px; text-align:center; color:#fff; }
  .header h1 { margin:0; font-size:22px; font-weight:800; }
  .header p { margin:6px 0 0; opacity:.85; font-size:13px; }
  .content { padding:24px; }
  .stat-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin:16px 0; }
  .stat { background:#f8fafc; border-radius:10px; padding:12px; text-align:center; }
  .stat-val { font-size:22px; font-weight:800; }
  .stat-label { font-size:10px; color:#94a3b8; text-transform:uppercase; margin-top:2px; }
  .footer { background:#f8fafc; padding:16px; text-align:center; font-size:11px; color:#94a3b8; }
  h2 { font-size:16px; margin:20px 0 8px; color:#1e293b; }
  p { font-size:14px; line-height:1.6; color:#475569; }
  .tir-bar { background:#e2e8f0; border-radius:6px; height:12px; margin:6px 0; overflow:hidden; }
  .tir-fill { height:12px; border-radius:6px; background:${tir >= 70 ? '#22c55e' : tir >= 50 ? '#f59e0b' : '#ef4444'}; width:${tir}%; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>🩺 Diabete Tracker — Report Settimanale</h1>
    <p>${new Date(weekAgo).toLocaleDateString('it-IT')} → ${new Date().toLocaleDateString('it-IT')}</p>
  </div>
  <div class="content">
    <div class="stat-grid">
      <div class="stat"><div class="stat-val" style="color:${avg<=180?'#22c55e':'#ef4444'}">${avg}</div><div class="stat-label">Media mg/dL</div></div>
      <div class="stat"><div class="stat-val" style="color:${tir>=70?'#22c55e':tir>=50?'#f59e0b':'#ef4444'}">${tir}%</div><div class="stat-label">Tempo in range</div></div>
      <div class="stat"><div class="stat-val" style="color:${ipo===0?'#22c55e':'#ef4444'}">${ipo}</div><div class="stat-label">Ipoglicemie</div></div>
    </div>
    <div style="margin-bottom:16px">
      <div style="font-size:11px;color:#94a3b8;margin-bottom:4px">Tempo in range (70–180 mg/dL)</div>
      <div class="tir-bar"><div class="tir-fill"></div></div>
      <div style="font-size:11px;color:#64748b">${tir}% • obiettivo ADA: ≥70%</div>
    </div>
    ${reportHtml}
  </div>
  <div class="footer">
    📱 Generato automaticamente da Diabete Tracker · Non sostituisce il parere medico<br/>
    Per modificare le preferenze, accedi all'app
  </div>
</div>
</body>
</html>`;

  // Manda email
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
      user: GMAIL_USER,
      pass: GMAIL_PASSWORD
    },
    tls: { rejectUnauthorized: false }
  });

  console.log('📧 Invio email a', GMAIL_USER);
  await transporter.sendMail({
    from: `"Diabete Tracker" <${GMAIL_USER}>`,
    to: GMAIL_USER,
    subject: `🩺 Report settimanale Diabete Tracker — TIR ${tir}%`,
    html: emailHtml
  });

  console.log(`✅ Email inviata a ${GMAIL_USER}`);
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
