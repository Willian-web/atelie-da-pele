const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();
const { sendConfirmationEmail } = require('./services/emailService');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors({ origin: '*' }));
app.use(express.json());

// Servir arquivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

// Fallback para dev local na ausência do banco Postgres
const isPostgresSetup = !!process.env.DATABASE_URL;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://user:pass@localhost:5432/dbname',
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

// Inicialização do Banco de Dados
async function initDB() {
    if (!isPostgresSetup) {
        console.warn('⚠️ AVISO: DATABASE_URL não definida. O sistema precisa do PostgreSQL para funcionar corretamente.');
        return;
    }
    try {
        const client = await pool.connect();
        
        // Tabela Clientes
        await client.query(`
            CREATE TABLE IF NOT EXISTS clients (
                id VARCHAR(255) PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                phone VARCHAR(50) NOT NULL UNIQUE,
                address TEXT,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Tabela Agendamentos
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
        
        client.release();
        console.log('✅ Banco de dados sincronizado');
    } catch (err) {
        console.error('❌ Erro ao iniciar banco:', err);
    }
}
initDB();

// Healthcheck
app.get('/health', (req, res) => {
    res.json({ status: "ok", db: isPostgresSetup ? "connected" : "missing" });
});

// Auto-cancelar pendentes (15 minutos)
async function sweepExpiredPending() {
    if (!isPostgresSetup) return;
    try {
        await pool.query(`
            UPDATE appointments 
            SET status = 'cancelled', 
                cancel_reason = 'Pagamento não identificado em 15 minutos',
                cancelled_at = CURRENT_TIMESTAMP,
                cancelled_by = 'system'
            WHERE status = 'pending_payment' 
            AND created_at < CURRENT_TIMESTAMP - INTERVAL '15 minutes'
        `);
    } catch (e) {
        console.error('Falha na varredura de pendentes:', e);
    }
}

// ======================== API CLIENTES ========================

app.get('/clients', async (req, res) => {
    if (!isPostgresSetup) return res.json([]);
    try {
        const { rows } = await pool.query('SELECT * FROM clients ORDER BY name ASC');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar clientes' });
    }
});

app.post('/clients', async (req, res) => {
    if (!isPostgresSetup) return res.status(500).json({error: 'DB não configurado.'});
    try {
        const { id, name, phone, address } = req.body;
        const cleanPhone = phone.replace(/\D/g, '');
        
        // Verifica se já existe por telefone para impedir duplicatas do mesmo cliente
        const exist = await pool.query('SELECT * FROM clients WHERE phone = $1', [cleanPhone]);
        
        if (exist.rows.length > 0) {
            // Atualiza endereço se mandou um novo
            await pool.query('UPDATE clients SET name = $1, address = $2 WHERE phone = $3', [name, address || exist.rows[0].address, cleanPhone]);
            return res.status(200).json(exist.rows[0]);
        }

        await pool.query(
            'INSERT INTO clients (id, name, phone, address) VALUES ($1, $2, $3, $4)',
            [id, name, cleanPhone, address || '']
        );
        res.status(201).json({ id, name, phone: cleanPhone, address });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao criar cliente' });
    }
});


// ====================== API AGENDAMENTOS ======================

app.get('/appointments', async (req, res) => {
    if (!isPostgresSetup) return res.json([]);
    await sweepExpiredPending(); // Limpa antes de enviar os dados

    try {
        const { rows } = await pool.query('SELECT * FROM appointments ORDER BY date ASC, time ASC');
        // Mapeando do padrão _ para camelCase para o front não quebrar
        const formatted = rows.map(r => ({
            id: r.id,
            serviceId: r.service_id,
            clientId: r.client_id,
            clientName: r.client_name,
            clientPhone: r.client_phone,
            location: r.location,
            date: r.date,
            time: r.time,
            notes: r.notes,
            createdAt: r.created_at,
            status: r.status,
            paymentUrl: r.payment_url,
            cancelledAt: r.cancelled_at,
            cancelledBy: r.cancelled_by,
            cancelReason: r.cancel_reason
        }));
        res.json(formatted);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar agendamentos' });
    }
});

app.post('/appointments', async (req, res) => {
    if (!isPostgresSetup) return res.status(500).json({error: 'DB não configurado.'});
    await sweepExpiredPending();

    const client = await pool.connect();
    try {
        const {
            serviceId, clientId, clientName, clientPhone,
            date, time, notes, location, price
        } = req.body;

        if (!clientName || !clientPhone || !serviceId || !date || !time) {
            return res.status(400).json({ error: 'Dados obrigatórios faltando.' });
        }

        await client.query('BEGIN'); // Transação real de concorrência

        // TRAVA (Anti Double-Booking): Verifica agendamentos válidos no mesmo horário
        const double = await client.query(`
            SELECT id FROM appointments 
            WHERE date = $1 AND time = $2 AND status IN ('pending_payment', 'confirmed', 'completed')
            FOR UPDATE
        `, [date, time]);

        if (double.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Este horário acabou de ser reservado por outra pessoa.' });
        }

        const newId = Date.now().toString();
        // CÁLCULO DE 30% PAGBANK
        const advanceAmount = price ? (price * 0.3).toFixed(2) : 0;
        
        // Mocking a PagBank Link
        const paymentUrl = `https://pagar.me/mock_link_${newId}?value=${advanceAmount}`;

        await client.query(`
            INSERT INTO appointments 
            (id, service_id, client_id, client_name, client_phone, location, date, time, notes, status, payment_url) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending_payment', $10)
        `, [newId, serviceId, clientId, clientName, clientPhone, location || '', date, time, notes || '', paymentUrl]);

        await client.query('COMMIT');

        console.log(`[Agendamento DB] Reserva gerada: ${date} ${time}`);
        
        res.status(201).json({
            id: newId, serviceId, clientId, clientName, clientPhone, location, 
            date, time, notes, status: 'pending_payment', paymentUrl
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Erro POST:', error);
        res.status(500).json({ error: 'Erro interno' });
    } finally {
        client.release();
    }
});

app.patch('/appointments/:id/cancel', async (req, res) => {
    if (!isPostgresSetup) return res.status(500).json({error: 'DB não configurado.'});
    const { id } = req.params;
    const { cancelledBy, cancelReason } = req.body;

    try {
        const check = await pool.query('SELECT * FROM appointments WHERE id = $1', [id]);
        if (check.rows.length === 0) return res.status(404).json({error: 'Inexistente'});

        const ap = check.rows[0];

        // REGRA DE DUAS HORAS: SE CANCELADO PELO CLIENTE, VALIDAR.
        if (cancelledBy === 'client' && ap.status !== 'cancelled') {
            const apDateTimeStr = ap.date + 'T' + ap.time + ':00-03:00'; // Fuso de BRT (UTC-3)
            const apTime = new Date(apDateTimeStr).getTime();
            const now = new Date().getTime();
            const diffHours = (apTime - now) / (1000 * 60 * 60);

            if (diffHours < 2) {
                return res.status(400).json({ error: 'Cancelamento permitido apenas com 2 horas ou mais de antecedência.' });
            }
        }

        await pool.query(`
            UPDATE appointments 
            SET status = 'cancelled', cancelled_by = $1, cancel_reason = $2, cancelled_at = CURRENT_TIMESTAMP
            WHERE id = $3
        `, [cancelledBy, cancelReason, id]);

        const updated = await pool.query('SELECT * FROM appointments WHERE id = $1', [id]);
        res.json(updated.rows[0]); // Retorna direto e o front formata se precisar
    } catch (e) {
        console.error(e);
        res.status(500).json({error: 'Erro no cancelar'});
    }
});

app.delete('/appointments/:id', async (req, res) => {
    if (!isPostgresSetup) return res.status(500).json({error: 'DB não configurado.'});
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM appointments WHERE id = $1', [id]);
        res.json({success: true});
    } catch (e) {
        res.status(500).json({error: 'Erro de deleção'});
    }
});

// ====================== WEBHOOK PAGBANK =======================

app.post('/webhook/pagbank', async (req, res) => {
    const { appointment_id, payment_status } = req.body;
    // Isso seria chamado pela API real do PagBank enviando os status e reference_id
    if (!isPostgresSetup) return res.status(500).json({error:'Sem DB'});

    try {
        if (payment_status === 'PAID') {
            await pool.query(`
                UPDATE appointments 
                SET status = 'confirmed' 
                WHERE id = $1 AND status = 'pending_payment'
            `, [appointment_id]);
            console.log(`[WebHook] Agendamento ${appointment_id} confirmado!`);
            
            // Buscar dados do agendamento para o email
            try {
                console.log(`[WebHook] Extraindo dados do agendamento ${appointment_id} para enviar e-mail...`);
                const result = await pool.query('SELECT * FROM appointments WHERE id = $1', [appointment_id]);
                if (result.rows.length > 0) {
                    const ap = result.rows[0];
                    console.log(`[WebHook] Agendamento encontrado para o cliente: ${ap.client_name}`);
                    const SERVICES = [
                        { id: 'limpeza_pele', name: 'Limpeza de Pele', price: 119.90 },
                        { id: 'dep_intima', name: 'Depilação Íntima Completa', price: 59.90 },
                        { id: 'dep_axila', name: 'Depilação Axila', price: 29.90 },
                        { id: 'dep_buco', name: 'Depilação Buço', price: 29.90 },
                        { id: 'dep_completa', name: 'Depilação Completa', price: 129.90 },
                        { id: 'reflexologia', name: 'Reflexologia Podal', price: 89.90 }
                    ];
                    const serviceObj = SERVICES.find(s => s.id === ap.service_id);
                    console.log(`[WebHook] Chamando a função sendConfirmationEmail...`);
                    await sendConfirmationEmail(ap, serviceObj);
                    console.log(`[WebHook] Função sendConfirmationEmail finalizou a execução.`);
                } else {
                    console.log(`[WebHook] NENHUM dado encontrado para o id ${appointment_id}. E-mail cancelado.`);
                }
            } catch (emailErr) {
                console.error('[WebHook] Falha geral ao enviar e-mail de confirmação:', emailErr);
            }

        } else if (payment_status === 'RECUSED' || payment_status === 'EXPIRED') {
            await pool.query(`
                UPDATE appointments 
                SET status = 'cancelled', 
                    cancel_reason = $2,
                    cancelled_at = CURRENT_TIMESTAMP,
                    cancelled_by = 'system'
                WHERE id = $1 AND status = 'pending_payment'
            `, [appointment_id, payment_status === 'EXPIRED' ? 'Expirou no Sandbox' : 'Cartão não aprovado (Sandbox)']);
            console.log(`[WebHook] Agendamento ${appointment_id} reprovado/expirado!`);
        }
        res.status(200).json({ received: true });
    } catch(e) {
        console.error(e);
        res.status(500).json({ error: 'Erro no webhook' });
    }
});

// ====================== TESTE DE EMAIL (DEV) ====================
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
        res.status(200).json({ success: true, message: 'E-mail de teste enviado com sucesso! Verifique sua caixa de entrada.' });
    } catch (e) {
        console.error('[TestEmail] Erro no teste:', e);
        res.status(500).json({ success: false, error: e.message || 'Erro ao enviar email' });
    }
});

// Single Page App
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 Ateliê Backend DB operando na porta ${PORT}`);
});
