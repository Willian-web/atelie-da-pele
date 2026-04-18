const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

const { sendConfirmationEmail } = require('./services/emailService');
const { createCheckoutLink, checkPaymentStatus } = require('./services/infinitepayService');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors({ origin: '*' }));
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

const isPostgresSetup = !!process.env.DATABASE_URL;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://user:pass@localhost:5432/dbname',
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
        ? false
        : { rejectUnauthorized: false }
});

const SERVICES = [
    { id: 'limpeza_pele', name: 'Limpeza de Pele', price: 119.90 },
    { id: 'dep_intima', name: 'Depilação Íntima Completa', price: 59.90 },
    { id: 'dep_axila', name: 'Depilação Axila', price: 29.90 },
    { id: 'dep_buco', name: 'Depilação Buço', price: 29.90 },
    { id: 'dep_completa', name: 'Depilação Completa', price: 129.90 },
    { id: 'reflexologia', name: 'Reflexologia Podal', price: 89.90 }
];

const FIXED_SIGNAL_AMOUNT = 30.00;

// ======================= BANCO =======================

async function initDB() {
    if (!isPostgresSetup) {
        console.warn('⚠️ AVISO: DATABASE_URL não definida. O sistema precisa do PostgreSQL para funcionar corretamente.');
        return;
    }

    const client = await pool.connect();

    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS clients (
                id VARCHAR(255) PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                phone VARCHAR(50) NOT NULL UNIQUE,
                address TEXT,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

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
                payment_amount NUMERIC(10,2) DEFAULT 30.00,
                transaction_nsu VARCHAR(255),
                invoice_slug VARCHAR(255),
                receipt_url TEXT,
                capture_method VARCHAR(50),
                paid_amount NUMERIC(10,2),
                cancelled_at TIMESTAMP WITH TIME ZONE,
                cancelled_by VARCHAR(50),
                cancel_reason TEXT
            );
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_appointments_date_time_status
            ON appointments (date, time, status);
        `);

        console.log('✅ Banco de dados sincronizado');
    } catch (err) {
        console.error('❌ Erro ao iniciar banco:', err);
    } finally {
        client.release();
    }
}

initDB();

// ======================= AUXILIARES =======================

function mapAppointmentRow(row) {
    return {
        id: row.id,
        serviceId: row.service_id,
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
        transactionNsu: row.transaction_nsu,
        invoiceSlug: row.invoice_slug,
        receiptUrl: row.receipt_url,
        captureMethod: row.capture_method,
        paidAmount: row.paid_amount ? Number(row.paid_amount) : null,
        cancelledAt: row.cancelled_at,
        cancelledBy: row.cancelled_by,
        cancelReason: row.cancel_reason
    };
}

function findServiceById(serviceId) {
    return SERVICES.find(s => s.id === serviceId) || {
        id: serviceId,
        name: serviceId || 'Serviço',
        price: 0
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

async function confirmAppointmentPayment({ appointmentId, transactionNsu, invoiceSlug, receiptUrl, captureMethod, paidAmount }) {
    if (!appointmentId) {
        throw new Error('appointmentId não informado para confirmação do pagamento');
    }

    const updateResult = await pool.query(`
        UPDATE appointments
        SET status = 'confirmed',
            transaction_nsu = COALESCE($2, transaction_nsu),
            invoice_slug = COALESCE($3, invoice_slug),
            receipt_url = COALESCE($4, receipt_url),
            capture_method = COALESCE($5, capture_method),
            paid_amount = COALESCE($6, paid_amount)
        WHERE id = $1
          AND status = 'pending_payment'
        RETURNING *
    `, [
        appointmentId,
        transactionNsu || null,
        invoiceSlug || null,
        receiptUrl || null,
        captureMethod || null,
        paidAmount || null
    ]);

    if (updateResult.rows.length === 0) {
        const existing = await pool.query('SELECT * FROM appointments WHERE id = $1', [appointmentId]);
        if (existing.rows.length === 0) {
            throw new Error(`Agendamento ${appointmentId} não encontrado`);
        }

        const current = existing.rows[0];
        console.log(`[Payment] Agendamento ${appointmentId} já estava com status ${current.status}.`);
        return current;
    }

    const appointment = updateResult.rows[0];
    console.log(`[Payment] Agendamento ${appointmentId} confirmado com sucesso.`);

    try {
        const serviceObj = findServiceById(appointment.service_id);
        await sendConfirmationEmail(appointment, serviceObj);
        console.log(`[Payment] E-mail de confirmação enviado para o agendamento ${appointmentId}.`);
    } catch (emailErr) {
        console.error(`[Payment] Falha ao enviar e-mail do agendamento ${appointmentId}:`, emailErr);
    }

    return appointment;
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
        const { id, name, phone, address } = req.body;

        if (!name || !phone) {
            return res.status(400).json({ error: 'Nome e telefone são obrigatórios.' });
        }

        const cleanPhone = String(phone).replace(/\D/g, '');

        if (!cleanPhone) {
            return res.status(400).json({ error: 'Telefone inválido.' });
        }

        const exist = await pool.query('SELECT * FROM clients WHERE phone = $1', [cleanPhone]);

        if (exist.rows.length > 0) {
            const existingClient = exist.rows[0];

            const update = await pool.query(`
                UPDATE clients
                SET name = $1,
                    address = $2
                WHERE phone = $3
                RETURNING *
            `, [
                name,
                address || existingClient.address || '',
                cleanPhone
            ]);

            return res.status(200).json(update.rows[0]);
        }

        const clientId = id || Date.now().toString();

        const insert = await pool.query(`
            INSERT INTO clients (id, name, phone, address)
            VALUES ($1, $2, $3, $4)
            RETURNING *
        `, [
            clientId,
            name,
            cleanPhone,
            address || ''
        ]);

        return res.status(201).json(insert.rows[0]);
    } catch (error) {
        console.error('[POST /clients] Erro:', error);
        return res.status(500).json({ error: 'Erro ao criar cliente' });
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

app.post('/appointments', async (req, res) => {
    if (!isPostgresSetup) {
        return res.status(500).json({ error: 'DB não configurado.' });
    }

    await sweepExpiredPending();

    const client = await pool.connect();

    try {
        const {
            serviceId,
            clientId,
            clientName,
            clientPhone,
            date,
            time,
            notes,
            location
        } = req.body;

        if (!clientName || !clientPhone || !serviceId || !date || !time) {
            return res.status(400).json({ error: 'Dados obrigatórios faltando.' });
        }

        await client.query('BEGIN');

        const cleanPhone = String(clientPhone).replace(/\D/g, '');
        let finalClientId = clientId;

        // Garante cliente
        const existingClient = await client.query('SELECT * FROM clients WHERE phone = $1', [cleanPhone]);

        if (existingClient.rows.length > 0) {
            finalClientId = existingClient.rows[0].id;

            await client.query(`
                UPDATE clients
                SET name = $1,
                    address = $2
                WHERE id = $3
            `, [
                clientName,
                location || existingClient.rows[0].address || '',
                finalClientId
            ]);
        } else {
            finalClientId = finalClientId || `${Date.now()}_client`;

            await client.query(`
                INSERT INTO clients (id, name, phone, address)
                VALUES ($1, $2, $3, $4)
            `, [
                finalClientId,
                clientName,
                cleanPhone,
                location || ''
            ]);
        }

        // Anti double-booking
        const double = await client.query(`
            SELECT id
            FROM appointments
            WHERE date = $1
              AND time = $2
              AND status IN ('pending_payment', 'confirmed', 'completed')
            FOR UPDATE
        `, [date, time]);

        if (double.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Este horário acabou de ser reservado por outra pessoa.' });
        }

        const newId = Date.now().toString();

        const appointmentPayload = {
            id: newId,
            serviceId,
            clientId: finalClientId,
            clientName,
            clientPhone: cleanPhone,
            date,
            time,
            notes,
            location
        };

        console.log(`[Appointments] Criando checkout InfinitePay para o agendamento ${newId}...`);
        const paymentUrl = await createCheckoutLink(appointmentPayload);

        const insert = await client.query(`
            INSERT INTO appointments (
                id,
                service_id,
                client_id,
                client_name,
                client_phone,
                location,
                date,
                time,
                notes,
                status,
                payment_url,
                payment_amount
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending_payment', $10, $11)
            RETURNING *
        `, [
            newId,
            serviceId,
            finalClientId,
            clientName,
            cleanPhone,
            location || '',
            date,
            time,
            notes || '',
            paymentUrl,
            FIXED_SIGNAL_AMOUNT
        ]);

        await client.query('COMMIT');

        console.log(`[Appointments] Reserva gerada com sucesso: ${date} ${time}`);

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

app.delete('/appointments/:id', async (req, res) => {
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

        const confirmedAppointment = await confirmAppointmentPayment({
            appointmentId: order_nsu,
            transactionNsu: transaction_nsu || null,
            invoiceSlug: invoice_slug || null,
            receiptUrl: receipt_url || null,
            captureMethod: capture_method || null,
            paidAmount: paid_amount ? Number(paid_amount) / 100 : null
        });

        console.log(`[InfinitePay Webhook] Pagamento aprovado do agendamento ${order_nsu}.`);
        console.log('[InfinitePay Webhook] Itens recebidos:', JSON.stringify(items || []));
        console.log('[InfinitePay Webhook] Parcela(s):', installments || 1);
        console.log('[InfinitePay Webhook] Valor cobrado (centavos):', amount || 0);

        return res.status(200).json({
            received: true,
            appointmentId: confirmedAppointment.id,
            status: confirmedAppointment.status
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
            const appointment = await confirmAppointmentPayment({
                appointmentId: order_nsu,
                transactionNsu: transaction_nsu,
                invoiceSlug: slug,
                receiptUrl: null,
                captureMethod: result.capture_method || null,
                paidAmount: result.paid_amount ? Number(result.paid_amount) / 100 : null
            });

            return res.status(200).json({
                success: true,
                paid: true,
                appointment: mapAppointmentRow(appointment)
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