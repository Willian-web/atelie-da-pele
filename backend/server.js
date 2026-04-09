const express = require('express');
const cors = require('cors');
require('dotenv').config();

const whatsappService = require('./services/whatsappService');
const pagbankService = require('./services/pagbankService');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Rota de Boas Vindas e Checagem da Nuvem
app.get('/', (req, res) => {
    res.send('Backend do Ateliê da Pele está ONLINE! 🚀 Autenticação via Twilio API.');
});

// Endpoint POST /appointments
app.post('/appointments', async (req, res) => {
    try {
        const {
            clientName,
            clientPhone,
            serviceName,
            date,
            time,
            price,
            notes,
            profPhone
        } = req.body;

        // Basic Validation
        if (!clientName || !clientPhone || !serviceName || !date || !time) {
            return res.status(400).json({ error: 'Dados obrigatórios estão faltando.' });
        }

        // --- Logic to save the appointment to a database could go here ---
        // As per the requirement, we are only firing WhatsApp messages upon receive.

        console.log(`[Agendamento Recebido] ${clientName} - ${serviceName} às ${time}`);

        // 1. Gera Link de Pagamento (PagBank)
        let checkoutLink = null;
        try {
            const pb = await pagbankService.createCheckoutLink({ clientName, clientPhone, serviceName, price });
            checkoutLink = pb.checkoutUrl;
        } catch (err) {
            console.error('Falha não-fatal no PagBank, seguindo sem link:', err.message);
        }

        // Construct Messages
        let clientMessage = `Olá, ${clientName}! Seu agendamento foi pré-confirmado no Ateliê da Pele.\nServiço: ${serviceName}\nData: ${date}\nHorário: ${time}\nValor: ${price}\n\n`;

        if (checkoutLink) {
            clientMessage += `💳 *Para confirmar definitivamente seu horário, por favor aguardamos o pagamento no painel Seguro PagBank:*\n🔗 ${checkoutLink}\n\n`;
        }

        clientMessage += `Aguardamos você.`;
        const profMessage = `Novo agendamento no Ateliê da Pele.\nCliente: ${clientName}\nTelefone: ${clientPhone}\nServiço: ${serviceName}\nData: ${date}\nHorário: ${time}\nObservações: ${notes || 'Nenhuma'}`;

        // Send logic
        const responses = {};

        // 1. Mensagem pro Cliente
        try {
            await whatsappService.sendMessage(clientPhone, clientMessage);
            responses.client = 'success';
        } catch (err) {
            console.error('Falha ao enviar msg p/ cliente:', err.message);
            responses.client = 'failed';
        }

        // 2. Mensagem pra Profissional
        if (profPhone) {
            try {
                await whatsappService.sendMessage(profPhone, profMessage);
                responses.prof = 'success';
            } catch (err) {
                console.error('Falha ao enviar msg p/ profissional:', err.message);
                responses.prof = 'failed';
            }
        }

        res.status(200).json({
            message: 'Processamento de mensagens concluído',
            checkoutUrl: checkoutLink,
            status: responses
        });

    } catch (error) {
        console.error('Erro geral /appointments:', error);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Ateliê Backend: Express na Trilha Global (0.0.0.0) na porta ${PORT}`);
});
