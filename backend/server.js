const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

const { sendConfirmationEmail } = require('./services/emailService');
const { createCheckoutLink } = require('./services/infinitepayService');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const isPostgresSetup = !!process.env.DATABASE_URL;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function initDB() {
    const client = await pool.connect();

    await client.query(`
        CREATE TABLE IF NOT EXISTS appointments (
            id VARCHAR(255) PRIMARY KEY,
            service_id VARCHAR(255),
            client_name VARCHAR(255),
            client_phone VARCHAR(50),
            location TEXT,
            date VARCHAR(10),
            time VARCHAR(5),
            status VARCHAR(50),
            payment_url TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);

    client.release();
    console.log('✅ Banco OK');
}

initDB();

// ====================== CRIAR AGENDAMENTO ======================

app.post('/appointments', async (req, res) => {
    const client = await pool.connect();

    try {
        const {
            serviceId,
            clientName,
            clientPhone,
            date,
            time,
            location
        } = req.body;

        const id = Date.now().toString();

        const appointment = {
            id,
            serviceId,
            clientName,
            clientPhone,
            date,
            time,
            location
        };

        console.log(`[Agendamento] Criando ${id}`);

        // 🔥 CRIA CHECKOUT INFINITEPAY
        const paymentUrl = await createCheckoutLink(appointment);

        await client.query(`
            INSERT INTO appointments
            (id, service_id, client_name, client_phone, location, date, time, status, payment_url)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        `, [
            id,
            serviceId,
            clientName,
            clientPhone,
            location,
            date,
            time,
            'pending_payment',
            paymentUrl
        ]);

        console.log(`[Agendamento] Checkout criado: ${paymentUrl}`);

        res.json({
            id,
            paymentUrl,
            status: 'pending_payment'
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao criar agendamento' });
    } finally {
        client.release();
    }
});

// ====================== WEBHOOK INFINITEPAY ======================

app.post('/webhook/infinitepay', async (req, res) => {
    try {
        console.log('[Webhook InfinitePay] Recebido:', JSON.stringify(req.body));

        const orderNsu = req.body?.order_nsu;
        const status = req.body?.status;

        if (!orderNsu) {
            return res.status(400).json({ error: 'order_nsu não enviado' });
        }

        if (status === 'approved' || status === 'paid') {
            await pool.query(`
                UPDATE appointments
                SET status = 'confirmed'
                WHERE id = $1
            `, [orderNsu]);

            console.log(`[Webhook] Pagamento confirmado: ${orderNsu}`);

            const result = await pool.query(
                'SELECT * FROM appointments WHERE id = $1',
                [orderNsu]
            );

            if (result.rows.length > 0) {
                const ap = result.rows[0];

                await sendConfirmationEmail(ap, {
                    name: 'Serviço',
                    price: 0
                });

                console.log(`[Webhook] Email enviado para ${ap.client_name}`);
            }
        }

        res.json({ ok: true });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro webhook' });
    }
});

// ====================== TESTE EMAIL ======================

app.post('/test-email', async (req, res) => {
    await sendConfirmationEmail(
        { client_name: 'Teste', date: '2026-01-01', time: '10:00' },
        { name: 'Teste', price: 0 }
    );

    res.json({ ok: true });
});

// SPA

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 Backend rodando na porta ${PORT}`);
});