require('dotenv').config();

const express = require('express');
const cors = require('cors');

/**
 * =================== PLANO DE IMPLEMENTAÇÃO ===================
 * 
 * 1) Alteração automática do schema:
 *    - Adicionar as colunas 'payment_type', 'amount_charged', 'remaining_amount' à tabela 'appointments' se não existirem.
 * 
 * 2) POST /appointments:
 *    - Aceitar o campo 'paymentType' enviado pelo frontend (cair como "partial" ou "full").
 *    - Calcular:
 *        - amount_charged: (R$ 30,00 se partial, total do serviço se full)
 *        - remaining_amount: (total - 30 se partial, 0 se full)
 *    - Salvar esses três campos no banco ao criar o appointment.
 *    - Passar da mesma forma o valor correto para o createCheckoutLink.
 * 
 * 3) mapAppointmentRow:
 *    - Incluir os novos campos no objeto retornado.
 * 
 * ==============================================================
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { Pool } = require('pg');
require('dotenv').config();

const {
    sendConfirmationEmail,
    sendClientConfirmationEmail,
    sendClientAppointmentCancelledEmail,
    sendAdminAppointmentCancelledEmail
} = require('./services/emailService');
const { createCheckoutLink, checkPaymentStatus } = require('./services/infinitepayService');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors({ origin: '*' }));
app.use(express.json());

/** Somente dígitos (DDI + número), ex.: 5541991234567 — usado em links wa.me da profissional. */
function getPublicAdminWhatsappDigits() {
    return String(process.env.ADMIN_WHATSAPP || '').replace(/\D/g, '');
}

app.use(express.static(path.join(__dirname, 'public')));

const isPostgresSetup = !!process.env.DATABASE_URL;

/** TTL do token admin (segundos), entre 5 min e 30 dias. */
const ADMIN_SESSION_TTL_SEC = (() => {
    const raw = parseInt(String(process.env.ADMIN_SESSION_TTL_SECONDS || '86400'), 10);
    if (!Number.isFinite(raw)) return 86400;
    return Math.min(Math.max(raw, 300), 2592000);
})();

function adminSigningSecret() {
    const explicit = process.env.ADMIN_SESSION_SECRET;
    if (explicit && String(explicit).length >= 16) {
        return String(explicit);
    }
    const pwd = process.env.ADMIN_PASSWORD;
    if (pwd && String(pwd).length >= 1) {
        return crypto.createHash('sha256').update(`atelie-admin-token-v1|${pwd}`, 'utf8').digest('hex');
    }
    return '';
}

function signAdminToken() {
    const secret = adminSigningSecret();
    if (!secret) return null;
    const exp = Math.floor(Date.now() / 1000) + ADMIN_SESSION_TTL_SEC;
    const rnd = crypto.randomBytes(12).toString('hex');
    const payload = JSON.stringify({ exp, rnd, v: 1 });
    const payloadB64 = Buffer.from(payload, 'utf8').toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
    return `${payloadB64}.${sig}`;
}

function verifyAdminToken(token) {
    if (!token || typeof token !== 'string') return false;
    const secret = adminSigningSecret();
    if (!secret) return false;
    const dot = token.indexOf('.');
    if (dot <= 0 || dot === token.length - 1) return false;
    const payloadB64 = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
    const sigBuf = Buffer.from(sig, 'utf8');
    const expBuf = Buffer.from(expected, 'utf8');
    if (sigBuf.length !== expBuf.length) return false;
    if (!crypto.timingSafeEqual(sigBuf, expBuf)) return false;
    let payload;
    try {
        payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    } catch {
        return false;
    }
    if (!payload || payload.v !== 1 || typeof payload.exp !== 'number') return false;
    if (Math.floor(Date.now() / 1000) > payload.exp) return false;
    return true;
}

function extractAdminToken(req) {
    const auth = req.headers.authorization;
    if (auth && String(auth).startsWith('Bearer ')) {
        return String(auth).slice(7).trim();
    }
    const x = req.headers['x-admin-token'];
    if (x) return String(x).trim();
    return '';
}

function getRequestIpForRateLimit(req) {
    const xf = req.headers['x-forwarded-for'];
    if (xf && typeof xf === 'string') {
        const first = xf.split(',')[0].trim();
        if (first) return first;
    }
    return req.socket?.remoteAddress || 'unknown';
}

const paymentCheckRateBuckets = new Map();

/** Limite simples por IP para POST /payments/check (janela deslizante). */
function allowPaymentCheckRate(req, maxPerWindow = 45, windowMs = 60000) {
    const ip = getRequestIpForRateLimit(req);
    const now = Date.now();
    let arr = paymentCheckRateBuckets.get(ip);
    if (!Array.isArray(arr)) arr = [];
    arr = arr.filter((t) => now - t < windowMs);
    if (arr.length >= maxPerWindow) {
        paymentCheckRateBuckets.set(ip, arr);
        return false;
    }
    arr.push(now);
    paymentCheckRateBuckets.set(ip, arr);
    return true;
}

function maskEmailForLog(email) {
    const s = String(email || '').trim();
    if (!s.includes('@')) return '(vazio)';
    const [u, dom] = s.split('@');
    if (!dom) return '(inválido)';
    const safeUser = u.length <= 1 ? `${u}***` : `${u[0]}***`;
    return `${safeUser}@${dom}`;
}

function maskPhoneForLog(phone) {
    const d = String(phone || '').replace(/\D/g, '');
    if (d.length < 4) return '(curto)';
    return `***${d.slice(-4)}`;
}

function timingSafeEqualUtf8(a, b) {
    const x = String(a || '');
    const y = String(b || '');
    if (x.length !== y.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(x, 'utf8'), Buffer.from(y, 'utf8'));
    } catch {
        return false;
    }
}

/**
 * Visão pública da agenda: mantém shape de mapAppointmentRow para o frontend (slots / status),
 * sem expor PII nem links de pagamento de terceiros.
 */
function sanitizeAppointmentForPublicOccupancy(mapped) {
    if (!mapped || typeof mapped !== 'object') return mapped;
    return {
        ...mapped,
        clientId: null,
        clientName: null,
        clientPhone: null,
        location: null,
        notes: null,
        manualPaymentNote: null,
        cancelReason: null,
        paymentUrl: null,
        transactionNsu: null,
        invoiceSlug: null,
        receiptUrl: null
    };
}

function requireAdminAuth(req, res, next) {
    const tok = extractAdminToken(req);
    if (!verifyAdminToken(tok)) {
        return res.status(401).json({ error: 'Não autorizado.' });
    }
    return next();
}

function verifyAdminPasswordCandidate(pwd) {
    const expected = process.env.ADMIN_PASSWORD;
    if (!expected || typeof expected !== 'string') return false;
    if (typeof pwd !== 'string') return false;
    const hExp = crypto.createHash('sha256').update(expected, 'utf8').digest();
    const hIn = crypto.createHash('sha256').update(pwd, 'utf8').digest();
    return crypto.timingSafeEqual(hExp, hIn);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://user:pass@localhost:5432/dbname',
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
        ? false
        : { rejectUnauthorized: false }
});

pool.on('error', (err) => {
    console.error('[pg pool] Erro inesperado em cliente ocioso:', err && err.message ? err.message : err);
});

/**
 * Catálogo bootstrap (sem Postgres). Espelhar em `backend/public/index.html` (SERVICES + PROMO_MAES_SERVICES).
 * Com Postgres, pacotes promocionais vêm de `catalog_services` + `promotional_campaigns` e da flag global
 * `promotional_packages_enabled` em `app_settings` (interrupção geral da vitrine).
 */
const SERVICES_CATALOG = [
    { id: 'limpeza_pele_profunda', name: 'Limpeza de pele profunda', price: 119, duration: 60 },
    { id: 'limpeza_pele_mascara', name: 'Limpeza de pele profunda + máscara facial específica', price: 150, duration: 60 },
    { id: 'dep_intima_com_anus', name: 'Depilação íntima completa com ânus', price: 95, duration: 60 },
    { id: 'dep_intima_sem_anus', name: 'Depilação íntima completa sem ânus', price: 85, duration: 60 },
    { id: 'dep_axilas', name: 'Depilação axilas', price: 35, duration: 60 },
    { id: 'dep_nariz', name: 'Depilação nariz', price: 20, duration: 60 },
    { id: 'dep_buco_facial', name: 'Depilação buço', price: 15, duration: 60 },
    { id: 'dep_meia_perna', name: 'Depilação meia perna', price: 45, duration: 60 },
    { id: 'dep_coxa', name: 'Depilação coxa', price: 50, duration: 60 },
    { id: 'dep_perna_inteira', name: 'Depilação perna inteira', price: 89, duration: 60 },
    { id: 'combo_intima_axilas_meia', name: 'Combo: íntima completa com ânus + axilas + meia perna', price: 160, duration: 60 },
    { id: 'reflexologia_podal', name: 'Reflexologia podal', price: 110, duration: 60 },
    {
        id: 'promo_dia_maes_reflexologia',
        name: 'Vale-presente Dia das Mães 1 — Reflexologia especial',
        price: 99,
        duration: 60
    },
    {
        id: 'promo_dia_maes_facial',
        name: 'Vale-presente Dia das Mães 2 — Limpeza suave & facial',
        price: 99,
        duration: 60
    }
];

/** Só para agendamentos já gravados com ids antigos (relatório, e-mails, normalização). */
const SERVICES_LEGACY = [
    { id: 'limpeza_pele', name: 'Limpeza de Pele', price: 119.9, duration: 60 },
    { id: 'dep_intima', name: 'Depilação Íntima Completa', price: 59.9, duration: 60 },
    { id: 'dep_axila', name: 'Depilação Axila', price: 29.9, duration: 60 },
    { id: 'dep_buco', name: 'Depilação Buço', price: 29.9, duration: 60 },
    { id: 'dep_completa', name: 'Depilação Completa', price: 129.9, duration: 60 },
    { id: 'reflexologia', name: 'Reflexologia Podal', price: 89.9, duration: 60 }
];

const FIXED_SIGNAL_AMOUNT = 30.00;

const PROMO_PACKAGE_IDS = new Set(['promo_dia_maes_reflexologia', 'promo_dia_maes_facial']);

/** Duração padrão na agenda (alinhada a `SERVICES` / `generateTimeSlots` em `public/index.html`). */
const DEFAULT_APPOINTMENT_DURATION_MIN = 60;
/** Intervalo mínimo entre inícios de agendamentos (minutos); grade em intervalos de 1 hora. */
const MIN_START_GAP_MINUTES = 60;

/** Catálogo carregado do PostgreSQL (`catalog_services`); fallback para constantes se vazio. */
let servicesCatalogAll = null;

/** Flag global (app_settings) espelhada em memória para filtrar pacotes promocionais sem I/O em cada request. */
let promoPackagesEnabledCache = false;

/** Linhas de `promotional_campaigns` para validade e ativo por campanha. */
let promotionalCampaignsAll = [];

// ======================= BANCO =======================

async function initDB() {
    if (!isPostgresSetup) {
        console.warn('⚠️ AVISO: DATABASE_URL não definida. O sistema precisa do PostgreSQL para funcionar corretamente.');
        return;
    }

    let client;
    try {
        client = await pool.connect();
    } catch (err) {
        console.error('❌ Erro ao conectar ao PostgreSQL para migrações:', err);
        return;
    }

    try {
        // Tabela clients
        await client.query(`
            CREATE TABLE IF NOT EXISTS clients (
                id VARCHAR(255) PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                phone VARCHAR(50) NOT NULL UNIQUE,
                address TEXT,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Tabela appointments base
        await client.query(`
            CREATE TABLE IF NOT EXISTS appointments (
                id VARCHAR(255) PRIMARY KEY,
                service_id VARCHAR(255) NOT NULL,
                client_id VARCHAR(255) REFERENCES clients(id),
                client_name VARCHAR(255),
                client_phone VARCHAR(50),
                location TEXT,
                date VARCHAR(10) NOT NULL,
                time VARCHAR(5) NOT NULL,
                notes TEXT,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                status VARCHAR(50) DEFAULT 'pending_payment',
                payment_url TEXT,
                cancelled_at TIMESTAMP WITH TIME ZONE,
                cancelled_by VARCHAR(50),
                cancel_reason TEXT
            );
        `);

        // MIGRAÇÕES AUTOMÁTICAS
        await client.query(`
            ALTER TABLE appointments
            ADD COLUMN IF NOT EXISTS payment_amount NUMERIC(10,2) DEFAULT 30.00
        `);

        await client.query(`
            ALTER TABLE appointments
            ADD COLUMN IF NOT EXISTS payment_type VARCHAR(20)
        `);

        await client.query(`
            ALTER TABLE appointments
            ADD COLUMN IF NOT EXISTS amount_charged NUMERIC(10,2)
        `);

        await client.query(`
            ALTER TABLE appointments
            ADD COLUMN IF NOT EXISTS remaining_amount NUMERIC(10,2)
        `);

        await client.query(`
            ALTER TABLE appointments
            ADD COLUMN IF NOT EXISTS transaction_nsu VARCHAR(255)
        `);

        await client.query(`
            ALTER TABLE appointments
            ADD COLUMN IF NOT EXISTS invoice_slug VARCHAR(255)
        `);

        await client.query(`
            ALTER TABLE appointments
            ADD COLUMN IF NOT EXISTS receipt_url TEXT
        `);

        await client.query(`
            ALTER TABLE appointments
            ADD COLUMN IF NOT EXISTS capture_method VARCHAR(50)
        `);

        await client.query(`
            ALTER TABLE appointments
            ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(10,2)
        `);

        await client.query(`
            ALTER TABLE appointments
            ADD COLUMN IF NOT EXISTS manual_payment_note TEXT
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_appointments_date_time_status
            ON appointments (date, time, status)
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS blocked_slots (
                id SERIAL PRIMARY KEY,
                date VARCHAR(10) NOT NULL,
                time VARCHAR(5) NOT NULL,
                reason TEXT,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(date, time)
            )
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_blocked_slots_date
            ON blocked_slots (date)
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS blocked_full_days (
                id SERIAL PRIMARY KEY,
                date VARCHAR(10) NOT NULL,
                reason TEXT,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(date)
            )
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_blocked_full_days_date
            ON blocked_full_days (date)
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS app_settings (
                key VARCHAR(64) PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await client.query(`
            INSERT INTO app_settings (key, value)
            VALUES ('promotional_packages_enabled', 'false')
            ON CONFLICT (key) DO NOTHING
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS catalog_services (
                id VARCHAR(80) PRIMARY KEY,
                name TEXT NOT NULL,
                category VARCHAR(140) NOT NULL DEFAULT 'Geral',
                price NUMERIC(10,2) NOT NULL,
                duration INT NOT NULL DEFAULT 60,
                summary TEXT,
                description TEXT,
                card_title TEXT,
                active BOOLEAN NOT NULL DEFAULT TRUE,
                is_promotional_package BOOLEAN NOT NULL DEFAULT FALSE,
                promotional_campaign VARCHAR(64),
                sort_order INT NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_catalog_services_active
            ON catalog_services (active);
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS promotional_campaigns (
                id VARCHAR(80) PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                active BOOLEAN NOT NULL DEFAULT TRUE,
                valid_from TIMESTAMPTZ NULL,
                valid_to TIMESTAMPTZ NULL,
                category VARCHAR(140) NOT NULL DEFAULT 'Campanhas',
                sort_order INT NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_promotional_campaigns_active
            ON promotional_campaigns (active);
        `);

        const cntRes = await client.query(`SELECT COUNT(*)::int AS c FROM catalog_services`);
        if (cntRes.rows[0].c === 0) {
            const seedPath = path.join(__dirname, 'catalog_seed.json');
            const raw = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
            if (!Array.isArray(raw) || raw.length === 0) {
                console.warn('[catalog_services] catalog_seed.json vazio ou inválido.');
            } else {
                for (const row of raw) {
                    await client.query(
                        `
                        INSERT INTO catalog_services (
                            id, name, category, price, duration, summary, description, card_title,
                            active, is_promotional_package, promotional_campaign, sort_order
                        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                    `,
                        [
                            row.id,
                            row.name,
                            row.category || 'Geral',
                            row.price,
                            row.duration != null ? Math.round(Number(row.duration)) : 60,
                            row.summary != null ? String(row.summary) : null,
                            row.description != null ? String(row.description) : null,
                            row.card_title != null ? String(row.card_title) : null,
                            row.active !== false,
                            !!row.is_promotional_package,
                            row.promotional_campaign || null,
                            row.sort_order != null ? Math.round(Number(row.sort_order)) : 0
                        ]
                    );
                }
                console.log(`[catalog_services] Seed inicial: ${raw.length} serviços.`);
            }
        }

        const campCnt = await client.query(`SELECT COUNT(*)::int AS c FROM promotional_campaigns`);
        if (campCnt.rows[0].c === 0) {
            const settingsPromo = await client.query(
                `SELECT value FROM app_settings WHERE key = 'promotional_packages_enabled' LIMIT 1`
            );
            const val = settingsPromo.rows[0]?.value;
            const enabled =
                val === true ||
                String(val ?? '')
                    .trim()
                    .toLowerCase() === 'true' ||
                String(val ?? '')
                    .trim()
                    .toLowerCase() === '1';
            await client.query(
                `
                INSERT INTO promotional_campaigns (id, name, description, active, category, sort_order)
                VALUES (
                    'dia_maes',
                    'Campanha sazonal (legado)',
                    'Importada automaticamente. Edite o nome e os pacotes na aba Campanhas.',
                    $1,
                    'Campanhas',
                    0
                )
            `,
                [enabled]
            );
        }

        await client.query(`
            INSERT INTO promotional_campaigns (id, name, description, active, category, sort_order)
            SELECT DISTINCT TRIM(s.promotional_campaign),
                   CASE
                       WHEN TRIM(s.promotional_campaign) = 'dia_maes' THEN 'Campanha sazonal (legado)'
                       ELSE INITCAP(REPLACE(REPLACE(TRIM(s.promotional_campaign), '_', ' '), '-', ' '))
                   END,
                   '',
                   TRUE,
                   'Campanhas',
                   0
            FROM catalog_services s
            WHERE s.promotional_campaign IS NOT NULL
              AND TRIM(s.promotional_campaign) <> ''
              AND NOT EXISTS (SELECT 1 FROM promotional_campaigns c WHERE c.id = TRIM(s.promotional_campaign))
        `);

        await client.query(`
            ALTER TABLE clients
            ADD COLUMN IF NOT EXISTS email VARCHAR(255)
        `);

        await client.query(`
            ALTER TABLE appointments
            ADD COLUMN IF NOT EXISTS client_confirmation_email_sent_at TIMESTAMPTZ
        `);

        await client.query(`
            ALTER TABLE appointments
            ADD COLUMN IF NOT EXISTS service_ids_json TEXT
        `);

        await client.query(`
            ALTER TABLE appointments
            ADD COLUMN IF NOT EXISTS service_slots_json TEXT
        `);

        await client.query(`
            ALTER TABLE appointments
            ADD COLUMN IF NOT EXISTS schedule_mode VARCHAR(32)
        `);

        await client.query(`
            ALTER TABLE catalog_services
            ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NULL
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_catalog_services_archived
            ON catalog_services (archived_at)
        `);
        await client.query(`
            ALTER TABLE promotional_campaigns
            ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NULL
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_promotional_campaigns_archived
            ON promotional_campaigns (archived_at)
        `);
        /* Legado Dia das Mães: só preenche campanha quando ainda não vinculado (não sobrescreve campanhas novas). */
        await client.query(`
            UPDATE catalog_services
            SET is_promotional_package = TRUE,
                promotional_campaign = 'dia_maes'
            WHERE id IN ('promo_dia_maes_reflexologia', 'promo_dia_maes_facial')
              AND (promotional_campaign IS NULL OR TRIM(promotional_campaign) = '')
        `);

        console.log('✅ Banco de dados sincronizado / migrado');
        await backfillAppointmentSlotItemStatus();
        await refreshServicesCatalogCache();
        await refreshPromotionalSettingsCache();
    } catch (err) {
        console.error('❌ Erro ao iniciar banco:', err);
    } finally {
        if (client) {
            try {
                client.release();
            } catch (relErr) {
                console.error('❌ Erro ao liberar conexão do initDB:', relErr);
            }
        }
    }
}

// ======================= AUXILIARES =======================

function normalizeSlotTimeHHMM(t) {
    if (t == null) return null;
    const s = String(t).trim();
    const m = s.match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    const hh = String(m[1]).padStart(2, '0');
    const mm = m[2];
    return `${hh}:${mm}`;
}

function timeStrToMinutes(timeStr) {
    const n = normalizeSlotTimeHHMM(timeStr);
    if (!n) return null;
    const [h, mm] = n.split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(mm)) return null;
    return h * 60 + mm;
}

function isValidReportDateYmd(s) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

/**
 * Valida se um horário pode receber novo agendamento (sobreposição + intervalo de 1h + bloqueio manual).
 * @param {Array<{ time: string, status: string }>} existingRows
 * @param {Set<string>|null} blockedTimesSet — horários normalizados HH:MM
 */
function normalizeEmail(s) {
    if (s == null || s === '') return '';
    return String(s).trim().toLowerCase();
}

function isValidEmailBasic(s) {
    const t = normalizeEmail(s);
    if (!t || t.length > 254) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);
}

function getServiceDurationMinForSchedule(serviceId) {
    const s = findServiceById(serviceId);
    if (s && typeof s.duration === 'number' && Number.isFinite(s.duration) && s.duration > 0) {
        return Math.round(s.duration);
    }
    return DEFAULT_APPOINTMENT_DURATION_MIN;
}

/** Slots em hora cheia; seg–sex 14h–20h; sáb 13h–18h; domingo fechado. */
function isValidHourlyBookingSlot(dateYmd, timeStr) {
    const tNorm = normalizeSlotTimeHHMM(timeStr);
    if (!tNorm || !/^\d{2}:00$/.test(tNorm)) return false;
    if (!isValidReportDateYmd(String(dateYmd || ''))) return false;
    const d = new Date(`${dateYmd}T12:00:00`);
    const dow = d.getDay();
    const hour = Number(tNorm.slice(0, 2));
    if (!Number.isFinite(hour)) return false;
    if (dow === 0) return false;
    if (dow === 6) return hour >= 13 && hour <= 18;
    return hour >= 14 && hour <= 20;
}

function sortSlotsChronologically(slots) {
    return [...slots].sort((a, b) => {
        if (a.date !== b.date) return String(a.date).localeCompare(String(b.date));
        return (timeStrToMinutes(a.time) || 0) - (timeStrToMinutes(b.time) || 0);
    });
}

function timeStrFromMinutes(totalMins) {
    const m = Math.round(Number(totalMins) || 0);
    const h = Math.floor(m / 60);
    const mm = ((m % 60) + 60) % 60;
    return normalizeSlotTimeHHMM(`${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`);
}

const APPOINTMENT_SLOT_STATUS_ACTIVE = 'active';
const APPOINTMENT_SLOT_STATUS_CANCELLED = 'cancelled';

function normalizeSlotStatus(st) {
    const s = String(st || APPOINTMENT_SLOT_STATUS_ACTIVE).trim().toLowerCase();
    return s === APPOINTMENT_SLOT_STATUS_CANCELLED ? APPOINTMENT_SLOT_STATUS_CANCELLED : APPOINTMENT_SLOT_STATUS_ACTIVE;
}

function isSlotCancelled(slot) {
    return normalizeSlotStatus(slot && slot.status) === APPOINTMENT_SLOT_STATUS_CANCELLED;
}

function enrichAppointmentSlotRecord(x, slotIndex) {
    const sid = String(x.serviceId || x.service_id || '').trim();
    const d = String(x.date || '').trim();
    const t = normalizeSlotTimeHHMM(x.time);
    if (!sid || !isValidReportDateYmd(d) || !t) return null;
    const svc = findServiceById(sid);
    return {
        slotIndex,
        serviceId: sid,
        date: d,
        time: t,
        status: normalizeSlotStatus(x.status),
        cancelledAt: x.cancelledAt || x.cancelled_at || null,
        cancelReason: x.cancelReason != null ? String(x.cancelReason) : x.cancel_reason != null ? String(x.cancel_reason) : null,
        rescheduledAt: x.rescheduledAt || x.rescheduled_at || null,
        serviceName: svc.name || sid,
        price: roundMoney2(Number(svc.price) || 0),
        duration: getServiceDurationMinForSchedule(sid)
    };
}

function parseServiceSlotsJson(raw) {
    if (raw == null || raw === '') return null;
    try {
        const p = JSON.parse(raw);
        if (!Array.isArray(p) || p.length === 0) return null;
        const out = [];
        for (let i = 0; i < p.length; i++) {
            const rec = enrichAppointmentSlotRecord(p[i], i);
            if (!rec) return null;
            out.push(rec);
        }
        return out.length ? out : null;
    } catch (_) {
        return null;
    }
}

/** Slots do agendamento: JSON explícito ou reconstrução legada a partir de date/time + service_ids. */
function getServiceSlotsFromRow(row) {
    if (!row) return [];
    const parsed = parseServiceSlotsJson(row.service_slots_json);
    if (parsed && parsed.length) return parsed;
    const ids = getAppointmentServiceIdsFromRow(row);
    const d = row.date != null ? String(row.date).trim() : '';
    const t0 = row.time != null ? normalizeSlotTimeHHMM(row.time) : null;
    if (!isValidReportDateYmd(d) || !t0 || ids.length === 0) return [];
    if (ids.length === 1) {
        const rec = enrichAppointmentSlotRecord({ serviceId: ids[0], date: d, time: t0, status: APPOINTMENT_SLOT_STATUS_ACTIVE }, 0);
        return rec ? [rec] : [];
    }
    let cur = timeStrToMinutes(t0);
    if (cur == null) return [];
    const out = [];
    for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const ts = timeStrFromMinutes(cur);
        if (!ts) return [];
        const rec = enrichAppointmentSlotRecord(
            { serviceId: id, date: d, time: ts, status: APPOINTMENT_SLOT_STATUS_ACTIVE },
            i
        );
        if (!rec) return [];
        out.push(rec);
        cur += getServiceDurationMinForSchedule(id);
    }
    return out;
}

function getActiveServiceSlotsFromRow(row) {
    return getServiceSlotsFromRow(row).filter((sl) => !isSlotCancelled(sl));
}

function getActiveAppointmentServiceIdsFromRow(row) {
    const active = getActiveServiceSlotsFromRow(row);
    if (active.length) {
        const out = [];
        const seen = new Set();
        for (const sl of active) {
            if (!sl.serviceId || seen.has(sl.serviceId)) continue;
            seen.add(sl.serviceId);
            out.push(sl.serviceId);
        }
        if (out.length) return out;
    }
    return getAppointmentServiceIdsFromRow(row);
}

function countActiveSlotsFromRow(row) {
    return getActiveServiceSlotsFromRow(row).length;
}

function serializeAppointmentSlots(slots) {
    return JSON.stringify(
        (slots || []).map((sl, i) => ({
            serviceId: sl.serviceId,
            date: sl.date,
            time: sl.time,
            status: normalizeSlotStatus(sl.status),
            ...(sl.cancelledAt ? { cancelledAt: sl.cancelledAt } : {}),
            ...(sl.cancelReason ? { cancelReason: sl.cancelReason } : {}),
            ...(sl.rescheduledAt ? { rescheduledAt: sl.rescheduledAt } : {})
        }))
    );
}

function syncAppointmentPrimaryFromActiveSlots(slots) {
    const active = sortSlotsChronologically((slots || []).filter((sl) => !isSlotCancelled(sl)));
    if (!active.length) return { primaryDate: null, primaryTime: null, primaryServiceId: null };
    return {
        primaryDate: active[0].date,
        primaryTime: active[0].time,
        primaryServiceId: active[0].serviceId
    };
}

function sumActiveProcedurePricesFromRow(row) {
    return roundMoney2(
        getActiveServiceSlotsFromRow(row).reduce((sum, sl) => sum + roundMoney2(Number(sl.price) || 0), 0)
    );
}

/** Recalcula valores pendentes após cancelar item; não altera valores já recebidos (online/local confirmado). */
function financialPatchAfterActiveItemsChange(row) {
    const st = String(row.status || '').trim().toLowerCase();
    if (st === 'cancelled' || st === 'completed') return {};
    const totalActive = sumActiveProcedurePricesFromRow(row);
    if (!Number.isFinite(totalActive) || totalActive < 0) return {};

    const pt = String(row.payment_type || '').trim().toLowerCase();
    const paid = toMoneyNumber(row.paid_amount);
    const hasPaid = paid != null && paid > 0.005;

    if (pt === 'local') {
        if (hasPaid) {
            return { remaining_amount: Math.max(0, roundMoney2(totalActive - paid)) };
        }
        return { remaining_amount: Math.max(0, totalActive), payment_amount: 0 };
    }

    if (st === 'pending_payment' && !hasPaid) {
        return {
            amount_charged: totalActive,
            remaining_amount: 0,
            payment_amount: totalActive
        };
    }

    if (hasPaid && totalActive + 0.005 < paid) {
        return { remaining_amount: 0 };
    }
    if (hasPaid) {
        return { remaining_amount: Math.max(0, roundMoney2(totalActive - paid)) };
    }

    return {};
}

async function backfillAppointmentSlotItemStatus() {
    if (!isPostgresSetup) return;
    try {
        const res = await pool.query(`
            SELECT id, service_slots_json
            FROM appointments
            WHERE service_slots_json IS NOT NULL AND TRIM(service_slots_json) <> ''
        `);
        for (const row of res.rows) {
            const slots = parseServiceSlotsJson(row.service_slots_json);
            if (!slots || !slots.length) continue;
            let changed = false;
            const next = slots.map((sl, i) => {
                if (sl.status && sl.slotIndex === i) return sl;
                changed = true;
                return { ...sl, status: normalizeSlotStatus(sl.status), slotIndex: i };
            });
            if (changed) {
                await pool.query(`UPDATE appointments SET service_slots_json = $1 WHERE id = $2`, [
                    serializeAppointmentSlots(next),
                    row.id
                ]);
            }
        }
    } catch (e) {
        console.warn('[Migration] backfillAppointmentSlotItemStatus:', e.message);
    }
}

function appointmentDurationMinutesFromRow(row) {
    const ids = getAppointmentServiceIdsFromRow(row);
    const mins = ids.reduce((sum, id) => sum + getServiceDurationMinForSchedule(id), 0);
    return mins > 0 ? mins : DEFAULT_APPOINTMENT_DURATION_MIN;
}

function getIntervalsFromSlots(slots) {
    const byDate = new Map();
    for (const sl of slots) {
        const S = timeStrToMinutes(sl.time);
        if (S == null) continue;
        const dur = getServiceDurationMinForSchedule(sl.serviceId);
        const arr = byDate.get(sl.date) || [];
        arr.push({ start: S, end: S + dur });
        byDate.set(sl.date, arr);
    }
    return byDate;
}

function intervalsFromAppointmentRow(row) {
    return getIntervalsFromSlots(getActiveServiceSlotsFromRow(row));
}

function resolveSlotsFromRequest(body, serviceIdsNorm) {
    const n = serviceIdsNorm.length;
    if (n === 0) return { err: 'Nenhum procedimento.', slots: null, scheduleMode: null };
    if (n === 1) {
        const date = String(body.date || '').trim();
        const time = normalizeSlotTimeHHMM(body.time);
        if (!isValidReportDateYmd(date) || !time) {
            return { err: 'Dados obrigatórios faltando.', slots: null, scheduleMode: null };
        }
        return {
            err: null,
            scheduleMode: 'single',
            slots: [{ serviceId: serviceIdsNorm[0], date, time }]
        };
    }
    const mode = String(body.scheduleMode || '').trim().toLowerCase();
    if (mode !== 'sequential' && mode !== 'per_service') {
        return {
            err: 'Para vários procedimentos informe scheduleMode: "sequential" ou "per_service".',
            slots: null,
            scheduleMode: null
        };
    }
    if (mode === 'sequential') {
        const date = String(body.date || '').trim();
        const time = normalizeSlotTimeHHMM(body.time);
        if (!isValidReportDateYmd(date) || !time) {
            return { err: 'Dados obrigatórios faltando.', slots: null, scheduleMode: null };
        }
        const slots = [];
        let cur = timeStrToMinutes(time);
        if (cur == null) return { err: 'Horário inválido.', slots: null, scheduleMode: null };
        for (let i = 0; i < n; i++) {
            const id = serviceIdsNorm[i];
            const tStr = timeStrFromMinutes(cur);
            if (!tStr || !isValidHourlyBookingSlot(date, tStr)) {
                return { err: 'Sequência de horários inválida para o dia escolhido.', slots: null, scheduleMode: null };
            }
            slots.push({ serviceId: id, date, time: tStr });
            cur += getServiceDurationMinForSchedule(id);
        }
        return { err: null, scheduleMode: 'sequential', slots };
    }
    const rawSlots = Array.isArray(body.slots) ? body.slots : [];
    if (rawSlots.length !== n) {
        return {
            err: 'Envie o array slots com date e time para cada procedimento (mesma ordem de serviceIds).',
            slots: null,
            scheduleMode: null
        };
    }
    const slots = [];
    for (let i = 0; i < n; i++) {
        const id = serviceIdsNorm[i];
        const ds = String(rawSlots[i]?.date || '').trim();
        const tt = normalizeSlotTimeHHMM(rawSlots[i]?.time);
        const sidBody = String(rawSlots[i]?.serviceId || rawSlots[i]?.service_id || '').trim();
        if (sidBody && sidBody !== id) {
            return { err: 'serviceId em slots não corresponde à ordem de serviceIds.', slots: null, scheduleMode: null };
        }
        if (!isValidReportDateYmd(ds) || !tt) {
            return { err: 'Data ou horário inválido em um dos procedimentos.', slots: null, scheduleMode: null };
        }
        slots.push({ serviceId: id, date: ds, time: tt });
    }
    return { err: null, scheduleMode: 'per_service', slots };
}

function validateNewBookingSlots(newSlots, existingRows, blockedFullSet, blockedSlotsByDate, excludeAppointmentId) {
    const newMap = getIntervalsFromSlots(newSlots);
    const excludeId = excludeAppointmentId != null ? String(excludeAppointmentId).trim() : '';
    const peerRows = excludeId
        ? (existingRows || []).filter((r) => String(r.id) !== excludeId)
        : existingRows || [];
    for (const sl of newSlots) {
        if (blockedFullSet.has(sl.date)) return 'Dia indisponível (bloqueado).';
        const bs = blockedSlotsByDate.get(sl.date);
        const nn = normalizeSlotTimeHHMM(sl.time);
        if (bs && nn && bs.has(nn)) return 'Horário indisponível (bloqueado manualmente).';
        const T = timeStrToMinutes(sl.time);
        if (T == null || !nn) return 'Horário inválido.';
        if (!isValidHourlyBookingSlot(sl.date, sl.time)) return 'Horário inválido ou fora do expediente.';
    }
    for (const [, ints] of newMap) {
        for (let i = 0; i < ints.length; i++) {
            for (let j = i + 1; j < ints.length; j++) {
                const a = ints[i];
                const b = ints[j];
                if (a.start < b.end && a.end > b.start) {
                    return 'Os horários escolhidos para os procedimentos entram em conflito.';
                }
            }
        }
    }
    for (const [date, newInts] of newMap) {
        for (const row of peerRows) {
            const exMap = intervalsFromAppointmentRow(row);
            const exInts = exMap.get(date) || [];
            for (const ni of newInts) {
                for (const ei of exInts) {
                    if (ni.start < ei.end && ni.end > ei.start) return 'Conflito com horário já reservado.';
                    if (Math.abs(ni.start - ei.start) < MIN_START_GAP_MINUTES) {
                        return 'É necessário intervalo mínimo de 1 hora entre agendamentos.';
                    }
                }
            }
        }
    }
    return null;
}

async function fetchLockedAppointmentRowsForDates(clientPg, dates) {
    const sorted = [...new Set((dates || []).map((d) => String(d || '').trim()).filter(isValidReportDateYmd))].sort();
    const byId = new Map();
    for (const d of sorted) {
        const res = await clientPg.query(
            `
            SELECT *
            FROM appointments
            WHERE status IN ('pending_payment', 'confirmed', 'completed')
              AND (
                date = $1
                OR (
                  service_slots_json IS NOT NULL
                  AND service_slots_json <> ''
                  AND EXISTS (
                    SELECT 1
                    FROM jsonb_array_elements(service_slots_json::jsonb) elem
                    WHERE elem->>'date' = $1
                  )
                )
              )
            FOR UPDATE
        `,
            [d]
        );
        for (const row of res.rows) {
            byId.set(row.id, row);
        }
    }
    return [...byId.values()];
}

function toMoneyNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function roundMoney2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
}

/** Valor monetário em centavos (inteiro) para somas sem erro de ponto flutuante. */
function moneyToCents(value) {
    const n = toMoneyNumber(value);
    if (n == null || !Number.isFinite(n)) return 0;
    return Math.round(n * 100);
}

function centsToReais(cents) {
    const c = Math.round(Number(cents) || 0);
    return roundMoney2(c / 100);
}

function mapDbRowToCatalogService(row) {
    if (!row) return null;
    const price = roundMoney2(Number(row.price));
    const duration = Math.round(Number(row.duration));
    return {
        id: row.id,
        name: row.name,
        category: row.category != null ? String(row.category) : 'Geral',
        price: Number.isFinite(price) ? price : 0,
        duration: Number.isFinite(duration) && duration > 0 ? duration : DEFAULT_APPOINTMENT_DURATION_MIN,
        summary: row.summary != null ? String(row.summary) : '',
        detail: row.description != null ? String(row.description) : '',
        card_title: row.card_title != null ? String(row.card_title) : null,
        active: row.active !== false,
        is_promotional_package: !!row.is_promotional_package,
        promotional_campaign: row.promotional_campaign != null ? String(row.promotional_campaign) : null,
        sort_order: Math.round(Number(row.sort_order)) || 0,
        archived_at: row.archived_at != null ? row.archived_at : null
    };
}

async function refreshServicesCatalogCache() {
    if (!isPostgresSetup) return;
    try {
        const { rows } = await pool.query(
            `SELECT id, name, category, price, duration, summary, description, card_title, active,
                    is_promotional_package, promotional_campaign, sort_order, archived_at
             FROM catalog_services
             ORDER BY sort_order ASC, name ASC`
        );
        servicesCatalogAll = rows.map(mapDbRowToCatalogService);
        console.log(`[catalog_services] Cache: ${servicesCatalogAll.length} itens.`);
    } catch (e) {
        console.error('[catalog_services] Falha ao recarregar cache:', e);
    }
}

async function refreshPromotionalSettingsCache() {
    if (!isPostgresSetup) {
        promotionalCampaignsAll = [];
        promoPackagesEnabledCache = false;
        return;
    }
    try {
        promoPackagesEnabledCache = await readPromotionalPackagesEnabledFromDb();
        const { rows } = await pool.query(
            `SELECT id, name, description, active, valid_from, valid_to, category, sort_order, created_at, updated_at, archived_at
             FROM promotional_campaigns
             WHERE archived_at IS NULL
             ORDER BY sort_order ASC, name ASC`
        );
        promotionalCampaignsAll = rows;
    } catch (e) {
        console.error('[promotional_campaigns] Falha ao recarregar cache:', e);
        promotionalCampaignsAll = [];
    }
}

function isCampaignActiveFlag(cRow) {
    if (!cRow) return false;
    const raw = cRow.active;
    if (raw === true || raw === 1) return true;
    if (raw === false || raw === 0 || raw == null) return false;
    const s = String(raw).trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 't') return true;
    if (s === 'false' || s === '0' || s === 'f' || s === '') return false;
    return Boolean(raw);
}

function getCampaignDisplayName(campaignId) {
    const row = getCampaignRowById(campaignId);
    if (!row || row.name == null) return undefined;
    const name = String(row.name).trim();
    return name || undefined;
}

function isCampaignLiveForNow(cRow) {
    if (!cRow) return false;
    if (cRow.archived_at != null && String(cRow.archived_at).trim() !== '') return false;
    if (!isCampaignActiveFlag(cRow)) return false;
    const nowMs = Date.now();
    if (cRow.valid_from != null) {
        const t = new Date(cRow.valid_from).getTime();
        if (Number.isFinite(t) && t > nowMs) return false;
    }
    if (cRow.valid_to != null) {
        const t = new Date(cRow.valid_to).getTime();
        if (Number.isFinite(t) && t < nowMs) return false;
    }
    return true;
}

function getCampaignRowById(campaignId) {
    const cid = String(campaignId || '').trim();
    if (!cid || !Array.isArray(promotionalCampaignsAll)) return null;
    return promotionalCampaignsAll.find((r) => String(r.id) === cid) || null;
}

/** Catálogo visível para novos agendamentos: pacotes exigem campanha ativa e dentro da validade (sem interruptor global). */
function isServiceVisibleForBooking(s) {
    if (!s || s.active === false) return false;
    if (s.archived_at != null && String(s.archived_at).trim() !== '') return false;
    if (!s.is_promotional_package) return true;
    const cid = s.promotional_campaign != null ? String(s.promotional_campaign).trim() : '';
    if (!cid) return false;
    return isCampaignLiveForNow(getCampaignRowById(cid));
}

function getActiveServicesCatalogForBooking() {
    if (Array.isArray(servicesCatalogAll) && servicesCatalogAll.length > 0) {
        return servicesCatalogAll.filter((s) => isServiceVisibleForBooking(s));
    }
    return SERVICES_CATALOG.filter((s) => {
        if (!PROMO_PACKAGE_IDS.has(s.id)) return true;
        return promoPackagesEnabledCache;
    });
}

function isPromotionalPackageServiceId(serviceId) {
    const sid = String(serviceId || '');
    if (PROMO_PACKAGE_IDS.has(sid)) return true;
    const s = Array.isArray(servicesCatalogAll) && servicesCatalogAll.find((x) => x.id === sid);
    return !!(s && s.is_promotional_package);
}

function toPublicServiceJson(s) {
    return {
        id: s.id,
        name: s.name,
        price: s.price,
        category: s.category || 'Geral',
        duration: s.duration,
        summary: s.summary || '',
        detail: s.detail || '',
        cardTitle: s.card_title || undefined,
        promotionalCampaign: s.promotional_campaign || undefined,
        promotionalCampaignName: getCampaignDisplayName(s.promotional_campaign) || undefined,
        isPromotionalPackage: !!s.is_promotional_package
    };
}

/** Sinal na reserva parcial: no máximo o fixo do produto, e nunca acima do valor total do procedimento. */
function effectivePartialDownPayment(totalServicePrice) {
    const t = roundMoney2(Number(totalServicePrice) || 0);
    if (t <= 0) return FIXED_SIGNAL_AMOUNT;
    return roundMoney2(Math.min(FIXED_SIGNAL_AMOUNT, t));
}

function findServiceById(serviceId) {
    const id = String(serviceId || '');
    if (Array.isArray(servicesCatalogAll) && servicesCatalogAll.length > 0) {
        const hit = servicesCatalogAll.find((s) => s.id === id);
        if (hit) return hit;
    }
    const leg = SERVICES_LEGACY.find((s) => s.id === id);
    if (leg) {
        return {
            id: leg.id,
            name: leg.name,
            price: roundMoney2(Number(leg.price) || 0),
            duration: leg.duration || DEFAULT_APPOINTMENT_DURATION_MIN,
            category: 'Legado',
            summary: '',
            detail: '',
            card_title: null,
            active: true,
            is_promotional_package: false,
            promotional_campaign: null,
            sort_order: 0
        };
    }
    const boot = SERVICES_CATALOG.find((s) => s.id === id);
    if (boot) {
        return {
            id: boot.id,
            name: boot.name,
            price: roundMoney2(Number(boot.price) || 0),
            duration: boot.duration || DEFAULT_APPOINTMENT_DURATION_MIN,
            category: 'Geral',
            summary: '',
            detail: '',
            card_title: null,
            active: true,
            is_promotional_package: PROMO_PACKAGE_IDS.has(boot.id),
            promotional_campaign: PROMO_PACKAGE_IDS.has(boot.id) ? 'dia_maes' : null,
            sort_order: 0
        };
    }
    return {
        id,
        name: id || 'Serviço',
        price: 0,
        duration: DEFAULT_APPOINTMENT_DURATION_MIN,
        category: 'Geral',
        summary: '',
        detail: '',
        card_title: null,
        active: false,
        is_promotional_package: false,
        promotional_campaign: null,
        sort_order: 0
    };
}

/** IDs do agendamento: JSON em `service_ids_json` ou legado só `service_id`. */
function getAppointmentServiceIdsFromRow(row) {
    if (!row) return [];
    const raw = row.service_ids_json;
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length > 0) {
                const out = [];
                const seen = new Set();
                for (const x of parsed) {
                    const id = String(x || '').trim();
                    if (!id || seen.has(id)) continue;
                    seen.add(id);
                    out.push(id);
                }
                if (out.length) return out;
            }
        } catch (_) {
            /* ignore */
        }
    }
    const sid = row.service_id != null ? String(row.service_id).trim() : '';
    return sid ? [sid] : [];
}

/** Nome e preço agregados para e-mails (admin/cliente). */
function buildServiceEmailAggregate(ids) {
    const lines = [];
    let total = 0;
    for (const id of ids) {
        const s = findServiceById(id);
        const p = roundMoney2(Number(s.price) || 0);
        total += p;
        lines.push(s.name || id);
    }
    return {
        name: lines.join(' + '),
        price: roundMoney2(total)
    };
}

function normalizeIncomingServiceIds(body) {
    if (Array.isArray(body?.serviceIds) && body.serviceIds.length > 0) {
        const out = [];
        const seen = new Set();
        for (const x of body.serviceIds) {
            const id = String(x || '').trim();
            if (!id || seen.has(id)) continue;
            seen.add(id);
            out.push(id);
        }
        return out;
    }
    const one = body?.serviceId != null ? String(body.serviceId).trim() : '';
    return one ? [one] : [];
}

function normalizeAppointmentFinancials(row) {
    const activeSlots = getActiveServiceSlotsFromRow(row);
    let totalServicePrice = 0;
    if (activeSlots.length) {
        totalServicePrice = roundMoney2(activeSlots.reduce((sum, sl) => sum + roundMoney2(Number(sl.price) || 0), 0));
    } else {
        const ids = getAppointmentServiceIdsFromRow(row);
        for (const id of ids) {
            const s = findServiceById(id);
            totalServicePrice += roundMoney2(Number(s.price) || 0);
        }
        totalServicePrice = roundMoney2(totalServicePrice);
    }
    if (!Number.isFinite(totalServicePrice) || totalServicePrice <= 0) {
        const fallback = findServiceById(row.service_id);
        totalServicePrice = roundMoney2(Number(fallback.price) || 0);
    }

    const rawTypeEarly = row.payment_type != null ? String(row.payment_type).toLowerCase().trim() : '';
    if (rawTypeEarly === 'local') {
        const remDb = toMoneyNumber(row.remaining_amount);
        const remainingAmount = Math.max(
            0,
            roundMoney2(remDb != null && Number.isFinite(remDb) ? remDb : totalServicePrice)
        );
        const amtDb = toMoneyNumber(row.amount_charged);
        const amountCharged = amtDb != null && Number.isFinite(amtDb) ? roundMoney2(amtDb) : 0;
        const status = row.status;
        const paidDb = toMoneyNumber(row.paid_amount);
        let paidAmount = null;
        if (status === 'confirmed' || status === 'completed') {
            paidAmount = paidDb != null && paidDb > 0 ? roundMoney2(paidDb) : 0;
        } else if (paidDb != null) {
            paidAmount = roundMoney2(paidDb);
        }
        return {
            paymentType: 'local',
            amountCharged,
            remainingAmount,
            paidAmount,
            totalServicePrice
        };
    }

    const partialSignal = effectivePartialDownPayment(totalServicePrice);

    const paymentAmount = roundMoney2(row.payment_amount ?? FIXED_SIGNAL_AMOUNT);

    let paymentType = row.payment_type ? String(row.payment_type).toLowerCase() : null;
    if (paymentType && !['partial', 'full'].includes(paymentType)) {
        paymentType = null;
    }

    let amountCharged = toMoneyNumber(row.amount_charged);
    let remainingAmount = toMoneyNumber(row.remaining_amount);

    // Inferência segura para registros antigos / inconsistentes
    if (!paymentType) {
        if (amountCharged != null && totalServicePrice > 0) {
            if (Math.abs(amountCharged - totalServicePrice) < 0.01) paymentType = 'full';
            else if (
                Math.abs(amountCharged - partialSignal) < 0.01 ||
                Math.abs(amountCharged - FIXED_SIGNAL_AMOUNT) < 0.01
            ) {
                paymentType = 'partial';
            }
        }

        if (!paymentType && amountCharged == null && paymentAmount != null) {
            // legado: payment_amount costuma representar o sinal
            if (Math.abs(paymentAmount - FIXED_SIGNAL_AMOUNT) < 0.01 || Math.abs(paymentAmount - partialSignal) < 0.01) {
                paymentType = 'partial';
                amountCharged = partialSignal;
            }
        }

        if (!paymentType) {
            paymentType = 'partial';
        }
    }

    if (paymentType === 'full') {
        amountCharged = totalServicePrice > 0 ? totalServicePrice : (amountCharged ?? totalServicePrice);
        remainingAmount = 0;
    } else {
        // partial — coerência com sinal limitado ao total do procedimento
        const sig = effectivePartialDownPayment(totalServicePrice);
        amountCharged = sig;

        if (remainingAmount == null) {
            remainingAmount = Math.max(0, roundMoney2(totalServicePrice - amountCharged));
        }
    }

    remainingAmount = Math.max(0, roundMoney2(remainingAmount ?? 0));

    let paidAmount = toMoneyNumber(row.paid_amount);
    const status = row.status;

    if (status === 'confirmed' || status === 'completed') {
        if (paidAmount == null || paidAmount <= 0) {
            paidAmount = amountCharged != null ? roundMoney2(amountCharged) : null;
        } else {
            paidAmount = roundMoney2(paidAmount);
        }
    } else if (paidAmount != null) {
        paidAmount = roundMoney2(paidAmount);
    }

    return {
        paymentType,
        amountCharged: amountCharged != null ? roundMoney2(amountCharged) : null,
        remainingAmount: remainingAmount != null ? roundMoney2(remainingAmount) : null,
        paidAmount,
        totalServicePrice
    };
}

/**
 * Valor recebido no relatório (apenas confirmado/concluído).
 * Regra: somar o que realmente entrou (integral ou sinal), sem usar preço antigo do catálogo
 * como “pago” e sem subtrair remaining_amount.
 * - Lê `paid_amount` e `amount_charged` crus no banco.
 * - Pagamento integral (`full`): se ambos > 0, usa max(paid, charged) em centavos (corrige
 *   casos em que o sinal ficou gravado em paid_amount mas o charged reflete o total pago).
 * - Parcial: prioriza paid_amount; se zero/nulo, usa amount_charged; último recurso fin.paidAmount.
 */
function reportEffectiveReceivedPaid(row) {
    if (row.status !== 'confirmed' && row.status !== 'completed') {
        return 0;
    }
    const fin = normalizeAppointmentFinancials(row);
    const rawPaid = toMoneyNumber(row.paid_amount);
    const rawCharged = toMoneyNumber(row.amount_charged);
    const paidPos = rawPaid != null && rawPaid > 0;
    const chargedPos = rawCharged != null && rawCharged > 0;

    let cents = 0;

    if (fin.paymentType === 'local') {
        const remDb = toMoneyNumber(row.remaining_amount);
        const settled = remDb != null && Number.isFinite(remDb) && remDb <= 0.005;
        if (paidPos) {
            cents = moneyToCents(rawPaid);
        } else if (settled && chargedPos) {
            // Legado raro: quitado sem paid_amount — não usar amount_charged enquanto houver pendência no registro
            cents = moneyToCents(rawCharged);
        } else if (settled && fin.paidAmount != null && fin.paidAmount > 0) {
            cents = moneyToCents(fin.paidAmount);
        }
        return centsToReais(cents);
    }

    if (fin.paymentType === 'full') {
        if (paidPos && chargedPos) {
            cents = Math.max(moneyToCents(rawPaid), moneyToCents(rawCharged));
        } else if (paidPos) {
            cents = moneyToCents(rawPaid);
        } else if (chargedPos) {
            cents = moneyToCents(rawCharged);
        } else if (fin.paidAmount != null && fin.paidAmount > 0) {
            cents = moneyToCents(fin.paidAmount);
        }
    } else {
        if (paidPos) {
            cents = moneyToCents(rawPaid);
        } else if (chargedPos) {
            cents = moneyToCents(rawCharged);
        } else if (fin.paidAmount != null && fin.paidAmount > 0) {
            cents = moneyToCents(fin.paidAmount);
        }
    }

    return centsToReais(cents);
}

/**
 * Classificação parcial vs integral para agregação do relatório (evita “tudo parcial” por default da normalização).
 */
function reportPaymentKindForAggregation(row, fin, receivedReais) {
    const raw = row.payment_type != null ? String(row.payment_type).toLowerCase().trim() : '';
    if (raw === 'local') {
        return 'local';
    }
    if (raw === 'full' || raw === 'partial') {
        return raw;
    }
    const tot = fin.totalServicePrice || 0;
    const recv = Number(receivedReais);
    if (tot > 0 && Number.isFinite(recv) && recv + 0.005 >= tot) {
        return 'full';
    }
    const paid = toMoneyNumber(row.paid_amount);
    const charged = toMoneyNumber(row.amount_charged);
    const ref = paid != null && paid > 0 ? paid : charged;
    if (tot > 0 && ref != null && Math.abs(ref - tot) < 0.01) {
        return 'full';
    }
    return 'partial';
}

/** Saldo a receber (só parcial), ≥ 0. */
function reportEffectiveRemainingPartial(row, fin) {
    let rem = toMoneyNumber(row.remaining_amount);
    if (rem == null || rem < 0) {
        rem = fin.remainingAmount != null ? fin.remainingAmount : 0;
    }
    return Math.max(0, roundMoney2(rem));
}

/**
 * Valor ainda a receber em agendamentos **não** confirmados/concluídos (ex.: checkout InfinitePay pendente).
 * Não inclui cancelados. Alinhado ao KPI "Valor a receber" do relatório.
 */
function reportPendingPaymentToReceiveKpi(row, fin) {
    const st = String(row.status || '').trim().toLowerCase();
    if (st !== 'pending_payment') return 0;
    const ptRaw = String(row.payment_type || '').trim().toLowerCase();
    if (ptRaw === 'full' || fin.paymentType === 'full') {
        const total = roundMoney2(Number(fin.totalServicePrice || 0));
        if (!Number.isFinite(total) || total <= 0) return 0;
        const paid = toMoneyNumber(row.paid_amount);
        const paidAdj = paid != null && Number.isFinite(paid) && paid > 0 ? paid : 0;
        return Math.max(0, roundMoney2(total - paidAdj));
    }
    if (ptRaw === 'partial' || fin.paymentType === 'partial') {
        return reportEffectiveRemainingPartial(row, fin);
    }
    return 0;
}

function buildPaymentSummary(row) {
    const fin = normalizeAppointmentFinancials(row);
    const status = row.status;

    const isPartial = fin.paymentType === 'partial';
    const isFull = fin.paymentType === 'full';
    const isLocal = fin.paymentType === 'local';

    const paymentTypeLabel = isLocal
        ? 'Pagamento no local'
        : isFull
            ? 'Total'
            : 'Parcial (histórico)';

    let paymentStatusLabel = 'Aguardando pagamento';
    if (status === 'pending_payment') {
        paymentStatusLabel = isFull ? 'Aguardando pagamento online' : 'Aguardando pagamento';
    } else if (status === 'confirmed') {
        if (isLocal) {
            const remL = fin.remainingAmount != null ? Number(fin.remainingAmount) : null;
            paymentStatusLabel =
                remL != null && Number.isFinite(remL) && remL > 0.005
                    ? 'Pendente pagamento local'
                    : 'Pagamento confirmado';
        } else if (isFull) {
            const cap = String(row.capture_method || '').toLowerCase();
            paymentStatusLabel =
                cap && cap !== 'manual' && cap !== 'manual_balance' ? 'Pago via InfinitePay' : 'Pagamento confirmado';
        } else {
            paymentStatusLabel = 'Pagamento confirmado';
        }
    } else if (status === 'completed') {
        if (isLocal) {
            const remL = fin.remainingAmount != null ? Number(fin.remainingAmount) : null;
            paymentStatusLabel =
                remL != null && Number.isFinite(remL) && remL > 0.005
                    ? 'Pendente pagamento local'
                    : 'Pagamento confirmado';
        } else {
            paymentStatusLabel = 'Concluído';
        }
    } else if (status === 'cancelled') {
        paymentStatusLabel = 'Cancelado';
    }

    const paidAmount = fin.paidAmount;
    const isPaid = (status === 'confirmed' || status === 'completed')
        && paidAmount != null
        && paidAmount > 0;

    return {
        paymentStatusLabel,
        paymentTypeLabel,
        amountCharged: fin.amountCharged,
        remainingAmount: fin.remainingAmount,
        paidAmount,
        totalServicePrice: fin.totalServicePrice,
        isPaid,
        isPartial,
        isFull,
        isLocal,
        paymentKind: fin.paymentType
    };
}

/**
 * Canal da reserva para UI/WhatsApp: `local` | `online` | null.
 * null = histórico (ex.: parcial antigo ou integral confirmado só como manual) — usar `paymentType` nos textos legados.
 */
function derivePaymentMethodForApi(row, fin) {
    const pt = String(fin?.paymentType || '').toLowerCase();
    if (pt === 'local') return 'local';
    if (pt === 'partial') return null;
    if (pt === 'full') {
        const st = String(row?.status || '').toLowerCase();
        if (st === 'pending_payment') return 'online';
        const cap = String(row?.capture_method || '').trim().toLowerCase();
        if (cap && cap !== 'manual' && cap !== 'manual_balance') return 'online';
        const url = row?.payment_url != null ? String(row.payment_url).trim() : '';
        if (url.startsWith('http')) return 'online';
        return null;
    }
    return null;
}

function mapAppointmentRow(row) {
    const fin = normalizeAppointmentFinancials(row);
    const paymentSummary = buildPaymentSummary(row);
    const allSlots = getServiceSlotsFromRow(row);
    const activeSlots = allSlots.filter((sl) => !isSlotCancelled(sl));
    const serviceIds = getAppointmentServiceIdsFromRow(row);
    const activeServiceIds = getActiveAppointmentServiceIdsFromRow(row);
    const serviceLineItems = allSlots.length
        ? allSlots.map((sl) => ({
              id: sl.serviceId,
              slotIndex: sl.slotIndex,
              name: sl.serviceName || sl.serviceId,
              price: roundMoney2(Number(sl.price) || 0),
              date: sl.date,
              time: sl.time,
              status: sl.status,
              cancelledAt: sl.cancelledAt || null,
              cancelReason: sl.cancelReason || null,
              rescheduledAt: sl.rescheduledAt || null
          }))
        : serviceIds.map((id) => {
              const s = findServiceById(id);
              return {
                  id,
                  slotIndex: 0,
                  name: s.name || id,
                  price: roundMoney2(Number(s.price) || 0),
                  date: row.date,
                  time: row.time,
                  status: APPOINTMENT_SLOT_STATUS_ACTIVE,
                  cancelledAt: null,
                  cancelReason: null,
                  rescheduledAt: null
              };
          });

    return {
        id: row.id,
        serviceId: row.service_id,
        serviceIds,
        activeServiceIds,
        serviceLineItems,
        hasItemLevelControl: allSlots.length > 0,
        activeItemCount: activeSlots.length,
        cancelledItemCount: allSlots.filter((sl) => isSlotCancelled(sl)).length,
        clientId: row.client_id,
        clientName: row.client_name,
        clientPhone: row.client_phone,
        location: row.location,
        date: row.date,
        time: row.time,
        notes: row.notes,
        createdAt: row.created_at,
        status: row.status,
        paymentUrl: row.payment_url,
        paymentAmount: Number(row.payment_amount || FIXED_SIGNAL_AMOUNT),
        paymentType: fin.paymentType,
        amountCharged: fin.amountCharged,
        remainingAmount: fin.remainingAmount,
        transactionNsu: row.transaction_nsu,
        invoiceSlug: row.invoice_slug,
        receiptUrl: row.receipt_url,
        captureMethod: row.capture_method,
        paidAmount: fin.paidAmount,
        manualPaymentNote: row.manual_payment_note,
        cancelledAt: row.cancelled_at,
        cancelledBy: row.cancelled_by,
        cancelReason: row.cancel_reason,
        paymentSummary,
        paymentMethod: derivePaymentMethodForApi(row, fin),
        scheduleMode: row.schedule_mode || null,
        serviceSlots: allSlots.map((sl) => ({
            serviceId: sl.serviceId,
            date: sl.date,
            time: sl.time,
            status: sl.status,
            slotIndex: sl.slotIndex,
            cancelledAt: sl.cancelledAt || null,
            cancelReason: sl.cancelReason || null,
            rescheduledAt: sl.rescheduledAt || null,
            serviceName: sl.serviceName,
            price: sl.price
        }))
    };
}

async function sweepExpiredPending() {
    if (!isPostgresSetup) return;

    try {
        const result = await pool.query(`
            UPDATE appointments
            SET status = 'cancelled',
                cancel_reason = 'Pagamento não identificado em 15 minutos',
                cancelled_at = CURRENT_TIMESTAMP,
                cancelled_by = 'system'
            WHERE status = 'pending_payment'
              AND created_at < CURRENT_TIMESTAMP - INTERVAL '15 minutes'
              AND LOWER(COALESCE(payment_type, '')) <> 'local'
            RETURNING id
        `);

        if (result.rowCount > 0) {
            console.log(`[Sweep] ${result.rowCount} agendamento(s) pendente(s) cancelado(s) por expiração.`);
        }
    } catch (e) {
        console.error('[Sweep] Falha na varredura de pendentes:', e);
    }
}

/**
 * Envia e-mail amigável à cliente após pagamento confirmado (uma vez por agendamento).
 */
/** E-mails admin + cliente para reserva confirmada sem checkout (pagamento no local). */
async function notifyNewLocalBookingEmails(appointmentRow) {
    const appointmentId = appointmentRow.id;
    try {
        const ids = getAppointmentServiceIdsFromRow(appointmentRow);
        const serviceObj = buildServiceEmailAggregate(ids);
        await sendConfirmationEmail(appointmentRow, serviceObj);
        console.log(`[LocalBooking] E-mail administrativo enviado (${appointmentId}).`);
    } catch (emailErr) {
        console.error(`[LocalBooking] Falha e-mail admin (${appointmentId}):`, emailErr);
    }
    try {
        await trySendClientAppointmentConfirmationIfNeeded(appointmentRow);
    } catch (clientMailErr) {
        console.error(`[LocalBooking] Falha e-mail cliente (${appointmentId}):`, clientMailErr);
    }
}

async function trySendClientAppointmentConfirmationIfNeeded(appointmentRow) {
    const appointmentId = appointmentRow.id;
    if (appointmentRow.client_confirmation_email_sent_at) {
        return;
    }

    const cid = appointmentRow.client_id;
    if (!cid) {
        return;
    }

    const cr = await pool.query('SELECT email FROM clients WHERE id = $1', [cid]);
    const em = normalizeEmail(cr.rows[0]?.email);
    if (!isValidEmailBasic(em)) {
        console.warn(`[Payment] E-mail da cliente ausente ou inválido; não enviando confirmação ao cliente (${appointmentId}).`);
        return;
    }

    const ids = getAppointmentServiceIdsFromRow(appointmentRow);
    const serviceObj = buildServiceEmailAggregate(ids);
    const fin = normalizeAppointmentFinancials(appointmentRow);
    const rowForClientEmail = {
        ...appointmentRow,
        payment_type: fin.paymentType,
        paid_amount: fin.paidAmount,
        amount_charged: fin.amountCharged,
        remaining_amount: fin.remainingAmount
    };
    await sendClientConfirmationEmail(rowForClientEmail, serviceObj, em);

    await pool.query(
        `
        UPDATE appointments
        SET client_confirmation_email_sent_at = CURRENT_TIMESTAMP
        WHERE id = $1
          AND client_confirmation_email_sent_at IS NULL
    `,
        [appointmentId]
    );

    console.log(`[Payment] E-mail ao cliente enviado (${maskEmailForLog(em)}) agendamento ${appointmentId}.`);
}

async function confirmAppointmentPayment({ appointmentId, transactionNsu, invoiceSlug, receiptUrl, captureMethod, paidAmount }) {
    if (!appointmentId) {
        throw new Error('appointmentId não informado para confirmação do pagamento');
    }

    const existing = await pool.query('SELECT * FROM appointments WHERE id = $1', [appointmentId]);
    if (existing.rows.length === 0) {
        throw new Error(`Agendamento ${appointmentId} não encontrado`);
    }

    const before = existing.rows[0];
    const previousStatus = before.status;

    if (String(before.payment_type || '').trim().toLowerCase() === 'local') {
        console.log(`[Payment] Ignorando confirmação de gateway: agendamento ${appointmentId} é pagamento no local.`);
        return {
            appointment: before,
            alreadyProcessed: true,
            updated: false,
            previousStatus
        };
    }

    const paidFromWebhook = (paidAmount === null || paidAmount === undefined)
        ? null
        : Number(paidAmount);

    const amountChargedBefore =
        before.amount_charged != null && before.amount_charged !== ''
            ? Number(before.amount_charged)
            : null;
    const paymentTypeNorm = String(before.payment_type || '').toLowerCase();

    let paidResolved = (paidFromWebhook != null && Number.isFinite(paidFromWebhook) && paidFromWebhook > 0)
        ? paidFromWebhook
        : (amountChargedBefore != null && Number.isFinite(amountChargedBefore) && amountChargedBefore > 0
            ? amountChargedBefore
            : null);

    // Integral: o valor cobrado no checkout está em amount_charged; o webhook pode mandar paid_amount do sinal.
    if (
        paymentTypeNorm === 'full' &&
        amountChargedBefore != null &&
        Number.isFinite(amountChargedBefore) &&
        amountChargedBefore > 0
    ) {
        if (paidResolved == null || !Number.isFinite(paidResolved) || paidResolved <= 0) {
            paidResolved = amountChargedBefore;
        } else {
            paidResolved = Math.max(paidResolved, amountChargedBefore);
        }
    }

    // Cancelado: não confirmar pagamento (idempotente / seguro)
    if (previousStatus === 'cancelled') {
        console.log(`[Payment] Ignorando confirmação: agendamento ${appointmentId} está cancelado (status=${previousStatus}).`);
        return {
            appointment: before,
            alreadyProcessed: false,
            updated: false,
            previousStatus
        };
    }

    // Já processado: não reenviar e-mail, mas pode enriquecer metadados sem mudar status
    if (previousStatus === 'confirmed' || previousStatus === 'completed') {
        const metaUpdate = await pool.query(`
            UPDATE appointments
            SET transaction_nsu = COALESCE($2, transaction_nsu),
                invoice_slug = COALESCE($3, invoice_slug),
                receipt_url = COALESCE($4, receipt_url),
                capture_method = COALESCE($5, capture_method),
                paid_amount = COALESCE(
                    NULLIF($6::numeric, 0::numeric),
                    NULLIF(paid_amount, 0::numeric),
                    paid_amount,
                    amount_charged
                )
            WHERE id = $1
            RETURNING *
        `, [
            appointmentId,
            transactionNsu || null,
            invoiceSlug || null,
            receiptUrl || null,
            captureMethod || null,
            paidResolved
        ]);

        const appointment = metaUpdate.rows[0] || before;
        console.log(`[Payment] Webhook duplicado/reatribuição: agendamento ${appointmentId} já estava ${previousStatus} (sem reprocessar confirmação).`);

        try {
            if (!appointment.client_confirmation_email_sent_at) {
                await trySendClientAppointmentConfirmationIfNeeded(appointment);
            }
        } catch (clientMailErr) {
            console.error(`[Payment] Falha ao enviar e-mail à cliente (recuperação) ${appointmentId}:`, clientMailErr);
        }

        return {
            appointment,
            alreadyProcessed: true,
            updated: metaUpdate.rowCount > 0,
            previousStatus
        };
    }

    // Fluxo principal: pending_payment -> confirmed
    if (previousStatus !== 'pending_payment') {
        console.log(`[Payment] Ignorando confirmação: agendamento ${appointmentId} com status inesperado (${previousStatus}).`);
        return {
            appointment: before,
            alreadyProcessed: true,
            updated: false,
            previousStatus
        };
    }

    const updateResult = await pool.query(`
        UPDATE appointments
        SET status = 'confirmed',
            transaction_nsu = COALESCE($2, transaction_nsu),
            invoice_slug = COALESCE($3, invoice_slug),
            receipt_url = COALESCE($4, receipt_url),
            capture_method = COALESCE($5, capture_method),
            paid_amount = COALESCE(
                NULLIF($6::numeric, 0::numeric),
                NULLIF(paid_amount, 0::numeric),
                amount_charged
            )
        WHERE id = $1
          AND status = 'pending_payment'
        RETURNING *
    `, [
        appointmentId,
        transactionNsu || null,
        invoiceSlug || null,
        receiptUrl || null,
        captureMethod || null,
        paidResolved
    ]);

    if (updateResult.rows.length === 0) {
        // Race: alguém mudou o status entre o SELECT e o UPDATE
        const again = await pool.query('SELECT * FROM appointments WHERE id = $1', [appointmentId]);
        const current = again.rows[0] || before;
        console.log(`[Payment] Concorrência detectada ao confirmar ${appointmentId}: status atual=${current.status}.`);
        return {
            appointment: current,
            alreadyProcessed: current.status !== 'pending_payment',
            updated: false,
            previousStatus
        };
    }

    const appointment = updateResult.rows[0];
    console.log(`[Payment] Agendamento ${appointmentId} confirmado com sucesso (${previousStatus} -> confirmed). paid_amount_resolved=${paidResolved}`);

    try {
        const ids = getAppointmentServiceIdsFromRow(appointment);
        const serviceObj = buildServiceEmailAggregate(ids);
        await sendConfirmationEmail(appointment, serviceObj);
        console.log(`[Payment] E-mail de confirmação enviado para o agendamento ${appointmentId}.`);
    } catch (emailErr) {
        console.error(`[Payment] Falha ao enviar e-mail do agendamento ${appointmentId}:`, emailErr);
    }

    try {
        await trySendClientAppointmentConfirmationIfNeeded(appointment);
    } catch (clientMailErr) {
        console.error(`[Payment] Falha ao enviar e-mail à cliente do agendamento ${appointmentId}:`, clientMailErr);
    }

    return {
        appointment,
        alreadyProcessed: false,
        updated: true,
        previousStatus
    };
}

// ======================= HEALTHCHECK =======================

app.get('/health', async (req, res) => {
    try {
        if (!isPostgresSetup) {
            return res.status(500).json({ status: 'error', db: 'missing_database_url' });
        }

        await pool.query('SELECT 1');
        return res.json({ status: 'ok', db: 'connected' });
    } catch (error) {
        return res.status(500).json({ status: 'error', db: 'down', details: error.message });
    }
});

// ======================== API CLIENTES ========================

app.get('/clients', requireAdminAuth, async (req, res) => {
    if (!isPostgresSetup) {
        return res.json([]);
    }

    try {
        const { rows } = await pool.query('SELECT * FROM clients ORDER BY name ASC');
        return res.json(rows);
    } catch (error) {
        console.error('[GET /clients] Erro:', error);
        return res.status(500).json({ error: 'Erro ao buscar clientes' });
    }
});

app.post('/clients', async (req, res) => {
    if (!isPostgresSetup) {
        return res.status(500).json({ error: 'DB não configurado.' });
    }

    try {
        const { id, name, phone, address, email } = req.body;

        if (!name || !phone) {
            return res.status(400).json({ error: 'Nome e telefone são obrigatórios.' });
        }

        const cleanPhone = String(phone).replace(/\D/g, '');

        if (!cleanPhone) {
            return res.status(400).json({ error: 'Telefone inválido.' });
        }

        const normEmail = normalizeEmail(email);
        if (!isValidEmailBasic(normEmail)) {
            return res.status(400).json({ error: 'Informe um e-mail válido.' });
        }

        const exist = await pool.query('SELECT * FROM clients WHERE phone = $1', [cleanPhone]);

        if (exist.rows.length > 0) {
            const existingClient = exist.rows[0];

            const update = await pool.query(`
                UPDATE clients
                SET name = $1,
                    address = $2,
                    email = $3
                WHERE phone = $4
                RETURNING *
            `, [
                name,
                address || existingClient.address || '',
                normEmail,
                cleanPhone
            ]);

            return res.status(200).json(update.rows[0]);
        }

        const clientId = id || Date.now().toString();

        const insert = await pool.query(`
            INSERT INTO clients (id, name, phone, address, email)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
        `, [
            clientId,
            name,
            cleanPhone,
            address || '',
            normEmail
        ]);

        return res.status(201).json(insert.rows[0]);
    } catch (error) {
        console.error('[POST /clients] Erro:', error);
        return res.status(500).json({ error: 'Erro ao criar cliente' });
    }
});

/**
 * Atualização de cadastro pela própria cliente (área pública).
 * Exige `verifyPhoneDigits` igual ao telefone atual no banco — não substitui autenticação forte,
 * mas impede alteração arbitrária sem conhecer o número cadastrado.
 */
app.patch('/clients/:id/self', async (req, res) => {
    if (!isPostgresSetup) {
        return res.status(500).json({ error: 'DB não configurado.' });
    }

    const rawId = req.params.id;
    const id = rawId != null ? String(rawId).trim() : '';
    if (!id) {
        return res.status(400).json({ error: 'ID inválido.' });
    }

    try {
        const { name, phone, address, email, verifyPhoneDigits } = req.body || {};
        const verifyDigits = String(verifyPhoneDigits || '').replace(/\D/g, '');

        if (!verifyDigits) {
            return res.status(400).json({ error: 'Confirmação de telefone ausente.' });
        }

        const curRow = await pool.query('SELECT * FROM clients WHERE id = $1', [id]);
        if (curRow.rows.length === 0) {
            return res.status(404).json({ error: 'Cadastro não encontrado.' });
        }

        const storedDigits = String(curRow.rows[0].phone || '').replace(/\D/g, '');
        if (storedDigits !== verifyDigits) {
            return res.status(403).json({
                error: 'Não foi possível confirmar seu telefone em relação ao cadastro. Verifique o número e tente novamente.'
            });
        }

        if (!name || !phone) {
            return res.status(400).json({ error: 'Nome e telefone são obrigatórios.' });
        }

        const cleanPhone = String(phone).replace(/\D/g, '');
        if (!cleanPhone) {
            return res.status(400).json({ error: 'Telefone inválido.' });
        }

        const normEmail = normalizeEmail(email);
        if (!isValidEmailBasic(normEmail)) {
            return res.status(400).json({ error: 'Informe um e-mail válido.' });
        }

        const conflict = await pool.query(
            'SELECT id FROM clients WHERE phone = $1 AND id <> $2',
            [cleanPhone, id]
        );
        if (conflict.rows.length > 0) {
            return res.status(409).json({ error: 'Já existe outro cadastro com este telefone.' });
        }

        const upd = await pool.query(
            `
            UPDATE clients
            SET name = $1,
                phone = $2,
                address = $3,
                email = $4
            WHERE id = $5
            RETURNING *
        `,
            [name, cleanPhone, address || '', normEmail, id]
        );

        await pool.query(
            `UPDATE appointments SET client_name = $1, client_phone = $2 WHERE client_id = $3`,
            [name, cleanPhone, id]
        );

        return res.json(upd.rows[0]);
    } catch (error) {
        console.error('[PATCH /clients/:id/self] Erro:', error);
        return res.status(500).json({ error: 'Erro ao atualizar cadastro.' });
    }
});

app.patch('/admin/clients/:id', requireAdminAuth, async (req, res) => {
    if (!isPostgresSetup) {
        return res.status(500).json({ error: 'DB não configurado.' });
    }

    const rawId = req.params.id;
    const id = rawId != null ? String(rawId).trim() : '';
    if (!id) {
        return res.status(400).json({ error: 'ID inválido.' });
    }

    try {
        const { name, phone, address, email } = req.body || {};

        if (!name || !phone) {
            return res.status(400).json({ error: 'Nome e telefone são obrigatórios.' });
        }

        const cleanPhone = String(phone).replace(/\D/g, '');
        if (!cleanPhone) {
            return res.status(400).json({ error: 'Telefone inválido.' });
        }

        const normEmail = normalizeEmail(email);
        if (!isValidEmailBasic(normEmail)) {
            return res.status(400).json({ error: 'Informe um e-mail válido.' });
        }

        const cur = await pool.query('SELECT id FROM clients WHERE id = $1', [id]);
        if (cur.rows.length === 0) {
            return res.status(404).json({ error: 'Cadastro não encontrado.' });
        }

        const conflict = await pool.query(
            'SELECT id FROM clients WHERE phone = $1 AND id <> $2',
            [cleanPhone, id]
        );
        if (conflict.rows.length > 0) {
            return res.status(409).json({ error: 'Já existe outro cadastro com este telefone.' });
        }

        const upd = await pool.query(
            `
            UPDATE clients
            SET name = $1,
                phone = $2,
                address = $3,
                email = $4
            WHERE id = $5
            RETURNING *
        `,
            [name, cleanPhone, address || '', normEmail, id]
        );

        await pool.query(
            `UPDATE appointments SET client_name = $1, client_phone = $2 WHERE client_id = $3`,
            [name, cleanPhone, id]
        );

        return res.json(upd.rows[0]);
    } catch (error) {
        console.error('[PATCH /admin/clients/:id] Erro:', error);
        return res.status(500).json({ error: 'Erro ao atualizar cliente.' });
    }
});

app.delete('/admin/clients/:id', requireAdminAuth, async (req, res) => {
    if (!isPostgresSetup) {
        return res.status(500).json({ error: 'DB não configurado.' });
    }

    const rawId = req.params.id;
    const id = rawId != null ? String(rawId).trim() : '';
    if (!id) {
        return res.status(400).json({ error: 'ID inválido.' });
    }

    try {
        const del = await pool.query('DELETE FROM clients WHERE id = $1 RETURNING id', [id]);
        if (del.rowCount === 0) {
            return res.status(404).json({ error: 'Cadastro não encontrado.' });
        }
        return res.json({ ok: true, id: del.rows[0].id });
    } catch (error) {
        if (error && error.code === '23503') {
            return res.status(409).json({
                error: 'Não é possível apagar: existem agendamentos vinculados a este cadastro. Cancele ou remova os agendamentos antes.'
            });
        }
        console.error('[DELETE /admin/clients/:id] Erro:', error);
        return res.status(500).json({ error: 'Erro ao remover cliente.' });
    }
});

// ====================== API AGENDAMENTOS ======================

app.get('/appointments', requireAdminAuth, async (req, res) => {
    if (!isPostgresSetup) {
        return res.json([]);
    }

    await sweepExpiredPending();

    try {
        const { rows } = await pool.query('SELECT * FROM appointments ORDER BY date ASC, time ASC');
        const formatted = rows.map(mapAppointmentRow);
        return res.json(formatted);
    } catch (error) {
        console.error('[GET /appointments] Erro:', error);
        return res.status(500).json({ error: 'Erro ao buscar agendamentos' });
    }
});

// ====================== ADMIN AUTH (MVP) ======================

app.post('/admin/login', (req, res) => {
    if (!process.env.ADMIN_PASSWORD) {
        return res.status(503).json({ error: 'Acesso administrativo não configurado no servidor.' });
    }
    const pwd = req.body && req.body.password;
    if (!verifyAdminPasswordCandidate(pwd)) {
        return res.status(401).json({ error: 'Credenciais inválidas.' });
    }
    if (!adminSigningSecret()) {
        return res.status(503).json({ error: 'Configuração incompleta do servidor.' });
    }
    const token = signAdminToken();
    if (!token) {
        return res.status(500).json({ error: 'Não foi possível iniciar a sessão.' });
    }
    return res.json({
        token,
        expiresInSec: ADMIN_SESSION_TTL_SEC
    });
});

// ====================== ADMIN REPORT ======================

app.get('/admin/report', requireAdminAuth, async (req, res) => {
    if (!isPostgresSetup) {
        return res.status(500).json({ error: 'DB não configurado.' });
    }

    try {
        const { start, end } = req.query || {};

        if (!start || !end) {
            return res.status(400).json({
                error: 'Informe o período com start e end no formato YYYY-MM-DD. Ex: /admin/report?start=2026-04-01&end=2026-04-30'
            });
        }

        const startStr = String(start);
        const endStr = String(end);

        // date é VARCHAR(10) (YYYY-MM-DD), então a comparação lexicográfica funciona.
        const { rows } = await pool.query(`
            SELECT *
            FROM appointments
            WHERE date >= $1 AND date <= $2
            ORDER BY date ASC, time ASC
        `, [startStr, endStr]);

        const items = rows.map(r => {
            const ids = getActiveAppointmentServiceIdsFromRow(r);
            const agg = buildServiceEmailAggregate(ids);
            const fin = normalizeAppointmentFinancials(r);
            const isPaidRow = r.status === 'confirmed' || r.status === 'completed';
            return {
                id: r.id,
                clientName: r.client_name,
                clientPhone: r.client_phone,
                serviceId: r.service_id,
                serviceIds: ids,
                serviceName: agg.name || r.service_id || 'Serviço',
                date: r.date,
                time: r.time,
                status: r.status,
                paymentType: fin.paymentType,
                paymentMethod: derivePaymentMethodForApi(r, fin),
                amountCharged: fin.amountCharged,
                remainingAmount: fin.remainingAmount,
                captureMethod: r.capture_method,
                paidAmount: fin.paidAmount,
                /** Mesmo critério do KPI “Total recebido” (só confirmado/concluído; demais null). */
                effectiveReceivedPaid: isPaidRow ? reportEffectiveReceivedPaid(r) : null,
                procedureTotal: fin.totalServicePrice != null ? roundMoney2(fin.totalServicePrice) : null
            };
        });

        /** KPIs do relatório admin. totalRevenue = soma do recebido (integral + parcial/sinal) só em confirmed/completed. */
        const summary = {
            totalAppointments: rows.length,
            confirmedCount: 0,
            cancelledCount: 0,
            completedCount: 0,
            pendingCount: 0,
            uniqueClients: 0,
            totalRevenue: 0,
            totalPartialReceived: 0,
            totalFullReceived: 0,
            totalRemainingToReceive: 0,
            totalExpectedRevenue: 0
        };

        let totalRevenueCents = 0;
        let totalPartialReceivedCents = 0;
        let totalFullReceivedCents = 0;

        const uniqueClientKeys = new Set();
        for (const r of rows) {
            if (r.status === 'confirmed') summary.confirmedCount += 1;
            else if (r.status === 'cancelled') summary.cancelledCount += 1;
            else if (r.status === 'completed') summary.completedCount += 1;
            else if (r.status === 'pending_payment') summary.pendingCount += 1;

            const clientKey = r.client_id || r.client_phone || null;
            if (clientKey) uniqueClientKeys.add(String(clientKey));

            const fin = normalizeAppointmentFinancials(r);
            const isPaidStatus = r.status === 'confirmed' || r.status === 'completed';
            if (!isPaidStatus) {
                summary.totalRemainingToReceive += reportPendingPaymentToReceiveKpi(r, fin);
                continue;
            }

            const received = reportEffectiveReceivedPaid(r);
            const kind = reportPaymentKindForAggregation(r, fin, received);
            const receivedCents = moneyToCents(received);

            totalRevenueCents += receivedCents;
            summary.totalExpectedRevenue += fin.totalServicePrice || 0;

            if (kind === 'partial' || kind === 'local') {
                totalPartialReceivedCents += receivedCents;
                summary.totalRemainingToReceive += reportEffectiveRemainingPartial(r, fin);
            } else if (kind === 'full') {
                totalFullReceivedCents += receivedCents;
            }
        }

        summary.uniqueClients = uniqueClientKeys.size;
        summary.totalRevenue = centsToReais(totalRevenueCents);
        summary.totalPartialReceived = centsToReais(totalPartialReceivedCents);
        summary.totalFullReceived = centsToReais(totalFullReceivedCents);

        return res.json({
            period: { start: startStr, end: endStr },
            summary,
            items
        });
    } catch (error) {
        console.error('[GET /admin/report] Erro:', error);
        return res.status(500).json({ error: 'Erro ao gerar relatório.' });
    }
});

// ====================== BLOQUEIOS DE AGENDA (LEITURA PÚBLICA + ADMIN) ======================

app.get('/public/schedule-blocks', async (_req, res) => {
    res.set('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
    res.set('Pragma', 'no-cache');
    if (!isPostgresSetup) {
        return res.json({ blockedSlots: [], blockedFullDays: [] });
    }
    try {
        const [slotsRes, daysRes] = await Promise.all([
            pool.query(
                `
                SELECT id, date, time, reason, created_at
                FROM blocked_slots
                ORDER BY date ASC, time ASC
            `
            ),
            pool.query(
                `
                SELECT id, date, reason, created_at
                FROM blocked_full_days
                ORDER BY date ASC
            `
            )
        ]);
        return res.json({
            blockedSlots: slotsRes.rows.map((r) => ({
                id: r.id,
                date: r.date,
                time: normalizeSlotTimeHHMM(r.time) || r.time,
                reason: r.reason,
                createdAt: r.created_at
            })),
            blockedFullDays: daysRes.rows.map((r) => ({
                id: r.id,
                date: r.date,
                reason: r.reason,
                createdAt: r.created_at
            }))
        });
    } catch (error) {
        console.error('[GET /public/schedule-blocks] Erro:', error);
        return res.status(500).json({ error: 'Erro ao carregar bloqueios.' });
    }
});

async function readPromotionalPackagesEnabledFromDb() {
    if (!isPostgresSetup) return false;
    try {
        const r = await pool.query(
            `SELECT value FROM app_settings WHERE key = 'promotional_packages_enabled' LIMIT 1`
        );
        const v = r.rows[0]?.value;
        if (v === true || v === false) return Boolean(v);
        const s = String(v ?? '')
            .trim()
            .toLowerCase();
        return s === 'true' || s === '1' || s === 'yes' || s === 'on';
    } catch (e) {
        console.warn('[app_settings] promotional_packages_enabled:', e.message);
        return false;
    }
}

app.get('/config/public', async (_req, res) => {
    /* Dinâmico (WhatsApp + campanhas): não cachear — evita cliente/admin verem flag promocional “voltando” sozinha. */
    res.set('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
    res.set('Pragma', 'no-cache');
    try {
        const promotionalPackagesEnabled = await readPromotionalPackagesEnabledFromDb();
        res.json({
            adminWhatsApp: getPublicAdminWhatsappDigits(),
            promotionalPackagesEnabled
        });
    } catch (error) {
        console.error('[GET /config/public] Erro:', error);
        res.json({ adminWhatsApp: getPublicAdminWhatsappDigits(), promotionalPackagesEnabled: false });
    }
});

// ====================== API PÚBLICA (AGENDA / CADASTRO — SEM LISTAGEM TOTAL) ======================

app.get('/public/appointments', async (req, res) => {
    res.set('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
    res.set('Pragma', 'no-cache');
    const purpose = String(req.query.purpose || '').trim().toLowerCase();
    if (purpose !== 'occupancy') {
        return res.status(400).json({ error: 'Informe purpose=occupancy para esta rota.' });
    }
    if (!isPostgresSetup) {
        return res.json([]);
    }
    try {
        const { rows } = await pool.query('SELECT * FROM appointments ORDER BY date ASC, time ASC');
        const formatted = rows.map((r) => sanitizeAppointmentForPublicOccupancy(mapAppointmentRow(r)));
        return res.json(formatted);
    } catch (error) {
        console.error('[GET /public/appointments] Erro:', error);
        return res.status(500).json({ error: 'Erro ao buscar ocupação da agenda.' });
    }
});

app.get('/public/my-appointments', async (req, res) => {
    res.set('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
    res.set('Pragma', 'no-cache');
    const digits = String(req.query.phoneDigits || '').replace(/\D/g, '');
    if (digits.length < 10) {
        return res.status(400).json({ error: 'Informe phoneDigits com ao menos 10 dígitos.' });
    }
    if (!isPostgresSetup) {
        return res.json([]);
    }
    try {
        const { rows } = await pool.query(
            `
            SELECT *
            FROM appointments
            WHERE regexp_replace(coalesce(client_phone, ''), '[^0-9]', '', 'g') = $1
            ORDER BY date ASC, time ASC
        `,
            [digits]
        );
        return res.json(rows.map((r) => mapAppointmentRow(r)));
    } catch (error) {
        console.error('[GET /public/my-appointments] Erro:', error);
        return res.status(500).json({ error: 'Erro ao buscar agendamentos.' });
    }
});

app.get('/public/appointment/:id', async (req, res) => {
    res.set('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
    res.set('Pragma', 'no-cache');
    const id = req.params.id != null ? String(req.params.id).trim() : '';
    if (!id) {
        return res.status(400).json({ error: 'ID inválido.' });
    }
    if (!isPostgresSetup) {
        return res.status(404).json({ error: 'Não encontrado.' });
    }
    try {
        const { rows } = await pool.query('SELECT * FROM appointments WHERE id = $1', [id]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Agendamento não encontrado.' });
        }
        return res.json(mapAppointmentRow(rows[0]));
    } catch (error) {
        console.error('[GET /public/appointment/:id] Erro:', error);
        return res.status(500).json({ error: 'Erro ao buscar agendamento.' });
    }
});

app.get('/public/clients', async (req, res) => {
    res.set('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
    res.set('Pragma', 'no-cache');
    const digits = String(req.query.phoneDigits || '').replace(/\D/g, '');
    if (digits.length < 10) {
        return res.status(400).json({ error: 'Informe phoneDigits com ao menos 10 dígitos.' });
    }
    if (!isPostgresSetup) {
        return res.json([]);
    }
    try {
        const { rows } = await pool.query(
            `
            SELECT *
            FROM clients
            WHERE regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') = $1
            ORDER BY name ASC
            LIMIT 3
        `,
            [digits]
        );
        if (rows.length > 1) {
            console.warn('[GET /public/clients] Múltiplos cadastros para o mesmo telefone; retornando o primeiro.');
        }
        return res.json(rows.length ? [rows[0]] : []);
    } catch (error) {
        console.error('[GET /public/clients] Erro:', error);
        return res.status(500).json({ error: 'Erro ao buscar cadastro.' });
    }
});

// ====================== ADMIN BLOQUEIOS DE HORÁRIO ======================

app.get('/admin/blocked-slots', requireAdminAuth, async (req, res) => {
    if (!isPostgresSetup) {
        return res.status(500).json({ error: 'DB não configurado.' });
    }

    try {
        const { rows } = await pool.query(`
            SELECT id, date, time, reason, created_at
            FROM blocked_slots
            ORDER BY date ASC, time ASC
        `);
        return res.json(
            rows.map((r) => ({
                id: r.id,
                date: r.date,
                time: normalizeSlotTimeHHMM(r.time) || r.time,
                reason: r.reason,
                createdAt: r.created_at
            }))
        );
    } catch (error) {
        console.error('[GET /admin/blocked-slots] Erro:', error);
        return res.status(500).json({ error: 'Erro ao listar bloqueios.' });
    }
});

app.post('/admin/blocked-slots', requireAdminAuth, async (req, res) => {
    if (!isPostgresSetup) {
        return res.status(500).json({ error: 'DB não configurado.' });
    }

    try {
        const { date, time, reason } = req.body || {};

        if (!isValidReportDateYmd(String(date || ''))) {
            return res.status(400).json({ error: 'Data inválida. Use YYYY-MM-DD.' });
        }

        const tNorm = normalizeSlotTimeHHMM(time);
        if (!tNorm) {
            return res.status(400).json({ error: 'Horário inválido. Use HH:MM.' });
        }

        if (!isValidHourlyBookingSlot(date, time)) {
            return res.status(400).json({
                error: 'Horário inválido ou fora do expediente. Use apenas horas cheias (ex.: 14:00).'
            });
        }

        const ins = await pool.query(
            `
            INSERT INTO blocked_slots (date, time, reason)
            VALUES ($1, $2, $3)
            RETURNING id, date, time, reason, created_at
        `,
            [date, tNorm, reason || null]
        );

        const r = ins.rows[0];
        return res.status(201).json({
            id: r.id,
            date: r.date,
            time: normalizeSlotTimeHHMM(r.time) || r.time,
            reason: r.reason,
            createdAt: r.created_at
        });
    } catch (error) {
        if (error && error.code === '23505') {
            return res.status(409).json({ error: 'Já existe bloqueio para esta data e horário.' });
        }
        console.error('[POST /admin/blocked-slots] Erro:', error);
        return res.status(500).json({ error: 'Erro ao criar bloqueio.' });
    }
});

app.delete('/admin/blocked-slots/:id', requireAdminAuth, async (req, res) => {
    if (!isPostgresSetup) {
        return res.status(500).json({ error: 'DB não configurado.' });
    }

    const rawId = req.params.id;
    const id = parseInt(String(rawId), 10);
    if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'ID inválido.' });
    }

    try {
        const del = await pool.query('DELETE FROM blocked_slots WHERE id = $1 RETURNING id', [id]);
        if (del.rowCount === 0) {
            return res.status(404).json({ error: 'Bloqueio não encontrado.' });
        }
        return res.json({ ok: true, id });
    } catch (error) {
        console.error('[DELETE /admin/blocked-slots] Erro:', error);
        return res.status(500).json({ error: 'Erro ao remover bloqueio.' });
    }
});

// ====================== ADMIN BLOQUEIO DE DIA INTEIRO ======================

app.post('/admin/blocked-full-days', requireAdminAuth, async (req, res) => {
    if (!isPostgresSetup) {
        return res.status(500).json({ error: 'DB não configurado.' });
    }

    try {
        const { date, reason } = req.body || {};

        if (!isValidReportDateYmd(String(date || ''))) {
            return res.status(400).json({ error: 'Data inválida. Use YYYY-MM-DD.' });
        }

        const ins = await pool.query(
            `
            INSERT INTO blocked_full_days (date, reason)
            VALUES ($1, $2)
            RETURNING id, date, reason, created_at
        `,
            [date, reason || null]
        );

        const r = ins.rows[0];
        return res.status(201).json({
            id: r.id,
            date: r.date,
            reason: r.reason,
            createdAt: r.created_at
        });
    } catch (error) {
        if (error && error.code === '23505') {
            return res.status(409).json({ error: 'Este dia já está bloqueado por completo.' });
        }
        console.error('[POST /admin/blocked-full-days] Erro:', error);
        return res.status(500).json({ error: 'Erro ao bloquear o dia.' });
    }
});

app.delete('/admin/blocked-full-days/:id', requireAdminAuth, async (req, res) => {
    if (!isPostgresSetup) {
        return res.status(500).json({ error: 'DB não configurado.' });
    }

    const rawId = req.params.id;
    const id = parseInt(String(rawId), 10);
    if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'ID inválido.' });
    }

    try {
        const del = await pool.query('DELETE FROM blocked_full_days WHERE id = $1 RETURNING id', [id]);
        if (del.rowCount === 0) {
            return res.status(404).json({ error: 'Bloqueio de dia não encontrado.' });
        }
        return res.json({ ok: true, id });
    } catch (error) {
        console.error('[DELETE /admin/blocked-full-days] Erro:', error);
        return res.status(500).json({ error: 'Erro ao remover bloqueio do dia.' });
    }
});

app.patch('/admin/promotional-packages', requireAdminAuth, async (req, res) => {
    if (!isPostgresSetup) {
        return res.status(500).json({ error: 'DB não configurado.' });
    }

    const raw = req.body && req.body.enabled;
    const enabled = raw === true || String(raw).toLowerCase() === 'true';

    try {
        const valueStr = enabled ? 'true' : 'false';
        await pool.query(
            `
            INSERT INTO app_settings (key, value, updated_at)
            VALUES ('promotional_packages_enabled', $1, NOW())
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
        `,
            [valueStr]
        );
        await refreshPromotionalSettingsCache();
        return res.json({ ok: true, promotionalPackagesEnabled: Boolean(enabled) });
    } catch (error) {
        console.error('[PATCH /admin/promotional-packages] Erro:', error);
        return res.status(500).json({ error: 'Erro ao salvar interrupção geral de campanhas.' });
    }
});

function mapCampaignRowToAdminApi(row) {
    if (!row) return null;
    const rawAct = row.active;
    const activeNorm =
        rawAct === true ||
        rawAct === 1 ||
        String(rawAct || '')
            .trim()
            .toLowerCase() === 'true' ||
        String(rawAct || '')
            .trim()
            .toLowerCase() === 't' ||
        String(rawAct || '')
            .trim()
            .toLowerCase() === '1';
    return {
        id: row.id,
        name: row.name,
        description: row.description != null ? String(row.description) : '',
        active: activeNorm,
        validFrom: row.valid_from ? new Date(row.valid_from).toISOString() : null,
        validTo: row.valid_to ? new Date(row.valid_to).toISOString() : null,
        category: row.category != null ? String(row.category) : 'Campanhas',
        sortOrder: Math.round(Number(row.sort_order)) || 0,
        linkedCount: row.linked_count != null ? Number(row.linked_count) : undefined,
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null
    };
}

/** `undefined` = inválido; `null` = ausente. */
function parseOptionalIsoTimestamp(v) {
    if (v == null || v === '') return null;
    const d = new Date(v);
    if (!Number.isFinite(d.getTime())) return undefined;
    return d;
}

async function generateUniqueCampaignId(dbClient, baseName) {
    let base = slugifyCatalogIdBase(baseName);
    if (!base) base = `campanha_${Date.now()}`;
    base = base.slice(0, 72);
    const r0 = await dbClient.query('SELECT 1 FROM promotional_campaigns WHERE id = $1', [base]);
    if (r0.rowCount === 0) return base;
    let n = 2;
    while (n < 10000) {
        const candidate = `${base}_${n}`.slice(0, 80);
        const r = await dbClient.query('SELECT 1 FROM promotional_campaigns WHERE id = $1', [candidate]);
        if (r.rowCount === 0) return candidate;
        n += 1;
    }
    return `campanha_${Date.now()}`.slice(0, 80);
}

/**
 * Desvincula pacotes desta campanha e vincula os ids informados como pacotes promocionais.
 * @param {import('pg').PoolClient} dbClient
 * @throws {Error} `code === 'BAD_SERVICE_IDS'` se algum serviço não existir ou estiver arquivado.
 */
async function applyCampaignLinkedServiceIds(dbClient, campaignId, rawIds) {
    const cid = String(campaignId || '').trim();
    if (!cid) {
        const err = new Error('INVALID_CAMPAIGN');
        err.code = 'BAD_SERVICE_IDS';
        throw err;
    }
    const ids = [...new Set((rawIds || []).map((x) => String(x || '').trim()).filter(Boolean))];
    await dbClient.query(
        `
        UPDATE catalog_services
        SET promotional_campaign = NULL,
            is_promotional_package = FALSE,
            updated_at = NOW()
        WHERE promotional_campaign = $1
    `,
        [cid]
    );
    if (ids.length === 0) {
        return { linkedCount: 0 };
    }
    const chk = await dbClient.query(
        `SELECT id FROM catalog_services WHERE id = ANY($1::varchar[]) AND archived_at IS NULL`,
        [ids]
    );
    if (chk.rows.length !== ids.length) {
        const err = new Error('INVALID_SERVICE_IDS');
        err.code = 'BAD_SERVICE_IDS';
        throw err;
    }
    await dbClient.query(
        `
        UPDATE catalog_services
        SET promotional_campaign = $1,
            is_promotional_package = TRUE,
            updated_at = NOW()
        WHERE id = ANY($2::varchar[])
    `,
        [cid, ids]
    );
    return { linkedCount: ids.length };
}

app.get('/admin/campaigns', requireAdminAuth, async (_req, res) => {
    if (!isPostgresSetup) {
        return res.status(500).json({ error: 'DB não configurado.' });
    }
    try {
        const { rows } = await pool.query(
            `
            SELECT c.*,
                   (SELECT COUNT(*)::int FROM catalog_services s WHERE s.promotional_campaign = c.id AND s.archived_at IS NULL) AS linked_count
            FROM promotional_campaigns c
            WHERE c.archived_at IS NULL
            ORDER BY c.sort_order ASC, c.name ASC
        `
        );
        return res.json(rows.map((r) => mapCampaignRowToAdminApi(r)));
    } catch (error) {
        console.error('[GET /admin/campaigns] Erro:', error);
        return res.status(500).json({ error: 'Erro ao listar campanhas.' });
    }
});

app.post('/admin/campaigns', requireAdminAuth, async (req, res) => {
    if (!isPostgresSetup) {
        return res.status(500).json({ error: 'DB não configurado.' });
    }
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) {
        return res.status(400).json({ error: 'Informe o nome da campanha.' });
    }
    const description = b.description != null ? String(b.description) : '';
    const category = String(b.category || 'Campanhas').trim() || 'Campanhas';
    const active = !(b.active === false || String(b.active).toLowerCase() === 'false');
    const vf = parseOptionalIsoTimestamp(b.validFrom != null ? b.validFrom : b.valid_from);
    const vt = parseOptionalIsoTimestamp(b.validTo != null ? b.validTo : b.valid_to);
    if (vf === undefined || vt === undefined) {
        return res.status(400).json({ error: 'Datas de validade inválidas (use ISO 8601 ou deixe vazio).' });
    }
    if (vf && vt && vf.getTime() > vt.getTime()) {
        return res.status(400).json({ error: 'A data inicial deve ser anterior à data final.' });
    }

    const rawSid = b.serviceIds != null ? b.serviceIds : b.service_ids;
    if (!Array.isArray(rawSid) || rawSid.length === 0) {
        return res.status(400).json({ error: 'Selecione pelo menos um procedimento para a campanha.' });
    }
    const serviceIdsNorm = [...new Set(rawSid.map((x) => String(x || '').trim()).filter(Boolean))];
    if (serviceIdsNorm.length === 0) {
        return res.status(400).json({ error: 'Selecione pelo menos um procedimento para a campanha.' });
    }

    const dbClient = await pool.connect();
    try {
        await dbClient.query('BEGIN');
        const rawSlug = b.slug != null ? b.slug : b.customSlug;
        const customSlug = rawSlug != null && String(rawSlug).trim() ? slugifyCatalogIdBase(rawSlug) : '';
        const id = customSlug
            ? await (async () => {
                  const exists = await dbClient.query('SELECT 1 FROM promotional_campaigns WHERE id = $1', [
                      customSlug.slice(0, 80)
                  ]);
                  if (exists.rowCount > 0) {
                      throw Object.assign(new Error('CONFLICT_ID'), { code: 'CONFLICT_ID' });
                  }
                  return customSlug.slice(0, 80);
              })()
            : await generateUniqueCampaignId(dbClient, name);
        const soRow = await dbClient.query(
            `SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM promotional_campaigns WHERE archived_at IS NULL`
        );
        const sortOrder = Number.isFinite(Math.round(Number(soRow.rows[0] && soRow.rows[0].n)))
            ? Math.round(Number(soRow.rows[0].n))
            : 0;
        const ins = await dbClient.query(
            `
            INSERT INTO promotional_campaigns (id, name, description, active, valid_from, valid_to, category, sort_order)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id, name, description, active, valid_from, valid_to, category, sort_order, created_at, updated_at
        `,
            [id, name, description, active, vf, vt, category, sortOrder]
        );
        await applyCampaignLinkedServiceIds(dbClient, id, serviceIdsNorm);
        await dbClient.query('COMMIT');
        const row = ins.rows[0];
        const cnt = await dbClient.query(
            `SELECT COUNT(*)::int AS c FROM catalog_services WHERE promotional_campaign = $1 AND archived_at IS NULL`,
            [id]
        );
        row.linked_count = cnt.rows[0].c;
        await refreshPromotionalSettingsCache();
        await refreshServicesCatalogCache();
        return res.status(201).json(mapCampaignRowToAdminApi(row));
    } catch (error) {
        try {
            await dbClient.query('ROLLBACK');
        } catch (_) {
            /* ignore */
        }
        if (error && error.code === 'CONFLICT_ID') {
            return res.status(409).json({ error: 'Já existe uma campanha com este identificador.' });
        }
        if (error && error.code === '23505') {
            return res.status(409).json({ error: 'Identificador de campanha já em uso.' });
        }
        if (error && error.code === 'BAD_SERVICE_IDS') {
            return res.status(400).json({ error: 'Um ou mais procedimentos informados não existem no catálogo.' });
        }
        console.error('[POST /admin/campaigns] Erro:', error);
        return res.status(500).json({ error: 'Erro ao criar campanha.' });
    } finally {
        dbClient.release();
    }
});

app.patch('/admin/campaigns/:id', requireAdminAuth, async (req, res) => {
    if (!isPostgresSetup) {
        return res.status(500).json({ error: 'DB não configurado.' });
    }
    const id = String(req.params.id || '').trim();
    if (!id) {
        return res.status(400).json({ error: 'ID inválido.' });
    }
    const b = req.body || {};
    const archiveRequested =
        b.archived === true ||
        String(b.archived || '').toLowerCase() === 'true' ||
        b.archive === true ||
        String(b.archive || '').toLowerCase() === 'true';

    if (archiveRequested) {
        const client = await pool.connect();
        try {
            const up = await client.query(
                `
                UPDATE promotional_campaigns
                SET archived_at = NOW(),
                    active = FALSE,
                    updated_at = NOW()
                WHERE id = $1 AND archived_at IS NULL
                RETURNING id, name, description, active, valid_from, valid_to, category, sort_order, created_at, updated_at
            `,
                [id]
            );
            if (up.rowCount === 0) {
                return res.status(404).json({ error: 'Campanha não encontrada ou já removida.' });
            }
            const row = up.rows[0];
            const cnt = await client.query(
                `SELECT COUNT(*)::int AS c FROM catalog_services WHERE promotional_campaign = $1 AND archived_at IS NULL`,
                [id]
            );
            row.linked_count = cnt.rows[0].c;
            await refreshPromotionalSettingsCache();
            await refreshServicesCatalogCache();
            return res.json(mapCampaignRowToAdminApi(row));
        } catch (error) {
            console.error('[PATCH /admin/campaigns/:id] Arquivo:', error);
            return res.status(500).json({ error: 'Erro ao arquivar campanha.' });
        } finally {
            client.release();
        }
    }

    const sets = [];
    const vals = [];
    let p = 1;
    const push = (col, val) => {
        sets.push(`${col} = $${p}`);
        vals.push(val);
        p += 1;
    };
    if (b.name !== undefined) {
        const n = String(b.name || '').trim();
        if (!n) return res.status(400).json({ error: 'Nome inválido.' });
        push('name', n);
    }
    if (b.description !== undefined) {
        push('description', b.description != null ? String(b.description) : '');
    }
    if (b.active !== undefined) {
        push('active', !(b.active === false || String(b.active).toLowerCase() === 'false'));
    }
    if (b.category !== undefined) {
        push('category', String(b.category || 'Campanhas').trim() || 'Campanhas');
    }
    if (b.sortOrder !== undefined || b.sort_order !== undefined) {
        const so = Math.round(Number(b.sortOrder !== undefined ? b.sortOrder : b.sort_order));
        if (!Number.isFinite(so)) return res.status(400).json({ error: 'sortOrder inválido.' });
        push('sort_order', so);
    }
    if (b.validFrom !== undefined || b.valid_from !== undefined) {
        const raw = b.validFrom !== undefined ? b.validFrom : b.valid_from;
        const d = parseOptionalIsoTimestamp(raw);
        if (d === undefined) return res.status(400).json({ error: 'validFrom inválido.' });
        push('valid_from', d);
    }
    if (b.validTo !== undefined || b.valid_to !== undefined) {
        const raw = b.validTo !== undefined ? b.validTo : b.valid_to;
        const d = parseOptionalIsoTimestamp(raw);
        if (d === undefined) return res.status(400).json({ error: 'validTo inválido.' });
        push('valid_to', d);
    }

    const hasServiceIdsKey = b.serviceIds !== undefined || b.service_ids !== undefined;
    let serviceIdsForAssign = null;
    if (hasServiceIdsKey) {
        const raw = b.serviceIds !== undefined ? b.serviceIds : b.service_ids;
        if (!Array.isArray(raw)) {
            return res.status(400).json({ error: 'serviceIds inválido.' });
        }
        serviceIdsForAssign = [...new Set(raw.map((x) => String(x || '').trim()).filter(Boolean))];
        if (serviceIdsForAssign.length === 0) {
            return res.status(400).json({ error: 'Selecione pelo menos um procedimento para a campanha.' });
        }
    }

    if (sets.length === 0 && !hasServiceIdsKey) {
        return res.status(400).json({ error: 'Nenhum campo para atualizar.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const exists = await client.query(
            `SELECT 1 FROM promotional_campaigns WHERE id = $1 AND archived_at IS NULL`,
            [id]
        );
        if (exists.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Campanha não encontrada ou já removida.' });
        }
        let row;
        if (sets.length > 0) {
            sets.push('updated_at = NOW()');
            vals.push(id);
            const q = `UPDATE promotional_campaigns SET ${sets.join(', ')} WHERE id = $${p} AND archived_at IS NULL RETURNING *`;
            const up = await client.query(q, vals);
            if (up.rowCount === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Campanha não encontrada.' });
            }
            row = up.rows[0];
        } else {
            const up = await client.query(
                `UPDATE promotional_campaigns SET updated_at = NOW() WHERE id = $1 AND archived_at IS NULL RETURNING *`,
                [id]
            );
            if (up.rowCount === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Campanha não encontrada.' });
            }
            row = up.rows[0];
        }
        if (hasServiceIdsKey) {
            await applyCampaignLinkedServiceIds(client, id, serviceIdsForAssign);
        }
        await client.query('COMMIT');
        const cnt = await client.query(
            `SELECT COUNT(*)::int AS c FROM catalog_services WHERE promotional_campaign = $1 AND archived_at IS NULL`,
            [id]
        );
        row.linked_count = cnt.rows[0].c;
        await refreshPromotionalSettingsCache();
        await refreshServicesCatalogCache();
        return res.json(mapCampaignRowToAdminApi(row));
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch (_) {
            /* ignore */
        }
        if (error && error.code === 'BAD_SERVICE_IDS') {
            return res.status(400).json({ error: 'Um ou mais procedimentos informados não existem no catálogo.' });
        }
        console.error('[PATCH /admin/campaigns/:id] Erro:', error);
        return res.status(500).json({ error: 'Erro ao atualizar campanha.' });
    } finally {
        client.release();
    }
});

app.patch('/admin/campaigns/:id/assign-services', requireAdminAuth, async (req, res) => {
    if (!isPostgresSetup) {
        return res.status(500).json({ error: 'DB não configurado.' });
    }
    const campaignId = String(req.params.id || '').trim();
    if (!campaignId) {
        return res.status(400).json({ error: 'ID de campanha inválido.' });
    }
    const rawIds = req.body && Array.isArray(req.body.serviceIds) ? req.body.serviceIds : [];

    const c = await pool.connect();
    try {
        const ex = await c.query('SELECT 1 FROM promotional_campaigns WHERE id = $1 AND archived_at IS NULL', [campaignId]);
        if (ex.rowCount === 0) {
            return res.status(404).json({ error: 'Campanha não encontrada.' });
        }

        await c.query('BEGIN');
        let linkedCount = 0;
        try {
            const r = await applyCampaignLinkedServiceIds(c, campaignId, rawIds);
            linkedCount = r.linkedCount;
            await c.query('COMMIT');
        } catch (e) {
            try {
                await c.query('ROLLBACK');
            } catch (_) {
                /* ignore */
            }
            throw e;
        }
        await refreshServicesCatalogCache();
        await refreshPromotionalSettingsCache();
        return res.json({ ok: true, campaignId, linkedCount });
    } catch (error) {
        if (error && error.code === 'BAD_SERVICE_IDS') {
            return res.status(400).json({ error: 'Um ou mais serviços informados não existem no catálogo.' });
        }
        console.error('[PATCH /admin/campaigns/:id/assign-services] Erro:', error);
        return res.status(500).json({ error: 'Erro ao vincular serviços à campanha.' });
    } finally {
        c.release();
    }
});

app.delete('/admin/campaigns/:id', requireAdminAuth, async (req, res) => {
    if (!isPostgresSetup) {
        return res.status(500).json({ error: 'DB não configurado.' });
    }
    const id = String(req.params.id || '').trim();
    if (!id) {
        return res.status(400).json({ error: 'ID inválido.' });
    }
    const client = await pool.connect();
    try {
        const up = await client.query(
            `
            UPDATE promotional_campaigns
            SET archived_at = NOW(),
                active = FALSE,
                updated_at = NOW()
            WHERE id = $1 AND archived_at IS NULL
            RETURNING id, name, description, active, valid_from, valid_to, category, sort_order, created_at, updated_at
        `,
            [id]
        );
        if (up.rowCount === 0) {
            return res.status(404).json({ error: 'Campanha não encontrada ou já removida.' });
        }
        await refreshPromotionalSettingsCache();
        await refreshServicesCatalogCache();
        return res.json({ ok: true, archived: true, campaign: mapCampaignRowToAdminApi(up.rows[0]) });
    } catch (error) {
        console.error('[DELETE /admin/campaigns/:id] Erro:', error);
        return res.status(500).json({ error: 'Erro ao arquivar campanha.' });
    } finally {
        client.release();
    }
});

function slugifyCatalogIdBase(raw) {
    const s = String(raw || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 72);
    return s || 'servico';
}

async function generateUniqueCatalogServiceId(dbClient, baseName) {
    let base = slugifyCatalogIdBase(baseName);
    if (!base) base = `servico_${Date.now()}`;
    let candidate = base;
    let n = 0;
    while (true) {
        const r = await dbClient.query('SELECT 1 FROM catalog_services WHERE id = $1', [candidate]);
        if (r.rowCount === 0) return candidate;
        n += 1;
        candidate = `${base}_${n}`;
    }
}

function mapCatalogRowToAdminApi(row) {
    const m = mapDbRowToCatalogService(row);
    return {
        id: m.id,
        name: m.name,
        category: m.category,
        price: m.price,
        duration: m.duration,
        summary: m.summary,
        detail: m.detail,
        cardTitle: m.card_title || null,
        active: m.active,
        isPromotionalPackage: m.is_promotional_package,
        promotionalCampaign: m.promotional_campaign || null,
        sortOrder: m.sort_order,
        updatedAt: row.updated_at || null
    };
}

app.get('/admin/services', requireAdminAuth, async (_req, res) => {
    if (!isPostgresSetup) {
        return res.status(500).json({ error: 'DB não configurado.' });
    }
    try {
        const { rows } = await pool.query(
            `SELECT id, name, category, price, duration, summary, description, card_title, active,
                    is_promotional_package, promotional_campaign, sort_order, created_at, updated_at
             FROM catalog_services
             WHERE archived_at IS NULL
             ORDER BY sort_order ASC, name ASC`
        );
        return res.json(rows.map(mapCatalogRowToAdminApi));
    } catch (error) {
        console.error('[GET /admin/services] Erro:', error);
        return res.status(500).json({ error: 'Erro ao listar serviços.' });
    }
});

app.post('/admin/services', requireAdminAuth, async (req, res) => {
    if (!isPostgresSetup) {
        return res.status(500).json({ error: 'DB não configurado.' });
    }
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) {
        return res.status(400).json({ error: 'Informe o nome do serviço.' });
    }
    const category = String(b.category || 'Geral').trim() || 'Geral';
    const price = roundMoney2(Number(b.price));
    if (!Number.isFinite(price) || price < 0) {
        return res.status(400).json({ error: 'Informe um preço válido (≥ 0).' });
    }
    const duration = Math.round(Number(b.duration));
    const dur = Number.isFinite(duration) && duration > 0 ? duration : DEFAULT_APPOINTMENT_DURATION_MIN;
    const summary = b.summary != null ? String(b.summary) : '';
    const description = b.detail != null ? String(b.detail) : b.description != null ? String(b.description) : '';
    const cardTitle =
        b.cardTitle != null && String(b.cardTitle).trim() !== ''
            ? String(b.cardTitle).trim()
            : b.card_title != null && String(b.card_title).trim() !== ''
              ? String(b.card_title).trim()
              : null;
    const active = b.active === false || String(b.active).toLowerCase() === 'false' ? false : true;
    const isPromotionalPackage =
        b.isPromotionalPackage === true ||
        String(b.isPromotionalPackage || '').toLowerCase() === 'true' ||
        b.is_promotional_package === true;
    const promotionalCampaign =
        b.promotionalCampaign != null && String(b.promotionalCampaign).trim() !== ''
            ? String(b.promotionalCampaign).trim().slice(0, 64)
            : b.promotional_campaign != null && String(b.promotional_campaign).trim() !== ''
              ? String(b.promotional_campaign).trim().slice(0, 64)
              : null;
    const hasExplicitSort =
        (b.sortOrder !== undefined && b.sortOrder !== null && String(b.sortOrder).trim() !== '') ||
        (b.sort_order !== undefined && b.sort_order !== null && String(b.sort_order).trim() !== '');
    const sortParsed = Math.round(Number(hasExplicitSort ? (b.sortOrder != null ? b.sortOrder : b.sort_order) : NaN));

    const client = await pool.connect();
    try {
        const id = await generateUniqueCatalogServiceId(client, name);
        let so;
        if (Number.isFinite(sortParsed)) {
            so = sortParsed;
        } else {
            const scopeSql = isPromotionalPackage
                ? `SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM catalog_services WHERE is_promotional_package = TRUE AND archived_at IS NULL`
                : `SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM catalog_services WHERE is_promotional_package = FALSE AND archived_at IS NULL`;
            const rSo = await client.query(scopeSql);
            so = Math.round(Number(rSo.rows[0].n)) || 0;
        }

        await client.query(
            `
            INSERT INTO catalog_services (
                id, name, category, price, duration, summary, description, card_title,
                active, is_promotional_package, promotional_campaign, sort_order, updated_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW())
        `,
            [
                id,
                name,
                category,
                price,
                dur,
                summary || null,
                description || null,
                cardTitle,
                active,
                isPromotionalPackage,
                promotionalCampaign,
                so
            ]
        );
        await refreshServicesCatalogCache();
        const ins = await client.query(
            `SELECT id, name, category, price, duration, summary, description, card_title, active,
                    is_promotional_package, promotional_campaign, sort_order, created_at, updated_at
             FROM catalog_services WHERE id = $1`,
            [id]
        );
        return res.status(201).json(mapCatalogRowToAdminApi(ins.rows[0]));
    } catch (error) {
        console.error('[POST /admin/services] Erro:', error);
        return res.status(500).json({ error: 'Erro ao criar serviço.' });
    } finally {
        client.release();
    }
});

app.patch('/admin/services/:id', requireAdminAuth, async (req, res) => {
    if (!isPostgresSetup) {
        return res.status(500).json({ error: 'DB não configurado.' });
    }
    const id = req.params.id != null ? String(req.params.id).trim() : '';
    if (!id) {
        return res.status(400).json({ error: 'ID inválido.' });
    }
    const b = req.body || {};
    const sets = [];
    const vals = [];
    let p = 1;

    const push = (col, val) => {
        sets.push(`${col} = $${p}`);
        vals.push(val);
        p += 1;
    };

    if (b.name !== undefined) {
        const n = String(b.name).trim();
        if (!n) return res.status(400).json({ error: 'Nome não pode ser vazio.' });
        push('name', n);
    }
    if (b.category !== undefined) {
        push('category', String(b.category).trim() || 'Geral');
    }
    if (b.price !== undefined) {
        const pr = roundMoney2(Number(b.price));
        if (!Number.isFinite(pr) || pr < 0) return res.status(400).json({ error: 'Preço inválido.' });
        push('price', pr);
    }
    if (b.duration !== undefined) {
        const d = Math.round(Number(b.duration));
        if (!Number.isFinite(d) || d <= 0) return res.status(400).json({ error: 'Duração inválida.' });
        push('duration', d);
    }
    if (b.summary !== undefined) {
        push('summary', b.summary == null ? null : String(b.summary));
    }
    if (b.detail !== undefined || b.description !== undefined) {
        const t = b.detail !== undefined ? b.detail : b.description;
        push('description', t == null ? null : String(t));
    }
    if (b.cardTitle !== undefined || b.card_title !== undefined) {
        const ct = b.cardTitle !== undefined ? b.cardTitle : b.card_title;
        const s = ct == null ? null : String(ct).trim();
        push('card_title', s || null);
    }
    if (b.active !== undefined) {
        push('active', !(b.active === false || String(b.active).toLowerCase() === 'false'));
    }
    if (b.isPromotionalPackage !== undefined || b.is_promotional_package !== undefined) {
        const v = b.isPromotionalPackage !== undefined ? b.isPromotionalPackage : b.is_promotional_package;
        push('is_promotional_package', v === true || String(v).toLowerCase() === 'true');
    }
    if (b.promotionalCampaign !== undefined || b.promotional_campaign !== undefined) {
        const pc = b.promotionalCampaign !== undefined ? b.promotionalCampaign : b.promotional_campaign;
        push('promotional_campaign', pc == null || String(pc).trim() === '' ? null : String(pc).trim().slice(0, 64));
    }
    if (b.sortOrder !== undefined || b.sort_order !== undefined) {
        const so = Math.round(Number(b.sortOrder !== undefined ? b.sortOrder : b.sort_order));
        if (!Number.isFinite(so)) return res.status(400).json({ error: 'sortOrder inválido.' });
        push('sort_order', so);
    }

    if (sets.length === 0) {
        return res.status(400).json({ error: 'Nenhum campo para atualizar.' });
    }

    sets.push(`updated_at = NOW()`);
    vals.push(id);

    const client = await pool.connect();
    try {
        const exists = await client.query(
            `SELECT 1 FROM catalog_services WHERE id = $1 AND archived_at IS NULL`,
            [id]
        );
        if (exists.rowCount === 0) {
            return res.status(404).json({ error: 'Serviço não encontrado ou já removido do catálogo.' });
        }

        const q = `UPDATE catalog_services SET ${sets.join(', ')} WHERE id = $${p} AND archived_at IS NULL RETURNING id, name, category, price, duration, summary, description, card_title, active,
                    is_promotional_package, promotional_campaign, sort_order, created_at, updated_at`;
        const up = await client.query(q, vals);
        if (up.rowCount === 0) {
            return res.status(404).json({ error: 'Serviço não encontrado.' });
        }
        await refreshServicesCatalogCache();
        return res.json(mapCatalogRowToAdminApi(up.rows[0]));
    } catch (error) {
        console.error('[PATCH /admin/services/:id] Erro:', error);
        return res.status(500).json({ error: 'Erro ao atualizar serviço.' });
    } finally {
        client.release();
    }
});

app.delete('/admin/services/:id', requireAdminAuth, async (req, res) => {
    if (!isPostgresSetup) {
        return res.status(500).json({ error: 'DB não configurado.' });
    }
    const id = req.params.id != null ? String(req.params.id).trim() : '';
    if (!id) {
        return res.status(400).json({ error: 'ID inválido.' });
    }
    const client = await pool.connect();
    try {
        const up = await client.query(
            `
            UPDATE catalog_services
            SET archived_at = NOW(),
                active = FALSE,
                updated_at = NOW()
            WHERE id = $1 AND archived_at IS NULL
            RETURNING id, name, category, price, duration, summary, description, card_title, active,
                      is_promotional_package, promotional_campaign, sort_order, created_at, updated_at
        `,
            [id]
        );
        if (up.rowCount === 0) {
            return res.status(404).json({ error: 'Serviço não encontrado ou já removido do catálogo.' });
        }
        await refreshServicesCatalogCache();
        return res.json({ ok: true, archived: true, service: mapCatalogRowToAdminApi(up.rows[0]) });
    } catch (error) {
        console.error('[DELETE /admin/services/:id] Erro:', error);
        return res.status(500).json({ error: 'Erro ao arquivar serviço.' });
    } finally {
        client.release();
    }
});

app.get('/public/services', async (_req, res) => {
    res.set('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
    res.set('Pragma', 'no-cache');
    if (!isPostgresSetup) {
        return res.json([]);
    }
    try {
        await refreshServicesCatalogCache();
        await refreshPromotionalSettingsCache();
        const src = Array.isArray(servicesCatalogAll) ? servicesCatalogAll : [];
        const filtered = src.filter((s) => isServiceVisibleForBooking(s));
        filtered.sort(
            (a, b) =>
                (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) ||
                String(a.name || '').localeCompare(String(b.name || ''), 'pt-BR')
        );
        return res.json(filtered.map((s) => toPublicServiceJson(s)));
    } catch (error) {
        console.error('[GET /public/services] Erro:', error);
        return res.status(500).json({ error: 'Erro ao carregar serviços.' });
    }
});

app.post('/appointments', async (req, res) => {
    if (!isPostgresSetup) {
        return res.status(500).json({ error: 'DB não configurado.' });
    }

    await sweepExpiredPending();

    const client = await pool.connect();

    try {
        const {
            clientId,
            clientName,
            clientPhone,
            clientEmail,
            email,
            notes,
            location
        } = req.body;

        const serviceIdsNorm = normalizeIncomingServiceIds(req.body);
        if (!clientName || !clientPhone) {
            return res.status(400).json({ error: 'Dados obrigatórios faltando.' });
        }
        if (serviceIdsNorm.length === 0) {
            return res.status(400).json({ error: 'Informe pelo menos um procedimento (serviceId ou serviceIds).' });
        }

        const resolved = resolveSlotsFromRequest(req.body, serviceIdsNorm);
        if (resolved.err) {
            return res.status(400).json({ error: resolved.err });
        }
        const resolvedSlots = resolved.slots;
        const scheduleMode = resolved.scheduleMode;
        const sortedSlots = sortSlotsChronologically(resolvedSlots);
        const primaryDate = sortedSlots[0].date;
        const primaryTime = sortedSlots[0].time;
        const touchDates = [...new Set(resolvedSlots.map((s) => s.date))].sort();

        const normClientEmail = normalizeEmail(clientEmail != null ? clientEmail : email);
        if (!isValidEmailBasic(normClientEmail)) {
            return res.status(400).json({ error: 'Informe um e-mail válido da cliente para contato e confirmação.' });
        }

        await refreshServicesCatalogCache();
        await refreshPromotionalSettingsCache();

        const catalogById = new Map(getActiveServicesCatalogForBooking().map((s) => [s.id, s]));
        for (const id of serviceIdsNorm) {
            if (!catalogById.has(id)) {
                return res.status(400).json({ error: 'Um ou mais procedimentos não estão disponíveis para novo agendamento.' });
            }
        }

        const rawPaymentMethodReq =
            req.body && req.body.paymentMethod != null ? String(req.body.paymentMethod).trim().toLowerCase() : '';
        const rawLegacyPaymentType =
            req.body && req.body.paymentType != null ? String(req.body.paymentType).trim().toLowerCase() : '';

        let paymentMethod = '';
        if (rawPaymentMethodReq === 'local' || rawPaymentMethodReq === 'online') {
            paymentMethod = rawPaymentMethodReq;
        } else if (rawLegacyPaymentType === 'full' || rawLegacyPaymentType === 'partial') {
            paymentMethod = 'online';
        } else {
            return res.status(400).json({
                error:
                    'Informe paymentMethod: "local" (pagamento no local) ou "online" (InfinitePay, valor total). Opcional: paymentType "full" ou "partial" (legado) é aceito como pagamento online pelo valor total do catálogo.'
            });
        }

        const totalServicePrice = roundMoney2(
            serviceIdsNorm.reduce((sum, id) => sum + Number(catalogById.get(id).price || 0), 0)
        );

        if (!Number.isFinite(totalServicePrice) || totalServicePrice <= 0) {
            return res.status(400).json({ error: 'Serviço inválido ou valor não encontrado para este procedimento.' });
        }

        const primaryServiceId = serviceIdsNorm[0];
        const serviceIdsJson = JSON.stringify(serviceIdsNorm);
        const serviceSlotsJson = serializeAppointmentSlots(
            resolvedSlots.map((s) => ({ ...s, status: APPOINTMENT_SLOT_STATUS_ACTIVE }))
        );

        const isLocalBooking = paymentMethod === 'local';
        /** Novos agendamentos online: sempre valor total no checkout; `payment_type` = full (compatível com webhook/relatórios). */
        const paymentTypeForDb = isLocalBooking ? 'local' : 'full';
        const amountCharged = isLocalBooking ? 0 : totalServicePrice;
        const remainingAmount = isLocalBooking ? Math.max(0, roundMoney2(totalServicePrice)) : 0;
        const paymentCents = isLocalBooking ? 0 : Math.round(totalServicePrice * 100);
        if (!isLocalBooking && (!Number.isFinite(paymentCents) || paymentCents <= 0)) {
            return res.status(400).json({ error: 'Valor de checkout inválido.' });
        }

        await client.query('BEGIN');

        const cleanPhone = String(clientPhone).replace(/\D/g, '');
        let finalClientId = clientId;

        const existingClient = await client.query('SELECT * FROM clients WHERE phone = $1', [cleanPhone]);

        if (existingClient.rows.length > 0) {
            finalClientId = existingClient.rows[0].id;

            await client.query(`
                UPDATE clients
                SET name = $1,
                    address = $2,
                    email = $3
                WHERE id = $4
            `, [
                clientName,
                location || existingClient.rows[0].address || '',
                normClientEmail,
                finalClientId
            ]);
        } else {
            finalClientId = finalClientId || `${Date.now()}_client`;

            await client.query(`
                INSERT INTO clients (id, name, phone, address, email)
                VALUES ($1, $2, $3, $4, $5)
            `, [
                finalClientId,
                clientName,
                cleanPhone,
                location || '',
                normClientEmail
            ]);
        }

        const blockedFullRes = await client.query(
            `SELECT date FROM blocked_full_days WHERE date = ANY($1::text[])`,
            [touchDates]
        );
        const blockedFullSet = new Set(blockedFullRes.rows.map((r) => r.date));

        const blockedSlotsByDate = new Map();
        for (const d of touchDates) {
            const br = await client.query('SELECT time FROM blocked_slots WHERE date = $1', [d]);
            blockedSlotsByDate.set(
                d,
                new Set(br.rows.map((r) => normalizeSlotTimeHHMM(r.time)).filter(Boolean))
            );
        }

        const lockedRows = await fetchLockedAppointmentRowsForDates(client, touchDates);
        const scheduleErr = validateNewBookingSlots(resolvedSlots, lockedRows, blockedFullSet, blockedSlotsByDate);
        if (scheduleErr) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: scheduleErr });
        }

        const newId = Date.now().toString();

        let paymentUrl = null;
        if (!isLocalBooking) {
            const appointmentPayload = {
                id: newId,
                serviceId: primaryServiceId,
                clientId: finalClientId,
                clientName,
                clientPhone: cleanPhone,
                date: primaryDate,
                time: primaryTime,
                notes,
                location,
                paymentType: 'full',
                amountCharged,
                remainingAmount,
                paymentCents,
                totalProcedureCents: Math.round(totalServicePrice * 100)
            };
            console.log(`[Appointments] Criando checkout InfinitePay para o agendamento ${newId}...`);
            paymentUrl = await createCheckoutLink(appointmentPayload);
        } else {
            console.log(`[Appointments] Reserva com pagamento no local (sem checkout) ${newId}...`);
        }

        const insertStatus = isLocalBooking ? 'confirmed' : 'pending_payment';
        const paymentAmountCol = isLocalBooking ? 0 : totalServicePrice;

        const insert = await client.query(`
            INSERT INTO appointments (
                id,
                service_id,
                service_ids_json,
                service_slots_json,
                schedule_mode,
                client_id,
                client_name,
                client_phone,
                location,
                date,
                time,
                notes,
                status,
                payment_url,
                payment_amount,
                payment_type,
                amount_charged,
                remaining_amount
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
            RETURNING *
        `, [
            newId,
            primaryServiceId,
            serviceIdsJson,
            serviceSlotsJson,
            scheduleMode,
            finalClientId,
            clientName,
            cleanPhone,
            location || '',
            primaryDate,
            primaryTime,
            notes || '',
            insertStatus,
            paymentUrl,
            paymentAmountCol,
            paymentTypeForDb,
            isLocalBooking ? null : amountCharged,
            remainingAmount
        ]);

        await client.query('COMMIT');

        console.log(`[Appointments] Reserva gerada com sucesso: ${primaryDate} ${primaryTime}`);

        const createdRow = insert.rows[0];
        if (isLocalBooking) {
            await notifyNewLocalBookingEmails(createdRow);
        } else {
            try {
                const idsMail = getAppointmentServiceIdsFromRow(createdRow);
                const serviceObjMail = buildServiceEmailAggregate(idsMail);
                await sendConfirmationEmail(createdRow, serviceObjMail);
            } catch (adminMailErr) {
                console.error('[Appointments] Falha e-mail admin (aguardando pagamento online):', adminMailErr);
            }
            try {
                const idsMail = getAppointmentServiceIdsFromRow(createdRow);
                const serviceObjMail = buildServiceEmailAggregate(idsMail);
                await sendClientConfirmationEmail(createdRow, serviceObjMail, normClientEmail);
            } catch (clientMailErr) {
                console.error('[Appointments] Falha e-mail cliente (aguardando pagamento online):', clientMailErr);
            }
        }

        return res.status(201).json(mapAppointmentRow(createdRow));
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[POST /appointments] Erro:', error);
        return res.status(500).json({ error: 'Erro interno ao criar agendamento.' });
    } finally {
        client.release();
    }
});

function verifyClientOwnsAppointmentByPhone(ap, body) {
    const clean = String(body.verifyPhoneDigits || body.clientPhone || '').replace(/\D/g, '');
    const apPhone = String(ap.client_phone || '').replace(/\D/g, '');
    return clean.length >= 10 && apPhone.length >= 10 && clean === apPhone;
}

function clientHoursUntilSlot(slot) {
    const apDateTimeStr = `${slot.date}T${slot.time}:00-03:00`;
    const apTime = new Date(apDateTimeStr).getTime();
    const now = Date.now();
    return (apTime - now) / (1000 * 60 * 60);
}

async function applyFullAppointmentCancel(ap, cancelledBy, cancelReason, res) {
    const id = ap.id;
    const update = await pool.query(
        `
            UPDATE appointments
            SET status = 'cancelled',
                cancelled_by = $1,
                cancel_reason = $2,
                cancelled_at = CURRENT_TIMESTAMP
            WHERE id = $3
              AND status <> 'cancelled'
            RETURNING *
        `,
        [cancelledBy || 'client', cancelReason || 'Cancelado pelo usuário', id]
    );
    if (update.rows.length === 0) {
        const again = await pool.query('SELECT * FROM appointments WHERE id = $1', [id]);
        if (again.rows.length === 0) {
            return res.status(404).json({ error: 'Agendamento inexistente.' });
        }
        return res.json(mapAppointmentRow(again.rows[0]));
    }
    const cancelledRow = update.rows[0];
    const idsForCancelMail = getActiveAppointmentServiceIdsFromRow(cancelledRow);
    const serviceObjForCancelMail = buildServiceEmailAggregate(
        idsForCancelMail.length ? idsForCancelMail : getAppointmentServiceIdsFromRow(cancelledRow)
    );
    try {
        const cid = cancelledRow.client_id;
        if (cid) {
            const cr = await pool.query('SELECT email FROM clients WHERE id = $1', [cid]);
            const em = normalizeEmail(cr.rows[0]?.email);
            if (isValidEmailBasic(em)) {
                await sendClientAppointmentCancelledEmail(cancelledRow, serviceObjForCancelMail, em);
            }
        }
    } catch (mailErr) {
        console.error(`[Cancel] Falha e-mail cliente (${id}):`, mailErr);
    }
    try {
        await sendAdminAppointmentCancelledEmail(cancelledRow, serviceObjForCancelMail);
    } catch (adminMailErr) {
        console.error(`[Cancel] Falha e-mail admin (${id}):`, adminMailErr);
    }
    return res.json(mapAppointmentRow(cancelledRow));
}

app.patch('/appointments/:id/slots/:slotIndex/cancel', async (req, res) => {
    if (!isPostgresSetup) {
        return res.status(500).json({ error: 'DB não configurado.' });
    }

    const { id, slotIndex: slotIndexRaw } = req.params;
    const slotIndex = Number.parseInt(String(slotIndexRaw), 10);
    const { cancelledBy, cancelReason } = req.body || {};

    if (!Number.isFinite(slotIndex) || slotIndex < 0) {
        return res.status(400).json({ error: 'Índice do procedimento inválido.' });
    }

    const clientPg = await pool.connect();
    try {
        await clientPg.query('BEGIN');
        const check = await clientPg.query('SELECT * FROM appointments WHERE id = $1 FOR UPDATE', [id]);
        if (check.rows.length === 0) {
            await clientPg.query('ROLLBACK');
            return res.status(404).json({ error: 'Agendamento inexistente.' });
        }

        const ap = check.rows[0];
        const st = String(ap.status || '').trim().toLowerCase();
        if (st === 'cancelled' || st === 'completed') {
            await clientPg.query('ROLLBACK');
            return res.status(400).json({ error: 'Este agendamento não permite cancelar procedimentos.' });
        }

        if (String(cancelledBy || '') === 'client') {
            if (!verifyClientOwnsAppointmentByPhone(ap, req.body || {})) {
                await clientPg.query('ROLLBACK');
                return res.status(403).json({ error: 'Telefone não confere com o agendamento.' });
            }
        } else if (String(cancelledBy || '') === 'admin') {
            const tok = extractAdminToken(req);
            if (!verifyAdminToken(tok)) {
                await clientPg.query('ROLLBACK');
                return res.status(401).json({ error: 'Não autorizado.' });
            }
        }

        const slots = getServiceSlotsFromRow(ap);
        if (slotIndex >= slots.length) {
            await clientPg.query('ROLLBACK');
            return res.status(404).json({ error: 'Procedimento não encontrado neste agendamento.' });
        }

        const target = slots[slotIndex];
        if (isSlotCancelled(target)) {
            await clientPg.query('ROLLBACK');
            return res.json(mapAppointmentRow(ap));
        }

        if (String(cancelledBy || '') === 'client') {
            const diffHours = clientHoursUntilSlot(target);
            if (diffHours < 2) {
                await clientPg.query('ROLLBACK');
                return res.status(400).json({
                    error: 'Cancelamento permitido apenas com 2 horas ou mais de antecedência.'
                });
            }
        }

        const nextSlots = slots.map((sl, i) =>
            i === slotIndex
                ? {
                      ...sl,
                      status: APPOINTMENT_SLOT_STATUS_CANCELLED,
                      cancelledAt: new Date().toISOString(),
                      cancelReason: cancelReason || 'Cancelado pelo cliente em Meus agendamentos'
                  }
                : sl
        );

        const activeCount = nextSlots.filter((sl) => !isSlotCancelled(sl)).length;
        if (activeCount === 0) {
            await clientPg.query('ROLLBACK');
            return applyFullAppointmentCancel(ap, cancelledBy || 'client', cancelReason, res);
        }

        const { primaryDate, primaryTime, primaryServiceId } = syncAppointmentPrimaryFromActiveSlots(nextSlots);
        const finPatch = financialPatchAfterActiveItemsChange({ ...ap, service_slots_json: serializeAppointmentSlots(nextSlots) });
        const activeIds = nextSlots.filter((sl) => !isSlotCancelled(sl)).map((sl) => sl.serviceId);

        const sets = [
            'service_slots_json = $1',
            'service_ids_json = $2',
            'date = $3',
            'time = $4',
            'service_id = $5'
        ];
        const vals = [
            serializeAppointmentSlots(nextSlots),
            JSON.stringify(activeIds),
            primaryDate,
            primaryTime,
            primaryServiceId
        ];
        let p = 6;
        for (const [k, v] of Object.entries(finPatch)) {
            sets.push(`${k} = $${p}`);
            vals.push(v);
            p += 1;
        }
        vals.push(id);

        const upd = await clientPg.query(
            `UPDATE appointments SET ${sets.join(', ')} WHERE id = $${p} RETURNING *`,
            vals
        );
        await clientPg.query('COMMIT');
        return res.json(mapAppointmentRow(upd.rows[0]));
    } catch (e) {
        await clientPg.query('ROLLBACK');
        console.error('[PATCH /appointments/:id/slots/:slotIndex/cancel] Erro:', e);
        return res.status(500).json({ error: 'Erro ao cancelar procedimento.' });
    } finally {
        clientPg.release();
    }
});

app.patch('/appointments/:id/slots/:slotIndex/reschedule', async (req, res) => {
    if (!isPostgresSetup) {
        return res.status(500).json({ error: 'DB não configurado.' });
    }

    const { id, slotIndex: slotIndexRaw } = req.params;
    const slotIndex = Number.parseInt(String(slotIndexRaw), 10);
    const { date: newDate, time: newTime } = req.body || {};

    if (!Number.isFinite(slotIndex) || slotIndex < 0) {
        return res.status(400).json({ error: 'Índice do procedimento inválido.' });
    }

    const dateStr = String(newDate || '').trim();
    const timeStr = normalizeSlotTimeHHMM(newTime);
    if (!isValidReportDateYmd(dateStr) || !timeStr) {
        return res.status(400).json({ error: 'Informe data e horário válidos.' });
    }

    const clientPg = await pool.connect();
    try {
        await clientPg.query('BEGIN');
        const check = await clientPg.query('SELECT * FROM appointments WHERE id = $1 FOR UPDATE', [id]);
        if (check.rows.length === 0) {
            await clientPg.query('ROLLBACK');
            return res.status(404).json({ error: 'Agendamento inexistente.' });
        }

        const ap = check.rows[0];
        const st = String(ap.status || '').trim().toLowerCase();
        if (st === 'cancelled' || st === 'completed') {
            await clientPg.query('ROLLBACK');
            return res.status(400).json({ error: 'Este agendamento não permite reagendar procedimentos.' });
        }

        if (!verifyClientOwnsAppointmentByPhone(ap, req.body || {})) {
            await clientPg.query('ROLLBACK');
            return res.status(403).json({ error: 'Telefone não confere com o agendamento.' });
        }

        const slots = getServiceSlotsFromRow(ap);
        if (slotIndex >= slots.length) {
            await clientPg.query('ROLLBACK');
            return res.status(404).json({ error: 'Procedimento não encontrado neste agendamento.' });
        }

        const target = slots[slotIndex];
        if (isSlotCancelled(target)) {
            await clientPg.query('ROLLBACK');
            return res.status(400).json({ error: 'Este procedimento já foi cancelado.' });
        }

        const diffHours = clientHoursUntilSlot(target);
        if (diffHours < 2) {
            await clientPg.query('ROLLBACK');
            return res.status(400).json({
                error: 'Reagendamento permitido apenas com 2 horas ou mais de antecedência.'
            });
        }

        const nextSlots = slots.map((sl, i) =>
            i === slotIndex
                ? {
                      ...sl,
                      date: dateStr,
                      time: timeStr,
                      rescheduledAt: new Date().toISOString(),
                      status: APPOINTMENT_SLOT_STATUS_ACTIVE
                  }
                : sl
        );

        const activeForValidation = nextSlots.filter((sl) => !isSlotCancelled(sl));
        const touchDates = [...new Set(activeForValidation.map((s) => s.date))].sort();

        const blockedFullRes = await clientPg.query(
            `SELECT date FROM blocked_full_days WHERE date = ANY($1::text[])`,
            [touchDates]
        );
        const blockedFullSet = new Set(blockedFullRes.rows.map((r) => r.date));
        const blockedSlotsByDate = new Map();
        for (const d of touchDates) {
            const br = await clientPg.query('SELECT time FROM blocked_slots WHERE date = $1', [d]);
            blockedSlotsByDate.set(
                d,
                new Set(br.rows.map((r) => normalizeSlotTimeHHMM(r.time)).filter(Boolean))
            );
        }

        const lockedRows = await fetchLockedAppointmentRowsForDates(clientPg, touchDates);
        const scheduleErr = validateNewBookingSlots(
            activeForValidation,
            lockedRows,
            blockedFullSet,
            blockedSlotsByDate,
            id
        );
        if (scheduleErr) {
            await clientPg.query('ROLLBACK');
            return res.status(409).json({ error: scheduleErr });
        }

        const { primaryDate, primaryTime, primaryServiceId } = syncAppointmentPrimaryFromActiveSlots(nextSlots);
        const activeIds = activeForValidation.map((sl) => sl.serviceId);

        const upd = await clientPg.query(
            `
            UPDATE appointments
            SET service_slots_json = $1,
                service_ids_json = $2,
                date = $3,
                time = $4,
                service_id = $5,
                schedule_mode = CASE
                    WHEN schedule_mode = 'sequential' AND $6::int > 1 THEN 'per_service'
                    ELSE schedule_mode
                END
            WHERE id = $7
            RETURNING *
        `,
            [
                serializeAppointmentSlots(nextSlots),
                JSON.stringify(activeIds),
                primaryDate,
                primaryTime,
                primaryServiceId,
                activeIds.length,
                id
            ]
        );

        await clientPg.query('COMMIT');
        return res.json(mapAppointmentRow(upd.rows[0]));
    } catch (e) {
        await clientPg.query('ROLLBACK');
        console.error('[PATCH /appointments/:id/slots/:slotIndex/reschedule] Erro:', e);
        return res.status(500).json({ error: 'Erro ao reagendar procedimento.' });
    } finally {
        clientPg.release();
    }
});

app.patch('/appointments/:id/cancel', async (req, res) => {
    if (!isPostgresSetup) {
        return res.status(500).json({ error: 'DB não configurado.' });
    }

    const { id } = req.params;
    const { cancelledBy, cancelReason } = req.body;

    if (String(cancelledBy || '') === 'admin') {
        const tok = extractAdminToken(req);
        if (!verifyAdminToken(tok)) {
            return res.status(401).json({ error: 'Não autorizado.' });
        }
    }

    try {
        const check = await pool.query('SELECT * FROM appointments WHERE id = $1', [id]);

        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'Agendamento inexistente.' });
        }

        const ap = check.rows[0];

        if (ap.status === 'cancelled') {
            return res.json(mapAppointmentRow(ap));
        }

        if (cancelledBy === 'client') {
            const apDateTimeStr = `${ap.date}T${ap.time}:00-03:00`;
            const apTime = new Date(apDateTimeStr).getTime();
            const now = new Date().getTime();
            const diffHours = (apTime - now) / (1000 * 60 * 60);

            if (diffHours < 2) {
                return res.status(400).json({
                    error: 'Cancelamento permitido apenas com 2 horas ou mais de antecedência.'
                });
            }
        }

        const update = await pool.query(
            `
            UPDATE appointments
            SET status = 'cancelled',
                cancelled_by = $1,
                cancel_reason = $2,
                cancelled_at = CURRENT_TIMESTAMP
            WHERE id = $3
              AND status <> 'cancelled'
            RETURNING *
        `,
            [cancelledBy || 'client', cancelReason || 'Cancelado pelo usuário', id]
        );

        if (update.rows.length === 0) {
            const again = await pool.query('SELECT * FROM appointments WHERE id = $1', [id]);
            if (again.rows.length === 0) {
                return res.status(404).json({ error: 'Agendamento inexistente.' });
            }
            return res.json(mapAppointmentRow(again.rows[0]));
        }

        const cancelledRow = update.rows[0];
        const idsForCancelMail = getAppointmentServiceIdsFromRow(cancelledRow);
        const serviceObjForCancelMail = buildServiceEmailAggregate(idsForCancelMail);

        try {
            const cid = cancelledRow.client_id;
            if (cid) {
                const cr = await pool.query('SELECT email FROM clients WHERE id = $1', [cid]);
                const em = normalizeEmail(cr.rows[0]?.email);
                if (isValidEmailBasic(em)) {
                    await sendClientAppointmentCancelledEmail(cancelledRow, serviceObjForCancelMail, em);
                } else {
                    console.warn(`[PATCH /appointments/:id/cancel] E-mail da cliente ausente; sem aviso de cancelamento (${id}).`);
                }
            }
        } catch (mailErr) {
            console.error(`[PATCH /appointments/:id/cancel] Falha e-mail de cancelamento ao cliente (${id}):`, mailErr);
        }

        try {
            await sendAdminAppointmentCancelledEmail(cancelledRow, serviceObjForCancelMail);
        } catch (adminMailErr) {
            console.error(`[PATCH /appointments/:id/cancel] Falha e-mail de cancelamento ao admin (${id}):`, adminMailErr);
        }

        return res.json(mapAppointmentRow(cancelledRow));
    } catch (e) {
        console.error('[PATCH /appointments/:id/cancel] Erro:', e);
        return res.status(500).json({ error: 'Erro ao cancelar agendamento.' });
    }
});

// ====================== ADMIN: CONFIRMAR PAGAMENTO MANUAL ======================
/**
 * Confirma pagamento manual (Pix/dinheiro/transferência/presencial) sem alterar o fluxo InfinitePay.
 * Regras:
 * - Protegido por admin token
 * - Não permite confirmar se estiver cancelado
 * - Se já estiver confirmed/completed, só permite com body.force === true
 * - Marca capture_method = "manual"
 * - Atualiza payment_type, paid_amount, remaining_amount (nunca negativo)
 * - Guarda observação em manual_payment_note
 */
app.patch('/admin/appointments/:id/manual-payment', requireAdminAuth, async (req, res) => {
    if (!isPostgresSetup) {
        return res.status(500).json({ error: 'DB não configurado.' });
    }

    const rawId = req.params.id;
    const id = rawId != null ? String(rawId).trim() : '';
    if (!id) {
        return res.status(400).json({ error: 'ID inválido.' });
    }

    try {
        const { paidAmount, paymentType, note, force } = req.body || {};

        const typeNorm = String(paymentType || '').trim().toLowerCase();
        if (!['partial', 'full'].includes(typeNorm)) {
            return res.status(400).json({ error: 'paymentType inválido. Use "partial" ou "full".' });
        }

        const noteNorm = (note == null ? '' : String(note)).trim();

        const check = await pool.query('SELECT * FROM appointments WHERE id = $1', [id]);
        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'Agendamento inexistente.' });
        }

        const ap = check.rows[0];
        const prevStatus = ap.status;

        if (prevStatus === 'cancelled') {
            return res.status(409).json({ error: 'Não é possível confirmar pagamento: agendamento está cancelado.' });
        }

        const alreadyPaid = prevStatus === 'confirmed' || prevStatus === 'completed';
        if (alreadyPaid && force !== true) {
            return res.status(409).json({
                error: 'Este agendamento já está confirmado/concluído. Para sobrescrever, envie {"force": true}.'
            });
        }

        const finAp = normalizeAppointmentFinancials(ap);
        const total = roundMoney2(Number(finAp.totalServicePrice || 0));
        if (!Number.isFinite(total) || total <= 0) {
            return res.status(400).json({ error: 'Não foi possível determinar o valor total do procedimento.' });
        }

        let paidResolved;
        if (typeNorm === 'full') {
            paidResolved = total;
        } else {
            const rawPaid = toMoneyNumber(paidAmount);
            if (rawPaid == null || !Number.isFinite(rawPaid) || rawPaid <= 0) {
                return res.status(400).json({ error: 'paidAmount inválido para registro histórico de valor parcial.' });
            }
            paidResolved = roundMoney2(rawPaid);
            if (paidResolved > total + 0.005) {
                return res.status(400).json({ error: 'paidAmount não pode ser maior que o total do procedimento (parcial).' });
            }
        }

        const remainingResolved = Math.max(0, roundMoney2(total - paidResolved));
        const finalType = remainingResolved <= 0.005 ? 'full' : typeNorm;

        console.log(`[AdminManualPayment] Confirmando pagamento manual: id=${id} prev_status=${prevStatus} type=${finalType} paid=${paidResolved} remaining=${remainingResolved} force=${force === true}`);

        const upd = await pool.query(
            `
            UPDATE appointments
            SET status = 'confirmed',
                payment_type = $2,
                paid_amount = $3,
                amount_charged = $4,
                remaining_amount = $5,
                capture_method = 'manual',
                transaction_nsu = COALESCE(NULLIF(transaction_nsu, ''), 'manual'),
                invoice_slug = COALESCE(NULLIF(invoice_slug, ''), 'manual'),
                manual_payment_note = NULLIF($6, '')
            WHERE id = $1
            RETURNING *
        `,
            [
                id,
                finalType,
                paidResolved,
                paidResolved,
                remainingResolved,
                noteNorm
            ]
        );

        const updated = upd.rows[0];
        return res.json({
            ok: true,
            previousStatus: prevStatus,
            appointment: mapAppointmentRow(updated)
        });
    } catch (e) {
        console.error('[PATCH /admin/appointments/:id/manual-payment] Erro:', e);
        return res.status(500).json({ error: 'Erro ao confirmar pagamento manual.' });
    }
});

// ====================== ADMIN: CONFIRMAR RECEBIMENTO (PAGAMENTO NO LOCAL) ======================
/**
 * Registra que o valor foi recebido presencialmente (mantém payment_type = local).
 * Não altera InfinitePay; não converte para full/parcial.
 */
app.patch('/admin/appointments/:id/confirm-local-payment-received', requireAdminAuth, async (req, res) => {
    if (!isPostgresSetup) {
        return res.status(500).json({ error: 'DB não configurado.' });
    }

    const rawId = req.params.id;
    const id = rawId != null ? String(rawId).trim() : '';
    if (!id) {
        return res.status(400).json({ error: 'ID inválido.' });
    }

    try {
        const { note } = req.body || {};
        const noteUser = (note == null ? '' : String(note)).trim();

        const check = await pool.query('SELECT * FROM appointments WHERE id = $1', [id]);
        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'Agendamento inexistente.' });
        }

        const ap = check.rows[0];
        const prevStatus = ap.status;

        if (prevStatus === 'cancelled') {
            return res.status(409).json({ error: 'Não é possível registrar recebimento: agendamento está cancelado.' });
        }

        if (prevStatus !== 'confirmed' && prevStatus !== 'completed') {
            return res.status(409).json({
                error: 'Registro de recebimento no local só é permitido para agendamentos confirmados ou concluídos.'
            });
        }

        const pt = String(ap.payment_type || '').trim().toLowerCase();
        if (pt !== 'local') {
            return res.status(409).json({
                error: 'Este registro não é pagamento no local. Use as ações de pagamento online ou histórico legado.'
            });
        }

        const fin = normalizeAppointmentFinancials(ap);
        const total = roundMoney2(Number(fin.totalServicePrice || 0));
        if (!Number.isFinite(total) || total <= 0) {
            return res.status(400).json({ error: 'Não foi possível determinar o valor total do procedimento.' });
        }

        const remaining = toMoneyNumber(ap.remaining_amount);
        if (remaining == null || remaining <= 0.005) {
            return res.status(409).json({
                error: 'Não há valor pendente de recebimento presencial para registrar (já consta como recebido).'
            });
        }

        const prevNote = String(ap.manual_payment_note || '').trim();
        const stamp = `[Recebimento no local registrado R$ ${total.toFixed(2).replace('.', ',')}]`;
        const noteCombined = [prevNote, noteUser, stamp].filter(Boolean).join(' — ').slice(0, 8000);

        const upd = await pool.query(
            `
            UPDATE appointments
            SET paid_amount = $2::numeric,
                remaining_amount = 0::numeric,
                capture_method = 'presencial',
                manual_payment_note = NULLIF($3, '')
            WHERE id = $1
              AND status IN ('confirmed', 'completed')
              AND LOWER(COALESCE(payment_type, '')) = 'local'
              AND COALESCE(remaining_amount, 0) > 0.005
            RETURNING *
        `,
            [id, total, noteCombined || null]
        );

        if (upd.rows.length === 0) {
            return res.status(409).json({
                error: 'Não foi possível registrar o recebimento (dados podem ter mudado ou valor já estava quitado no registro).'
            });
        }

        return res.json({
            ok: true,
            previousStatus: prevStatus,
            appointment: mapAppointmentRow(upd.rows[0])
        });
    } catch (e) {
        console.error('[PATCH /admin/appointments/:id/confirm-local-payment-received] Erro:', e);
        return res.status(500).json({ error: 'Erro ao registrar recebimento no local.' });
    }
});

// ====================== ADMIN: QUITAR SALDO RESTANTE (PARCIAL) ======================
/**
 * Registra quitação manual do saldo restante (após sinal via InfinitePay, etc.).
 * - Só para status confirmed ou completed
 * - payment_type deve ser partial no banco
 * - remaining_amount > 0
 * - paid_amount += remaining_amount (centavos), remaining_amount = 0
 * - Mantém payment_type = partial (histórico)
 * - capture_method: manual_balance se antes era vazio/manual; senão mixed
 * - Não dispara webhook
 */
app.patch('/admin/appointments/:id/settle-remaining-balance', requireAdminAuth, async (req, res) => {
    if (!isPostgresSetup) {
        return res.status(500).json({ error: 'DB não configurado.' });
    }

    const rawId = req.params.id;
    const id = rawId != null ? String(rawId).trim() : '';
    if (!id) {
        return res.status(400).json({ error: 'ID inválido.' });
    }

    try {
        const { note } = req.body || {};
        const noteUser = (note == null ? '' : String(note)).trim();

        const check = await pool.query('SELECT * FROM appointments WHERE id = $1', [id]);
        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'Agendamento inexistente.' });
        }

        const ap = check.rows[0];
        const prevStatus = ap.status;

        if (prevStatus === 'cancelled') {
            return res.status(409).json({ error: 'Não é possível registrar o pagamento: agendamento está cancelado.' });
        }

        if (prevStatus !== 'confirmed' && prevStatus !== 'completed') {
            return res.status(409).json({
                error: 'Registro de pagamento só é permitido para agendamentos confirmados ou concluídos.'
            });
        }

        const pt = String(ap.payment_type || '').trim().toLowerCase();
        if (pt !== 'partial') {
            return res.status(409).json({
                error: 'Este registro só se aplica a reservas com histórico de valor parcial (valor na reserva + complemento).'
            });
        }

        const remaining = toMoneyNumber(ap.remaining_amount);
        if (remaining == null || remaining <= 0.005) {
            return res.status(409).json({ error: 'Não há valor histórico pendente a registrar (saldo já zerado no sistema).' });
        }

        const paidBefore = toMoneyNumber(ap.paid_amount);
        const paidBeforeSafe = paidBefore != null && Number.isFinite(paidBefore) && paidBefore >= 0 ? roundMoney2(paidBefore) : 0;

        const addCents = moneyToCents(remaining);
        const paidCents = moneyToCents(paidBeforeSafe) + addCents;
        const newPaid = centsToReais(paidCents);
        const newRemaining = 0;

        const finAp = normalizeAppointmentFinancials(ap);
        const total = roundMoney2(Number(finAp.totalServicePrice || 0));
        if (Number.isFinite(total) && total > 0 && newPaid - total > 0.02) {
            return res.status(400).json({ error: 'Inconsistência: valor pago após o registro ultrapassa o total do procedimento.' });
        }

        const prevCap = String(ap.capture_method || '').trim().toLowerCase();
        const newCapture = (!prevCap || prevCap === 'manual' || prevCap === 'manual_balance')
            ? 'manual_balance'
            : 'mixed';

        const prevNsu = String(ap.transaction_nsu || '').trim();
        let newNsu = prevNsu;
        if (!newNsu) {
            newNsu = 'manual_balance';
        } else if (!newNsu.includes('manual_balance')) {
            const concat = `${newNsu}|manual_balance`;
            newNsu = concat.length > 255 ? concat.slice(0, 255) : concat;
        }

        const prevNote = String(ap.manual_payment_note || '').trim();
        const stamp = `[Registro histórico complemento +R$ ${remaining.toFixed(2).replace('.', ',')}]`;
        const noteCombined = [prevNote, noteUser, stamp].filter(Boolean).join(' — ').slice(0, 8000);

        console.log(`[AdminSettleRemaining] id=${id} status=${prevStatus} paid_before=${paidBeforeSafe} add=${remaining} paid_after=${newPaid} capture=${newCapture}`);

        const upd = await pool.query(
            `
            UPDATE appointments
            SET paid_amount = $2::numeric,
                remaining_amount = $3::numeric,
                payment_type = 'partial',
                capture_method = $4,
                transaction_nsu = $5,
                manual_payment_note = NULLIF($6, '')
            WHERE id = $1
              AND status IN ('confirmed', 'completed')
              AND LOWER(COALESCE(payment_type, '')) = 'partial'
              AND COALESCE(remaining_amount, 0) > 0.005
            RETURNING *
        `,
            [id, newPaid, newRemaining, newCapture, newNsu, noteCombined || null]
        );

        if (upd.rows.length === 0) {
            return res.status(409).json({
                error: 'Não foi possível registrar o pagamento (dados podem ter mudado ou tipo de registro incompatível).'
            });
        }

        return res.json({
            ok: true,
            previousStatus: prevStatus,
            appointment: mapAppointmentRow(upd.rows[0])
        });
    } catch (e) {
        console.error('[PATCH /admin/appointments/:id/settle-remaining-balance] Erro:', e);
        return res.status(500).json({ error: 'Erro ao registrar o pagamento.' });
    }
});

app.delete('/appointments/:id', requireAdminAuth, async (req, res) => {
    if (!isPostgresSetup) {
        return res.status(500).json({ error: 'DB não configurado.' });
    }

    const { id } = req.params;

    try {
        await pool.query('DELETE FROM appointments WHERE id = $1', [id]);
        return res.json({ success: true });
    } catch (e) {
        console.error('[DELETE /appointments/:id] Erro:', e);
        return res.status(500).json({ error: 'Erro de deleção.' });
    }
});

// ====================== WEBHOOK INFINITEPAY =======================

app.post('/webhook/infinitepay', async (req, res) => {
    if (!isPostgresSetup) {
        return res.status(500).json({ error: 'Sem DB' });
    }

    try {
        const whSecret = process.env.INFINITEPAY_WEBHOOK_SECRET;
        if (whSecret != null && String(whSecret).trim().length > 0) {
            const expected = String(whSecret).trim();
            const hdr =
                String(req.headers['x-webhook-secret'] || '').trim() ||
                String(req.headers['x-infinitepay-webhook-secret'] || '').trim() ||
                String(req.headers['x-atelie-webhook-secret'] || '').trim();
            if (!timingSafeEqualUtf8(hdr, expected)) {
                console.warn('[InfinitePay Webhook] Requisição rejeitada: segredo de webhook inválido ou ausente.');
                return res.status(401).json({ error: 'Webhook não autorizado.' });
            }
        } else {
            console.warn(
                '[InfinitePay Webhook] INFINITEPAY_WEBHOOK_SECRET não definida — aceitando requisições sem validação de segredo (compatibilidade).'
            );
        }

        const {
            invoice_slug,
            amount,
            paid_amount,
            installments,
            capture_method,
            transaction_nsu,
            order_nsu,
            receipt_url,
            items
        } = req.body || {};

        console.log(
            '[InfinitePay Webhook] Evento recebido:',
            JSON.stringify({
                order_nsu: order_nsu || null,
                transaction_nsu: transaction_nsu || null,
                invoice_slug: invoice_slug || null,
                amount: amount || 0,
                paid_amount: paid_amount,
                installments: installments || 1,
                capture_method: capture_method || null,
                items_count: Array.isArray(items) ? items.length : 0
            })
        );

        if (!order_nsu) {
            return res.status(400).json({ error: 'order_nsu não informado no webhook.' });
        }

        const appointmentId = String(order_nsu);
        const pre = await pool.query('SELECT id, status FROM appointments WHERE id = $1', [appointmentId]);
        if (pre.rows.length === 0) {
            console.warn(`[InfinitePay Webhook] order_nsu=${appointmentId} não encontrado no banco.`);
            return res.status(400).json({ error: 'Agendamento não encontrado para o order_nsu informado.' });
        }

        const previousStatus = pre.rows[0].status;
        console.log(`[InfinitePay Webhook] Agendamento localizado: id=${appointmentId} status_anterior=${previousStatus}`);

        if (previousStatus === 'cancelled') {
            console.log(`[InfinitePay Webhook] Ignorado: agendamento ${appointmentId} está cancelado.`);
            return res.status(200).json({
                received: true,
                ignored: true,
                reason: 'Agendamento cancelado; webhook ignorado.',
                appointmentId,
                status: previousStatus
            });
        }

        if (previousStatus === 'confirmed' || previousStatus === 'completed') {
            console.log(`[InfinitePay Webhook] Idempotência: agendamento ${appointmentId} já estava ${previousStatus}.`);
        }

        const paidFromWebhook = (paid_amount === null || paid_amount === undefined)
            ? null
            : Number(paid_amount) / 100;

        const confirmResult = await confirmAppointmentPayment({
            appointmentId,
            transactionNsu: transaction_nsu || null,
            invoiceSlug: invoice_slug || null,
            receiptUrl: receipt_url || null,
            captureMethod: capture_method || null,
            paidAmount: paidFromWebhook
        });

        const confirmedAppointment = confirmResult.appointment;
        const finalStatus = confirmedAppointment.status;

        if (confirmResult.alreadyProcessed) {
            console.log(`[InfinitePay Webhook] Duplicidade/sem mudança: id=${appointmentId} status_final=${finalStatus} updated=${confirmResult.updated}`);
        } else {
            console.log(`[InfinitePay Webhook] Processado: id=${appointmentId} ${confirmResult.previousStatus} -> ${finalStatus} updated=${confirmResult.updated}`);
        }

        const ignoredBecauseProcessed =
            !!confirmResult.alreadyProcessed &&
            (finalStatus === 'confirmed' || finalStatus === 'completed');

        return res.status(200).json({
            received: true,
            appointmentId: confirmedAppointment.id,
            status: confirmedAppointment.status,
            ignored: ignoredBecauseProcessed,
            message: ignoredBecauseProcessed
                ? 'Pagamento já processado anteriormente.'
                : 'Pagamento processado.',
            alreadyProcessed: !!confirmResult.alreadyProcessed,
            updated: !!confirmResult.updated,
            previousStatus: confirmResult.previousStatus
        });
    } catch (e) {
        console.error('[InfinitePay Webhook] Erro:', e);
        return res.status(400).json({ error: 'Erro no webhook da InfinitePay.' });
    }
});

// ====================== PAYMENT CHECK MANUAL =======================

app.post('/payments/check', async (req, res) => {
    if (!isPostgresSetup) {
        return res.status(500).json({ error: 'Sem DB' });
    }

    if (!allowPaymentCheckRate(req)) {
        return res.status(429).json({ error: 'Muitas consultas. Aguarde um instante e tente novamente.' });
    }

    try {
        const { order_nsu, transaction_nsu, slug } = req.body || {};

        if (!order_nsu || !transaction_nsu || !slug) {
            return res.status(400).json({
                error: 'É necessário informar order_nsu, transaction_nsu e slug.'
            });
        }

        const result = await checkPaymentStatus({
            orderNsu: order_nsu,
            transactionNsu: transaction_nsu,
            slug
        });

        if (!result || !result.success) {
            return res.status(200).json({
                success: false,
                paid: false,
                message: 'Pagamento ainda não confirmado.'
            });
        }

        if (result.paid) {
            const paidFromCheck = (result.paid_amount === null || result.paid_amount === undefined)
                ? null
                : Number(result.paid_amount) / 100;

            const confirmResult = await confirmAppointmentPayment({
                appointmentId: order_nsu,
                transactionNsu: transaction_nsu,
                invoiceSlug: slug,
                receiptUrl: null,
                captureMethod: result.capture_method || null,
                paidAmount: paidFromCheck
            });

            return res.status(200).json({
                success: true,
                paid: true,
                appointment: mapAppointmentRow(confirmResult.appointment),
                alreadyProcessed: !!confirmResult.alreadyProcessed,
                updated: !!confirmResult.updated,
                previousStatus: confirmResult.previousStatus
            });
        }

        return res.status(200).json({
            success: true,
            paid: false,
            details: result
        });
    } catch (error) {
        console.error('[POST /payments/check] Erro:', error);
        return res.status(500).json({ error: 'Erro ao consultar pagamento.' });
    }
});

// ====================== TESTE DE EMAIL ====================

app.post('/test-email', requireAdminAuth, async (req, res) => {
    try {
        const variant = String(req.query.variant || '').trim().toLowerCase();
        const isOnlineVariant = variant === 'online';
        console.log(
            `[TestEmail] Chamando endpoint manual /test-email${isOnlineVariant ? ' (variant=online, mock pendente InfinitePay)' : ' (padrão: pagamento local)'}`
        );

        const mockService = { name: 'Serviço de Teste', price: 100.0 };
        const total = Number(mockService.price) || 100;

        const mockAp = isOnlineVariant
            ? {
                  client_name: 'Cliente Teste Manual',
                  date: '2026-04-18',
                  time: '14:30',
                  location: 'Rua de Teste, 123',
                  paymentMethod: 'online',
                  payment_type: 'full',
                  status: 'pending_payment',
                  paid_amount: 0,
                  remaining_amount: 0,
                  amount_charged: total,
                  capture_method: null,
                  payment_url: 'https://example.invalid/infinitepay-mock-checkout-teste-email'
              }
            : {
                  client_name: 'Cliente Teste Manual',
                  date: '2026-04-18',
                  time: '14:30',
                  location: 'Rua de Teste, 123',
                  payment_type: 'local',
                  status: 'confirmed',
                  paid_amount: 0,
                  remaining_amount: total,
                  amount_charged: 0,
                  capture_method: null
              };

        await sendConfirmationEmail(mockAp, mockService);

        return res.status(200).json({
            success: true,
            message: isOnlineVariant
                ? 'E-mail de teste (pendente InfinitePay, valor total) enviado! Verifique sua caixa de entrada.'
                : 'E-mail de teste (pagamento no local) enviado com sucesso! Verifique sua caixa de entrada.'
        });
    } catch (e) {
        console.error('[TestEmail] Erro no teste:', e);
        return res.status(500).json({
            success: false,
            error: e.message || 'Erro ao enviar email'
        });
    }
});

// ====================== SPA ====================

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/**
 * O `net.Server` emite `error` em falhas como EADDRINUSE; sem listener isso derruba o processo.
 * `app.listen` delega ao mesmo servidor — usamos `http.createServer` e registramos o handler antes do listen.
 * Migrações terminam antes de abrir a porta (evita corrida com o primeiro request).
 */
async function bootstrap() {
    await initDB();
    const server = http.createServer(app);
    server.on('error', (err) => {
        console.error('❌ Erro no servidor HTTP:', err && err.message ? err.message : err);
        if (err && err.code === 'EADDRINUSE') {
            console.error(
                `   A porta ${PORT} já está em uso. Encerre o outro processo ou defina a variável de ambiente PORT.`
            );
            process.exit(1);
        }
    });
    server.listen(PORT, () => {
        console.log(`🚀 Ateliê Backend DB operando na porta ${PORT}`);
    });
}

bootstrap().catch((err) => {
    console.error('❌ Falha ao subir o servidor:', err);
    process.exit(1);
});