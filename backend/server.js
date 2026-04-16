const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors({ origin: '*' }));
app.use(express.json());

// Servir arquivos estáticos (Frontend unificado em produção Railway)
app.use(express.static(path.join(__dirname, 'public')));

// Estado persistente em Memória do Node para este MVP
let appointments = [];

// Healthcheck
app.get('/health', (req, res) => {
    res.json({ status: "ok" });
});

// 1. Ler todos agendamentos da API
app.get('/appointments', (req, res) => {
    res.json(appointments);
});

// 2. Criar Agendamento centralizado
app.post('/appointments', (req, res) => {
    try {
        const {
            serviceId,
            clientId,
            clientName,
            clientPhone,
            date,
            time,
            notes
        } = req.body;

        if (!clientName || !clientPhone || !serviceId || !date || !time) {
            return res.status(400).json({ error: 'Dados obrigatórios faltando.' });
        }

        const newApp = {
            id: Date.now().toString(),
            serviceId,
            clientId,
            clientName,
            clientPhone,
            date,
            time,
            notes: notes || '',
            createdAt: new Date().toISOString(),
            status: 'scheduled',
            cancelledAt: null,
            cancelledBy: null,
            cancelReason: ''
        };

        appointments.push(newApp);

        console.log(`[Agendamento RAM] ${clientName} reservou às ${time} - ${date}`);
        res.status(201).json(newApp);

    } catch (error) {
        console.error('Erro POST:', error);
        res.status(500).json({ error: 'Erro interno' });
    }
});

// 3. Status Cancelamento
app.patch('/appointments/:id/cancel', (req, res) => {
    const { id } = req.params;
    const { cancelledBy, cancelReason } = req.body;

    const idx = appointments.findIndex(a => a.id === id);
    if(idx !== -1) {
        appointments[idx].status = 'cancelled';
        appointments[idx].cancelledAt = new Date().toISOString();
        appointments[idx].cancelledBy = cancelledBy || 'admin';
        appointments[idx].cancelReason = cancelReason || '';

        console.log(`[Cancelado RAM] ${id} por ${appointments[idx].cancelledBy}`);
        res.json(appointments[idx]);
    } else {
        res.status(404).json({error: 'Dado inexistente'});
    }
});

// 4. Deleção Limpa
app.delete('/appointments/:id', (req, res) => {
    const { id } = req.params;
    appointments = appointments.filter(a => a.id !== id);
    console.log(`[Excluído RAM] ${id}`);
    res.json({success: true});
});

// Redirecionamento Final -> Tudo não capturado vai pro Single Page App React
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Ateliê Backend MVP rodando e servindo public/ na porta ${PORT}`);
});
