/**
 * AFCIA Backend — Automobile Fault Codes Interpreter App
 * Single-file Express + PostgreSQL API, built to match the AFCIA_App.html frontend.
 *
 * Endpoints (all versioned under /api/v1) map 1:1 to the fetch() calls already
 * sketched as TODOs in the frontend's <script> block:
 *   POST   /api/v1/auth/signup
 *   POST   /api/v1/auth/login
 *   GET    /api/v1/auth/me
 *   PATCH  /api/v1/auth/me
 *   GET    /api/v1/fault-codes/:code
 *   POST   /api/v1/fault-codes/image      (multipart "file")
 *   POST   /api/v1/fault-codes/file       (multipart "file")
 *   GET    /api/v1/vin/:vin
 *   GET    /api/v1/history
 *   DELETE /api/v1/history/:id
 *   GET    /api/v1/dashboard/stats
 *   POST   /api/v1/assistant
 *   POST   /api/v1/billing/checkout
 *   GET    /api/v1/billing/portal
 *   POST   /api/v1/billing/webhook        (raw body, Stripe signature verified)
 *
 * Deploy target: Render (Web Service) + Render Postgres. Auto-migrates and
 * auto-seeds on boot behind env flags so no shell access is required.
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

// Optional integrations — loaded defensively so the app still boots without them.
let cloudinary = null;
try {
  cloudinary = require('cloudinary').v2;
} catch (_) { /* not installed / not needed */ }

let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
}

let pdfParse = null;
try {
  pdfParse = require('pdf-parse');
} catch (_) { /* pdf export parsing disabled without it */ }

// ============================================================================
// CONFIG
// ============================================================================
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '30d';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '*').split(',').map(s => s.trim());

const PLAN_LIMITS = {
  free: 10,
  premium_monthly: Infinity,
  premium_yearly: Infinity,
  professional: Infinity
};

if (cloudinary && process.env.CLOUDINARY_CLOUD_NAME) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
}

// ============================================================================
// DATABASE
// ============================================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false }
});

async function migrate() {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'free',
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      interpretations_used INTEGER NOT NULL DEFAULT 0,
      usage_reset_at TIMESTAMPTZ NOT NULL DEFAULT (date_trunc('month', now()) + interval '1 month'),
      locale TEXT NOT NULL DEFAULT 'en',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS fault_code_cache (
      code TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      explain TEXT NOT NULL,
      severity INTEGER NOT NULL,
      sev_label TEXT NOT NULL,
      causes JSONB NOT NULL,
      symptoms JSONB NOT NULL,
      steps JSONB NOT NULL,
      safety TEXT NOT NULL,
      cost_parts TEXT NOT NULL,
      cost_labor TEXT NOT NULL,
      cost_total TEXT NOT NULL,
      location TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'ai',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS interpretations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      title TEXT NOT NULL,
      severity INTEGER NOT NULL,
      sev_label TEXT NOT NULL,
      result JSONB NOT NULL,
      input_source TEXT NOT NULL DEFAULT 'code',
      vin TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_interpretations_user ON interpretations(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS vin_lookups (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      vin TEXT NOT NULL,
      result JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_vin_lookups_user ON vin_lookups(user_id);

    CREATE TABLE IF NOT EXISTS assistant_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      code TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log('[migrate] schema is up to date');
}

// A small seed set of the most commonly scanned OBD-II codes so the app responds
// instantly (no AI round-trip / no AI cost) for the codes people hit most. Anything
// not in this table falls through to the AI generator and gets cached after first use.
const SEED_CODES = [
  {
    code: 'P0301', title: 'Cylinder 1 Misfire Detected',
    explain: 'The engine control module has detected combustion is not occurring properly in cylinder 1, either intermittently or continuously.',
    severity: 68, sevLabel: 'Moderate–High',
    causes: ['Worn or fouled spark plug on cylinder 1', 'Failing ignition coil', 'Clogged or leaking fuel injector', 'Low compression (worn piston rings or valve)', 'Vacuum leak near cylinder 1'],
    symptoms: ['Rough idle or engine shake', 'Noticeable power loss on acceleration', 'Check engine light flashing under load', 'Reduced fuel economy', 'If ignored: risk of catalytic converter damage from unburnt fuel'],
    steps: [
      ['Confirm the misfire', 'Read live misfire counters with a scan tool to confirm cylinder 1 specifically.'],
      ['Inspect ignition components', 'Remove and inspect the spark plug and coil on cylinder 1 for wear, fouling, or damage.'],
      ['Swap and retest', 'Swap the coil with another cylinder — if the misfire follows, the coil is faulty.'],
      ['Check fuel delivery', 'Test injector resistance and spray pattern if plug/coil are healthy.'],
      ['Compression test', 'If electrical and fuel checks pass, run a compression test to rule out mechanical wear.']
    ],
    safety: 'A sustained misfire can send unburnt fuel into the exhaust and damage the catalytic converter. Avoid prolonged high-RPM driving until resolved.',
    costParts: '$25 – $180', costLabor: '$60 – $150', costTotal: '$85 – $330',
    location: 'engine'
  },
  {
    code: 'P0420', title: 'Catalyst System Efficiency Below Threshold (Bank 1)',
    explain: 'The upstream and downstream oxygen sensors indicate the catalytic converter on Bank 1 is not converting exhaust gases as efficiently as it should.',
    severity: 55, sevLabel: 'Moderate',
    causes: ['Aging or failing catalytic converter', 'Failing upstream or downstream O2 sensor', 'Exhaust leak before the converter', 'Engine running rich or lean, damaging the catalyst over time'],
    symptoms: ['Check engine light, usually no drivability change at first', 'Possible failed emissions test', 'Slightly reduced fuel economy', 'Sulfur ("rotten egg") smell in severe cases'],
    steps: [
      ['Rule out sensors first', 'Test upstream and downstream O2 sensor voltage patterns before condemning the converter.'],
      ['Inspect for exhaust leaks', 'Check the exhaust manifold and piping ahead of the converter for leaks that skew readings.'],
      ['Check for underlying rich/lean conditions', 'A misfire or leaking injector upstream will kill a converter again if not fixed first.'],
      ['Replace the converter if confirmed', 'Replace with an OEM-spec catalytic converter once sensors and fuel trims check out.']
    ],
    safety: 'Not an immediate safety issue, but continuing to drive with a failed converter can trigger repeat failures and emissions test failures.',
    costParts: '$180 – $1200', costLabor: '$80 – $200', costTotal: '$260 – $1400',
    location: 'sensor'
  },
  {
    code: 'P0171', title: 'System Too Lean (Bank 1)',
    explain: 'The engine control module has detected more oxygen than expected in the exhaust, meaning the air-fuel mixture on Bank 1 is running leaner than it should.',
    severity: 48, sevLabel: 'Moderate',
    causes: ['Vacuum leak (hose, intake gasket, PCV)', 'Dirty or failing mass airflow (MAF) sensor', 'Weak fuel pump or clogged fuel filter', 'Leaking or undersized fuel injectors', 'Failing oxygen sensor'],
    symptoms: ['Rough or high idle', 'Hesitation on acceleration', 'Check engine light', 'Possible slight fuel smell absence (lean, not rich)'],
    steps: [
      ['Check for vacuum leaks', 'Use a smoke test or carefully listen/spray around intake gaskets and hoses.'],
      ['Clean or test the MAF sensor', 'A dirty MAF under-reports airflow, causing a false lean condition.'],
      ['Check fuel trims', 'Long-term fuel trim above +10% confirms a lean condition needing correction.'],
      ['Inspect fuel delivery', 'Verify fuel pressure meets spec if vacuum and MAF check out.']
    ],
    safety: 'A persistent lean condition run hot for a long time can damage pistons and valves. Get it checked within a week of the light coming on.',
    costParts: '$15 – $250', costLabor: '$60 – $180', costTotal: '$75 – $430',
    location: 'engine'
  },
  {
    code: 'P0300', title: 'Random / Multiple Cylinder Misfire Detected',
    explain: 'The engine control module has detected misfires occurring across multiple cylinders rather than one specific cylinder, pointing to a system-wide cause.',
    severity: 74, sevLabel: 'High',
    causes: ['Worn spark plugs across multiple cylinders', 'Vacuum leak affecting the whole intake', 'Low fuel pressure', 'Faulty crankshaft or camshaft position sensor', 'Bad batch of fuel or contaminated fuel'],
    symptoms: ['Noticeable rough running at idle and under load', 'Check engine light flashing (active misfire)', 'Possible stalling', 'If ignored: catalytic converter damage is likely, not just possible'],
    steps: [
      ['Pull misfire data per cylinder', 'A random/multiple pattern across all cylinders points to a shared system, not one part.'],
      ['Check spark plugs across the board', 'Worn plugs at high mileage are the most common shared cause.'],
      ['Test fuel pressure', 'Low system-wide fuel pressure will cause misfires on every cylinder under load.'],
      ['Inspect position sensors', 'A failing crank or cam sensor causes intermittent, engine-wide misfire patterns.'],
      ['Check for a large vacuum leak', 'A leak at a shared intake gasket or hose affects all cylinders at once.']
    ],
    safety: 'If the check engine light is flashing (not solid), reduce speed and load immediately — a flashing light means active misfire that can destroy the catalytic converter within minutes.',
    costParts: '$40 – $300', costLabor: '$90 – $220', costTotal: '$130 – $520',
    location: 'engine'
  },
  {
    code: 'P0455', title: 'Evaporative Emission System Leak Detected (Large Leak)',
    explain: 'The evaporative emissions (EVAP) system, which captures fuel vapor from the tank, has a large leak — most often something as simple as a loose gas cap.',
    severity: 20, sevLabel: 'Low',
    causes: ['Loose, missing, or damaged gas cap', 'Cracked EVAP hose or purge valve', 'Failed purge or vent solenoid', 'Cracked charcoal canister'],
    symptoms: ['Check engine light only — no drivability impact', 'Faint fuel odor near the fuel filler in some cases', 'Failed emissions/smog test'],
    steps: [
      ['Check the gas cap first', 'Ensure it is tightened until it clicks and inspect the seal for cracks — this fixes the majority of P0455 cases.'],
      ['Clear the code and drive', 'Clear the code and complete a few drive cycles; a loose cap often self-resolves.'],
      ['Smoke test the EVAP system', 'If the light returns, a smoke machine will reveal the exact leak location.'],
      ['Replace the faulty component', 'Replace the specific hose, valve, or canister identified by the smoke test.']
    ],
    safety: 'No safety risk. Purely an emissions system fault — safe to keep driving while you arrange a fix.',
    costParts: '$5 – $150', costLabor: '$0 – $120', costTotal: '$5 – $270',
    location: 'wiring'
  },
  {
    code: 'C0035', title: 'Left Front Wheel Speed Sensor Circuit Malfunction',
    explain: 'The ABS/traction control module has lost or detected an invalid signal from the left front wheel speed sensor.',
    severity: 58, sevLabel: 'Moderate',
    causes: ['Damaged or dirty wheel speed sensor', 'Damaged tone ring / reluctor ring', 'Corroded or damaged sensor wiring/connector', 'Wheel bearing failure affecting sensor air gap'],
    symptoms: ['ABS and/or traction control warning light on', 'ABS may be disabled until resolved', 'Possible speedometer irregularities on some vehicles'],
    steps: [
      ['Inspect the sensor and wiring', 'Check the left front sensor and connector for corrosion, damage, or debris on the tone ring.'],
      ['Check wheel bearing play', 'Excess bearing play changes the sensor air gap and can trigger this code.'],
      ['Test sensor resistance/signal', 'Compare readings against the right front sensor to confirm which side is faulty.'],
      ['Replace sensor or bearing as needed', 'Replace the sensor itself, or the wheel bearing/hub assembly if that is the root cause.']
    ],
    safety: 'ABS may be partially or fully disabled with this code active. Drive cautiously in wet or slippery conditions and get this addressed promptly.',
    costParts: '$40 – $220', costLabor: '$60 – $160', costTotal: '$100 – $380',
    location: 'wiring'
  }
];

async function seed() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM fault_code_cache');
  if (rows[0].n > 0) {
    console.log('[seed] fault_code_cache already populated, skipping');
    return;
  }
  for (const c of SEED_CODES) {
    await pool.query(
      `INSERT INTO fault_code_cache
        (code, title, explain, severity, sev_label, causes, symptoms, steps, safety, cost_parts, cost_labor, cost_total, location, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'seed')
       ON CONFLICT (code) DO NOTHING`,
      [c.code, c.title, c.explain, c.severity, c.sevLabel, JSON.stringify(c.causes), JSON.stringify(c.symptoms),
       JSON.stringify(c.steps), c.safety, c.costParts, c.costLabor, c.costTotal, c.location]
    );
  }
  console.log(`[seed] inserted ${SEED_CODES.length} common fault codes`);
}

// ============================================================================
// AI (Anthropic) — fault-code generation, screenshot/export code extraction, assistant chat
// ============================================================================
async function callClaude({ system, messages, maxTokens = 1400 }) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured on the server');
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      system,
      messages
    })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Anthropic API error ${res.status}: ${text}`);
  }
  const data = await res.json();
  return (data.content || []).map(b => b.text || '').join('\n').trim();
}

function extractJson(text) {
  // Strip markdown fences if the model wraps its JSON despite instructions.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in AI response');
  return JSON.parse(raw.slice(start, end + 1));
}

const INTERPRETER_SYSTEM_PROMPT = `You are the diagnostic engine behind AFCIA, an automobile fault code interpreter.
Given a single OBD-II / manufacturer fault code, respond with ONLY a JSON object (no prose, no markdown fences) with this exact shape:
{
  "title": "short human title for the fault",
  "explain": "2-3 sentence plain-language explanation of what the code means",
  "severity": <integer 0-100, how urgent/serious this is>,
  "sevLabel": "Low" | "Moderate" | "Moderate–High" | "High" | "Critical",
  "causes": ["3-6 likely causes, most common first"],
  "symptoms": ["3-6 symptoms/consequences a driver would notice, including what happens if ignored"],
  "steps": [["step title", "1-2 sentence detail"], ... 3-6 diagnostic/repair steps in order],
  "safety": "1-2 sentence safety note — is it safe to keep driving, what to watch for",
  "cost": {"parts": "$low – $high", "labor": "$low – $high", "total": "$low – $high"},
  "location": "engine" | "transmission" | "sensor" | "wiring"
}
Use realistic 2026 US aftermarket-parts pricing for cost estimates. Pick the single "location" value that best represents where the fault physically lives on the vehicle. If the code is not a real/recognized fault code, still respond in this exact shape, explaining that the code is unrecognized in the "explain" field and set severity to 0.`;

async function interpretCode(code) {
  const cached = await pool.query('SELECT * FROM fault_code_cache WHERE code = $1', [code]);
  if (cached.rows.length) {
    const r = cached.rows[0];
    return {
      title: r.title, explain: r.explain, severity: r.severity, sevLabel: r.sev_label,
      causes: r.causes, symptoms: r.symptoms, steps: r.steps, safety: r.safety,
      cost: { parts: r.cost_parts, labor: r.cost_labor, total: r.cost_total },
      location: r.location
    };
  }

  const text = await callClaude({
    system: INTERPRETER_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `Interpret fault code: ${code}` }]
  });
  const data = extractJson(text);

  await pool.query(
    `INSERT INTO fault_code_cache
      (code, title, explain, severity, sev_label, causes, symptoms, steps, safety, cost_parts, cost_labor, cost_total, location, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'ai')
     ON CONFLICT (code) DO NOTHING`,
    [code, data.title, data.explain, data.severity, data.sevLabel, JSON.stringify(data.causes),
     JSON.stringify(data.symptoms), JSON.stringify(data.steps), data.safety,
     data.cost.parts, data.cost.labor, data.cost.total, data.location]
  );

  return data;
}

const CODE_PATTERN = /\b[PBCU]0?[0-9A-F]{3,4}\b/gi;

function extractCodesFromText(text) {
  const found = new Set();
  for (const m of (text.match(CODE_PATTERN) || [])) {
    let code = m.toUpperCase();
    if (/^[PBCU][0-9A-F]{4}$/.test(code)) found.add(code);
  }
  return [...found];
}

async function extractCodesFromImage(buffer, mimeType) {
  const text = await callClaude({
    system: 'You extract OBD-II / manufacturer diagnostic fault codes visible in a scan-tool screenshot. Respond with ONLY a JSON object: {"codes": ["P0301", ...]}. If no codes are visible, return {"codes": []}.',
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') } },
        { type: 'text', text: 'Extract every fault code visible in this scanner screenshot.' }
      ]
    }],
    maxTokens: 500
  });
  const data = extractJson(text);
  return Array.isArray(data.codes) ? data.codes.map(c => c.toUpperCase()) : [];
}

// ============================================================================
// APP + MIDDLEWARE
// ============================================================================
const app = express();
app.set('trust proxy', 1);

// Stripe webhook needs the raw body — register it BEFORE express.json().
app.post('/api/v1/billing/webhook', express.raw({ type: 'application/json' }), billingWebhookHandler);

app.use(cors({ origin: CORS_ORIGIN.includes('*') ? true : CORS_ORIGIN, credentials: true }));
app.use(express.json({ limit: '2mb' }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
app.use('/api/', apiLimiter);

function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    const payload = jwt.verify(token, JWT_SECRET);
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [payload.sub]);
    if (!rows.length) return res.status(401).json({ error: 'Not authenticated' });
    req.user = rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

async function optionalAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) { req.user = null; return next(); }
    const payload = jwt.verify(token, JWT_SECRET);
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [payload.sub]);
    req.user = rows[0] || null;
  } catch (_) {
    req.user = null;
  }
  next();
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

async function ensureUsageWindow(user) {
  if (new Date(user.usage_reset_at) <= new Date()) {
    await pool.query(
      `UPDATE users SET interpretations_used = 0,
        usage_reset_at = date_trunc('month', now()) + interval '1 month'
       WHERE id = $1`,
      [user.id]
    );
    user.interpretations_used = 0;
  }
}

function publicUser(u) {
  return {
    id: u.id, name: u.name, email: u.email, plan: u.plan,
    interpretationsUsed: u.interpretations_used,
    interpretationsLimit: PLAN_LIMITS[u.plan] === Infinity ? null : PLAN_LIMITS[u.plan],
    usageResetAt: u.usage_reset_at, locale: u.locale, createdAt: u.created_at
  };
}

// ============================================================================
// ROUTES — AUTH
// ============================================================================
app.post('/api/v1/auth/signup', asyncHandler(async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
  if (existing.rows.length) return res.status(409).json({ error: 'An account with this email already exists' });

  const hash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    `INSERT INTO users (name, email, password_hash) VALUES ($1,$2,$3) RETURNING *`,
    [name.trim(), email.toLowerCase().trim(), hash]
  );
  const user = rows[0];
  res.status(201).json({ token: signToken(user), user: publicUser(user) });
}));

app.post('/api/v1/auth/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
  if (!rows.length) return res.status(401).json({ error: 'Invalid email or password' });

  const user = rows[0];
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

  res.json({ token: signToken(user), user: publicUser(user) });
}));

app.get('/api/v1/auth/me', requireAuth, asyncHandler(async (req, res) => {
  await ensureUsageWindow(req.user);
  res.json({ user: publicUser(req.user) });
}));

app.patch('/api/v1/auth/me', requireAuth, asyncHandler(async (req, res) => {
  const { name, locale, password } = req.body || {};
  const updates = [];
  const values = [];
  let i = 1;
  if (name) { updates.push(`name = $${i++}`); values.push(name.trim()); }
  if (locale) { updates.push(`locale = $${i++}`); values.push(locale); }
  if (password) {
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    updates.push(`password_hash = $${i++}`);
    values.push(await bcrypt.hash(password, 10));
  }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  values.push(req.user.id);
  const { rows } = await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`, values);
  res.json({ user: publicUser(rows[0]) });
}));

// ============================================================================
// ROUTES — PLANS & PRICING
// ============================================================================
// Single source of truth for pricing. The frontend fetches this instead of
// hardcoding prices, so a price change here updates the UI everywhere.
const PLANS = [
  {
    id: 'free',
    name: 'Free',
    price: 0,
    interval: null,
    tagline: 'Try AFCIA at no cost',
    features: [
      `${PLAN_LIMITS.free} fault code interpretations per month`,
      'VIN decoding',
      'Basic repair guidance',
      'AI assistant access'
    ],
    limit: PLAN_LIMITS.free,
    popular: false,
    cta: 'Get started'
  },
  {
    id: 'premium_monthly',
    name: 'Premium Monthly',
    price: 9.99,
    interval: 'month',
    tagline: 'Unlimited diagnostics, billed monthly',
    features: [
      'Unlimited fault code interpretations',
      'Unlimited VIN decoding',
      'Priority AI assistant',
      'Full repair & cost guidance',
      'Scan history'
    ],
    limit: null,
    popular: false,
    cta: 'Subscribe',
    stripeConfigured: !!process.env.STRIPE_PRICE_MONTHLY
  },
  {
    id: 'premium_yearly',
    name: 'Premium Yearly',
    price: 99.99,
    interval: 'year',
    tagline: 'Unlimited diagnostics — 2 months free vs. monthly',
    features: [
      'Unlimited fault code interpretations',
      'Unlimited VIN decoding',
      'Priority AI assistant',
      'Full repair & cost guidance',
      'Scan history',
      'Save $19.89/year vs. monthly'
    ],
    limit: null,
    popular: true,
    cta: 'Subscribe',
    stripeConfigured: !!process.env.STRIPE_PRICE_YEARLY
  }
];

app.get('/api/v1/plans', (req, res) => {
  res.json({ plans: PLANS });
});

// ============================================================================
// ROUTES — FAULT CODE INTERPRETATION
// ============================================================================
async function chargeUsage(user, count) {
  if (!user) return { ok: true };
  await ensureUsageWindow(user);
  const limit = PLAN_LIMITS[user.plan] ?? PLAN_LIMITS.free;
  if (user.interpretations_used + count > limit) {
    return { ok: false, limit };
  }
  await pool.query('UPDATE users SET interpretations_used = interpretations_used + $1 WHERE id = $2', [count, user.id]);
  return { ok: true };
}

async function logInterpretation(user, code, data, inputSource) {
  if (!user) return;
  await pool.query(
    `INSERT INTO interpretations (user_id, code, title, severity, sev_label, result, input_source)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [user.id, code, data.title, data.severity, data.sevLabel, JSON.stringify(data), inputSource]
  );
}

app.get('/api/v1/fault-codes/:code', optionalAuth, asyncHandler(async (req, res) => {
  const code = (req.params.code || '').trim().toUpperCase();
  if (!/^[A-Z][0-9A-Z]{3,5}$/.test(code)) return res.status(400).json({ error: 'That doesn\u2019t look like a valid fault code' });

  const charge = await chargeUsage(req.user, 1);
  if (!charge.ok) return res.status(402).json({ error: `You've used all ${charge.limit} free interpretations this month. Upgrade to Premium for unlimited access.`, code: 'LIMIT_REACHED' });

  const data = await interpretCode(code);
  await logInterpretation(req.user, code, data, 'code');
  res.json(data);
}));

app.post('/api/v1/fault-codes/image', optionalAuth, upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

  const codes = await extractCodesFromImage(req.file.buffer, req.file.mimetype);
  if (!codes.length) return res.status(422).json({ error: 'No fault codes could be recognized in that screenshot' });

  const charge = await chargeUsage(req.user, codes.length);
  if (!charge.ok) return res.status(402).json({ error: `This would use more interpretations than you have left this month (limit ${charge.limit}). Upgrade to Premium for unlimited access.`, code: 'LIMIT_REACHED' });

  let imageUrl = null;
  if (cloudinary && process.env.CLOUDINARY_CLOUD_NAME) {
    imageUrl = await new Promise((resolve) => {
      const stream = cloudinary.uploader.upload_stream({ folder: 'afcia/scans' }, (err, result) => resolve(err ? null : result.secure_url));
      stream.end(req.file.buffer);
    });
  }

  const results = [];
  for (const code of codes) {
    const data = await interpretCode(code);
    await logInterpretation(req.user, code, data, 'image');
    results.push({ code, ...data });
  }
  res.json({ codes, results, imageUrl });
}));

app.post('/api/v1/fault-codes/file', optionalAuth, upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  let text = '';
  const name = (req.file.originalname || '').toLowerCase();
  if (name.endsWith('.pdf')) {
    if (!pdfParse) return res.status(501).json({ error: 'PDF parsing is not enabled on this server' });
    text = (await pdfParse(req.file.buffer)).text;
  } else {
    text = req.file.buffer.toString('utf8');
  }

  const codes = extractCodesFromText(text);
  if (!codes.length) return res.status(422).json({ error: 'No fault codes were found in that file' });

  const charge = await chargeUsage(req.user, codes.length);
  if (!charge.ok) return res.status(402).json({ error: `This would use more interpretations than you have left this month (limit ${charge.limit}). Upgrade to Premium for unlimited access.`, code: 'LIMIT_REACHED' });

  const results = [];
  for (const code of codes) {
    const data = await interpretCode(code);
    await logInterpretation(req.user, code, data, 'file');
    results.push({ code, ...data });
  }
  res.json({ codes, results });
}));

// ============================================================================
// ROUTES — VIN DECODER
// ============================================================================
const SAE_YEAR_CODES = { A: 2010, B: 2011, C: 2012, D: 2013, E: 2014, F: 2015, G: 2016, H: 2017, J: 2018, K: 2019, L: 2020, M: 2021, N: 2022, P: 2023, R: 2024, S: 2025, T: 2026 };

app.get('/api/v1/vin/:vin', optionalAuth, asyncHandler(async (req, res) => {
  const vin = (req.params.vin || '').trim().toUpperCase();
  if (vin.length !== 17) return res.status(400).json({ error: 'VIN must be exactly 17 characters' });

  // NHTSA vPIC — free, no API key required, official US vehicle registry.
  const nhtsaRes = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues/${vin}?format=json`);
  const nhtsaData = await nhtsaRes.json();
  const row = (nhtsaData.Results && nhtsaData.Results[0]) || {};

  const yearChar = vin[9];
  const localYear = SAE_YEAR_CODES[yearChar];

  const result = {
    make: row.Make || null,
    year: (row.ModelYear && Number(row.ModelYear)) || localYear || null,
    trim: row.Trim || row.Series || null,
    engine: [row.EngineCylinders && `${row.EngineCylinders}-cyl`, row.DisplacementL && `${row.DisplacementL}L`, row.FuelTypePrimary]
      .filter(Boolean).join(' ') || null,
    specs: [
      row.Model && `Model: ${row.Model}`,
      row.BodyClass && `Body style: ${row.BodyClass}`,
      row.DriveType && `Drivetrain: ${row.DriveType}`,
      row.TransmissionStyle && `Transmission: ${row.TransmissionStyle}`,
      row.PlantCountry && `Assembly country: ${row.PlantCountry}`,
      `Model-year code (VIN position 10): decoded per SAE standard as ${localYear || 'unknown'}`,
      `Production sequence: ${vin.slice(11) || '\u2014'}`
    ].filter(Boolean)
  };

  if (req.user) {
    await pool.query('INSERT INTO vin_lookups (user_id, vin, result) VALUES ($1,$2,$3)', [req.user.id, vin, JSON.stringify(result)]);
  }
  res.json(result);
}));

// ============================================================================
// ROUTES — HISTORY
// ============================================================================
app.get('/api/v1/history', requireAuth, asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = parseInt(req.query.offset, 10) || 0;
  const { rows } = await pool.query(
    `SELECT id, code, title, severity, sev_label, input_source, created_at
     FROM interpretations WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [req.user.id, limit, offset]
  );
  res.json({ history: rows });
}));

app.get('/api/v1/history/:id', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM interpretations WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json({ ...rows[0].result, code: rows[0].code, createdAt: rows[0].created_at });
}));

app.delete('/api/v1/history/:id', requireAuth, asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM interpretations WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  res.status(204).end();
}));

// ============================================================================
// ROUTES — DASHBOARD STATS
// ============================================================================
app.get('/api/v1/dashboard/stats', requireAuth, asyncHandler(async (req, res) => {
  await ensureUsageWindow(req.user);

  const [{ rows: monthRows }, { rows: vehicleRows }, { rows: sevRows }] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS n FROM interpretations
       WHERE user_id = $1 AND created_at >= date_trunc('month', now())`,
      [req.user.id]
    ),
    pool.query('SELECT COUNT(DISTINCT vin)::int AS n FROM vin_lookups WHERE user_id = $1', [req.user.id]),
    pool.query(
      `SELECT COALESCE(AVG(severity), 0)::int AS avg FROM interpretations
       WHERE user_id = $1 AND created_at >= date_trunc('month', now())`,
      [req.user.id]
    )
  ]);

  res.json({
    interpretationsThisMonth: monthRows[0].n,
    vehiclesTracked: vehicleRows[0].n,
    averageSeverity: sevRows[0].avg,
    plan: req.user.plan,
    interpretationsUsed: req.user.interpretations_used,
    interpretationsLimit: PLAN_LIMITS[req.user.plan] === Infinity ? null : PLAN_LIMITS[req.user.plan]
  });
}));

// ============================================================================
// ROUTES — AI ASSISTANT
// ============================================================================
const ASSISTANT_SYSTEM_PROMPT = `You are the AFCIA AI Assistant, embedded in an automobile fault code interpreter app.
You help drivers understand a specific fault code they just scanned: what it means, where the part is, how to fix it,
what happens if they ignore it, and roughly what it will cost. Be concise (2-5 sentences), practical, and reassuring
but honest about safety risk. If no fault code is provided, answer general car-diagnostic questions helpfully.
Never fabricate a specific dollar figure with false precision — give ranges. Do not answer questions unrelated to
vehicles, diagnostics, or maintenance; politely redirect back to car topics.`;

app.post('/api/v1/assistant', optionalAuth, asyncHandler(async (req, res) => {
  const { code, question, history } = req.body || {};
  if (!question || !question.trim()) return res.status(400).json({ error: 'A question is required' });

  const messages = [];
  if (Array.isArray(history)) {
    for (const m of history.slice(-10)) {
      if (m.role === 'user' || m.role === 'assistant') messages.push({ role: m.role, content: String(m.content).slice(0, 2000) });
    }
  }
  messages.push({ role: 'user', content: code ? `[Context: current fault code is ${code}]\n${question}` : question });

  const answer = await callClaude({ system: ASSISTANT_SYSTEM_PROMPT, messages, maxTokens: 500 });

  if (req.user) {
    await pool.query('INSERT INTO assistant_messages (user_id, code, role, content) VALUES ($1,$2,$3,$4)', [req.user.id, code || null, 'user', question]);
    await pool.query('INSERT INTO assistant_messages (user_id, code, role, content) VALUES ($1,$2,$3,$4)', [req.user.id, code || null, 'assistant', answer]);
  }

  res.json({ answer });
}));

// ============================================================================
// ROUTES — BILLING (Stripe)
// ============================================================================
const PRICE_TO_PLAN = {};
if (process.env.STRIPE_PRICE_MONTHLY) PRICE_TO_PLAN[process.env.STRIPE_PRICE_MONTHLY] = 'premium_monthly';
if (process.env.STRIPE_PRICE_YEARLY) PRICE_TO_PLAN[process.env.STRIPE_PRICE_YEARLY] = 'premium_yearly';
if (process.env.STRIPE_PRICE_PROFESSIONAL) PRICE_TO_PLAN[process.env.STRIPE_PRICE_PROFESSIONAL] = 'professional';

app.post('/api/v1/billing/checkout', requireAuth, asyncHandler(async (req, res) => {
  if (!stripe) return res.status(501).json({ error: 'Billing is not configured on this server' });
  const { plan } = req.body || {};
  const priceId = { premium_monthly: process.env.STRIPE_PRICE_MONTHLY, premium_yearly: process.env.STRIPE_PRICE_YEARLY, professional: process.env.STRIPE_PRICE_PROFESSIONAL }[plan];
  if (!priceId) return res.status(400).json({ error: 'Unknown plan' });

  let customerId = req.user.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({ email: req.user.email, name: req.user.name });
    customerId = customer.id;
    await pool.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [customerId, req.user.id]);
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: process.env.BILLING_SUCCESS_URL || 'https://example.com?billing=success',
    cancel_url: process.env.BILLING_CANCEL_URL || 'https://example.com?billing=cancelled',
    metadata: { userId: req.user.id, plan }
  });

  res.json({ url: session.url });
}));

app.get('/api/v1/billing/portal', requireAuth, asyncHandler(async (req, res) => {
  if (!stripe) return res.status(501).json({ error: 'Billing is not configured on this server' });
  if (!req.user.stripe_customer_id) return res.status(400).json({ error: 'No billing account on file yet' });
  const session = await stripe.billingPortal.sessions.create({
    customer: req.user.stripe_customer_id,
    return_url: process.env.BILLING_SUCCESS_URL || 'https://example.com'
  });
  res.json({ url: session.url });
}));

async function billingWebhookHandler(req, res) {
  if (!stripe) return res.status(501).end();
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const plan = session.metadata && session.metadata.plan;
      if (session.metadata && session.metadata.userId && plan) {
        await pool.query('UPDATE users SET plan = $1, stripe_subscription_id = $2 WHERE id = $3', [plan, session.subscription, session.metadata.userId]);
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      await pool.query('UPDATE users SET plan = $1, stripe_subscription_id = NULL WHERE stripe_subscription_id = $2', ['free', sub.id]);
    } else if (event.type === 'customer.subscription.updated') {
      const sub = event.data.object;
      const priceId = sub.items && sub.items.data[0] && sub.items.data[0].price && sub.items.data[0].price.id;
      const plan = PRICE_TO_PLAN[priceId];
      if (plan) await pool.query('UPDATE users SET plan = $1 WHERE stripe_subscription_id = $2', [plan, sub.id]);
    }
  } catch (err) {
    console.error('[webhook] handler error', err);
  }

  res.json({ received: true });
}

// ============================================================================
// HEALTH + ERROR HANDLING
// ============================================================================
app.get('/api/v1/health', (req, res) => res.json({ ok: true, service: 'afcia-backend' }));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ============================================================================
// BOOT
// ============================================================================
(async () => {
  try {
    if (process.env.AUTO_MIGRATE === 'true') await migrate();
    if (process.env.AUTO_SEED === 'true') await seed();
  } catch (err) {
    console.error('[boot] migration/seed failed:', err);
    process.exit(1);
  }
  app.listen(PORT, () => console.log(`AFCIA backend listening on port ${PORT}`));
})();
