const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = Number(process.env.PORT || 3000);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const LICENSE_SIGNING_SECRET = process.env.LICENSE_SIGNING_SECRET || SESSION_SECRET || '';

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const PAYPAL_MODE = process.env.PAYPAL_MODE === 'live' ? 'live' : 'sandbox';
const PRO_PRICE = String(process.env.PRO_PRICE || '5.99');
const PRO_CURRENCY = String(process.env.PRO_CURRENCY || 'EUR').toUpperCase();
const PAYPAL_BASE = PAYPAL_MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

const FREE_QUESTION_LIMIT = 20;
const LICENSE_LEASE_MS = 45_000;
const LICENSE_HEARTBEAT_MS = 15_000;

if (IS_PRODUCTION) {
  const missing = [];
  if (!ADMIN_PASSWORD_HASH) missing.push('ADMIN_PASSWORD_HASH');
  if (SESSION_SECRET.length < 32) missing.push('SESSION_SECRET (minim 32 caractere)');
  if (LICENSE_SIGNING_SECRET.length < 32) missing.push('LICENSE_SIGNING_SECRET (minim 32 caractere)');
  if (!PAYPAL_CLIENT_ID) missing.push('PAYPAL_CLIENT_ID');
  if (!PAYPAL_CLIENT_SECRET) missing.push('PAYPAL_CLIENT_SECRET');
  if (missing.length) {
    console.error(`CONFIG ERROR: lipsesc ${missing.join(', ')}.`);
    process.exit(1);
  }
}

if (!ADMIN_PASSWORD_HASH) console.warn('AVERTISMENT: login-ul profesorului este dezactivat până setezi ADMIN_PASSWORD_HASH.');
if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) console.warn('AVERTISMENT: PayPal este dezactivat până setezi PAYPAL_CLIENT_ID și PAYPAL_CLIENT_SECRET.');

const effectiveSessionSecret = SESSION_SECRET || crypto.randomBytes(48).toString('hex');
const effectiveLicenseSecret = LICENSE_SIGNING_SECRET || effectiveSessionSecret;

const DATA_DIR = path.join(__dirname, 'data');
const QUESTIONS_FILE = path.join(DATA_DIR, 'questions.json');
const EN_QUESTIONS_FILE = path.join(DATA_DIR, 'questions.en.json');
const LICENSES_FILE = path.join(DATA_DIR, 'licenses.json');
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads', 'questions');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(QUESTIONS_FILE)) fs.writeFileSync(QUESTIONS_FILE, '[]\n');
if (!fs.existsSync(LICENSES_FILE)) {
  fs.writeFileSync(LICENSES_FILE, JSON.stringify({ licenses: [], pendingOrders: {} }, null, 2) + '\n', { mode: 0o600 });
}
try { fs.chmodSync(LICENSES_FILE, 0o600); } catch { }



// Traduceri EN statice pentru toate întrebările builtin.
// Fișierul conține câte o variantă pentru fiecare combinație distinctă
// (categorie + text + răspuns corect + imagine), astfel încât întrebările
// cu același text dar alte răspunsuri/imagini să fie localizate corect.
const EN_QUESTION_SEPARATOR = '\u241f';
const EN_MATH_KINDS = Object.freeze({
  'Adunare': 'Addition',
  'Scădere': 'Subtraction',
  'Înmulțire': 'Multiplication',
  'Împărțire': 'Division',
  'Număr lipsă': 'Missing number'
});

function englishQuestionKey(q) {
  return [q.kind, q.text, String(q.correct), q.image || ''].join(EN_QUESTION_SEPARATOR);
}

function loadEnglishQuestionTranslations() {
  try {
    const raw = JSON.parse(fs.readFileSync(EN_QUESTIONS_FILE, 'utf8'));
    const variants = Array.isArray(raw?.variants) ? raw.variants : [];
    return new Map(variants.map(item => [String(item.key), item]));
  } catch (error) {
    console.warn('AVERTISMENT: traducerile EN statice nu au putut fi încărcate:', error.message);
    return new Map();
  }
}

const EN_QUESTION_TRANSLATIONS = loadEnglishQuestionTranslations();

function englishQuestionForClient(question) {
  if (question.mode === 'math') {
    return {
      kind: EN_MATH_KINDS[question.kind] || question.kind,
      text: question.text,
      imageAlt: question.imageAlt || '',
      answers: question.answers.map(String)
    };
  }

  const translated = EN_QUESTION_TRANSLATIONS.get(englishQuestionKey(question));
  if (!translated) return null; // întrebările custom pot folosi fallback-ul din browser
  return {
    kind: translated.kind || question.kind,
    text: translated.text || question.text,
    imageAlt: translated.imageAlt || question.imageAlt || '',
    answers: question.answers.map(answer => translated.answerMap?.[String(answer)] ?? String(answer))
  };
}

const rooms = new Map();
const licenseLeases = new Map(); // licenseHash -> { activationId, token, expiresAt }
const tokenToLicense = new Map(); // token -> licenseHash
let paypalAccessToken = null;
let paypalAccessTokenExpiresAt = 0;

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use(express.urlencoded({ extended: true, limit: '64kb' }));
app.use(express.json({ limit: '64kb' }));
app.use(session({
  name: 'matharena.sid',
  secret: effectiveSessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'lax',
    maxAge: 4 * 60 * 60 * 1000
  }
}));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: IS_PRODUCTION ? '1h' : 0
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { ok: false, message: 'Prea multe încercări de autentificare. Încearcă din nou peste aproximativ 15 minute.' }
});

const licenseLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, message: 'Prea multe cereri pentru licență. Încearcă din nou puțin mai târziu.' }
});

const heartbeatLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 5000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, message: 'Prea multe heartbeat-uri de licență.' }
});

const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, message: 'Prea multe cereri de plată. Încearcă din nou mai târziu.' }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 1, fields: 12, fieldSize: 16 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.mimetype)) return cb(new Error('Format imagine neacceptat. Folosește PNG, JPG/JPEG sau WEBP.'));
    cb(null, true);
  }
});

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function safeName(value) { return String(value || '').trim().replace(/[<>]/g, '').slice(0, 20); }
function shuffle(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
function normalizeMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.round(number * 100);
}

function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) return { ext: '.png', mime: 'image/png' };
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { ext: '.jpg', mime: 'image/jpeg' };
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return { ext: '.webp', mime: 'image/webp' };
  return null;
}

function saveValidatedImage(file) {
  if (!file) return null;
  const detected = detectImageType(file.buffer);
  if (!detected || detected.mime !== file.mimetype) throw new Error('Fișierul încărcat nu este o imagine validă sau tipul real nu corespunde extensiei.');
  const filename = `${crypto.randomUUID()}${detected.ext}`;
  const absolutePath = path.join(UPLOAD_DIR, filename);
  fs.writeFileSync(absolutePath, file.buffer, { flag: 'wx', mode: 0o644 });
  return { filename, absolutePath, publicPath: `/uploads/questions/${filename}` };
}

function readJsonFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { console.error(`Nu pot citi ${path.basename(file)}:`, error); return fallback; }
}
function atomicWriteJson(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}
function readCustomQuestions() {
  const data = readJsonFile(QUESTIONS_FILE, []);
  return Array.isArray(data) ? data : [];
}
function writeCustomQuestions(questions) { atomicWriteJson(QUESTIONS_FILE, questions); }
function readLicenseStore() {
  const data = readJsonFile(LICENSES_FILE, { licenses: [], pendingOrders: {} });
  return {
    licenses: Array.isArray(data.licenses) ? data.licenses : [],
    pendingOrders: data.pendingOrders && typeof data.pendingOrders === 'object' ? data.pendingOrders : {}
  };
}
function writeLicenseStore(store) { atomicWriteJson(LICENSES_FILE, store); }

function createCsrfToken(req) {
  const token = crypto.randomBytes(32).toString('hex');
  req.session.csrfToken = token;
  return token;
}
function requireCsrf(req, res, next) {
  const expected = String(req.session?.csrfToken || '');
  const received = String(req.get('x-csrf-token') || '');
  if (!expected || !received) return res.status(403).json({ ok: false, message: 'Cerere invalidă. Reîncarcă pagina și încearcă din nou.' });
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(403).json({ ok: false, message: 'Token CSRF invalid.' });
  next();
}
function requireAdmin(req, res, next) {
  if (req.session?.isAdmin === true) return next();
  return res.status(401).json({ ok: false, message: 'Autentificare necesară.' });
}

// -------------------- Admin profesor --------------------
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));
app.get('/api/admin/me', (req, res) => {
  const authenticated = req.session?.isAdmin === true;
  res.json({ authenticated, csrfToken: authenticated ? (req.session.csrfToken || createCsrfToken(req)) : null });
});
app.post('/api/admin/login', loginLimiter, async (req, res, next) => {
  try {
    if (!ADMIN_PASSWORD_HASH) return res.status(503).json({ ok: false, message: 'Autentificarea profesorului nu este configurată.' });
    const password = String(req.body.password || '');
    if (!password || password.length > 256 || !(await bcrypt.compare(password, ADMIN_PASSWORD_HASH))) return res.status(401).json({ ok: false, message: 'Date de autentificare incorecte.' });
    req.session.regenerate(error => {
      if (error) return next(error);
      req.session.isAdmin = true;
      const csrfToken = createCsrfToken(req);
      req.session.save(saveError => saveError ? next(saveError) : res.json({ ok: true, csrfToken }));
    });
  } catch (error) { next(error); }
});
app.post('/api/admin/logout', requireAdmin, requireCsrf, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('matharena.sid', { httpOnly: true, secure: IS_PRODUCTION, sameSite: 'lax' });
    res.json({ ok: true });
  });
});
app.get('/api/admin/questions', requireAdmin, (_req, res) => res.json({ ok: true, questions: readCustomQuestions() }));
app.post('/api/admin/questions', requireAdmin, requireCsrf, upload.single('image'), (req, res, next) => {
  let savedImage = null;
  try {
    const text = String(req.body.text || '').trim();
    const kind = String(req.body.kind || 'General').trim().slice(0, 40);
    const minGrade = clamp(Number(req.body.minGrade) || 1, 1, 4);
    const maxGrade = clamp(Number(req.body.maxGrade) || 4, minGrade, 4);
    const answers = [1, 2, 3, 4].map(i => String(req.body[`answer${i}`] || '').trim().slice(0, 180));
    const correctIndex = Number(req.body.correctIndex);
    if (!text || text.length > 500 || answers.some(a => !a) || ![0, 1, 2, 3].includes(correctIndex)) return res.status(422).json({ ok: false, message: 'Completează întrebarea, toate cele 4 răspunsuri și răspunsul corect.' });
    if (new Set(answers.map(a => a.toLocaleLowerCase('ro'))).size !== 4) return res.status(422).json({ ok: false, message: 'Cele 4 variante trebuie să fie diferite.' });
    savedImage = saveValidatedImage(req.file);
    const questions = readCustomQuestions();
    const question = {
      id: crypto.randomUUID(), minGrade, maxGrade, kind, text,
      correct: answers[correctIndex], answers,
      image: savedImage?.publicPath || null,
      imageAlt: String(req.body.imageAlt || '').trim().slice(0, 160),
      createdAt: new Date().toISOString()
    };
    questions.unshift(question);
    writeCustomQuestions(questions);
    res.status(201).json({ ok: true, question });
  } catch (error) {
    if (savedImage?.absolutePath) fs.unlink(savedImage.absolutePath, () => { });
    next(error);
  }
});
app.delete('/api/admin/questions/:id', requireAdmin, requireCsrf, (req, res) => {
  const id = String(req.params.id || '');
  const questions = readCustomQuestions();
  const index = questions.findIndex(q => q.id === id);
  if (index === -1) return res.status(404).json({ ok: false, message: 'Întrebarea nu există.' });
  const [removed] = questions.splice(index, 1);
  writeCustomQuestions(questions);
  if (removed.image?.startsWith('/uploads/questions/')) fs.unlink(path.join(UPLOAD_DIR, path.basename(removed.image)), () => { });
  res.json({ ok: true });
});

// -------------------- PayPal + licențe --------------------
function hashLicenseKey(key) {
  return crypto.createHash('sha256').update(String(key).trim().toUpperCase()).digest('hex');
}
function licenseKeyForOrder(orderId) {
  const digest = crypto.createHmac('sha256', effectiveLicenseSecret).update(`math-arena-pro:${orderId}`).digest('hex').toUpperCase();
  return `MA-PRO-${digest.slice(0, 4)}-${digest.slice(4, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}`;
}
function findActiveLicenseByKey(key) {
  const normalized = String(key || '').trim().toUpperCase();
  if (!/^MA-PRO-[A-F0-9]{4}(?:-[A-F0-9]{4}){3}$/.test(normalized)) return null;
  const hash = hashLicenseKey(normalized);
  const license = readLicenseStore().licenses.find(item => item.licenseHash === hash && item.status === 'active');
  return license ? { license, hash, normalized } : null;
}
function cleanupExpiredLeases() {
  const now = Date.now();
  for (const [hash, lease] of licenseLeases.entries()) {
    if (lease.expiresAt <= now) {
      licenseLeases.delete(hash);
      tokenToLicense.delete(lease.token);
    }
  }
}
function validateLicenseToken(token, refresh = false) {
  cleanupExpiredLeases();
  const hash = tokenToLicense.get(String(token || ''));
  if (!hash) return null;
  const lease = licenseLeases.get(hash);
  if (!lease || lease.token !== token || lease.expiresAt <= Date.now()) return null;
  if (refresh) lease.expiresAt = Date.now() + LICENSE_LEASE_MS;
  return { hash, lease };
}
function activateLicense(key, activationId) {
  cleanupExpiredLeases();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(String(activationId || ''))) return { ok: false, status: 422, code: 'BAD_ACTIVATION', message: 'Identificatorul sesiunii este invalid.' };
  const found = findActiveLicenseByKey(key);
  if (!found) return { ok: false, status: 404, code: 'LICENSE_INVALID', message: 'Codul de licență nu este valid.' };
  const existing = licenseLeases.get(found.hash);
  if (existing && existing.expiresAt > Date.now() && existing.activationId !== activationId) {
    return { ok: false, status: 409, code: 'LICENSE_IN_USE', message: 'Această licență PRO este deja activă într-o altă sesiune. A doua activare a fost blocată.' };
  }
  if (existing && existing.activationId === activationId) {
    existing.expiresAt = Date.now() + LICENSE_LEASE_MS;
    return { ok: true, token: existing.token, expiresIn: Math.floor(LICENSE_LEASE_MS / 1000) };
  }
  const token = crypto.randomBytes(32).toString('base64url');
  const lease = { activationId, token, expiresAt: Date.now() + LICENSE_LEASE_MS };
  licenseLeases.set(found.hash, lease);
  tokenToLicense.set(token, found.hash);
  return { ok: true, token, expiresIn: Math.floor(LICENSE_LEASE_MS / 1000) };
}
function deactivateLicenseToken(token) {
  const validated = validateLicenseToken(token, false);
  if (!validated) return false;
  licenseLeases.delete(validated.hash);
  tokenToLicense.delete(token);
  return true;
}

async function getPayPalAccessToken() {
  if (paypalAccessToken && paypalAccessTokenExpiresAt > Date.now() + 30_000) return paypalAccessToken;
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) throw new Error('PAYPAL_NOT_CONFIGURED');
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const response = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  if (!response.ok) throw new Error(`PAYPAL_AUTH_${response.status}`);
  const data = await response.json();
  paypalAccessToken = data.access_token;
  paypalAccessTokenExpiresAt = Date.now() + Math.max(60, Number(data.expires_in || 300) - 60) * 1000;
  return paypalAccessToken;
}
async function paypalRequest(apiPath, options = {}) {
  const token = await getPayPalAccessToken();
  const { requestId, headers = {}, ...fetchOptions } = options;
  const response = await fetch(`${PAYPAL_BASE}${apiPath}`, {
    ...fetchOptions,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': requestId || crypto.randomBytes(12).toString('hex'),
      Prefer: 'return=representation',
      ...headers
    }
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) {
    const error = new Error(`PAYPAL_API_${response.status}`);
    error.paypal = data;
    throw error;
  }
  return data;
}

app.get('/api/license/config', (_req, res) => {
  res.json({
    ok: true,
    freeQuestionLimit: FREE_QUESTION_LIMIT,
    proQuestionCount: builtinQuestionBank().length + readCustomQuestions().length,
    paypal: {
      enabled: Boolean(PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET),
      clientId: PAYPAL_CLIENT_ID || null,
      currency: PRO_CURRENCY,
      price: PRO_PRICE,
      mode: PAYPAL_MODE
    }
  });
});

app.post('/api/paypal/orders', paymentLimiter, async (_req, res, next) => {
  try {
    if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) return res.status(503).json({ ok: false, message: 'PayPal nu este configurat pe server.' });
    const order = await paypalRequest('/v2/checkout/orders', {
      method: 'POST',
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: 'MATH_ARENA_PRO',
          description: `Arena Matematica PRO - bancă extinsă de întrebări`,
          amount: { currency_code: PRO_CURRENCY, value: PRO_PRICE }
        }],
        application_context: { shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW' }
      })
    });
    const store = readLicenseStore();
    store.pendingOrders[order.id] = { amount: PRO_PRICE, currency: PRO_CURRENCY, createdAt: new Date().toISOString() };
    writeLicenseStore(store);
    res.status(201).json({ ok: true, orderId: order.id });
  } catch (error) { next(error); }
});

app.post('/api/paypal/orders/:orderId/capture', paymentLimiter, async (req, res, next) => {
  try {
    const orderId = String(req.params.orderId || '').trim();
    if (!/^[A-Z0-9]+$/i.test(orderId)) return res.status(422).json({ ok: false, message: 'ID PayPal invalid.' });
    let store = readLicenseStore();
    const existingLicense = store.licenses.find(item => item.orderId === orderId && item.status === 'active');
    if (existingLicense) {
      return res.json({ ok: true, licenseKey: licenseKeyForOrder(orderId), alreadyCaptured: true });
    }
    const pending = store.pendingOrders[orderId];
    if (!pending) return res.status(404).json({ ok: false, message: 'Comanda PayPal nu a fost creată de acest server.' });

    const captureRequestId = crypto.createHash('sha256').update(`capture:${orderId}`).digest('hex').slice(0, 24);
    let capture;
    try {
      capture = await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { method: 'POST', body: '{}', requestId: captureRequestId });
    } catch (error) {
      const issue = error.paypal?.details?.[0]?.issue;
      if (issue !== 'ORDER_ALREADY_CAPTURED') throw error;
      capture = await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, { method: 'GET' });
    }
    const captureInfo = capture.purchase_units?.[0]?.payments?.captures?.[0];
    const amount = captureInfo?.amount;
    const validAmount = amount && amount.currency_code === pending.currency && normalizeMoney(amount.value) === normalizeMoney(pending.amount);
    if (capture.status !== 'COMPLETED' || captureInfo?.status !== 'COMPLETED' || !validAmount) {
      return res.status(422).json({ ok: false, message: 'Plata nu a fost confirmată cu suma și moneda așteptate.' });
    }

    const licenseKey = licenseKeyForOrder(orderId);
    store = readLicenseStore(); // recitește înainte de scriere
    if (!store.licenses.some(item => item.orderId === orderId)) {
      store.licenses.push({
        id: crypto.randomUUID(),
        orderId,
        captureId: captureInfo.id,
        licenseHash: hashLicenseKey(licenseKey),
        status: 'active',
        createdAt: new Date().toISOString()
      });
    }
    delete store.pendingOrders[orderId];
    writeLicenseStore(store);
    res.json({ ok: true, licenseKey });
  } catch (error) { next(error); }
});

app.post('/api/license/activate', licenseLimiter, (req, res) => {
  const result = activateLicense(req.body.licenseKey, req.body.activationId);
  if (!result.ok) return res.status(result.status).json(result);
  res.json({ ok: true, tier: 'pro', token: result.token, heartbeatMs: LICENSE_HEARTBEAT_MS, leaseSeconds: result.expiresIn });
});
app.post('/api/license/heartbeat', heartbeatLimiter, (req, res) => {
  const token = String(req.body.token || '');
  const validated = validateLicenseToken(token, true);
  if (!validated) return res.status(401).json({ ok: false, code: 'LEASE_EXPIRED', message: 'Activarea PRO a expirat. Activează din nou licența.' });
  res.json({ ok: true, tier: 'pro', leaseSeconds: Math.floor(LICENSE_LEASE_MS / 1000) });
});
app.post('/api/license/deactivate', licenseLimiter, (req, res) => {
  deactivateLicenseToken(String(req.body.token || ''));
  res.json({ ok: true });
});
app.post('/api/license/status', licenseLimiter, (req, res) => {
  const token = String(req.body.token || '');
  res.json({ ok: true, tier: validateLicenseToken(token, false) ? 'pro' : 'free' });
});

// -------------------- Bancă de întrebări --------------------
function makeBankQuestion(id, grade, mode, kind, text, correct, answers, image = null, imageAlt = '') {
  return { id, minGrade: grade, maxGrade: grade, mode, kind, text, correct: String(correct), answers: answers.map(String), image, imageAlt };
}
function numericAnswers(correct, min = 0) {
  const values = new Set([correct]);
  const offsets = [-10, -5, -3, -2, -1, 1, 2, 3, 5, 10, 20];
  for (const offset of offsets) {
    const candidate = Math.max(min, correct + offset);
    if (candidate !== correct) values.add(candidate);
    if (values.size >= 4) break;
  }
  return [...values].slice(0, 4).map(String);
}
let BUILTIN_BANK_CACHE = null;
function builtinQuestionBank() {
  if (BUILTIN_BANK_CACHE) return BUILTIN_BANK_CACHE;
  const bank = [];
  let seq = 1;
  const addMath = (grade, kind, text, correct, min = 0) => bank.push(makeBankQuestion(`math-${seq++}`, grade, 'math', kind, text, correct, numericAnswers(correct, min)));

  // Peste 180 de exerciții matematice deterministe, grupate pe clase.
  for (let a = 1; a <= 10; a++) for (let b = 0; b <= 4; b++) if (a + b <= 10) addMath(1, 'Adunare', `${a} + ${b} = ?`, a + b);
  for (let a = 5; a <= 10; a++) for (let b = 0; b <= 4; b++) if (b <= a) addMath(1, 'Scădere', `${a} − ${b} = ?`, a - b);

  for (let i = 0; i < 30; i++) {
    const a = 12 + i * 2, b = 3 + (i % 8);
    addMath(2, 'Adunare', `${a} + ${b} = ?`, a + b);
  }
  for (let i = 0; i < 20; i++) {
    const a = 40 + i * 2, b = 5 + (i % 12);
    addMath(2, 'Scădere', `${a} − ${b} = ?`, a - b);
  }
  for (let a = 2; a <= 5; a++) for (let b = 2; b <= 10; b++) addMath(2, 'Înmulțire', `${a} × ${b} = ?`, a * b);

  for (let i = 0; i < 25; i++) {
    const a = 120 + i * 11, b = 20 + (i % 17);
    addMath(3, 'Adunare', `${a} + ${b} = ?`, a + b);
  }
  for (let i = 0; i < 20; i++) {
    const a = 300 + i * 13, b = 40 + (i % 21);
    addMath(3, 'Scădere', `${a} − ${b} = ?`, a - b);
  }
  for (let a = 6; a <= 10; a++) for (let b = 2; b <= 10; b++) addMath(3, 'Înmulțire', `${a} × ${b} = ?`, a * b);
  for (let b = 2; b <= 10; b++) for (let q = 2; q <= 6; q++) addMath(3, 'Împărțire', `${b * q} ÷ ${b} = ?`, q);

  for (let i = 0; i < 25; i++) {
    const a = 1250 + i * 47, b = 230 + (i % 23) * 11;
    addMath(4, 'Adunare', `${a} + ${b} = ?`, a + b);
  }
  for (let i = 0; i < 25; i++) {
    const a = 4200 + i * 83, b = 350 + (i % 19) * 17;
    addMath(4, 'Scădere', `${a} − ${b} = ?`, a - b);
  }
  for (let a = 7; a <= 12; a++) for (let b = 2; b <= 12; b++) addMath(4, 'Înmulțire', `${a} × ${b} = ?`, a * b);
  for (let b = 4; b <= 12; b++) for (let q = 3; q <= 8; q++) addMath(4, 'Împărțire', `${b * q} ÷ ${b} = ?`, q);
  for (let x = 2; x <= 25; x++) {
    const add = 10 + (x % 13);
    addMath(4, 'Număr lipsă', `? + ${add} = ${x + add}`, x);
  }

  const commonGeneral = [
    ['Timp', 'Câte zile are o săptămână?', '7', ['5', '6', '7', '8']],
    ['Calendar', 'Câte luni are un an?', '12', ['10', '11', '12', '13']],
    ['Natură', 'În ce anotimp ninge de obicei?', 'Iarna', ['Primăvara', 'Vara', 'Toamna', 'Iarna'], '/images/questions/seasons.svg', 'Simboluri pentru anotimpuri'],
    ['Animale', 'Ce animal spune „miau”?', 'Pisica', ['Câinele', 'Pisica', 'Vaca', 'Rața']],
    ['Corp', 'Cu ce organ vedem?', 'Ochii', ['Urechile', 'Nasul', 'Ochii', 'Mâinile']],
    ['Corp', 'Cu ce organ auzim?', 'Urechile', ['Ochii', 'Urechile', 'Picioarele', 'Dinții']],
    ['Culori', 'Ce culoare obții din albastru și galben?', 'Verde', ['Verde', 'Roșu', 'Mov', 'Portocaliu']],
    ['Natură', 'Ce animal trăiește de obicei în apă?', 'Peștele', ['Pisica', 'Calul', 'Peștele', 'Găina'], '/images/questions/animal-fish.svg', 'Pește stilizat'],
    ['Forme', 'Câte laturi are un pătrat?', '4', ['3', '4', '5', '6'], '/images/questions/shapes.svg', 'Forme geometrice'],
    ['Forme', 'Care formă nu are colțuri?', 'Cercul', ['Pătratul', 'Triunghiul', 'Cercul', 'Dreptunghiul']],
    ['Timp', 'Câte ore are o zi?', '24', ['12', '18', '24', '30'], '/images/questions/clock-3.svg', 'Ceas analogic'],
    ['Timp', 'Câte minute are o oră?', '60', ['30', '45', '60', '100']],
    ['Bani', 'Câți bani sunt într-un leu?', '100 bani', ['10 bani', '50 bani', '100 bani', '1000 bani'], '/images/questions/coins.svg', 'Monede stilizate'],
    ['Natură', 'Ce ne oferă Soarele în timpul zilei?', 'Lumină', ['Zăpadă', 'Lumină', 'Pământ', 'Ploaie']],
    ['Animale', 'Care animal are aripi?', 'Pasărea', ['Pisica', 'Pasărea', 'Calul', 'Peștele'], '/images/questions/animal-bird.svg', 'Pasăre stilizată'],
    ['Limbă', 'Care este o vocală?', 'A', ['B', 'C', 'A', 'D']],
    ['Geografie', 'În ce țară se află București?', 'România', ['România', 'Franța', 'Italia', 'Spania'], '/images/questions/romania.svg', 'Harta României'],
    ['Știință', 'Apa este de obicei...', 'lichidă', ['solidă', 'lichidă', 'metal', 'gaz permanent']],
    ['Natură', 'De ce are nevoie o plantă ca să crească?', 'Apă și lumină', ['Doar întuneric', 'Apă și lumină', 'Doar pietre', 'Zăpadă'], '/images/questions/plant-parts.svg', 'Plantă cu rădăcină, tulpină, frunze și floare'],
    ['Siguranță', 'Ce culoare a semaforului înseamnă „oprește”?', 'Roșu', ['Verde', 'Galben', 'Roșu', 'Albastru'], '/images/questions/traffic-light.svg', 'Semafor cu trei culori']
  ];

  const imageGeneral = [
    ['Numărare', 'Câte stele vezi în imagine?', '7', ['5', '6', '7', '8'], '/images/questions/count-stars.svg', 'Șapte stele galbene'],
    ['Numărare', 'Câte mere vezi în imagine?', '6', ['4', '5', '6', '7'], '/images/questions/count-apples.svg', 'Șase mere roșii'],
    ['Numărare', 'Câte baloane sunt în imagine?', '4', ['3', '4', '5', '6'], '/images/questions/count-balloons.svg', 'Patru baloane colorate'],
    ['Timp', 'Cât arată ceasul din imagine?', '3:00', ['2:00', '3:00', '6:00', '12:15'], '/images/questions/clock-3.svg', 'Ceas care arată ora trei'],
    ['Timp', 'Cât arată ceasul din imagine?', '6:30', ['6:00', '6:30', '3:30', '12:30'], '/images/questions/clock-630.svg', 'Ceas care arată șase și jumătate'],
    ['Geometrie', 'Ce formă geometrică vezi?', 'Triunghi', ['Cerc', 'Pătrat', 'Triunghi', 'Dreptunghi'], '/images/questions/shape-triangle.svg', 'Triunghi galben'],
    ['Geometrie', 'Ce formă geometrică vezi?', 'Dreptunghi', ['Pătrat', 'Cerc', 'Dreptunghi', 'Triunghi'], '/images/questions/shape-rectangle.svg', 'Dreptunghi albastru'],
    ['Logică', 'Ce formă urmează în șir?', 'Cerc', ['Cerc', 'Triunghi', 'Stea', 'Hexagon'], '/images/questions/pattern.svg', 'Șir alternativ cerc, pătrat, cerc, pătrat'],
    ['Vreme', 'Ce fenomen meteo arată imaginea?', 'Ploaie', ['Ninsoare', 'Ploaie', 'Curcubeu', 'Vânt'], '/images/questions/weather-rain.svg', 'Nor cu picături de ploaie'],
    ['Biologie', 'Ce parte a plantei se află în pământ?', 'Rădăcina', ['Floarea', 'Frunza', 'Rădăcina', 'Tulpina'], '/images/questions/plant-parts.svg', 'Plantă cu rădăcini vizibile în sol'],
    ['Geometrie', 'Ce fracție din cerc este colorată?', '1/2', ['1/4', '1/2', '1/3', '3/4'], '/images/questions/fractions-half.svg', 'Jumătate dintr-un cerc colorată'],
    ['Geometrie', 'Ce fracție din cerc este colorată?', '1/4', ['1/2', '1/4', '2/3', '3/4'], '/images/questions/fractions-quarter.svg', 'Un sfert dintr-un cerc colorat'],
    ['Geografie', 'Ce țară are acest drapel?', 'România', ['România', 'Franța', 'Italia', 'Germania'], '/images/questions/romania-flag.svg', 'Drapel vertical albastru, galben și roșu'],
    ['Bani', 'Ce sumă arată imaginea?', '1 leu și 50 bani', ['50 bani', '1 leu', '1 leu și 50 bani', '2 lei'], '/images/questions/coins.svg', 'O monedă de un leu și una de cincizeci de bani'],
    ['Matematică vizuală', 'Pe ce număr este punctul roz?', '4', ['3', '4', '5', '6'], '/images/questions/number-line.svg', 'Axă numerică de la zero la șase cu punct la patru'],
    ['Astronomie', 'Care este planeta albastră din imagine?', 'Pământul', ['Marte', 'Pământul', 'Mercur', 'Saturn'], '/images/questions/solar-order.svg', 'Soarele și mai multe planete stilizate']
  ];

const extraGeneral = [
  ['Geografie', 'Care este capitala României?', 'București', ['Brașov', 'București', 'Iași', 'Cluj-Napoca'], '/images/questions/romania.svg', 'Harta României'],
  ['Geografie', 'Pe ce continent se află România?', 'Europa', ['Asia', 'Africa', 'Europa', 'America de Sud']],
  ['Geografie', 'Care este cel mai mare ocean?', 'Oceanul Pacific', ['Oceanul Atlantic', 'Oceanul Arctic', 'Oceanul Indian', 'Oceanul Pacific']],
  ['Geografie', 'Dunărea este...', 'un fluviu', ['un munte', 'un fluviu', 'un oraș', 'un ocean']],
  ['Geografie', 'Care este un punct cardinal?', 'Nord', ['Sus', 'Nord', 'Rotund', 'Mic']],
  ['Geografie', 'Care este capitala Franței?', 'Paris', ['Roma', 'Paris', 'Madrid', 'Berlin']],
  ['Geografie', 'Care este capitala Italiei?', 'Roma', ['Viena', 'Roma', 'Atena', 'Lisabona']],
  ['Geografie', 'Care este capitala Spaniei?', 'Madrid', ['Barcelona', 'Madrid', 'Sevilla', 'Valencia']],
  ['Geografie', 'Care este capitala Germaniei?', 'Berlin', ['Berlin', 'Munchen', 'Hamburg', 'Bonn']],
  ['Geografie', 'Care este capitala Marii Britanii?', 'Londra', ['Dublin', 'Londra', 'Oxford', 'Manchester']],
  ['Geografie', 'Care este capitala Greciei?', 'Atena', ['Atena', 'Sparta', 'Salonic', 'Sofia']],
  ['Geografie', 'Care este capitala Ungariei?', 'Budapesta', ['Praga', 'Budapesta', 'Bratislava', 'Varșovia']],
  ['Geografie', 'Care este capitala Bulgariei?', 'Sofia', ['Sofia', 'Varna', 'Plovdiv', 'Burgas']],
  ['Geografie', 'Care este capitala Republicii Moldova?', 'Chișinău', ['Bălți', 'Chișinău', 'Cahul', 'Orhei']],
  ['Geografie', 'Ce mare se află la estul României?', 'Marea Neagră', ['Marea Roșie', 'Marea Neagră', 'Marea Baltică', 'Marea Nordului']],
  ['Geografie', 'Ce lanț muntos important se află în România?', 'Carpații', ['Alpii', 'Himalaya', 'Carpații', 'Anzii']],
  ['Geografie', 'Care râu traversează Bucureștiul?', 'Dâmbovița', ['Olt', 'Mureș', 'Dâmbovița', 'Siret']],
  ['Geografie', 'Care este cel mai lung fluviu din Europa?', 'Volga', ['Dunărea', 'Volga', 'Rinul', 'Sena']],
  ['Geografie', 'Ce țară are forma aproximativă a unei cizme?', 'Italia', ['Italia', 'Franța', 'Norvegia', 'Grecia']],
  ['Geografie', 'În ce țară se află Turnul Eiffel?', 'Franța', ['Italia', 'Franța', 'Germania', 'Belgia']],
  ['Geografie', 'În ce oraș se află Colosseumul?', 'Roma', ['Paris', 'Atena', 'Roma', 'Madrid']],
  ['Geografie', 'În ce țară se află piramidele de la Giza?', 'Egipt', ['Egipt', 'Mexic', 'India', 'China']],
  ['Geografie', 'Care este cel mai rece continent?', 'Antarctica', ['Europa', 'Africa', 'Antarctica', 'Asia']],
  ['Geografie', 'Care este cel mai mare continent?', 'Asia', ['Europa', 'Asia', 'Africa', 'Australia']],
  ['Geografie', 'Care continent este cunoscut pentru Sahara?', 'Africa', ['Africa', 'Europa', 'Asia', 'America de Nord']],
  ['Geografie', 'Ce ocean se află între Europa și America?', 'Oceanul Atlantic', ['Oceanul Pacific', 'Oceanul Indian', 'Oceanul Atlantic', 'Oceanul Arctic']],
  ['Geografie', 'Care este capitala Japoniei?', 'Tokyo', ['Kyoto', 'Tokyo', 'Osaka', 'Nagoya']],
  ['Geografie', 'Care este capitala Chinei?', 'Beijing', ['Shanghai', 'Beijing', 'Hong Kong', 'Seul']],
  ['Geografie', 'Care este capitala SUA?', 'Washington, D.C.', ['New York', 'Los Angeles', 'Washington, D.C.', 'Chicago']],
  ['Geografie', 'Care este capitala Canadei?', 'Ottawa', ['Toronto', 'Vancouver', 'Ottawa', 'Montreal']],
  ['Geografie', 'Care este capitala Portugaliei?', 'Lisabona', ['Porto', 'Lisabona', 'Madrid', 'Braga']],
  ['Geografie', 'Ce țară se află la sud de România?', 'Bulgaria', ['Polonia', 'Bulgaria', 'Germania', 'Norvegia']],
  ['Geografie', 'Ce țară se află la vest de România?', 'Ungaria', ['Ungaria', 'Grecia', 'Italia', 'Franța']],
  ['Geografie', 'Ce țară se află la nord de România?', 'Ucraina', ['Serbia', 'Ucraina', 'Bulgaria', 'Turcia']],
  ['Geografie', 'Care este un exemplu de insulă?', 'Sicilia', ['Sicilia', 'Carpații', 'Dunărea', 'Sahara']],
  ['Geografie', 'Care este un exemplu de deșert?', 'Sahara', ['Sahara', 'Amazon', 'Alpi', 'Dunărea']],
  ['Geografie', 'Care este un exemplu de munte?', 'Everest', ['Everest', 'Nil', 'Pacific', 'Sahara']],
  ['Geografie', 'Care este un exemplu de fluviu?', 'Nil', ['Nil', 'Alpi', 'Sahara', 'Atlantic']],
  ['Geografie', 'Unde răsare Soarele?', 'La est', ['La nord', 'La sud', 'La est', 'La vest']],
  ['Geografie', 'Unde apune Soarele?', 'La vest', ['La est', 'La vest', 'La nord', 'La sud']],

  ['Știință', 'Care planetă este numită „Planeta Roșie”?', 'Marte', ['Venus', 'Marte', 'Jupiter', 'Mercur'], '/images/questions/solar-system.svg', 'Planete stilizate'],
  ['Natură', 'Ce proces folosesc plantele pentru a-și produce hrana?', 'Fotosinteza', ['Evaporarea', 'Fotosinteza', 'Înghețarea', 'Topirea']],
  ['Știință', 'La ce temperatură îngheață apa?', '0°C', ['0°C', '10°C', '50°C', '100°C']],
  ['Știință', 'Pământul se învârte în jurul...', 'Soarelui', ['Lunii', 'Soarelui', 'Marte', 'Polului Nord']],
  ['Natură', 'Ce gaz respiră oamenii pentru a trăi?', 'Oxigen', ['Oxigen', 'Heliu', 'Hidrogen', 'Abur']],
  ['Natură', 'Care este satelitul natural al Pământului?', 'Luna', ['Soarele', 'Luna', 'Marte', 'Venus']],
  ['Știință', 'Ce stare are gheața?', 'Solidă', ['Lichidă', 'Solidă', 'Gazoasă', 'Luminoasă']],
  ['Biologie', 'Cu ce respiră peștii?', 'Branhii', ['Plămâni', 'Branhii', 'Aripi', 'Frunze']],
  ['Astronomie', 'Care este steaua sistemului nostru solar?', 'Soarele', ['Luna', 'Soarele', 'Pământul', 'Marte']],
  ['Natură', 'Ce parte a plantei absoarbe apa din sol?', 'Rădăcina', ['Floarea', 'Frunza', 'Rădăcina', 'Fructul']],
  ['Natură', 'Ce parte a plantei produce de obicei semințe?', 'Floarea', ['Rădăcina', 'Floarea', 'Tulpina', 'Scoarța']],
  ['Biologie', 'Ce organ pompează sângele în corp?', 'Inima', ['Creierul', 'Inima', 'Stomacul', 'Plămânul']],
  ['Biologie', 'Cu ce organ vedem?', 'Ochii', ['Urechile', 'Ochii', 'Nasul', 'Pielea']],
  ['Biologie', 'Cu ce organ auzim?', 'Urechile', ['Ochii', 'Urechile', 'Mâinile', 'Dinții']],
  ['Biologie', 'Cu ce organ mirosim?', 'Nasul', ['Nasul', 'Ochii', 'Genunchii', 'Părul']],
  ['Biologie', 'Care organ ne ajută să gândim?', 'Creierul', ['Inima', 'Creierul', 'Stomacul', 'Ficatul']],
  ['Natură', 'Ce animal dă lapte și spune „muu”?', 'Vaca', ['Calul', 'Vaca', 'Pisica', 'Rața']],
  ['Natură', 'Ce animal spune „miau”?', 'Pisica', ['Câinele', 'Pisica', 'Vaca', 'Rața']],
  ['Natură', 'Ce animal spune „ham-ham”?', 'Câinele', ['Câinele', 'Pisica', 'Calul', 'Oaia']],
  ['Natură', 'Ce animal trăiește în apă și are înotătoare?', 'Peștele', ['Peștele', 'Găina', 'Pisica', 'Fluturele']],
  ['Natură', 'Ce insectă produce miere?', 'Albina', ['Furnica', 'Albina', 'Musca', 'Țânțarul']],
  ['Natură', 'Ce animal are trompă?', 'Elefantul', ['Tigrul', 'Elefantul', 'Leul', 'Ursul']],
  ['Natură', 'Ce animal are gât foarte lung?', 'Girafa', ['Girafa', 'Zebra', 'Leul', 'Ursul']],
  ['Natură', 'Ce animal poartă cochilia în spate?', 'Melcul', ['Melcul', 'Furnica', 'Fluturele', 'Broasca']],
  ['Natură', 'Care animal este cunoscut pentru dungi alb-negru?', 'Zebra', ['Zebra', 'Elefantul', 'Leopardul', 'Calul']],
  ['Natură', 'Care animal hibernează adesea iarna?', 'Ursul', ['Ursul', 'Delfinul', 'Girafa', 'Găina']],
  ['Natură', 'Care pasăre nu poate zbura?', 'Pinguinul', ['Rândunica', 'Pinguinul', 'Vulturul', 'Porumbelul']],
  ['Natură', 'Ce pasăre poate imita uneori vocea oamenilor?', 'Papagalul', ['Papagalul', 'Pinguinul', 'Barza', 'Găina']],
  ['Natură', 'Ce animal este numit adesea „regele junglei”?', 'Leul', ['Leul', 'Calul', 'Ursul', 'Iepurele']],
  ['Natură', 'Ce animal este cunoscut pentru viteza sa foarte mare?', 'Ghepardul', ['Ghepardul', 'Broasca țestoasă', 'Panda', 'Koala']],
  ['Știință', 'Apa fierbe în mod obișnuit la...', '100°C', ['0°C', '50°C', '100°C', '200°C']],
  ['Știință', 'Ce se formează când apa îngheață?', 'Gheață', ['Abur', 'Gheață', 'Nisip', 'Fum']],
  ['Știință', 'Cum se numește apa în stare gazoasă?', 'Vapori de apă', ['Gheață', 'Vapori de apă', 'Praf', 'Nisip']],
  ['Știință', 'Ce forță ne ține pe Pământ?', 'Gravitația', ['Lumina', 'Gravitația', 'Sunetul', 'Căldura']],
  ['Știință', 'Ce produce o umbră?', 'Blocarea luminii', ['Sunetul', 'Blocarea luminii', 'Vântul', 'Magnetul']],
  ['Știință', 'Ce ne oferă Soarele în timpul zilei?', 'Lumină și căldură', ['Zăpadă', 'Lumină și căldură', 'Ploaie mereu', 'Vânt mereu']],
  ['Știință', 'Ce instrument măsoară temperatura?', 'Termometrul', ['Rigla', 'Termometrul', 'Ceasul', 'Cântarul']],
  ['Știință', 'Ce obiect atrage unele metale?', 'Magnetul', ['Paharul', 'Magnetul', 'Creionul', 'Prosopul']],
  ['Știință', 'Ce material este atras de un magnet?', 'Fierul', ['Lemnul', 'Fierul', 'Hârtia', 'Sticla']],
  ['Știință', 'Sunetul se aude cu ajutorul...', 'urechilor', ['ochilor', 'urechilor', 'nasului', 'mâinilor']],
  ['Știință', 'Lumina ne ajută să...', 'vedem', ['auzim', 'vedem', 'mirosim', 'gustăm']],
  ['Natură', 'În ce anotimp înfloresc multe plante?', 'Primăvara', ['Iarna', 'Primăvara', 'Toamna', 'Noaptea']],
  ['Natură', 'În ce anotimp sunt de obicei temperaturile cele mai ridicate?', 'Vara', ['Vara', 'Iarna', 'Toamna', 'Primăvara']],
  ['Natură', 'În ce anotimp cad multe frunze din copaci?', 'Toamna', ['Primăvara', 'Vara', 'Toamna', 'Iarna']],
  ['Natură', 'În ce anotimp ninge cel mai des?', 'Iarna', ['Primăvara', 'Vara', 'Toamna', 'Iarna']],
  ['Natură', 'Ce fenomen apare după ploaie când Soarele luminează picăturile de apă?', 'Curcubeul', ['Fulgerul', 'Curcubeul', 'Ceața', 'Vântul']],
  ['Natură', 'Ce formă de precipitație este formată din fulgi?', 'Ninsoarea', ['Ploaia', 'Ninsoarea', 'Ceața', 'Vântul']],
  ['Natură', 'Norii sunt formați în principal din...', 'picături mici de apă și cristale de gheață', ['nisip', 'fum', 'picături mici de apă și cristale de gheață', 'frunze']],
  ['Natură', 'Ce fenomen produce lumină puternică în timpul furtunii?', 'Fulgerul', ['Curcubeul', 'Fulgerul', 'Ceața', 'Bruma']],
  ['Natură', 'Ce se aude după un fulger?', 'Tunetul', ['Tunetul', 'Ecoul', 'Muzica', 'Șoapta']],
  ['Biologie', 'Câte picioare are de obicei un păianjen?', '8', ['4', '6', '8', '10']],
  ['Biologie', 'Câte picioare are o insectă?', '6', ['4', '6', '8', '10']],
  ['Biologie', 'Ce acoperă corpul păsărilor?', 'Penele', ['Blana', 'Penele', 'Solzii', 'Scoarța']],
  ['Biologie', 'Ce acoperă corpul peștilor?', 'Solzii', ['Penele', 'Solzii', 'Blana', 'Lâna']],
  ['Biologie', 'Ce folosesc păsările pentru a zbura?', 'Aripile', ['Înotătoarele', 'Aripile', 'Coarnele', 'Labele']],
  ['Biologie', 'Ce produc găinile?', 'Ouă', ['Lapte', 'Ouă', 'Miere', 'Lână']],
  ['Biologie', 'De la ce animal obținem lână?', 'Oaia', ['Oaia', 'Pisica', 'Găina', 'Rața']],
  ['Natură', 'Ce copac produce ghinde?', 'Stejarul', ['Mărul', 'Stejarul', 'Bradul', 'Cireșul']],
  ['Natură', 'Ce copac rămâne de obicei verde iarna?', 'Bradul', ['Bradul', 'Mărul', 'Cireșul', 'Prunul']],
  ['Natură', 'Ce fruct crește într-un măr?', 'Mărul', ['Piersica', 'Mărul', 'Pruna', 'Para']],

  ['Limbă', 'Care este antonimul cuvântului „rapid”?', 'lent', ['repede', 'lent', 'mare', 'vesel']],
  ['Limbă', 'Care cuvânt este scris corect?', 'copil', ['copill', 'copil', 'kopil', 'copiil']],
  ['Limbă', 'Care semn încheie de obicei o întrebare?', '?', ['.', '!', '?', ',']],
  ['Limbă', 'Care este pluralul cuvântului „copil”?', 'copii', ['copili', 'copii', 'copile', 'copiii']],
  ['Limbă', 'Care este pluralul cuvântului „carte”?', 'cărți', ['carte', 'cărți', 'carturi', 'cărții']],
  ['Limbă', 'Care este pluralul cuvântului „floare”?', 'flori', ['floare', 'flori', 'floari', 'floruri']],
  ['Limbă', 'Care este antonimul cuvântului „mare”?', 'mic', ['înalt', 'mic', 'lung', 'lat']],
  ['Limbă', 'Care este antonimul cuvântului „cald”?', 'rece', ['rece', 'moale', 'repede', 'greu']],
  ['Limbă', 'Care este antonimul cuvântului „vesel”?', 'trist', ['trist', 'rapid', 'mic', 'curat']],
  ['Limbă', 'Care este antonimul cuvântului „sus”?', 'jos', ['mare', 'jos', 'repede', 'aproape']],
  ['Limbă', 'Care este sinonimul cuvântului „fericit”?', 'bucuros', ['trist', 'bucuros', 'obosit', 'mic']],
  ['Limbă', 'Care este sinonimul cuvântului „rapid”?', 'repede', ['repede', 'încet', 'mare', 'rece']],
  ['Limbă', 'Care cuvânt denumește o persoană?', 'copil', ['copil', 'masă', 'aleargă', 'verde']],
  ['Limbă', 'Care cuvânt denumește un obiect?', 'creion', ['repede', 'creion', 'cântă', 'frumos']],
  ['Limbă', 'Care cuvânt denumește o acțiune?', 'aleargă', ['masă', 'aleargă', 'albastru', 'copil']],
  ['Limbă', 'Care cuvânt arată o însușire?', 'frumos', ['frumos', 'merge', 'copil', 'ghiozdan']],
  ['Limbă', 'Cu ce literă începe cuvântul „școală”?', 'ș', ['s', 'ș', 'c', 'a']],
  ['Limbă', 'Cu ce literă începe cuvântul „mere”?', 'm', ['n', 'm', 'r', 'e']],
  ['Limbă', 'Care cuvânt începe cu litera „P”?', 'pisică', ['casă', 'pisică', 'masă', 'floare']],
  ['Limbă', 'Care cuvânt se termină cu litera „a”?', 'masa', ['copil', 'masa', 'pom', 'tren']],
  ['Limbă', 'Câte silabe are cuvântul „ma-ma”?', '2', ['1', '2', '3', '4']],
  ['Limbă', 'Câte silabe are cuvântul „ca-să”?', '2', ['1', '2', '3', '4']],
  ['Limbă', 'Câte silabe are cuvântul „a-ni-mal”?', '3', ['1', '2', '3', '4']],
  ['Limbă', 'Care propoziție este o întrebare?', 'Unde mergi?', ['Unde mergi?', 'Merg la școală.', 'Ce zi frumoasă!', 'Deschid cartea.']],
  ['Limbă', 'Care propoziție exprimă mirare?', 'Ce frumos!', ['Merg acasă.', 'Ce frumos!', 'Unde e cartea?', 'Eu citesc.']],
  ['Limbă', 'Ce semn folosim la finalul unei exclamații?', '!', ['.', '!', '?', ',']],
  ['Limbă', 'Ce semn folosim la finalul unei propoziții obișnuite?', '.', ['.', '!', '?', ':']],
  ['Limbă', 'Ce semn folosim pentru a despărți uneori elementele unei enumerări?', 'Virgula', ['Punctul', 'Virgula', 'Ghilimelele', 'Paranteza']],
  ['Limbă', 'Care cuvânt este scris cu diacritice corect?', 'țară', ['tara', 'țară', 'târă', 'țarra']],
  ['Limbă', 'Care cuvânt este scris corect?', 'școală', ['scoala', 'școală', 'școallă', 'scoală']],
  ['Limbă', 'Care cuvânt este nume de animal?', 'câine', ['câine', 'masă', 'verde', 'aleargă']],
  ['Limbă', 'Care cuvânt este nume de plantă?', 'trandafir', ['trandafir', 'nor', 'ușă', 'tren']],
  ['Limbă', 'Care cuvânt este nume de loc?', 'parc', ['parc', 'vesel', 'aleargă', 'albastru']],
  ['Limbă', 'Care este diminutivul uzual pentru „casă”?', 'căsuță', ['căsuță', 'casoi', 'case', 'căsesc']],
  ['Limbă', 'Care este diminutivul uzual pentru „floare”?', 'floricică', ['floricică', 'floroi', 'floresc', 'floarelor']],
  ['Limbă', 'Care cuvânt rimează cu „soare”?', 'floare', ['floare', 'masă', 'copil', 'tren']],
  ['Limbă', 'Care cuvânt rimează cu „casă”?', 'masă', ['masă', 'copil', 'nor', 'drum']],
  ['Limbă', 'Care este forma corectă?', 'copiii se joacă', ['copii se joacă', 'copiii se joacă', 'copiii se joace', 'copiii se joakă']],
  ['Limbă', 'Care este forma corectă?', 'eu citesc', ['eu citesc', 'eu citește', 'eu citi', 'eu citesci']],
  ['Limbă', 'Care este forma corectă?', 'noi mergem', ['noi merge', 'noi mergem', 'noi mergi', 'noi mers']],

  ['Istorie', 'Ce sărbătorim în România la 1 Decembrie?', 'Ziua Națională', ['Ziua Copilului', 'Ziua Națională', 'Anul Nou', 'Ziua Europei']],
  ['Istorie', 'În ce zi sărbătorim Ziua Copilului în România?', '1 iunie', ['1 ianuarie', '1 martie', '1 iunie', '1 decembrie']],
  ['Educație civică', 'Ce faci înainte să traversezi strada?', 'Te asiguri', ['Alergi imediat', 'Te asiguri', 'Închizi ochii', 'Te întorci cu spatele']],
  ['Educație civică', 'La culoarea roșie a semaforului pentru pietoni...', 'te oprești', ['alergi', 'te oprești', 'traversezi repede', 'mergi cu spatele']],
  ['Educație civică', 'La culoarea verde a semaforului pentru pietoni...', 'poți traversa după ce te asiguri', ['închizi ochii', 'poți traversa după ce te asiguri', 'stai mereu pe loc', 'alergi fără să te uiți']],
  ['Educație civică', 'Cum te porți într-o bibliotecă?', 'Vorbești încet', ['Strigi', 'Vorbești încet', 'Alergi printre rafturi', 'Arunci cărți']],
  ['Educație civică', 'Ce spui când primești ceva?', 'Mulțumesc', ['Nu vreau', 'Mulțumesc', 'Pleacă', 'Taci']],
  ['Educație civică', 'Ce spui când ceri ceva politicos?', 'Te rog', ['Te rog', 'Dă-mi', 'Acum', 'Pleacă']],
  ['Educație civică', 'Ce faci dacă găsești un obiect care nu este al tău la școală?', 'Îl predai unui adult', ['Îl păstrezi', 'Îl ascunzi', 'Îl predai unui adult', 'Îl arunci']],
  ['Educație civică', 'Ce faci dacă vezi un coleg căzut și rănit?', 'Chemi un adult și îl ajuți în siguranță', ['Râzi', 'Pleci', 'Chemi un adult și îl ajuți în siguranță', 'Îl împingi']],
  ['Siguranță', 'Numărul unic de urgență în România și UE este...', '112', ['111', '112', '911', '999']],
  ['Siguranță', 'Dacă simți miros de fum într-o clădire, ce faci?', 'Anunți imediat un adult și ieși în siguranță', ['Te ascunzi', 'Anunți imediat un adult și ieși în siguranță', 'Deschizi focul', 'Rămâi singur']],
  ['Siguranță', 'Este sigur să te joci cu prizele electrice?', 'Nu', ['Da', 'Nu', 'Doar seara', 'Doar dacă sunt multe']],
  ['Siguranță', 'Când mergi cu bicicleta, ce obiect te protejează capul?', 'Casca', ['Șapca', 'Casca', 'Mănușa', 'Eșarfa']],
  ['Educație civică', 'De ce respectăm regulile clasei?', 'Pentru siguranță și bună înțelegere', ['Ca să fie gălăgie', 'Pentru siguranță și bună înțelegere', 'Ca să întârziem', 'Ca să nu învățăm']],
  ['Educație civică', 'Ce înseamnă să fii punctual?', 'Să ajungi la timp', ['Să întârzii mereu', 'Să ajungi la timp', 'Să uiți ora', 'Să pleci fără să spui']],
  ['Educație civică', 'Ce înseamnă să îți respecți colegii?', 'Să vorbești și să te porți politicos', ['Să îi jignești', 'Să vorbești și să te porți politicos', 'Să îi ignori mereu', 'Să le iei lucrurile']],
  ['Istorie', 'Cine a fost Mihai Viteazul?', 'Un domnitor român', ['Un pictor', 'Un domnitor român', 'Un astronaut', 'Un compozitor']],
  ['Istorie', 'Cine a fost Ștefan cel Mare?', 'Un domnitor al Moldovei', ['Un domnitor al Moldovei', 'Un împărat roman', 'Un scriitor francez', 'Un explorator']],
  ['Istorie', 'Cine a fost Alexandru Ioan Cuza?', 'Domnitorul Principatelor Unite', ['Un astronaut', 'Domnitorul Principatelor Unite', 'Un pictor', 'Un inventator']],
  ['Istorie', 'În ce an a avut loc Marea Unire?', '1918', ['1848', '1859', '1918', '2007']],
  ['Istorie', 'Unirea Principatelor Române este legată de anul...', '1859', ['1600', '1859', '1918', '1989']],
  ['Istorie', 'Care este una dintre culorile drapelului României?', 'Albastru', ['Mov', 'Albastru', 'Roz', 'Maro']],
  ['Istorie', 'Drapelul României are culorile...', 'albastru, galben și roșu', ['verde, alb și roșu', 'albastru, galben și roșu', 'negru, alb și verde', 'mov, roz și portocaliu']],
  ['Educație civică', 'Care este limba oficială a României?', 'Limba română', ['Limba română', 'Limba italiană', 'Limba germană', 'Limba japoneză']],

  ['Măsurători', 'Cu ce unitate măsurăm lungimea unei camere?', 'Metru', ['Litru', 'Metru', 'Kilogram', 'Minut']],
  ['Măsurători', 'Cu ce unitate măsurăm masa unui ghiozdan?', 'Kilogram', ['Metru', 'Litru', 'Kilogram', 'Oră']],
  ['Geometrie', 'Câte laturi are un hexagon?', '6', ['4', '5', '6', '8']],
  ['Geometrie', 'Câte laturi are un triunghi?', '3', ['2', '3', '4', '5']],
  ['Geometrie', 'Câte laturi are un pătrat?', '4', ['3', '4', '5', '6']],
  ['Geometrie', 'Câte colțuri are un dreptunghi?', '4', ['2', '3', '4', '6']],
  ['Geometrie', 'Ce figură geometrică are 3 laturi?', 'Triunghiul', ['Cercul', 'Pătratul', 'Triunghiul', 'Hexagonul']],
  ['Geometrie', 'Ce figură geometrică nu are laturi?', 'Cercul', ['Triunghiul', 'Cercul', 'Pătratul', 'Dreptunghiul']],
  ['Geometrie', 'Ce figură are toate cele 4 laturi egale?', 'Pătratul', ['Dreptunghiul', 'Pătratul', 'Triunghiul', 'Cercul']],
  ['Geometrie', 'Ce corp geometric seamănă cu o minge?', 'Sfera', ['Cubul', 'Sfera', 'Cilindrul', 'Conul']],
  ['Geometrie', 'Ce corp geometric seamănă cu o cutie cu fețe pătrate?', 'Cubul', ['Cubul', 'Sfera', 'Conul', 'Cilindrul']],
  ['Geometrie', 'Ce corp geometric seamănă cu un zar?', 'Cubul', ['Conul', 'Cubul', 'Sfera', 'Piramida']],
  ['Geometrie', 'Ce corp geometric seamănă cu o doză de suc?', 'Cilindrul', ['Sfera', 'Cubul', 'Cilindrul', 'Piramida']],
  ['Geometrie', 'Ce corp geometric seamănă cu un cornet de înghețată?', 'Conul', ['Cubul', 'Sfera', 'Conul', 'Cilindrul']],
  ['Măsurători', 'Cu ce unitate măsurăm lichidele?', 'Litru', ['Metru', 'Litru', 'Kilogram', 'Secundă']],
  ['Măsurători', 'Cu ce unitate măsurăm timpul scurt?', 'Secundă', ['Litru', 'Metru', 'Secundă', 'Kilogram']],
  ['Măsurători', 'Cu ce instrument măsurăm lungimea unui caiet?', 'Rigla', ['Termometrul', 'Rigla', 'Cântarul', 'Ceasul']],
  ['Măsurători', 'Cu ce instrument măsurăm masa?', 'Cântarul', ['Rigla', 'Cântarul', 'Ceasul', 'Busola']],
  ['Măsurători', 'Cu ce instrument măsurăm timpul?', 'Ceasul', ['Ceasul', 'Termometrul', 'Rigla', 'Busola']],
  ['Măsurători', 'Câți centimetri are un metru?', '100', ['10', '50', '100', '1000']],
  ['Măsurători', 'Câte minute are o oră?', '60', ['30', '45', '60', '100']],
  ['Măsurători', 'Câte secunde are un minut?', '60', ['10', '30', '60', '100']],
  ['Timp', 'Câte ore are o zi?', '24', ['12', '18', '24', '48']],
  ['Timp', 'Câte zile are o săptămână?', '7', ['5', '6', '7', '8']],
  ['Timp', 'Câte luni are un an?', '12', ['10', '11', '12', '13']],
  ['Timp', 'Ce zi vine după luni?', 'Marți', ['Duminică', 'Marți', 'Vineri', 'Sâmbătă']],
  ['Timp', 'Ce zi vine după vineri?', 'Sâmbătă', ['Luni', 'Joi', 'Sâmbătă', 'Duminică']],
  ['Timp', 'Ce lună vine după ianuarie?', 'Februarie', ['Martie', 'Februarie', 'Decembrie', 'Aprilie']],
  ['Timp', 'Ce lună vine după iunie?', 'Iulie', ['Mai', 'Iulie', 'August', 'Septembrie']],
  ['Timp', 'Care este prima lună a anului?', 'Ianuarie', ['Ianuarie', 'Martie', 'Iunie', 'Decembrie']],
  ['Timp', 'Care este ultima lună a anului?', 'Decembrie', ['Octombrie', 'Noiembrie', 'Decembrie', 'Ianuarie']],
  ['Măsurători', 'Ce este mai lung: 1 metru sau 50 centimetri?', '1 metru', ['50 centimetri', '1 metru', 'Sunt egale', 'Nu se pot compara']],
  ['Măsurători', 'Ce este mai greu în mod obișnuit: un creion sau un ghiozdan plin?', 'Un ghiozdan plin', ['Un creion', 'Un ghiozdan plin', 'Au aceeași masă', 'Nu se pot compara']],
  ['Măsurători', 'Ce unitate este potrivită pentru înălțimea unui copil?', 'Centimetrul', ['Litru', 'Centimetrul', 'Kilogramul', 'Secunda']],
  ['Măsurători', 'Ce unitate este potrivită pentru apa dintr-o sticlă?', 'Litru', ['Litru', 'Metru', 'Kilogram', 'Minut']],

  ['Informatică', 'Care dispozitiv este folosit pentru a tasta?', 'Tastatura', ['Monitorul', 'Tastatura', 'Boxa', 'Imprimanta']],
  ['Informatică', 'Ce dispozitiv afișează imaginile calculatorului?', 'Monitorul', ['Mouse-ul', 'Monitorul', 'Tastatura', 'Microfonul']],
  ['Informatică', 'Ce dispozitiv mișcă de obicei cursorul pe ecran?', 'Mouse-ul', ['Mouse-ul', 'Imprimanta', 'Boxa', 'Routerul']],
  ['Informatică', 'Ce dispozitiv tipărește pe hârtie?', 'Imprimanta', ['Imprimanta', 'Monitorul', 'Mouse-ul', 'Microfonul']],
  ['Informatică', 'Ce dispozitiv redă sunetul?', 'Boxele', ['Boxele', 'Tastatura', 'Scannerul', 'Mouse-ul']],
  ['Informatică', 'Ce dispozitiv poate înregistra vocea?', 'Microfonul', ['Microfonul', 'Monitorul', 'Imprimanta', 'Mouse-ul']],
  ['Informatică', 'Ce înseamnă să salvezi un fișier?', 'Să păstrezi modificările', ['Să ștergi calculatorul', 'Să păstrezi modificările', 'Să închizi internetul', 'Să tipărești automat']],
  ['Informatică', 'Ce este un fișier?', 'O informație salvată pe un dispozitiv', ['Un cablu', 'O informație salvată pe un dispozitiv', 'Un scaun', 'Un difuzor']],
  ['Informatică', 'Ce este un folder?', 'Un loc unde organizăm fișiere', ['Un joc', 'Un loc unde organizăm fișiere', 'Un monitor', 'Un cablu']],
  ['Informatică', 'Ce program folosim pentru a vizita site-uri web?', 'Browserul', ['Browserul', 'Calculatorul de buzunar', 'Scannerul', 'Ceasul']],
  ['Informatică', 'Care este un browser web?', 'Chrome', ['Chrome', 'Word', 'Paint', 'Calculator']],
  ['Informatică', 'Ce este internetul?', 'O rețea mare de calculatoare și dispozitive conectate', ['Un singur joc', 'O rețea mare de calculatoare și dispozitive conectate', 'Un creion', 'O imprimantă']],
  ['Informatică', 'Este bine să spui parola ta oricui?', 'Nu', ['Da', 'Nu', 'Doar online', 'Doar în jocuri']],
  ['Siguranță online', 'Ce trebuie să faci dacă un necunoscut îți cere parola?', 'Nu o dai și anunți un adult', ['O trimiți', 'Nu o dai și anunți un adult', 'O postezi public', 'O scrii pe internet']],
  ['Siguranță online', 'Este sigur să dai adresa de acasă unui necunoscut online?', 'Nu', ['Da', 'Nu', 'Doar dacă are poză', 'Doar seara']],
  ['Siguranță online', 'Ce faci dacă vezi un mesaj online care te sperie?', 'Anunți un adult de încredere', ['Îl trimiți tuturor', 'Anunți un adult de încredere', 'Răspunzi cu parola', 'Îl publici']],
  ['Informatică', 'Ce tastă folosim adesea pentru a crea un spațiu între cuvinte?', 'Space', ['Enter', 'Space', 'Shift', 'Esc']],
  ['Informatică', 'Ce tastă folosim adesea pentru a trece pe un rând nou?', 'Enter', ['Enter', 'Space', 'Caps Lock', 'Alt']],
  ['Informatică', 'Ce tastă șterge de obicei caracterul din stânga cursorului?', 'Backspace', ['Shift', 'Backspace', 'Tab', 'Ctrl']],
  ['Informatică', 'Ce înseamnă „click”?', 'Apăsarea unui buton al mouse-ului', ['Închiderea monitorului', 'Apăsarea unui buton al mouse-ului', 'Tipărirea', 'Pornirea boxelor']],
  ['Informatică', 'Ce este o aplicație?', 'Un program care face anumite lucruri', ['Un cablu', 'Un program care face anumite lucruri', 'O foaie', 'Un mouse']],
  ['Informatică', 'Ce este o pictogramă?', 'Un mic simbol grafic pentru o aplicație sau funcție', ['O parolă', 'Un mic simbol grafic pentru o aplicație sau funcție', 'Un cablu', 'O imprimantă']],
  ['Informatică', 'Ce face butonul „Play” într-un joc?', 'Pornește jocul sau redarea', ['Șterge calculatorul', 'Pornește jocul sau redarea', 'Închide internetul', 'Tipărește']],
  ['Informatică', 'Ce face butonul „Pause”?', 'Oprește temporar jocul sau redarea', ['Șterge jocul', 'Oprește temporar jocul sau redarea', 'Mărește volumul mereu', 'Închide calculatorul']],
  ['Informatică', 'Care este un exemplu de dispozitiv portabil?', 'Tableta', ['Tableta', 'Tabla de scris', 'Creta', 'Caietul']],

  ['Astronomie', 'Pe ce planetă trăim?', 'Pământ', ['Marte', 'Pământ', 'Venus', 'Jupiter']],
  ['Astronomie', 'Care este cea mai apropiată stea de Pământ?', 'Soarele', ['Luna', 'Soarele', 'Marte', 'Venus']],
  ['Astronomie', 'Cum se numește satelitul natural al Pământului?', 'Luna', ['Soarele', 'Luna', 'Marte', 'Mercur']],
  ['Astronomie', 'Care planetă este cea mai apropiată de Soare?', 'Mercur', ['Mercur', 'Pământ', 'Saturn', 'Neptun']],
  ['Astronomie', 'Care este cea mai mare planetă din Sistemul Solar?', 'Jupiter', ['Marte', 'Jupiter', 'Mercur', 'Venus']],
  ['Astronomie', 'Ce planetă este cunoscută pentru inelele sale?', 'Saturn', ['Saturn', 'Marte', 'Pământ', 'Mercur']],
  ['Astronomie', 'Soarele este...', 'o stea', ['o planetă', 'o stea', 'un satelit', 'un asteroid']],
  ['Astronomie', 'Luna este...', 'un satelit natural', ['o stea', 'un satelit natural', 'un ocean', 'un continent']],
  ['Astronomie', 'Cum se numește drumul unei planete în jurul Soarelui?', 'Orbită', ['Orbită', 'Stradă', 'Pistă', 'Linie']],
  ['Astronomie', 'Ce vedem adesea pe cer noaptea?', 'Stelele', ['Curcubeul mereu', 'Stelele', 'Soarele mereu', 'Norii doar']],
  ['Astronomie', 'Ce instrument folosim pentru a observa mai bine stelele?', 'Telescopul', ['Microscopul', 'Telescopul', 'Termometrul', 'Cântarul']],
  ['Astronomie', 'Cine călătorește în spațiu?', 'Astronautul', ['Astronautul', 'Fermierul', 'Poștașul', 'Brutarul']],
  ['Astronomie', 'Cum se numește vehiculul care poate ajunge în spațiu?', 'Racheta', ['Racheta', 'Bicicleta', 'Trenul', 'Barca']],
  ['Astronomie', 'Ce planetă este numită uneori „planeta albastră”?', 'Pământul', ['Pământul', 'Marte', 'Mercur', 'Venus']],
  ['Astronomie', 'Câte planete sunt în Sistemul Solar?', '8', ['7', '8', '9', '10']],
  ['Astronomie', 'Pluto este considerat astăzi...', 'planetă pitică', ['stea', 'planetă pitică', 'cometă', 'galaxie']],
  ['Astronomie', 'Ce este o cometă?', 'Un corp ceresc cu gheață și praf', ['Un animal', 'Un corp ceresc cu gheață și praf', 'Un ocean', 'Un munte']],
  ['Astronomie', 'Ce se întâmplă când Pământul se rotește în jurul axei sale?', 'Se succed ziua și noaptea', ['Apare o nouă planetă', 'Se succed ziua și noaptea', 'Dispare Luna', 'Se oprește Soarele']],
  ['Astronomie', 'Aproximativ cât durează o rotație completă a Pământului în jurul axei sale?', '24 de ore', ['12 ore', '24 de ore', '7 zile', '30 de zile']],
  ['Astronomie', 'Aproximativ cât durează mișcarea Pământului în jurul Soarelui?', 'Un an', ['O zi', 'O săptămână', 'O lună', 'Un an']],

  ['Muzică', 'Câte note are gama Do-Re-Mi-Fa-Sol-La-Si?', '7', ['5', '6', '7', '8']],
  ['Muzică', 'Ce instrument are clape albe și negre?', 'Pianul', ['Pianul', 'Toba', 'Fluierul', 'Trompeta']],
  ['Muzică', 'Ce instrument are corzi și se cântă adesea cu arcușul?', 'Vioara', ['Vioara', 'Toba', 'Flautul', 'Trompeta']],
  ['Muzică', 'Ce instrument are de obicei șase corzi?', 'Chitara', ['Chitara', 'Toba', 'Flautul', 'Xilofonul']],
  ['Muzică', 'Ce instrument se lovește cu bețe?', 'Toba', ['Toba', 'Vioara', 'Flautul', 'Chitara']],
  ['Muzică', 'Care dintre acestea este o notă muzicală?', 'Do', ['Do', 'Ro', 'Pa', 'Zu']],
  ['Muzică', 'Ce înseamnă să cânți în ritm?', 'Să păstrezi măsura muzicii', ['Să cânți foarte tare', 'Să păstrezi măsura muzicii', 'Să vorbești', 'Să alergi']],

  ['Artă', 'Care sunt culorile primare folosite frecvent în pictură?', 'Roșu, galben și albastru', ['Roșu, galben și albastru', 'Roz, maro și gri', 'Negru, alb și verde', 'Portocaliu, mov și roz']],
  ['Artă', 'Ce obții dacă amesteci albastru cu galben?', 'Verde', ['Verde', 'Roșu', 'Mov', 'Negru']],
  ['Artă', 'Ce obții dacă amesteci roșu cu galben?', 'Portocaliu', ['Verde', 'Portocaliu', 'Albastru', 'Maro']],
  ['Artă', 'Ce obții dacă amesteci roșu cu albastru?', 'Mov', ['Mov', 'Galben', 'Verde', 'Alb']],
  ['Artă', 'Cu ce putem desena pe hârtie?', 'Creionul', ['Creionul', 'Lingura', 'Perna', 'Farfuria']],
  ['Artă', 'Ce folosim pentru a picta cu acuarele?', 'Pensula', ['Pensula', 'Furculița', 'Rigla', 'Lingura']],
  ['Artă', 'Ce este un portret?', 'O imagine a unei persoane', ['O hartă', 'O imagine a unei persoane', 'Un cântec', 'O problemă']],
  ['Artă', 'Ce este un peisaj?', 'O imagine a naturii sau a unui loc', ['O imagine a naturii sau a unui loc', 'O formulă', 'Un sunet', 'O poveste doar cu cifre']],

  ['Mediu', 'Unde aruncăm hârtia pentru reciclare?', 'În recipientul pentru hârtie', ['Pe stradă', 'În râu', 'În recipientul pentru hârtie', 'În foc']],
  ['Mediu', 'De ce este bine să reciclăm?', 'Pentru a reduce deșeurile și a proteja mediul', ['Ca să facem mai mult gunoi', 'Pentru a reduce deșeurile și a proteja mediul', 'Ca să murdărim apa', 'Ca să tăiem mai mulți copaci']],
  ['Mediu', 'Ce putem face pentru a economisi apă?', 'Închidem robinetul când nu îl folosim', ['Lăsăm apa să curgă mereu', 'Închidem robinetul când nu îl folosim', 'Umplem podeaua cu apă', 'Pornim toate robinetele']],
  ['Mediu', 'Ce putem face pentru a economisi energie?', 'Stingem lumina când ieșim din cameră', ['Lăsăm toate becurile aprinse', 'Stingem lumina când ieșim din cameră', 'Pornim toate aparatele', 'Deschidem frigiderul mereu']],
  ['Mediu', 'Ce plantăm pentru a ajuta natura?', 'Copaci', ['Copaci', 'Plastic', 'Sticlă', 'Metal']],
  ['Mediu', 'Unde este bine să aruncăm gunoiul?', 'În coșul de gunoi', ['Pe stradă', 'În coșul de gunoi', 'În parc', 'În râu']],

  ['Sănătate', 'De ce ne spălăm pe mâini?', 'Pentru a îndepărta murdăria și microbii', ['Pentru a uda podeaua', 'Pentru a îndepărta murdăria și microbii', 'Pentru a răci camera', 'Pentru a murdări prosopul']],
  ['Sănătate', 'Când este bine să ne spălăm pe mâini?', 'Înainte de masă și după folosirea toaletei', ['Doar o dată pe lună', 'Înainte de masă și după folosirea toaletei', 'Niciodată', 'Doar iarna']],
  ['Sănătate', 'De ce ne spălăm pe dinți?', 'Pentru a menține dinții curați și sănătoși', ['Pentru a colora dinții', 'Pentru a menține dinții curați și sănătoși', 'Pentru a uda periuța', 'Pentru a face zgomot']],
  ['Sănătate', 'Ce băutură este importantă pentru hidratare?', 'Apa', ['Apa', 'Vopseaua', 'Uleiul', 'Cerneala']],
  ['Sănătate', 'Ce ajută corpul să se odihnească?', 'Somnul', ['Somnul', 'Zgomotul', 'Alergatul toată noaptea', 'Lumina puternică']],
  ['Sănătate', 'Ce aliment face parte din categoria fructelor?', 'Mărul', ['Mărul', 'Pâinea', 'Brânza', 'Orezul']],
  ['Sănătate', 'Ce aliment face parte din categoria legumelor?', 'Morcovul', ['Morcovul', 'Mărul', 'Pâinea', 'Iaurtul']],
  ['Sănătate', 'Ce obicei este sănătos?', 'Mișcarea regulată', ['Să nu dormi', 'Mișcarea regulată', 'Să nu bei apă', 'Să sari mesele']],

  ['Viață de zi cu zi', 'Cu ce obiect ne protejăm de ploaie?', 'Umbrela', ['Umbrela', 'Furculița', 'Perna', 'Creionul']],
  ['Viață de zi cu zi', 'Ce obiect folosim pentru a tăia hârtia?', 'Foarfeca', ['Foarfeca', 'Lingura', 'Perna', 'Cana']],
  ['Viață de zi cu zi', 'Ce obiect folosim pentru a șterge tabla?', 'Buretele', ['Buretele', 'Furculița', 'Pantoful', 'Cana']],
  ['Viață de zi cu zi', 'Ce obiect folosim pentru a scrie cu cerneală?', 'Stiloul', ['Stiloul', 'Lingura', 'Perna', 'Farfuria']],
  ['Viață de zi cu zi', 'Ce obiect folosim pentru a transporta cărțile la școală?', 'Ghiozdanul', ['Ghiozdanul', 'Umbrela', 'Farfuria', 'Prosopul']],
  ['Viață de zi cu zi', 'Ce încăpere este folosită de obicei pentru gătit?', 'Bucătăria', ['Bucătăria', 'Dormitorul', 'Balconul', 'Garajul']],

  ['Cultură generală', 'Ce culoare are iarba de obicei?', 'Verde', ['Verde', 'Mov', 'Negru', 'Portocaliu']],
  ['Cultură generală', 'Ce culoare are zăpada de obicei?', 'Albă', ['Albă', 'Verde', 'Albastră', 'Roșie']],
  ['Cultură generală', 'Ce culoare are cărbunele de obicei?', 'Negru', ['Alb', 'Negru', 'Roz', 'Galben']],
  ['Cultură generală', 'Ce obiect arată ora?', 'Ceasul', ['Ceasul', 'Cana', 'Perna', 'Furculița']],
  ['Cultură generală', 'Ce folosim pentru a deschide o ușă încuiată?', 'Cheia', ['Cheia', 'Lingura', 'Creionul', 'Perna']],
  ['Cultură generală', 'Ce mijloc de transport merge pe șine?', 'Trenul', ['Trenul', 'Barca', 'Avionul', 'Bicicleta']],
  ['Cultură generală', 'Ce mijloc de transport zboară?', 'Avionul', ['Avionul', 'Autobuzul', 'Trenul', 'Barca']],
  ['Cultură generală', 'Ce mijloc de transport merge pe apă?', 'Barca', ['Barca', 'Mașina', 'Trenul', 'Bicicleta']],
  ['Cultură generală', 'Ce obiect folosim pentru a telefona?', 'Telefonul', ['Telefonul', 'Lingura', 'Perna', 'Caietul']],
  ['Cultură generală', 'Ce obiect folosim pentru a fotografia?', 'Aparatul foto', ['Aparatul foto', 'Cana', 'Perna', 'Mătura']],
  ['Cultură generală', 'Care animal trăiește de obicei într-un acvariu?', 'Peștele', ['Peștele', 'Calul', 'Câinele', 'Găina']],
  ['Cultură generală', 'Care animal trăiește de obicei într-un stup?', 'Albina', ['Albina', 'Vaca', 'Calul', 'Pisica']],
  ['Cultură generală', 'Care animal trăiește de obicei într-o vizuină?', 'Vulpea', ['Vulpea', 'Delfinul', 'Găina', 'Girafa']],
  ['Cultură generală', 'Ce aliment se face de obicei din lapte?', 'Brânza', ['Brânza', 'Pâinea', 'Orezul', 'Mărul']],
  ['Cultură generală', 'Ce aliment se obține din grâu?', 'Pâinea', ['Pâinea', 'Mierea', 'Iaurtul', 'Mărul']],
  ['Cultură generală', 'Ce fruct este galben și curbat?', 'Banana', ['Banana', 'Cireșa', 'Pruna', 'Căpșuna']],
  ['Cultură generală', 'Ce fruct este de obicei roșu și are semințe mici la exterior?', 'Căpșuna', ['Căpșuna', 'Banana', 'Para', 'Pruna']],
  ['Cultură generală', 'Ce legumă este de obicei portocalie?', 'Morcovul', ['Morcovul', 'Vânăta', 'Varza', 'Castravetele']],
  ['Cultură generală', 'Ce legumă este de obicei verde și lungă?', 'Castravetele', ['Castravetele', 'Morcovul', 'Sfecla', 'Conopida']],
  ['Cultură generală', 'Ce obiect folosim pentru a mătura podeaua?', 'Mătura', ['Mătura', 'Lingura', 'Creionul', 'Perna']],
];

  let gid = 1;
  for (let grade = 1; grade <= 4; grade++) {
    for (const q of commonGeneral) bank.push(makeBankQuestion(`general-${grade}-${gid++}`, grade, 'general', q[0], q[1], q[2], q[3], q[4] || null, q[5] || ''));
    for (const q of imageGeneral) bank.push(makeBankQuestion(`general-${grade}-${gid++}`, grade, 'general', q[0], q[1], q[2], q[3], q[4] || null, q[5] || ''));
    for (const q of extraGeneral) bank.push(makeBankQuestion(`general-${grade}-${gid++}`, grade, 'general', q[0], q[1], q[2], q[3], q[4] || null, q[5] || ''));
  }

  BUILTIN_BANK_CACHE = bank;
  return bank;
}

function customQuestionBank() {
  return readCustomQuestions().map((q, index) => ({ ...q, id: `custom-${q.id || index}`, mode: 'general' }));
}
function interleave(a, b) {
  const out = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) { if (a[i]) out.push(a[i]); if (b[i]) out.push(b[i]); }
  return out;
}
function questionPool(grade, mode, tier) {
  const g = clamp(Number(grade) || 1, 1, 4);
  const builtin = builtinQuestionBank();
  const math = builtin.filter(q => q.mode === 'math' && g >= q.minGrade && g <= q.maxGrade);
  const generalBuiltin = builtin.filter(q => q.mode === 'general' && g >= q.minGrade && g <= q.maxGrade);
  const generalPro = [...generalBuiltin, ...customQuestionBank().filter(q => g >= q.minGrade && g <= q.maxGrade)];
  let pool;
  if (mode === 'general') pool = generalPro;
  else if (mode === 'mixed') pool = interleave(math, generalPro);
  else pool = math;
  return tier === 'pro' ? pool : pool.slice(0, FREE_QUESTION_LIMIT);
}
function materializeQuestion(q) {
  return { ...q, answers: shuffle(q.answers.map(String)), correct: String(q.correct) };
}

// -------------------- Multiplayer --------------------
function makeRoomCode() {
  let code;
  do { code = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms.has(code));
  return code;
}
function refreshPlayerTier(player) {
  player.tier = player.licenseToken && validateLicenseToken(player.licenseToken, true) ? 'pro' : 'free';
  return player.tier;
}
const ALLOWED_AVATARS = new Set(['🦊', '🐼', '🦁', '🐸', '🐙', '🦄', '🤖', '🚀']);
function safeAvatar(value) { const avatar = String(value || '🦊'); return ALLOWED_AVATARS.has(avatar) ? avatar : '🦊'; }
function publicPlayer(player) { return { id: player.id, name: player.name, avatar: player.avatar || '🦊', score: player.score, correct: player.correct, tier: player.tier, streak: player.streak || 0, bestStreak: player.bestStreak || 0, badges: [...(player.badges || [])] }; }
function awardBadge(player, id, newBadges) { if (!player.badges) player.badges = new Set(); if (!player.badges.has(id)) { player.badges.add(id); newBadges.push(id); } }

function roomContentTier(room) {
  if (!room.players.size) return 'free';
  for (const player of room.players.values()) if (refreshPlayerTier(player) !== 'pro') return 'free';
  return 'pro';
}
function publicRoom(room) {
  return {
    code: room.code,
    hostName: room.players.get(room.hostId)?.name || 'Gazdă',
    grade: room.settings.grade, mode: room.settings.mode, language: room.settings.language || 'ro', questions: room.settings.questions,
    questionTime: room.settings.questionTime, noTimer: room.settings.noTimer,
    players: room.players.size, maxPlayers: room.settings.maxPlayers, status: room.status,
    contentTier: roomContentTier(room)
  };
}
function waitingRooms() { return [...rooms.values()].filter(room => room.status === 'lobby' && room.players.size < room.settings.maxPlayers).map(publicRoom); }
function broadcastRooms() { io.emit('rooms:list', waitingRooms()); }
function roomState(room) {
  const contentTier = roomContentTier(room);
  return {
    code: room.code, hostId: room.hostId, status: room.status, settings: room.settings, contentTier,
    freeQuestionLimit: FREE_QUESTION_LIMIT,
    players: [...room.players.values()].map(publicPlayer)
  };
}
function emitRoomState(room) { io.to(room.code).emit('room:state', roomState(room)); }
function sortedPlayers(room) {
  return [...room.players.values()].sort((a, b) => b.score - a.score || b.correct - a.correct || a.name.localeCompare(b.name)).map(publicPlayer);
}
function emitLeaderboard(room) { io.to(room.code).emit('game:leaderboard', sortedPlayers(room)); }
function clearQuestionTimer(room) { if (room.timer) { clearTimeout(room.timer); room.timer = null; } }
function finishQuestion(room) {
  if (room.status !== 'playing' || room.questionClosed) return;
  room.questionClosed = true;
  clearQuestionTimer(room);
  // Dacă un jucător nu a răspuns înainte de expirarea timpului, seria lui se întrerupe.
  for (const player of room.players.values()) if (!room.answers.has(player.id)) player.streak = 0;
  io.to(room.code).emit('game:questionEnd', { correctAnswer: room.currentQuestion?.correct, leaderboard: sortedPlayers(room) });
  room.nextTimer = setTimeout(() => { if (room.status === 'playing') { room.currentIndex += 1; sendQuestion(room); } }, 1700);
}
function pickNextQuestion(room, tier) {
  const pool = questionPool(room.settings.grade, room.settings.mode, tier);
  let available = pool.filter(q => !room.usedQuestionIds.has(q.id));
  if (!available.length) {
    room.usedQuestionIds.clear();
    available = pool;
  }
  if (!available.length) return null;
  const selected = available[randomInt(0, available.length - 1)];
  room.usedQuestionIds.add(selected.id);
  return materializeQuestion(selected);
}
function sendQuestion(room) {
  if (room.currentIndex >= room.settings.questions) return finishGame(room);
  const tier = roomContentTier(room);
  room.contentTier = tier;
  const question = pickNextQuestion(room, tier);
  if (!question) return finishGame(room);
  room.questionClosed = false;
  room.answers = new Set();
  room.currentQuestion = question;
  room.questionStartedAt = Date.now();
  const translation = room.settings.language === 'en' ? englishQuestionForClient(question) : null;
  io.to(room.code).emit('game:question', {
    index: room.currentIndex + 1, total: room.settings.questions,
    text: question.text, kind: question.kind, image: question.image, imageAlt: question.imageAlt,
    answers: question.answers, translation,
    questionTime: room.settings.questionTime, noTimer: room.settings.noTimer,
    startedAt: room.questionStartedAt, contentTier: tier
  });
  emitRoomState(room);
  if (!room.settings.noTimer) room.timer = setTimeout(() => finishQuestion(room), room.settings.questionTime * 1000);
}
function finishGame(room) {
  room.status = 'finished';
  clearQuestionTimer(room);
  if (room.nextTimer) clearTimeout(room.nextTimer);
  io.to(room.code).emit('game:finished', { leaderboard: sortedPlayers(room), totalQuestions: room.settings.questions });
  broadcastRooms();
}
function removePlayer(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  socket.data.roomCode = null;
  if (!room) return;
  room.players.delete(socket.id);
  socket.leave(code);
  if (room.players.size === 0) {
    clearQuestionTimer(room);
    if (room.nextTimer) clearTimeout(room.nextTimer);
    rooms.delete(code);
    broadcastRooms();
    return;
  }
  if (room.hostId === socket.id) {
    room.hostId = room.players.keys().next().value;
    io.to(room.hostId).emit('room:becameHost');
  }
  if (room.status === 'playing' && room.answers.size >= room.players.size) finishQuestion(room);
  emitRoomState(room); emitLeaderboard(room); broadcastRooms();
}
function playerLicenseToken(payload) {
  const token = String(payload?.licenseToken || '');
  return validateLicenseToken(token, true) ? token : null;
}

io.on('connection', socket => {
  socket.emit('rooms:list', waitingRooms());
  socket.on('rooms:request', () => socket.emit('rooms:list', waitingRooms()));
  socket.on('room:create', (payload = {}, callback = () => { }) => {
    const name = safeName(payload.name);
    if (!name) return callback({ ok: false, message: 'Scrie mai întâi prenumele tău 🙂' });
    removePlayer(socket);
    const code = makeRoomCode();
    const token = playerLicenseToken(payload);
    const room = {
      code, hostId: socket.id, status: 'lobby',
      settings: {
        grade: clamp(Number(payload.grade) || 1, 1, 4),
        mode: ['math', 'general', 'mixed'].includes(payload.mode) ? payload.mode : 'math',
        language: payload.language === 'en' ? 'en' : 'ro',
        questions: [5, 10, 15, 20].includes(Number(payload.questions)) ? Number(payload.questions) : 10,
        questionTime: [10, 15, 20, 30].includes(Number(payload.questionTime)) ? Number(payload.questionTime) : 15,
        noTimer: Boolean(payload.noTimer), maxPlayers: 12
      },
      players: new Map(), currentIndex: 0, currentQuestion: null, answers: new Set(), questionClosed: false, timer: null, nextTimer: null, usedQuestionIds: new Set(), contentTier: 'free'
    };
    room.players.set(socket.id, { id: socket.id, name, avatar: safeAvatar(payload.avatar), score: 0, correct: 0, streak: 0, bestStreak: 0, badges: new Set(), tier: token ? 'pro' : 'free', licenseToken: token });
    rooms.set(code, room); socket.join(code); socket.data.roomCode = code;
    callback({ ok: true, code, tier: token ? 'pro' : 'free' }); emitRoomState(room); broadcastRooms();
  });
  socket.on('room:join', (payload = {}, callback = () => { }) => {
    const name = safeName(payload.name), code = String(payload.code || '').trim();
    if (!name) return callback({ ok: false, message: 'Scrie prenumele tău 🙂' });
    const room = rooms.get(code);
    if (!room) return callback({ ok: false, message: 'Jocul nu mai este disponibil.' });
    if (room.status !== 'lobby') return callback({ ok: false, message: 'Jocul a început deja.' });
    if (room.players.size >= room.settings.maxPlayers) return callback({ ok: false, message: 'Jocul este plin.' });
    removePlayer(socket);
    const token = playerLicenseToken(payload);
    room.players.set(socket.id, { id: socket.id, name, avatar: safeAvatar(payload.avatar), score: 0, correct: 0, streak: 0, bestStreak: 0, badges: new Set(), tier: token ? 'pro' : 'free', licenseToken: token });
    socket.join(code); socket.data.roomCode = code;
    callback({ ok: true, code, tier: token ? 'pro' : 'free' }); emitRoomState(room); broadcastRooms();
  });
  socket.on('license:refresh', (payload = {}, callback = () => { }) => {
    const room = rooms.get(socket.data.roomCode), player = room?.players.get(socket.id);
    if (!player) return callback({ ok: false });
    const token = playerLicenseToken(payload);
    player.licenseToken = token; player.tier = token ? 'pro' : 'free';
    callback({ ok: true, tier: player.tier }); emitRoomState(room); broadcastRooms();
  });
  socket.on('room:start', (callback = () => { }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return callback({ ok: false, message: 'Camera nu există.' });
    if (room.hostId !== socket.id) return callback({ ok: false, message: 'Doar gazda poate începe jocul.' });
    if (room.status !== 'lobby') return callback({ ok: false, message: 'Jocul este deja pornit.' });
    for (const player of room.players.values()) { refreshPlayerTier(player); player.score = 0; player.correct = 0; player.streak = 0; player.bestStreak = 0; player.badges = new Set(); }
    room.status = 'playing'; room.currentIndex = 0; room.usedQuestionIds.clear(); room.contentTier = roomContentTier(room);
    callback({ ok: true, contentTier: room.contentTier }); io.to(room.code).emit('game:started', { contentTier: room.contentTier }); broadcastRooms();
    setTimeout(() => sendQuestion(room), 650);
  });
  socket.on('game:answer', (payload = {}, callback = () => { }) => {
    const room = rooms.get(socket.data.roomCode), player = room?.players.get(socket.id);
    if (!room || !player || room.status !== 'playing' || room.questionClosed || !room.currentQuestion) return callback({ ok: false });
    if (room.answers.has(socket.id)) return callback({ ok: false, message: 'Ai răspuns deja.' });
    refreshPlayerTier(player);
    room.answers.add(socket.id);
    const answer = String(payload.answer ?? ''), isCorrect = answer === room.currentQuestion.correct;
    let points = 0;
    const newBadges = [];
    if (isCorrect) {
      const elapsed = Date.now() - room.questionStartedAt, maxMs = room.settings.questionTime * 1000;
      const speedBonus = room.settings.noTimer ? 0 : Math.max(0, Math.round(50 * (1 - elapsed / maxMs)));
      player.streak = (player.streak || 0) + 1; player.bestStreak = Math.max(player.bestStreak || 0, player.streak);
      const comboBonus = Math.min(50, Math.max(0, player.streak - 1) * 10);
      points = 100 + speedBonus + comboBonus; player.score += points; player.correct += 1;
      if (player.correct === 1) awardBadge(player, 'first', newBadges);
      if (player.streak >= 3) awardBadge(player, 'streak3', newBadges);
      if (player.streak >= 5) awardBadge(player, 'streak5', newBadges);
      if (!room.settings.noTimer && speedBonus >= 40) awardBadge(player, 'fast', newBadges);
      if (player.correct >= 10) awardBadge(player, 'expert10', newBadges);
    } else { player.streak = 0; }
    callback({ ok: true, isCorrect, points, correctAnswer: room.currentQuestion.correct, score: player.score, tier: player.tier, streak: player.streak, bestStreak: player.bestStreak, badges: [...player.badges], newBadges });
    emitLeaderboard(room);
    if (room.answers.size >= room.players.size) setTimeout(() => finishQuestion(room), 450);
  });
  socket.on('room:leave', () => removePlayer(socket));
  socket.on('disconnect', () => removePlayer(socket));
});

// Curăță lease-urile și actualizează lobby-urile dacă o licență a expirat.
setInterval(() => {
  cleanupExpiredLeases();
  for (const room of rooms.values()) {
    let changed = false;
    for (const player of room.players.values()) {
      const old = player.tier;
      refreshPlayerTier(player);
      if (old !== player.tier) changed = true;
    }
    if (changed) emitRoomState(room);
  }
  broadcastRooms();
}, 10_000).unref();

app.use((err, _req, res, _next) => {
  console.error(err.paypal || err);
  if (err instanceof multer.MulterError) return res.status(422).json({ ok: false, message: err.code === 'LIMIT_FILE_SIZE' ? 'Imaginea este prea mare. Maxim 4 MB.' : 'Fișierul nu a putut fi încărcat.' });
  const safe = ['Format imagine neacceptat. Folosește PNG, JPG/JPEG sau WEBP.', 'Fișierul încărcat nu este o imagine validă sau tipul real nu corespunde extensiei.'];
  if (safe.includes(err.message)) return res.status(422).json({ ok: false, message: err.message });
  if (String(err.message).startsWith('PAYPAL_')) return res.status(502).json({ ok: false, message: 'PayPal nu a putut procesa cererea. Încearcă din nou.' });
  res.status(500).json({ ok: false, message: 'A apărut o eroare pe server.' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Arena Matematica rulează pe http://localhost:${PORT}`);
  console.log(`Întrebări builtin: ${builtinQuestionBank().length}; FREE: primele ${FREE_QUESTION_LIMIT} din pool-ul selectat.`);
});
