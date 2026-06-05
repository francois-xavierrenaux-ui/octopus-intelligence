const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const BASE_URL = 'https://app.octopus-haccp.com';
// Trim whitespace/newlines that can appear in Vercel env vars
const GROUP_TOKEN = (process.env.GROUP_TOKEN || 'zTLzMDgwItTuvwN4K4mHIPWH5uD3yqWWOz77ExYDDiJcLwsvFmsjxpAtkT2GF1hL').trim();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Diagnostic endpoint ───────────────────────────────────────────────────────
app.get('/api/ping', async (req, res) => {
  try {
    const tok = await getToken();
    res.json({ ok: true, tokenLength: tok.length, env: !!process.env.GROUP_TOKEN, ts: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, env: !!process.env.GROUP_TOKEN });
  }
});

// ── Auth ──────────────────────────────────────────────────────────────────────
let authToken = null, tokenExpiry = null;
async function getToken() {
  if (authToken && tokenExpiry && new Date() < new Date(tokenExpiry)) return authToken;
  const r = await fetch(`${BASE_URL}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: GROUP_TOKEN }),
  });
  const d = await r.json();
  if (!d.token) throw new Error(d.message || 'Auth failed');
  authToken = d.token; tokenExpiry = d.expires_at;
  return authToken;
}
async function apiGet(ep, params = {}) {
  const tok = await getToken();
  const q = new URLSearchParams(params).toString();
  const r = await fetch(`${BASE_URL}/api/${ep}${q ? '?' + q : ''}`, { headers: { token: tok } });
  return r.json();
}
// In-memory cache to avoid reloading identical requests (key: ep+params, ttl: 10min)
const _cache = new Map();
function cacheGet(key) {
  const e = _cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > 10 * 60 * 1000) { _cache.delete(key); return null; }
  return e.data;
}
function cacheSet(key, data) { _cache.set(key, { data, ts: Date.now() }); }

async function fetchAll(ep, params = {}) {
  const cacheKey = ep + JSON.stringify(params);
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // Use per_page=500 to reduce pages — all pages fetched in parallel for speed
  const PER_PAGE = 500;
  const MAX_PAGES = 10; // max 5000 items per module (sufficient for 30-day periods)
  const first = await apiGet(ep, { ...params, page: 1, per_page: PER_PAGE });
  const items = first.data || (Array.isArray(first) ? first : []);
  if (!first.last_page || first.last_page <= 1) { cacheSet(cacheKey, items); return items; }

  const totalPages = Math.min(first.last_page, MAX_PAGES);
  if (totalPages <= 1) { cacheSet(cacheKey, items); return items; }

  // Fetch ALL remaining pages in parallel (no batching — maximise speed)
  const results = await Promise.all(
    Array.from({ length: totalPages - 1 }, (_, i) =>
      apiGet(ep, { ...params, page: i + 2, per_page: PER_PAGE })
    )
  );
  const allItems = items.concat(results.flatMap(r => r.data || []));
  cacheSet(cacheKey, allItems);
  return allItems;
}

app.get('/proxy/*', async (req, res) => {
  try {
    const tok = await getToken();
    const q = new URLSearchParams(req.query).toString();
    const url = `${BASE_URL}/api/${req.params[0]}${q ? '?' + q : ''}`;
    res.json(await (await fetch(url, { headers: { token: tok } })).json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Modules ────────────────────────────────────────────────────────────────────
const MODULE_CONFIG = {
  'Températures frigos':  { endpoint:'fridge_temperature_records',   metric:'pct',   unit:'couverture',  icon:'🌡️', critical:true,  desc:'Relevés température enceintes réfrigérées (seuil régl. ≤4°C, 2 relevés/jour min.)' },
  'Plans de nettoyage':   { endpoint:'cleaning_plan_action_tasks',   metric:'pct',   unit:'réalisées',   icon:'🧹', critical:true,  desc:'Tâches PND réalisées (Règlement CE 852/2004 - obligations nettoyage & désinfection)' },
  'Réceptions':           { endpoint:'control_receptions',           metric:'count', unit:'contrôles',   icon:'📦', critical:true,  desc:'Contrôles à réception (PCC - vérification températures, DLC, intégrité emballages)' },
  'Étiquettes DLC':       { endpoint:'labels',                       metric:'count', unit:'étiquettes',  icon:'🏷️', critical:false, desc:'Traçabilité étiquettes DLC/DDM (Règl. CE 178/2002 - un pas en avant/arrière)' },
  'Étiq. imprimées':      { endpoint:'print_labels',                 metric:'count', unit:'impr.',       icon:'🖨️', critical:false, desc:'Étiquettes DLC imprimées pour reconditionnement et traçabilité lot' },
  'Refroidissement':      { endpoint:'cooling_trackings',            metric:'count', unit:'opérations',  icon:'❄️', critical:true,  desc:'Refroidissements rapides tracés (protocole HACCP : 63°C→10°C en <2h)' },
  'Réchauffage':          { endpoint:'heating_trackings',            metric:'count', unit:'opérations',  icon:'🔥', critical:false, desc:'Remises en température tracées (≥63°C à cœur avant service)' },
  'Gestion déchets':      { endpoint:'waste_actions',                metric:'count', unit:'saisies',     icon:'♻️', critical:false, desc:'Pertes, retraits et non-conformités produits enregistrés' },
};
const MODULE_NAMES = Object.keys(MODULE_CONFIG);
const CRITICAL = MODULE_NAMES.filter(m => MODULE_CONFIG[m].critical);
const MODULE_WEIGHT = { 'Températures frigos': 1.5, 'Plans de nettoyage': 1.3, 'Réceptions': 1.2 };

// ── Date helpers ────────────────────────────────────────────────────────────
function datesInRange(start, end) {
  const [sd, sm, sy] = start.split('/');
  const [ed, em, ey] = end.split('/');
  const s = new Date(`${sy}-${sm}-${sd}`), e = new Date(`${ey}-${em}-${ed}`);
  const out = [];
  for (const d = new Date(s); d <= e; d.setDate(d.getDate() + 1))
    out.push(d.toISOString().split('T')[0]);
  return out;
}
function parseDate(item) {
  const raw = item.created_at || item.date || item.realisation_date || item.start_date || item.updated_at;
  return raw ? String(raw).split('T')[0].split(' ')[0] : null;
}
function fmtPeriod(dates) {
  const f = d => d ? d.split('-').reverse().join('/') : '';
  return `${f(dates[0])} → ${f(dates[dates.length - 1])}`;
}

// ── Stats ────────────────────────────────────────────────────────────────────
function stats(values) {
  const n = values.length;
  const total = values.reduce((a, b) => a + b, 0);
  const active = values.filter(v => v > 0).length;
  const coverage = n > 0 ? active / n : 0;
  const mean = n > 0 ? total / n : 0;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(n, 1);
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 1;
  const xm = (n - 1) / 2;
  const denom = values.reduce((s, _, i) => s + (i - xm) ** 2, 0);
  const slope = denom > 0 ? values.reduce((s, v, i) => s + (i - xm) * (v - mean), 0) / denom : 0;
  const trend = mean > 0 ? Math.max(-1, Math.min(1, slope / mean)) : 0;
  const h = Math.floor(n / 2);
  const h1 = h > 0 ? values.slice(0, h).reduce((a, b) => a + b, 0) / h : 0;
  const h2 = (n - h) > 0 ? values.slice(h).reduce((a, b) => a + b, 0) / (n - h) : 0;
  const halfTrend = h1 > 0 ? (h2 - h1) / h1 : h2 > 0 ? 1 : 0;
  const maxVal = Math.max(...values, 0);
  const peakRatio = mean > 0 ? maxVal / mean : 0;
  const crammingDay = total > 0 ? Math.round(maxVal / total * 100) : 0;
  let maxGap = 0, cur = 0;
  for (const v of values) { if (v === 0) { cur++; if (cur > maxGap) maxGap = cur; } else cur = 0; }
  maxGap = Math.max(maxGap, cur);
  const lastIdx = values.map((v, i) => v > 0 ? i : -1).filter(i => i >= 0).pop() ?? -1;
  const daysSince = lastIdx >= 0 ? n - 1 - lastIdx : n;
  return { total, active, coverage, mean, cv, trend, halfTrend, peakRatio, crammingDay, maxGap, daysSince, values, n };
}

// ── Compliance Score (0-100, HACCP-weighted) ──────────────────────────────────
function complianceScore(rs, allDates) {
  let score = 100;
  const factors = [];

  for (const mod of CRITICAL) {
    const ms = rs.modules[mod];
    const w = MODULE_WEIGHT[mod] || 1;
    const isPct = MODULE_CONFIG[mod].metric === 'pct';
    if (!ms || ms.total === 0) {
      const p = Math.round(-18 * w); score += p;
      factors.push({ icon: '🔴', label: `Module "${mod}" absent`, impact: p, severity: 'critical' });
    } else if (isPct) {
      // pct modules: penalise based on coverage percentage
      const covPct = Math.round(ms.coverage * 100);
      if (mod === 'Températures frigos') {
        if (covPct < 50) { score -= 20; factors.push({ icon: '🔴', label: `Couverture température insuffisante (${covPct}%)`, impact: -20, severity: 'critical' }); }
        else if (covPct < 70) { score -= 10; factors.push({ icon: '🟡', label: `Couverture température faible (${covPct}%)`, impact: -10, severity: 'high' }); }
        else if (covPct < 85) { score -= 5; factors.push({ icon: '🟠', label: `Couverture température partielle (${covPct}%)`, impact: -5, severity: 'medium' }); }
      } else if (mod === 'Plans de nettoyage') {
        if (covPct < 50) { score -= 15; factors.push({ icon: '🔴', label: `PND : couverture insuffisante (${covPct}%)`, impact: -15, severity: 'critical' }); }
        else if (covPct < 70) { score -= 8; factors.push({ icon: '🟡', label: `PND : couverture faible (${covPct}%)`, impact: -8, severity: 'high' }); }
      } else {
        if (ms.coverage < 0.4) {
          const p = Math.round(-10 * w); score += p;
          factors.push({ icon: '🟡', label: `Couverture "${mod}" insuffisante (${covPct}%)`, impact: p, severity: 'high' });
        } else if (ms.coverage < 0.65) {
          const p = Math.round(-5 * w); score += p;
          factors.push({ icon: '🟠', label: `Couverture "${mod}" partielle (${covPct}%)`, impact: p, severity: 'medium' });
        }
      }
    } else {
      // count modules: presence/absence penalty already handled above (total===0)
      if (ms.coverage < 0.4) {
        const p = Math.round(-10 * w); score += p;
        factors.push({ icon: '🟡', label: `Couverture "${mod}" insuffisante (${Math.round(ms.coverage*100)}%)`, impact: p, severity: 'high' });
      } else if (ms.coverage < 0.65) {
        const p = Math.round(-5 * w); score += p;
        factors.push({ icon: '🟠', label: `Couverture "${mod}" partielle (${Math.round(ms.coverage*100)}%)`, impact: p, severity: 'medium' });
      }
    }
    if (ms && ms.maxGap >= 5) {
      score -= 8; factors.push({ icon: '🕳', label: `Interruption ${ms.maxGap}j sur "${mod}"`, impact: -8, severity: 'high' });
    } else if (ms && ms.maxGap >= 3) {
      score -= 4; factors.push({ icon: '🕳', label: `Interruption ${ms.maxGap}j sur "${mod}"`, impact: -4, severity: 'medium' });
    }
    if (ms && ms.crammingDay > 50 && ms.total > 8) {
      score -= 7; factors.push({ icon: '📦', label: `Saisie rétroactive "${mod}" (${ms.crammingDay}% en 1 jour)`, impact: -7, severity: 'high' });
    }
  }

  if (rs.overall.coverage < 0.25) { score -= 12; factors.push({ icon: '💤', label: 'Activité globale critique (<25% des jours)', impact: -12, severity: 'critical' }); }
  else if (rs.overall.coverage < 0.4) { score -= 6; factors.push({ icon: '📉', label: 'Activité globale faible (<40% des jours)', impact: -6, severity: 'high' }); }

  // Weekend coverage
  const weDays = allDates.filter(d => [0, 6].includes(new Date(d).getDay()));
  if (weDays.length >= 4) {
    const weTotal = weDays.reduce((s, d) => s + (rs.totalVals[allDates.indexOf(d)] || 0), 0);
    const wdTotal = rs.overall.total - weTotal;
    const wdAvg = (allDates.length - weDays.length) > 0 ? wdTotal / (allDates.length - weDays.length) : 0;
    const weAvg = weDays.length > 0 ? weTotal / weDays.length : 0;
    if (wdAvg > 5 && weAvg < wdAvg * 0.15) {
      score -= 8; factors.push({ icon: '📅', label: 'Activité week-end quasi-nulle (risque contrôle sanitaire)', impact: -8, severity: 'high' });
    }
  }

  if (rs.overall.halfTrend < -0.4) { score -= 8; factors.push({ icon: '📉', label: `Tendance fortement baissière (${Math.round(rs.overall.halfTrend*100)}%)`, impact: -8, severity: 'high' }); }
  if (rs.overall.daysSince > 7) { score -= 10; factors.push({ icon: '🔇', label: `Inactivité récente : ${rs.overall.daysSince} jours sans action`, impact: -10, severity: 'critical' }); }

  // Bonuses
  if (rs.missingCritical.length === 0 && rs.overall.coverage > 0.75) {
    score += 8; factors.push({ icon: '✅', label: 'Tous modules critiques actifs + couverture >75%', impact: 8, severity: 'bonus' });
  }
  if (rs.activeModules >= 6) {
    score += 5; factors.push({ icon: '🌟', label: `Adoption modules excellente (${rs.activeModules}/8)`, impact: 5, severity: 'bonus' });
  }
  if (rs.overall.halfTrend > 0.2) {
    score += 4; factors.push({ icon: '📈', label: `Progression significative (+${Math.round(rs.overall.halfTrend*100)}%)`, impact: 4, severity: 'bonus' });
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const level = score >= 90 ? 'champion' : score >= 75 ? 'conforme' : score >= 60 ? 'vigilance' : score >= 45 ? 'atrisk' : 'critique';
  const LEVELS = { champion: { label: 'Champion', color: '#22c55e', bg: '#f0fdf4' }, conforme: { label: 'Conforme', color: '#14b8a6', bg: '#f0fdfa' }, vigilance: { label: 'Vigilance', color: '#f59e0b', bg: '#fffbeb' }, atrisk: { label: 'À risque', color: '#f97316', bg: '#fff7ed' }, critique: { label: 'Critique', color: '#ef4444', bg: '#fef2f2' } };
  return { score, level, ...LEVELS[level], factors };
}

// ── Quality Maturity Model (1-5) ──────────────────────────────────────────────
function maturityLevel(rs) {
  const { activeModules, overall, missingCritical } = rs;
  const MATRIX = [
    { level: 1, label: 'Initiating',      color: '#ef4444', icon: '①', desc: 'Aucune utilisation ou usage isolé — traçabilité non établie.' },
    { level: 2, label: 'En développement',color: '#f97316', icon: '②', desc: 'Utilisation partielle, irrégulière — les habitudes restent à construire.' },
    { level: 3, label: 'Défini',           color: '#f59e0b', icon: '③', desc: 'Processus documentés et utilisés, quelques modules critiques manquants.' },
    { level: 4, label: 'Maîtrisé',         color: '#14b8a6', icon: '④', desc: 'Usage régulier et structuré sur tous les modules clés.' },
    { level: 5, label: 'Excellence',       color: '#22c55e', icon: '⑤', desc: 'Performance optimale — modèle à dupliquer dans le groupe.' },
  ];
  if (overall.total === 0) return MATRIX[0];
  if (activeModules <= 2 || overall.coverage < 0.25) return MATRIX[1];
  if (activeModules <= 4 || missingCritical.length > 1 || overall.coverage < 0.45) return MATRIX[2];
  if (missingCritical.length === 0 && activeModules >= 5 && overall.coverage >= 0.6 && overall.cv < 0.9) return MATRIX[3];
  if (missingCritical.length === 0 && activeModules >= 7 && overall.coverage >= 0.75 && overall.halfTrend > -0.1) return MATRIX[4];
  return MATRIX[2];
}

// ── Regulatory Exposure (0-100) ───────────────────────────────────────────────
function regulatoryExposure(rs, rAnomalies) {
  let risk = 0;
  risk += rs.missingCritical.length * 22;
  const fridge = rs.modules['Températures frigos'];
  const fridgePct = fridge ? fridge.coverage * 100 : 0;
  if (!fridge || fridge.total === 0) risk += 30;
  else if (fridgePct < 30) risk += 30;
  else if (fridgePct < 60) risk += 18;
  else if (fridgePct < 80) risk += 8;
  const recep = rs.modules['Réceptions'];
  if (!recep || recep.total === 0) risk += 20;
  risk += rAnomalies.filter(a => a.type === 'cramming').length * 12;
  risk += rAnomalies.filter(a => a.type === 'gap').length * 8;
  if (rs.overall.coverage < 0.3) risk += 15;
  if (rs.overall.daysSince > 7) risk += 20;
  risk = Math.min(100, Math.round(risk));
  const level = risk >= 65 ? 'critique' : risk >= 40 ? 'elevee' : risk >= 20 ? 'moderee' : 'faible';
  const MAP = { critique: { label: 'Critique', color: '#ef4444' }, elevee: { label: 'Élevée', color: '#f97316' }, moderee: { label: 'Modérée', color: '#f59e0b' }, faible: { label: 'Faible', color: '#22c55e' } };
  return { risk, level, ...MAP[level] };
}

// ── Behavioral Profile ────────────────────────────────────────────────────────
const PROFILES = {
  champion:    { label: 'Champion',        icon: '🌟', color: '#22c55e', desc: 'Référence du groupe — excellence opérationnelle.' },
  progressive: { label: 'En progression',  icon: '📈', color: '#1e88e5', desc: 'Dynamique positive — continuer l\'accompagnement.' },
  declining:   { label: 'En déclin',       icon: '📉', color: '#ef4444', desc: 'Tendance baissière — intervention prioritaire.' },
  burst:       { label: 'Usage en rafale', icon: '⚡', color: '#f59e0b', desc: 'Saisies concentrées — risque de backdating.' },
  specialized: { label: 'Spécialisé',      icon: '🎯', color: '#8e24aa', desc: 'Modules partiellement adoptés — accompagnement nécessaire.' },
  regular:     { label: 'Régulier',        icon: '✓',  color: '#14b8a6', desc: 'Usage stable conforme aux attentes.' },
  atrisk:      { label: 'À risque',        icon: '⚠️', color: '#f97316', desc: 'Conformité insuffisante — plan de redressement requis.' },
  inactive:    { label: 'Inactif',         icon: '💤', color: '#9e9e9e', desc: 'Aucune activité — urgence absolue.' },
};
function assignProfile(r, avgTotal) {
  const { overall: o, activeModules: am, missingCritical: mc } = r;
  if (o.total === 0) return 'inactive';
  if (mc.length >= 2 || o.coverage < 0.2) return 'atrisk';
  if (o.halfTrend < -0.4 && o.total > 5) return 'declining';
  if (o.peakRatio > 4 && o.coverage < 0.4) return 'burst';
  if (am <= 2) return 'specialized';
  if (o.halfTrend > 0.3 && o.coverage > 0.4) return 'progressive';
  if (o.coverage >= 0.7 && o.halfTrend >= -0.05 && o.total >= avgTotal * 0.85 && am >= 4) return 'champion';
  return 'regular';
}

// ── Anomaly Detection ─────────────────────────────────────────────────────────
function detectAnomalies(restaurantStats, allDates) {
  const anomalies = [];
  const n = allDates.length;
  for (const [rid, rs] of Object.entries(restaurantStats)) {
    for (const [mod, ms] of Object.entries(rs.modules)) {
      const isCrit = CRITICAL.includes(mod);

      // ① Module critique JAMAIS utilisé sur toute la période → CRITIQUE absolu
      if (isCrit && ms.total === 0 && n >= 5) {
        anomalies.push({ rid, restaurant: rs.name, module: mod, type: 'absent',
          severity: 'critical', icon: '🚫',
          title: `"${mod}" jamais enregistré — ${n} jours`,
          desc: `${rs.name} : aucun enregistrement du module "${mod}" sur l'ensemble de la période. Non-conformité HACCP avérée — risque maximal lors d'un contrôle DDPP/DGAL.`,
          metric: `0 / ${n}j`, action: `Activer le module "${mod}" et former l'équipe immédiatement. Ce module est un Point de Contrôle Critique obligatoire.` });
        continue; // pas d'autre alerte sur ce module
      }

      // ② Module critique avec couverture < 30% (fridge = relevé quasi absent)
      if (isCrit && ms.metric === 'pct' && ms.coverage < 0.3 && ms.total > 0) {
        anomalies.push({ rid, restaurant: rs.name, module: mod, type: 'low_coverage',
          severity: 'critical', icon: '📉',
          title: `Couverture critique "${mod}" — ${Math.round(ms.coverage*100)}%`,
          desc: `Seulement ${Math.round(ms.coverage*100)}% des jours couverts pour "${mod}" chez ${rs.name}. Réglementation exige un suivi quotidien minimum.`,
          metric: `${Math.round(ms.coverage*100)}% / 100%`, action: 'Vérifier que les équipes saisissent les relevés chaque jour. Paramétrer des rappels dans l\'app.' });
      }

      // ③ Interruption > 3j consécutifs sur module critique (avec données existantes)
      if (isCrit && ms.maxGap >= 3 && ms.total > 0)
        anomalies.push({ rid, restaurant: rs.name, module: mod, type: 'gap',
          severity: ms.maxGap >= 5 ? 'critical' : 'high', icon: '🕳',
          title: `Interruption ${ms.maxGap}j — ${mod}`,
          desc: `${rs.name} : ${ms.maxGap} jours consécutifs sans enregistrement sur ce module critique.`,
          metric: `${ms.maxGap} jours`, action: 'Vérifier l\'accès à l\'application et former l\'équipe à la saisie quotidienne.' });

      // ④ Silence récent (module utilisé avant, plus rien depuis 7j)
      if (isCrit && ms.daysSince >= 7 && ms.total > ms.values.slice(-7).reduce((a,b)=>a+b,0))
        anomalies.push({ rid, restaurant: rs.name, module: mod, type: 'silence',
          severity: 'critical', icon: '🔇',
          title: `Silence ${ms.daysSince}j — ${mod}`,
          desc: `Plus aucune activité "${mod}" depuis ${ms.daysSince} jours (module utilisé avant).`,
          metric: `${ms.daysSince} jours`, action: 'Contact immédiat du responsable d\'établissement requis.' });

      // ⑤ Saisie rétroactive (cramming)
      if (ms.crammingDay > 55 && ms.total > 8)
        anomalies.push({ rid, restaurant: rs.name, module: mod, type: 'cramming',
          severity: isCrit ? 'high' : 'medium', icon: '📦',
          title: `Saisie rétroactive — ${mod}`,
          desc: `${ms.crammingDay}% des actions "${mod}" concentrées sur une seule journée chez ${rs.name}. Possible saisie en différé non conforme.`,
          metric: `${ms.crammingDay}% en 1j`, action: 'Rappeler l\'obligation de saisie en temps réel. Risque de non-sincérité lors d\'un contrôle.' });

      // ⑥ Tendance fortement baissière
      if (isCrit && ms.halfTrend < -0.45 && ms.total > 8)
        anomalies.push({ rid, restaurant: rs.name, module: mod, type: 'decline',
          severity: 'high', icon: '📉',
          title: `Baisse ${Math.abs(Math.round(ms.halfTrend*100))}% — ${mod}`,
          desc: `Activité "${mod}" en chute de ${Math.abs(Math.round(ms.halfTrend*100))}% chez ${rs.name} (1ère vs 2ème moitié de période).`,
          metric: `-${Math.abs(Math.round(ms.halfTrend*100))}%`, action: 'Analyser les causes : turnover, matériel défaillant, démotivation ?' });

      // ⑦ Module non critique jamais utilisé (medium)
      if (!isCrit && ms.total === 0 && n >= 14)
        anomalies.push({ rid, restaurant: rs.name, module: mod, type: 'absent',
          severity: 'medium', icon: '⭕',
          title: `"${mod}" non activé`,
          desc: `${rs.name} n'utilise pas le module "${mod}" — adoption incomplète du dispositif Octopus.`,
          metric: `0 / ${n}j`, action: 'Présenter les bénéfices de ce module lors du prochain point client.' });
    }

    // ⑧ Week-end sans activité
    const weDays = allDates.filter(d => [0,6].includes(new Date(d).getDay()));
    if (weDays.length >= 4 && rs.overall.total > 15) {
      const weTotal = weDays.reduce((s,d)=>s+(rs.totalVals[allDates.indexOf(d)]||0),0);
      const wdTotal = rs.overall.total - weTotal;
      const wdAvg = (allDates.length-weDays.length)>0 ? wdTotal/(allDates.length-weDays.length) : 0;
      const weAvg = weDays.length>0 ? weTotal/weDays.length : 0;
      if (wdAvg > 5 && weAvg < wdAvg * 0.25)
        anomalies.push({ rid, restaurant: rs.name, module: null, type: 'weekend',
          severity: weAvg === 0 ? 'high' : 'medium', icon: '📅',
          title: `Activité week-end ${weAvg===0?'nulle':'insuffisante'}`,
          desc: `${rs.name} : ${weAvg===0?'aucune':'seulement '+Math.round(weAvg)+' actions/j en'} activité le samedi/dimanche (vs ${Math.round(wdAvg)}/j en semaine). HACCP s'applique 7j/7.`,
          metric: weAvg===0 ? '0 W-E' : `-${Math.round((1-weAvg/wdAvg)*100)}% W-E`,
          action: 'Rappeler les obligations HACCP 7j/7 aux équipes. Vérifier les plannings week-end.' });
    }
  }
  // Synchronized dip
  const dayTots = {};
  for (const rs of Object.values(restaurantStats)) {
    allDates.forEach((d,i)=>{ const v=rs.totalVals[i]||0; if(!dayTots[d])dayTots[d]=[]; dayTots[d].push(v); });
  }
  const nR = Object.keys(restaurantStats).length;
  for (const [d, tots] of Object.entries(dayTots)) {
    if (tots.length < nR) continue;
    const zeros = tots.filter(v=>v===0).length;
    if (zeros >= Math.max(nR-1,2))
      anomalies.push({ rid: null, restaurant: 'Tous les établissements', module: null, type: 'group_dip', severity: 'medium', icon: '🌐', title: `Baisse synchronisée — ${d.split('-').reverse().join('/')}`, desc: `${zeros}/${nR} établissements sans activité le même jour — problème systémique possible.`, metric: `${zeros}/${nR} inactifs`, action: 'Vérifier les accès applicatifs / incidents serveur ce jour. Signaler à l\'éditeur si récurrent.' });
  }
  const order = { critical:0, high:1, medium:2 };
  return anomalies.sort((a,b)=>(order[a.severity]??3)-(order[b.severity]??3));
}

// ── Action Plan Generator ─────────────────────────────────────────────────────
function generateActionPlan(restaurantStats, anomalies, groupScore) {
  const actions = [];
  let id = 1;
  for (const [rid, rs] of Object.entries(restaurantStats)) {
    for (const mod of rs.missingCritical) {
      actions.push({ id: id++, priority: 'P1', site: rs.name, type: 'activation', module: mod, title: `Activer le module "${mod}"`, description: `Le module "${mod}" est absent sur toute la période. C'est un module critique HACCP.`, impact: 'Mise en conformité réglementaire immédiate', effort: 'Faible', deadline: 'Cette semaine', owner: '', status: 'open', scoreImpact: '+15 pts' });
    }
    if (rs.overall.coverage < 0.4 && rs.overall.total > 0) {
      actions.push({ id: id++, priority: 'P1', site: rs.name, type: 'training', module: null, title: `Renforcer la régularité de saisie`, description: `Couverture de seulement ${Math.round(rs.overall.coverage*100)}% — les équipes ne saisissent pas quotidiennement.`, impact: 'Amélioration score conformité et crédibilité lors d\'un contrôle', effort: 'Moyen', deadline: '2 semaines', owner: '', status: 'open', scoreImpact: '+10 pts' });
    }
    const crammingAnom = anomalies.filter(a => a.rid==rid && a.type==='cramming');
    if (crammingAnom.length > 0) {
      actions.push({ id: id++, priority: 'P2', site: rs.name, type: 'process', module: crammingAnom[0].module, title: `Corriger les saisies rétroactives`, description: `Saisies concentrées détectées sur ${crammingAnom.length} module(s) — indique des saisies en différé non conformes.`, impact: 'Fiabilité des données et sécurité juridique en cas de contrôle', effort: 'Moyen', deadline: '1 mois', owner: '', status: 'open', scoreImpact: '+7 pts' });
    }
    const weekendAnom = anomalies.filter(a => a.rid==rid && a.type==='weekend');
    if (weekendAnom.length > 0) {
      actions.push({ id: id++, priority: 'P2', site: rs.name, type: 'coverage', module: null, title: `Assurer la continuité HACCP week-end`, description: `Activité quasi-nulle le samedi et dimanche — non-conformité réglementaire.`, impact: 'Conformité HACCP 7j/7 — prévention des sanctions', effort: 'Faible', deadline: '1 semaine', owner: '', status: 'open', scoreImpact: '+8 pts' });
    }
  }
  if (Object.values(restaurantStats).filter(r=>r.modules['Gestion déchets'].total===0).length >= 3) {
    actions.push({ id: id++, priority: 'P3', site: 'Groupe', type: 'activation', module: 'Gestion déchets', title: `Déployer le module Gestion déchets sur le groupe`, description: `Module non utilisé sur ${Object.values(restaurantStats).filter(r=>r.modules['Gestion déchets'].total===0).length} sites — opportunité d\'optimisation RSE et conformité.`, impact: 'Conformité RSE et réduction gaspillage alimentaire', effort: 'Moyen', deadline: '1 mois', owner: '', status: 'open', scoreImpact: '+5 pts' });
  }
  return actions.sort((a,b) => a.priority.localeCompare(b.priority));
}

// ── Narrative Generator ───────────────────────────────────────────────────────
function generateNarrative(data, period) {
  const { restaurantStats, groupScore, anomalies, actionPlan } = data;
  const rList = Object.values(restaurantStats).sort((a,b)=>b.complianceScore.score-a.complianceScore.score);
  const n = rList.length;
  const totalActions = rList.reduce((s,r)=>s+r.overall.total,0);
  const leader = rList[0], laggard = rList[n-1];
  const critAnom = anomalies.filter(a=>a.severity==='critical').length;
  const highAnom = anomalies.filter(a=>a.severity==='high').length;
  const p1Actions = actionPlan.filter(a=>a.priority==='P1').length;
  const missingGlobal = [...new Set(rList.flatMap(r=>r.missingCritical))];
  const progCount = rList.filter(r=>r.overall.halfTrend>0.1).length;
  const declCount = rList.filter(r=>r.overall.halfTrend<-0.2).length;
  const g = groupScore;

  // Module-specific metrics for narrative
  const avgFridgePct = rList.length > 0
    ? Math.round(rList.reduce((s,r) => s + (r.modules['Températures frigos'] ? r.modules['Températures frigos'].coverage * 100 : 0), 0) / rList.length)
    : 0;
  const totalReceptions = rList.reduce((s,r) => s + (r.modules['Réceptions'] ? r.modules['Réceptions'].total : 0), 0);
  const avgNettoyagePct = rList.length > 0
    ? Math.round(rList.reduce((s,r) => s + (r.modules['Plans de nettoyage'] ? r.modules['Plans de nettoyage'].coverage * 100 : 0), 0) / rList.length)
    : 0;

  const scoreLabel = g >= 85 ? 'excellente' : g >= 70 ? 'satisfaisante avec des axes d\'amélioration' : g >= 55 ? 'préoccupante — plan de redressement recommandé' : 'critique — intervention immédiate nécessaire';
  const scoreVerdict = g >= 85 ? '✅ Le groupe est en bonne santé qualité.' : g >= 70 ? '🟡 La situation est maîtrisée mais nécessite de la vigilance.' : g >= 55 ? '🟠 La conformité du groupe est insuffisante.' : '🔴 Le groupe présente un risque réglementaire élevé.';

  const lines = [
    `**Synthèse de la période ${fmtPeriod(period.allDates)}**\n`,
    `Le groupe enregistre **${totalActions.toLocaleString('fr')} actions de traçabilité** sur ${n} établissements actifs. ${scoreVerdict}\n`,
    `**Score de conformité groupe : ${g}/100** — Situation ${scoreLabel}.`,
    `🌡️ **Températures frigos :** ${avgFridgePct}% de couverture des relevés température (régl. ≤4°C, 2 relevés/jour min.).`,
    `🧹 **Plans de nettoyage :** ${avgNettoyagePct}% de couverture PND (Règl. CE 852/2004).`,
    `📦 **Réceptions :** ${totalReceptions.toLocaleString('fr')} contrôles à réception (PCC) enregistrés sur la période.`,
    progCount > 0 ? `${progCount} établissement${progCount>1?'s':''} en progression témoigne${progCount>1?'nt':''} d'une dynamique positive.` : null,
    declCount > 0 ? `**⚠️ ${declCount} établissement${declCount>1?'s':''} en déclin** — intervention prioritaire requise.` : null,
    `\n**📌 Points d'attention critiques :**`,
    critAnom + highAnom > 0 ? `${critAnom} anomalie${critAnom>1?'s':''} critique${critAnom>1?'s':''} et ${highAnom} importante${highAnom>1?'s':''} ont été détectées automatiquement.` : '✅ Aucune anomalie critique détectée sur la période.',
    missingGlobal.length > 0 ? `Le module **"${missingGlobal[0]}"** est absent sur ${rList.filter(r=>r.missingCritical.includes(missingGlobal[0])).length}/${n} établissements — exposition réglementaire directe.` : null,
    `\n**🏆 Référence groupe :** ${leader.name} — ${leader.complianceScore.score}/100 (${leader.complianceScore.label}) · ${leader.overall.total.toLocaleString('fr')} actions · Maturité niveau ${leader.maturity.level}.`,
    rList.length > 1 ? `**⚡ À accompagner en priorité :** ${laggard.name} — ${laggard.complianceScore.score}/100 (${laggard.complianceScore.label}) · Exposition réglementaire ${laggard.regulatoryExposure.label}.` : null,
    `\n**📋 Plan d'action :** ${actionPlan.length} actions identifiées dont ${p1Actions} priorité P1 (cette semaine).`,
    `\n**Objectif recommandé :** Atteindre un score groupe de ${Math.min(100, g+10)}/100 à fin de période prochaine via l'activation des modules critiques manquants et la correction des irrégularités de saisie.`,
  ];
  return lines.filter(Boolean).join('\n');
}

// ── /api/deep ─────────────────────────────────────────────────────────────────
app.get('/api/deep', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const allDates = datesInRange(start_date, end_date);
    const n = allDates.length;
    const dateIdx = Object.fromEntries(allDates.map((d,i)=>[d,i]));

    const [restaurants, ...moduleItems] = await Promise.all([
      apiGet('restaurants'),
      ...MODULE_NAMES.map(m => fetchAll(MODULE_CONFIG[m].endpoint, { start_date, end_date })),
    ]);
    const rList = restaurants.data || (Array.isArray(restaurants) ? restaurants : []);

    // Build per-restaurant per-module daily arrays
    const raw = {};
    for (const r of rList) { raw[r.id] = {}; for (const m of MODULE_NAMES) raw[r.id][m] = new Array(n).fill(0); }
    MODULE_NAMES.forEach((mod, mi) => {
      for (const item of moduleItems[mi]) {
        const rid = item.restaurant_id;
        if (rid === undefined || !raw[rid]) continue;
        const d = parseDate(item);
        if (d && dateIdx[d] !== undefined) raw[rid][mod][dateIdx[d]]++;
      }
    });

    const restaurantStats = {};
    for (const r of rList) {
      const modules = {};
      for (const mod of MODULE_NAMES) {
        const modStat = stats(raw[r.id][mod]);
        modStat.metric = MODULE_CONFIG[mod].metric;
        modStat.displayValue = MODULE_CONFIG[mod].metric === 'pct'
          ? Math.round(modStat.coverage * 100)
          : modStat.total;
        modStat.displayUnit = MODULE_CONFIG[mod].unit;
        modStat.icon = MODULE_CONFIG[mod].icon;
        modStat.desc = MODULE_CONFIG[mod].desc;
        modules[mod] = modStat;
      }
      const totalVals = new Array(n).fill(0);
      for (const mod of MODULE_NAMES) raw[r.id][mod].forEach((v,i)=>{ totalVals[i]+=v; });
      const overall = stats(totalVals);
      const activeModules = MODULE_NAMES.filter(m=>modules[m].total>0).length;
      const missingCritical = CRITICAL.filter(m=>modules[m].total===0);
      restaurantStats[r.id] = { id:r.id, name:r.name, modules, overall, totalVals, activeModules, missingCritical, peakRatio:overall.peakRatio };
    }

    const avgTotal = rList.length > 0 ? Object.values(restaurantStats).reduce((s,r)=>s+r.overall.total,0)/rList.length : 0;

    // Enrichment
    for (const rs of Object.values(restaurantStats)) {
      rs.profile = assignProfile(rs, avgTotal);
      rs.profileData = PROFILES[rs.profile];
    }

    const anomalies = detectAnomalies(restaurantStats, allDates);

    for (const rs of Object.values(restaurantStats)) {
      const rAnom = anomalies.filter(a=>a.rid==rs.id);
      rs.complianceScore = complianceScore(rs, allDates);
      rs.maturity = maturityLevel(rs);
      rs.regulatoryExposure = regulatoryExposure(rs, rAnom);
    }

    const scores = Object.values(restaurantStats).map(r=>r.complianceScore.score);
    const groupScore = scores.length > 0 ? Math.round(scores.reduce((a,b)=>a+b,0)/scores.length) : 0;
    const groupLevel = groupScore>=90?'champion':groupScore>=75?'conforme':groupScore>=60?'vigilance':groupScore>=45?'atrisk':'critique';
    const LEVEL_MAP = { champion:{label:'Champion',color:'#22c55e'}, conforme:{label:'Conforme',color:'#14b8a6'}, vigilance:{label:'Vigilance',color:'#f59e0b'}, atrisk:{label:'À risque',color:'#f97316'}, critique:{label:'Critique',color:'#ef4444'} };

    const moduleTotals = {};
    for (const mod of MODULE_NAMES) moduleTotals[mod] = Object.values(restaurantStats).reduce((s,r)=>s+r.modules[mod].total,0);
    const groupDailyTotals = new Array(n).fill(0);
    for (const rs of Object.values(restaurantStats)) rs.totalVals.forEach((v,i)=>{ groupDailyTotals[i]+=v; });

    const dowTot=new Array(7).fill(0), dowCnt=new Array(7).fill(0);
    allDates.forEach((d,i)=>{ const dow=new Date(d).getDay(); dowTot[dow]+=groupDailyTotals[i]; dowCnt[dow]++; });
    const dowAvgs=dowTot.map((t,i)=>dowCnt[i]>0?Math.round(t/dowCnt[i]):0);
    for (const rs of Object.values(restaurantStats)) {
      const dt=new Array(7).fill(0),dc=new Array(7).fill(0);
      allDates.forEach((d,i)=>{const dow=new Date(d).getDay();dt[dow]+=rs.totalVals[i];dc[dow]++;});
      rs.dowAvgs=dt.map((t,i)=>dc[i]>0?Math.round(t/dc[i]):0);
    }

    const actionPlan = generateActionPlan(restaurantStats, anomalies, groupScore);

    const data = { period:{start_date,end_date,allDates,n}, restaurants:rList, restaurantStats, moduleTotals, groupDailyTotals, dowAvgs, anomalies, groupScore, groupLevel, groupLevelData:LEVEL_MAP[groupLevel], avgTotal, profiles:PROFILES, actionPlan };
    data.narrative = generateNarrative(data, { allDates });

    const rArr = Object.values(restaurantStats);
    data.rankings = {
      byScore: rArr.sort((a,b)=>b.complianceScore.score-a.complianceScore.score).map(r=>r.id),
      byVolume: [...rArr].sort((a,b)=>b.overall.total-a.overall.total).map(r=>r.id),
      byMaturity: [...rArr].sort((a,b)=>b.maturity.level-a.maturity.level).map(r=>r.id),
      byTrend: [...rArr].sort((a,b)=>b.overall.halfTrend-a.overall.halfTrend).map(r=>r.id),
      byRisk: [...rArr].sort((a,b)=>b.regulatoryExposure.risk-a.regulatoryExposure.risk).map(r=>r.id),
    };

    res.json(data);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ── /api/geocode ──────────────────────────────────────────────────────────────
const geoCache = {};
// Deterministic fallback spread around Paris when geocoding fails
const PARIS_FALLBACKS = [
  [48.8738, 2.3026], [48.8766, 2.3099], [48.8695, 2.3208],
  [48.8820, 2.3317], [48.8648, 2.2945], [48.8710, 2.3580],
];

app.get('/api/geocode', async (req, res) => {
  try {
    const tok = await getToken();
    const rResp = await fetch(`${BASE_URL}/api/restaurants`, { headers: { token: tok } });
    const rData = await rResp.json();
    const rList = rData.data || (Array.isArray(rData) ? rData : []);

    const results = {};
    let fallbackIdx = 0;

    for (let i = 0; i < rList.length; i++) {
      const r = rList[i];

      // Cache hit
      if (geoCache[r.id]) { results[r.id] = geoCache[r.id]; continue; }

      // Try to get restaurant detail for address
      let searchQuery = null;
      try {
        const det = await (await fetch(`${BASE_URL}/api/restaurant/${r.id}`, { headers: { token: tok } })).json();
        const parts = [det.address, det.zip, det.city || det.ville].filter(Boolean);
        if (parts.length > 0) searchQuery = parts.join(' ') + ', France';
        else if (det.email) {
          // Infer from email domain hint if possible
        }
      } catch(e) {}

      if (!searchQuery) searchQuery = r.name + ', France';

      // Nominatim rate limit: 1 req/s
      if (i > 0) await new Promise(resolve => setTimeout(resolve, 1200));

      let geo = null;
      try {
        const gResp = await fetch(
          `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(searchQuery)}&format=json&limit=1&countrycodes=fr`,
          { headers: { 'User-Agent': 'OctopusHACCP-Analytics/1.0 (contact@octopus-haccp.com)' } }
        );
        const gData = await gResp.json();
        if (gData && gData[0]) {
          geo = { lat: parseFloat(gData[0].lat), lng: parseFloat(gData[0].lon), address: gData[0].display_name, fallback: false };
        }
      } catch(e) {}

      if (!geo) {
        const fb = PARIS_FALLBACKS[fallbackIdx % PARIS_FALLBACKS.length];
        geo = { lat: fb[0], lng: fb[1], address: r.name, fallback: true };
        fallbackIdx++;
      }

      geoCache[r.id] = geo;
      results[r.id] = geo;
    }

    res.json(results);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── /api/audit ────────────────────────────────────────────────────────────────
app.get('/api/audit', async (req, res) => {
  const report = { timestamp: new Date().toISOString(), auth: null, restaurants: null, modules: {}, crossValidation: {}, summary: { issues: [], warnings: [], ok: [] } };

  // 1. Auth
  try {
    const tok = await getToken();
    report.auth = { status: 'ok', tokenLength: tok.length };
    report.summary.ok.push('Authentification : token valide');
  } catch (e) {
    report.auth = { status: 'error', message: e.message };
    report.summary.issues.push('Authentification échouée : ' + e.message);
    return res.json(report);
  }

  // 2. Restaurants
  const rResp = await apiGet('restaurants');
  const rList = rResp.data || (Array.isArray(rResp) ? rResp : []);
  const knownRIds = new Set(rList.map(r => r.id));
  report.restaurants = { count: rList.length, ids: rList.map(r => r.id), hasIdField: rList.every(r => r.id !== undefined), fields: rList[0] ? Object.keys(rList[0]) : [], samples: rList.map(r => ({ id: r.id, name: r.name, email: r.email, code: r.code })) };
  if (rList.length === 0) report.summary.issues.push('Aucun restaurant retourné');
  else report.summary.ok.push(`${rList.length} restaurant(s) chargé(s) : ${rList.map(r=>r.name).join(', ')}`);

  // 3. Per-module tests
  const today = new Date(), t30 = new Date(); t30.setDate(today.getDate() - 30);
  const fmt = d => `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
  const startDate = fmt(t30), endDate = fmt(today);
  const DATE_FIELDS = ['created_at','date','realisation_date','start_date','updated_at','recorded_at'];

  for (const [modName, cfg] of Object.entries(MODULE_CONFIG)) {
    const mr = { endpoint: cfg.endpoint, metricType: cfg.metric, critical: cfg.critical, status: 'unknown', totalItems: 0, totalPages: 0, restaurantIdCoverage: 'N/A', orphaned: 0, unmatchedRIds: [], dateFieldsFound: [], allFields: [], perRestaurant: {}, issues: [], warnings: [] };
    try {
      const fp = await apiGet(cfg.endpoint, { start_date: startDate, end_date: endDate, page: 1, per_page: 50 });
      const items = fp.data || (Array.isArray(fp) ? fp : []);
      mr.status = 'ok';
      mr.totalItems = fp.total !== undefined ? fp.total : items.length;
      mr.totalPages = fp.last_page || 1;
      mr.firstPageItems = items.length;

      if (items.length > 0) {
        mr.allFields = Object.keys(items[0]);
        mr.sampleItem = items[0]; // First raw item for inspection

        // restaurant_id check
        const withRId = items.filter(i => i.restaurant_id !== undefined);
        mr.restaurantIdCoverage = `${Math.round(withRId.length / items.length * 100)}% (${withRId.length}/${items.length})`;
        mr.orphaned = items.length - withRId.length;
        if (mr.orphaned > 0) mr.issues.push(`${mr.orphaned} item(s) sans restaurant_id sur les 50 premiers`);

        // Unmatched restaurant IDs
        const uniqueRIds = [...new Set(withRId.map(i => i.restaurant_id))];
        mr.unmatchedRIds = uniqueRIds.filter(id => !knownRIds.has(id));
        if (mr.unmatchedRIds.length > 0) mr.warnings.push(`restaurant_id inconnus: [${mr.unmatchedRIds.join(',')}]`);

        // Matched restaurant IDs
        mr.matchedRIds = uniqueRIds.filter(id => knownRIds.has(id));

        // Date fields
        mr.dateFieldsFound = DATE_FIELDS.filter(f => items[0][f] !== undefined);
        if (mr.dateFieldsFound.length === 0) mr.warnings.push('Aucun champ date standard détecté dans les items');

        // Per-restaurant count (first page)
        for (const item of withRId) {
          const rid = item.restaurant_id;
          mr.perRestaurant[rid] = (mr.perRestaurant[rid] || 0) + 1;
        }

        // Check: are all known restaurants represented?
        const missingRIds = [...knownRIds].filter(id => !mr.perRestaurant[id]);
        if (missingRIds.length > 0 && mr.totalItems > 0) {
          const missingNames = missingRIds.map(id => rList.find(r=>r.id===id)?.name||id);
          mr.warnings.push(`Établissements absents de la 1ère page: ${missingNames.join(', ')}`);
        }

        // Pagination completeness
        if (mr.totalPages > 20) mr.warnings.push(`${mr.totalPages} pages — cap serveur: 20 → données potentiellement incomplètes`);

      } else if (mr.totalItems === 0) {
        if (cfg.critical) mr.issues.push('MODULE CRITIQUE — Aucune donnée sur 30 jours (module non utilisé ?)');
        else mr.warnings.push('Aucune donnée sur la période (module non activé)');
      }

      // Summary
      const issuesStr = mr.issues.length ? ` | ⚠ ${mr.issues.join(' · ')}` : '';
      const warnStr = mr.warnings.length ? ` | 💡 ${mr.warnings[0]}` : '';
      if (mr.issues.length > 0) report.summary.issues.push(`[${modName}] total=${mr.totalItems}, rId=${mr.restaurantIdCoverage}${issuesStr}`);
      else if (mr.warnings.length > 0) report.summary.warnings.push(`[${modName}] total=${mr.totalItems}, rId=${mr.restaurantIdCoverage}${warnStr}`);
      else report.summary.ok.push(`[${modName}] ✓ total=${mr.totalItems}, rId=${mr.restaurantIdCoverage}, dates=${mr.dateFieldsFound[0]||'N/A'}`);

    } catch (e) { mr.status = 'error'; mr.error = e.message; report.summary.issues.push(`[${modName}] ERREUR: ${e.message}`); }
    report.modules[modName] = mr;
  }

  // 4. Cross-validation: fetch full period totals for comparison
  const allDates = datesInRange(startDate, endDate);
  report.crossValidation = { period: `${startDate} → ${endDate}`, days: allDates.length, note: 'Comparaison total API déclaré vs pages calculées' };
  let totalDeclared = 0, totalPotentiallyMissed = 0;
  for (const [modName, mr] of Object.entries(report.modules)) {
    if (mr.status === 'ok') {
      totalDeclared += mr.totalItems;
      const fetchedPages = Math.min(mr.totalPages, 20);
      const missed = Math.max(0, mr.totalPages - 20) * 100;
      totalPotentiallyMissed += missed;
      report.crossValidation[modName] = { declared: mr.totalItems, pages: mr.totalPages, fetchedPages, estimatedMissed: missed };
    }
  }
  report.crossValidation.totalDeclaredAllModules = totalDeclared;
  report.crossValidation.totalPotentiallyMissed = totalPotentiallyMissed;
  if (totalPotentiallyMissed > 0) report.summary.warnings.push(`Pagination: ~${totalPotentiallyMissed} items potentiellement non chargés (>20 pages)`);
  else report.summary.ok.push(`Pagination: Toutes les données chargées (${totalDeclared} items total)`);

  // 5. Global score
  report.qualityScore = Math.max(0, 100 - report.summary.issues.length * 15 - report.summary.warnings.length * 5);
  res.json(report);
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Octopus Intelligence QD → http://localhost:${PORT}`));
}

module.exports = app;
