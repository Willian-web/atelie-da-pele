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
const crypto = require('crypto');
const { Pool } = require('pg');
require('dotenv').config();

const { sendConfirmationEmail, sendClientConfirmationEmail } = require('./services/emailService');
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

/**
 * Catálogo ativo (novos agendamentos). Espelhar em `backend/public/index.html` (SERVICES + PROMO_MAES_SERVICES).
 * Vales-presente `promo_*` só podem ser agendados com `promotional_packages_enabled = true` em `app_settings`.
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

// ======================= BANCO =======================

async function initDB() {
    if (!isPostgresSetup) {
        console.warn('⚠️ AVISO: DATABASE_URL não definida. O sistema precisa do PostgreSQL para funcionar corretamente.');
        return;
    }

    const client = await pool.connect();

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

        console.log('✅ Banco de dados sincronizado / migrado');
    } catch (err) {
        console.error('❌ Erro ao iniciar banco:', err);
    } finally {
        client.release();
    }
}

initDB();

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

function parseServiceSlotsJson(raw) {
    if (raw == null || raw === '') return null;
    try {
        const p = JSON.parse(raw);
        if (!Array.isArray(p) || p.length === 0) return null;
        const out = [];
        for (const x of p) {
            const sid = String(x.serviceId || x.service_id || '').trim();
            const d = String(x.date || '').trim();
            const t = normalizeSlotTimeHHMM(x.time);
            if (!sid || !isValidReportDateYmd(d) || !t) return null;
            out.push({ serviceId: sid, date: d, time: t });
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
    if (ids.length === 1) return [{ serviceId: ids[0], date: d, time: t0 }];
    let cur = timeStrToMinutes(t0);
    if (cur == null) return [];
    const out = [];
    for (const id of ids) {
        const ts = timeStrFromMinutes(cur);
        if (!ts) return [];
        out.push({ serviceId: id, date: d, time: ts });
        cur += getServiceDurationMinForSchedule(id);
    }
    return out;
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
    return getIntervalsFromSlots(getServiceSlotsFromRow(row));
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

function validateNewBookingSlots(newSlots, existingRows, blockedFullSet, blockedSlotsByDate) {
    const newMap = getIntervalsFromSlots(newSlots);
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
        for (const row of existingRows) {
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

/** Sinal na reserva parcial: no máximo o fixo do produto, e nunca acima do valor total do procedimento. */
function effectivePartialDownPayment(totalServicePrice) {
    const t = roundMoney2(Number(totalServicePrice) || 0);
    if (t <= 0) return FIXED_SIGNAL_AMOUNT;
    return roundMoney2(Math.min(FIXED_SIGNAL_AMOUNT, t));
}

function findServiceById(serviceId) {
    return SERVICES_CATALOG.find((s) => s.id === serviceId)
        || SERVICES_LEGACY.find((s) => s.id === serviceId)
        || {
            id: serviceId,
            name: serviceId || 'Serviço',
            price: 0,
            duration: DEFAULT_APPOINTMENT_DURATION_MIN
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
    const ids = getAppointmentServiceIdsFromRow(row);
    let totalServicePrice = 0;
    for (const id of ids) {
        const s = findServiceById(id);
        totalServicePrice += roundMoney2(Number(s.price) || 0);
    }
    totalServicePrice = roundMoney2(totalServicePrice);
    if (!Number.isFinite(totalServicePrice) || totalServicePrice <= 0) {
        const fallback = findServiceById(row.service_id);
        totalServicePrice = roundMoney2(Number(fallback.price) || 0);
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

function buildPaymentSummary(row) {
    const fin = normalizeAppointmentFinancials(row);
    const status = row.status;

    const isPartial = fin.paymentType === 'partial';
    const isFull = fin.paymentType === 'full';

    const paymentTypeLabel = isFull ? 'Total' : 'Parcial';

    let paymentStatusLabel = 'Aguardando pagamento';
    if (status === 'pending_payment') paymentStatusLabel = 'Aguardando pagamento';
    else if (status === 'confirmed') paymentStatusLabel = 'Pagamento confirmado';
    else if (status === 'completed') paymentStatusLabel = 'Concluído';
    else if (status === 'cancelled') paymentStatusLabel = 'Cancelado';

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
        isFull
    };
}

function mapAppointmentRow(row) {
    const fin = normalizeAppointmentFinancials(row);
    const paymentSummary = buildPaymentSummary(row);
    const serviceIds = getAppointmentServiceIdsFromRow(row);
    const serviceLineItems = serviceIds.map((id) => {
        const s = findServiceById(id);
        return {
            id,
            name: s.name || id,
            price: roundMoney2(Number(s.price) || 0)
        };
    });

    return {
        id: row.id,
        serviceId: row.service_id,
        serviceIds,
        serviceLineItems,
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
        scheduleMode: row.schedule_mode || null,
        serviceSlots: getServiceSlotsFromRow(row)
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

    console.log(`[Payment] E-mail ao cliente enviado (${em}) agendamento ${appointmentId}.`);
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

app.get('/clients', async (req, res) => {
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

app.get('/appointments', async (req, res) => {
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
            const ids = getAppointmentServiceIdsFromRow(r);
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

            const isPaidStatus = r.status === 'confirmed' || r.status === 'completed';
            if (!isPaidStatus) continue;

            const fin = normalizeAppointmentFinancials(r);
            const received = reportEffectiveReceivedPaid(r);
            const kind = reportPaymentKindForAggregation(r, fin, received);
            const receivedCents = moneyToCents(received);

            totalRevenueCents += receivedCents;
            summary.totalExpectedRevenue += fin.totalServicePrice || 0;

            if (kind === 'partial') {
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
        return res.json({ ok: true, promotionalPackagesEnabled: Boolean(enabled) });
    } catch (error) {
        console.error('[PATCH /admin/promotional-packages] Erro:', error);
        return res.status(500).json({ error: 'Erro ao salvar campanha promocional.' });
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
            location,
            paymentType: rawPaymentType
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

        const catalogById = new Map(SERVICES_CATALOG.map((s) => [s.id, s]));
        for (const id of serviceIdsNorm) {
            if (!catalogById.has(id)) {
                return res.status(400).json({ error: 'Um ou mais procedimentos não estão disponíveis para novo agendamento.' });
            }
        }

        const hasPromo = serviceIdsNorm.some((id) => PROMO_PACKAGE_IDS.has(id));
        if (hasPromo) {
            const promoOn = await readPromotionalPackagesEnabledFromDb();
            if (!promoOn) {
                return res.status(400).json({ error: 'Este vale-presente não está disponível no momento.' });
            }
        }

        let paymentType = rawPaymentType ? String(rawPaymentType).toLowerCase() : 'partial';
        if (!['partial', 'full'].includes(paymentType)) {
            return res.status(400).json({ error: 'paymentType inválido. Use "partial" ou "full".' });
        }

        /* Com vales-presente no carrinho: um único checkout pelo valor total (catálogo). */
        if (hasPromo) {
            paymentType = 'full';
        }

        const totalServicePrice = roundMoney2(
            serviceIdsNorm.reduce((sum, id) => sum + Number(catalogById.get(id).price || 0), 0)
        );

        if (!Number.isFinite(totalServicePrice) || totalServicePrice <= 0) {
            return res.status(400).json({ error: 'Serviço inválido ou valor não encontrado para este procedimento.' });
        }

        const partialNow = effectivePartialDownPayment(totalServicePrice);
        if (partialNow >= totalServicePrice - 0.005) {
            paymentType = 'full';
        }

        const primaryServiceId = serviceIdsNorm[0];
        const serviceIdsJson = JSON.stringify(serviceIdsNorm);
        const serviceSlotsJson = JSON.stringify(resolvedSlots);

        const amountCharged = paymentType === 'partial' ? partialNow : totalServicePrice;

        const remainingAmount = paymentType === 'partial' ? Math.max(0, roundMoney2(totalServicePrice - partialNow)) : 0;

        const paymentCents =
            paymentType === 'partial' ? Math.round(partialNow * 100) : Math.round(totalServicePrice * 100);

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
            paymentType,
            amountCharged,
            remainingAmount,
            paymentCents,
            totalProcedureCents: Math.round(totalServicePrice * 100)
        };

        console.log(`[Appointments] Criando checkout InfinitePay para o agendamento ${newId}...`);
        const paymentUrl = await createCheckoutLink(appointmentPayload);

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
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending_payment', $13, $14, $15, $16, $17)
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
            paymentUrl,
            amountCharged,
            paymentType,
            amountCharged,
            remainingAmount
        ]);

        await client.query('COMMIT');

        console.log(`[Appointments] Reserva gerada com sucesso: ${primaryDate} ${primaryTime}`);

        return res.status(201).json(mapAppointmentRow(insert.rows[0]));
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[POST /appointments] Erro:', error);
        return res.status(500).json({ error: 'Erro interno ao criar agendamento.' });
    } finally {
        client.release();
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

        if (cancelledBy === 'client' && ap.status !== 'cancelled') {
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

        const update = await pool.query(`
            UPDATE appointments
            SET status = 'cancelled',
                cancelled_by = $1,
                cancel_reason = $2,
                cancelled_at = CURRENT_TIMESTAMP
            WHERE id = $3
            RETURNING *
        `, [
            cancelledBy || 'client',
            cancelReason || 'Cancelado pelo usuário',
            id
        ]);

        return res.json(mapAppointmentRow(update.rows[0]));
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
                return res.status(400).json({ error: 'paidAmount inválido para pagamento parcial.' });
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
            return res.status(409).json({ error: 'Não é possível quitar saldo: agendamento está cancelado.' });
        }

        if (prevStatus !== 'confirmed' && prevStatus !== 'completed') {
            return res.status(409).json({ error: 'Quitação de saldo só é permitida para agendamentos confirmados ou concluídos.' });
        }

        const pt = String(ap.payment_type || '').trim().toLowerCase();
        if (pt !== 'partial') {
            return res.status(409).json({ error: 'Quitação de saldo só se aplica a pagamentos parciais (sinal + saldo).' });
        }

        const remaining = toMoneyNumber(ap.remaining_amount);
        if (remaining == null || remaining <= 0.005) {
            return res.status(409).json({ error: 'Não há saldo restante a quitar (remaining_amount já é zero).' });
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
            return res.status(400).json({ error: 'Inconsistência: valor pago após quitação ultrapassa o total do procedimento.' });
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
        const stamp = `[Quitação saldo manual +R$ ${remaining.toFixed(2).replace('.', ',')}]`;
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
                error: 'Não foi possível quitar o saldo (dados podem ter mudado: saldo já quitado ou tipo de pagamento incompatível).'
            });
        }

        return res.json({
            ok: true,
            previousStatus: prevStatus,
            appointment: mapAppointmentRow(upd.rows[0])
        });
    } catch (e) {
        console.error('[PATCH /admin/appointments/:id/settle-remaining-balance] Erro:', e);
        return res.status(500).json({ error: 'Erro ao quitar saldo restante.' });
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
        console.log('[InfinitePay Webhook] Payload recebido:', JSON.stringify(req.body));

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

        console.log('[InfinitePay Webhook] Itens recebidos:', JSON.stringify(items || []));
        console.log('[InfinitePay Webhook] Parcela(s):', installments || 1);
        console.log('[InfinitePay Webhook] Valor cobrado (centavos):', amount || 0);

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

app.post('/test-email', async (req, res) => {
    try {
        console.log('[TestEmail] Chamando endpoint manual /test-email');

        const mockAp = {
            client_name: 'Cliente Teste Manual',
            date: '2026-04-18',
            time: '14:30',
            location: 'Rua de Teste, 123'
        };

        const mockService = { name: 'Serviço de Teste', price: 100.00 };

        await sendConfirmationEmail(mockAp, mockService);

        return res.status(200).json({
            success: true,
            message: 'E-mail de teste enviado com sucesso! Verifique sua caixa de entrada.'
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

app.listen(PORT, () => {
    console.log(`🚀 Ateliê Backend DB operando na porta ${PORT}`);
});