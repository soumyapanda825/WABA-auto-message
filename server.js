require('dotenv').config();
const express  = require('express');
const session  = require('express-session');
const bcrypt   = require('bcryptjs');
const multer   = require('multer');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode   = require('qrcode');
const csv      = require('csv-parser');
const fs       = require('fs');
const path     = require('path');

const app = express();

// ── Session + auth ────────────────────────────────────────────────────────────
app.use(session({
    secret:            process.env.SESSION_SECRET || 'changeme-in-production',
    resave:            false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true } // 7 days
}));

function requireAuth(req, res, next) {
    if (req.session.authenticated) return next();
    // API calls get 401 JSON, page requests get redirect
    if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) {
        return res.status(401).json({ error: 'Unauthorised' });
    }
    res.redirect('/login');
}

// ── Public routes (no auth) ───────────────────────────────────────────────────
app.get('/login', (req, res) => {
    if (req.session.authenticated) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/auth/login', express.urlencoded({ extended: false }), (req, res) => {
    const { email, password } = req.body;
    const hash = process.env.AUTH_PASSWORD_HASH;
    if (!hash) {
        console.error('AUTH_PASSWORD_HASH env var is not set — set it in Railway Variables');
        return res.redirect('/login?error=1');
    }
    const emailOk    = email === (process.env.AUTH_EMAIL || '');
    const passwordOk = bcrypt.compareSync(password || '', hash);
    if (emailOk && passwordOk) {
        req.session.authenticated = true;
        return res.redirect('/');
    }
    res.redirect('/login?error=1');
});

app.post('/auth/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});

// ── Auth wall — everything below requires login ───────────────────────────────
app.use(requireAuth);

app.use(express.json({ limit: '25mb' }));
const upload = multer({ dest: 'uploads/' });

// ── Persistent data ───────────────────────────────────────────────────────────
// On cloud (Railway/Fly.io), point DATA_DIR at a mounted volume path via env var
const DATA_DIR       = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR)
                                             : path.join(__dirname, 'data');
const TEMPLATES_FILE = path.join(DATA_DIR, 'templates.json');
const HISTORY_FILE   = path.join(DATA_DIR, 'history.json');

if (!fs.existsSync(DATA_DIR))       fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(TEMPLATES_FILE)) fs.writeFileSync(TEMPLATES_FILE, '[]');
if (!fs.existsSync(HISTORY_FILE))   fs.writeFileSync(HISTORY_FILE,   '[]');

function loadJSON(file)       { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; } }
function saveJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

// ── WhatsApp state ────────────────────────────────────────────────────────────
let waState    = { status: 'initializing', qr: null };
const sseClients = new Set();
let readyWaiters = [];
let reconnecting = false;

function broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) res.write(msg);
}

function waitForReady(timeoutMs = 90000) {
    if (waState.status === 'ready') return Promise.resolve();
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Timed out waiting for WhatsApp to reconnect')), timeoutMs);
        readyWaiters.push(() => { clearTimeout(t); resolve(); });
    });
}

async function forceReconnect() {
    if (reconnecting) return waitForReady(90000);
    reconnecting = true;
    waState = { status: 'disconnected', qr: null };
    broadcast('status', waState);
    console.log('Force-reconnecting…');
    try { await client.destroy(); } catch (_) {}
    await sleep(3000);
    client = buildClient();
    client.initialize();
    return waitForReady(90000);
}

let client;

function buildClient() {
    const wwebjsPath    = process.env.WWEBJS_DATA_PATH || '.wwebjs_auth';
    const puppeteerOpts = {
        headless:       true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
            '--no-sandbox', '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', '--disable-gpu',
            '--no-first-run', '--no-zygote', '--disable-extensions',
        ]
    };
    const c = new Client({
        authStrategy: new LocalAuth({ dataPath: wwebjsPath }),
        puppeteer:    puppeteerOpts
    });

    c.on('qr', async (qr) => {
        const dataUrl = await qrcode.toDataURL(qr);
        waState = { status: 'qr', qr: dataUrl };
        broadcast('status', waState);
        console.log('QR code ready — open http://localhost:3000 to scan');
    });

    c.on('authenticated', () => {
        waState = { status: 'authenticated', qr: null };
        broadcast('status', waState);
        console.log('Authenticated');
    });

    c.on('ready', () => {
        reconnecting = false;
        waState = { status: 'ready', qr: null };
        broadcast('status', waState);
        console.log('WhatsApp ready');
        const waiters = readyWaiters.splice(0);
        for (const fn of waiters) fn();
    });

    c.on('disconnected', async (reason) => {
        console.log('Disconnected:', reason, '— force-reconnecting…');
        forceReconnect().catch(err => console.error('Reconnect failed:', err.message));
    });

    return c;
}

// WhatsApp is initialised after the HTTP server is already listening
// so Railway's health check gets a response immediately
client = buildClient();

// ── Static + SSE ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (_req, res) => res.json(waState));

app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(`event: status\ndata: ${JSON.stringify(waState)}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
});

// ── Templates ─────────────────────────────────────────────────────────────────
app.get('/api/templates', (_req, res) => {
    const templates = loadJSON(TEMPLATES_FILE);
    // Strip photo data from list — only send on individual fetch
    res.json(templates.map(({ id, name, message, photo }) => ({
        id, name, message, hasPhoto: !!photo
    })));
});

app.get('/api/templates/:id', (req, res) => {
    const t = loadJSON(TEMPLATES_FILE).find(t => t.id === req.params.id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    res.json(t);
});

app.post('/api/templates', (req, res) => {
    const { name, message, photo } = req.body;
    if (!name?.trim() || !message?.trim())
        return res.status(400).json({ error: 'Name and message are required' });

    const templates    = loadJSON(TEMPLATES_FILE);
    const existingIdx  = templates.findIndex(t => t.name === name.trim());
    const existing     = existingIdx >= 0 ? templates[existingIdx] : null;

    const template = {
        id:      existing?.id || Date.now().toString(),
        name:    name.trim(),
        message: message.trim(),
        // If new photo provided use it; if null keep existing so updating message alone doesn't wipe photo
        photo:   photo !== undefined ? photo : (existing?.photo || null)
    };

    if (existing) templates[existingIdx] = template;
    else          templates.push(template);

    saveJSON(TEMPLATES_FILE, templates);
    res.json({ ok: true, id: template.id });
});

app.delete('/api/templates/:id', (req, res) => {
    saveJSON(TEMPLATES_FILE, loadJSON(TEMPLATES_FILE).filter(t => t.id !== req.params.id));
    res.json({ ok: true });
});

// ── History ───────────────────────────────────────────────────────────────────
app.get('/api/history', (_req, res) => {
    res.json([...loadJSON(HISTORY_FILE)].reverse());
});

app.delete('/api/history', (_req, res) => {
    saveJSON(HISTORY_FILE, []);
    broadcast('historyCleared', {});
    res.json({ ok: true });
});

// ── Send ──────────────────────────────────────────────────────────────────────
app.post('/api/send', upload.single('csv'), async (req, res) => {
    if (waState.status !== 'ready')
        return res.status(400).json({ error: 'WhatsApp is not connected yet.' });

    const template      = (req.body.message      || '').trim();
    const csvFile       = req.file;
    const manualName    = (req.body.manualName   || '').trim();
    const manualNumber  = (req.body.manualNumber || '').trim();
    const photoBase64   = req.body.photoBase64   || null;
    const photoMimetype = req.body.photoMimetype || 'image/jpeg';
    const photoFilename = req.body.photoFilename || 'photo.jpg';

    if (!template || (!csvFile && !(manualName && manualNumber)))
        return res.status(400).json({ error: 'Message and at least one contact are required.' });

    let contacts = [];
    if (csvFile) {
        try {
            contacts = await parseCSV(csvFile.path);
        } catch (e) {
            return res.status(400).json({ error: 'Failed to parse CSV: ' + e.message });
        } finally {
            fs.unlink(csvFile.path, () => {});
        }
    }

    if (manualName && manualNumber)
        contacts.push({ name: manualName, number: manualNumber });

    if (contacts.length === 0)
        return res.status(400).json({ error: 'No valid contacts found.' });

    const templatePhoto = photoBase64
        ? { data: photoBase64, mimetype: photoMimetype, filename: photoFilename }
        : null;

    res.json({ ok: true, total: contacts.length });
    sendMessages(contacts, template, templatePhoto);
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseCSV(filePath) {
    return new Promise((resolve, reject) => {
        const contacts = [];
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', row => {
                const number = (row.number || row.Number || '').toString().trim();
                const name   = (row.name   || row.Name   || '').toString().trim();
                if (number && name) contacts.push({ number, name });
            })
            .on('end',   () => resolve(contacts))
            .on('error', reject);
    });
}

async function sendMessages(contacts, template, templatePhoto) {
    let photo = null;
    if (templatePhoto?.data) {
        photo = new MessageMedia(templatePhoto.mimetype, templatePhoto.data, templatePhoto.filename);
    }

    broadcast('log', { type: 'start', total: contacts.length });

    const historyBatch = [];

    for (let i = 0; i < contacts.length; i++) {
        const { number, name } = contacts[i];
        const message = template.replace(/<>/g, name);

        try {
            if (waState.status !== 'ready') await forceReconnect();

            const numberId = await client.getNumberId(number);
            if (!numberId) {
                const entry = { name, number, success: false, error: 'Not registered on WhatsApp', timestamp: new Date().toISOString() };
                historyBatch.push(entry);
                broadcast('log', { type: 'sent', index: i + 1, total: contacts.length, ...entry });
                if (i < contacts.length - 1) await sleep(3000);
                continue;
            }

            if (photo) {
                await client.sendMessage(numberId._serialized, photo, { caption: message });
            } else {
                await client.sendMessage(numberId._serialized, message);
            }

            const entry = { name, number, success: true, timestamp: new Date().toISOString() };
            historyBatch.push(entry);
            broadcast('log', { type: 'sent', index: i + 1, total: contacts.length, ...entry });

        } catch (err) {
            const isFrameError = err.message && (
                err.message.includes('detached Frame') ||
                err.message.includes('Target closed') ||
                err.message.includes('Session closed')
            );
            if (isFrameError) {
                broadcast('log', { type: 'warning', message: 'Connection dropped — reconnecting and retrying…' });
                try {
                    await forceReconnect();
                    i--;
                } catch (_) {
                    const entry = { name, number, success: false, error: 'Reconnect timed out', timestamp: new Date().toISOString() };
                    historyBatch.push(entry);
                    broadcast('log', { type: 'sent', index: i + 1, total: contacts.length, ...entry });
                }
            } else {
                const entry = { name, number, success: false, error: err.message, timestamp: new Date().toISOString() };
                historyBatch.push(entry);
                broadcast('log', { type: 'sent', index: i + 1, total: contacts.length, ...entry });
            }
        }

        if (i < contacts.length - 1) await sleep(3000);
    }

    const existing = loadJSON(HISTORY_FILE);
    saveJSON(HISTORY_FILE, [...existing, ...historyBatch]);

    broadcast('log', { type: 'done', total: contacts.length });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const PORT = process.env.PORT || 3000;
// Bind to 0.0.0.0 so Railway's proxy can reach the process, then start WhatsApp
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\nServer listening on port ${PORT}\n`);
    client.initialize().catch(err => console.error('WhatsApp init error:', err.message));
});
