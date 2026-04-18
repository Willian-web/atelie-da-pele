const { Resend } = require('resend');

const FIXED_SIGNAL_AMOUNT = 30;

function formatCurrencyBRL(value) {
    return Number(value || 0).toLocaleString('pt-BR', {
        style: 'currency',
        currency: 'BRL'
    });
}

async function sendConfirmationEmail(appointmentData, serviceData) {
    console.log('[EmailService] Iniciando envio via HTTPS REST (Resend)...');
    console.log(
        `[EmailService] Variáveis - Destino: ${process.env.NOTIFICATION_EMAIL || 'NÃO DEFINIDO'}, Remetente: ${process.env.FROM_EMAIL || 'onboarding@resend.dev'}`
    );

    if (!process.env.RESEND_API_KEY) {
        console.error('[EmailService] ERRO CRÍTICO: RESEND_API_KEY não está definida!');
        return;
    }

    if (!process.env.NOTIFICATION_EMAIL) {
        console.error('[EmailService] ERRO CRÍTICO: NOTIFICATION_EMAIL não está definido!');
        return;
    }

    const resend = new Resend(process.env.RESEND_API_KEY);

    try {
        const clientName =
            appointmentData.client_name ||
            appointmentData.clientName ||
            'Cliente';

        const serviceName =
            serviceData?.name ||
            appointmentData.service_name ||
            appointmentData.service_id ||
            'Serviço';

        const appointmentDate = appointmentData.date
            ? new Date(`${appointmentData.date}T12:00:00`).toLocaleDateString('pt-BR')
            : 'Sem data';

        const appointmentTime = appointmentData.time || 'Sem horário';

        const serviceValue =
            typeof serviceData?.price === 'number'
                ? formatCurrencyBRL(serviceData.price)
                : 'N/A';

        const clientAddress = appointmentData.location
            ? `\nEndereço Cliente (A Domicílio): ${appointmentData.location}`
            : '';

        const emailData = {
            from: process.env.FROM_EMAIL || 'Ateliê da Pele <onboarding@resend.dev>',
            to: process.env.NOTIFICATION_EMAIL,
            subject: `Novo Agendamento Confirmado - ${clientName}`,
            text: `
NOVO AGENDAMENTO CONFIRMADO!

O pagamento do sinal foi aprovado e um novo agendamento foi confirmado no sistema.

DETALHES DO AGENDAMENTO:
------------------------------------------
Cliente: ${clientName}
Serviço: ${serviceName}
Data: ${appointmentDate}
Horário: ${appointmentTime}
Local do atendimento: Ateliê da Pele — Rua Rio Jaguaribe, nº 274${clientAddress}
Valor do Serviço: ${serviceValue}
Valor do Sinal: ${formatCurrencyBRL(FIXED_SIGNAL_AMOUNT)}
Status: Confirmado

------------------------------------------
Este é um e-mail automático enviado via API HTTPS.
            `.trim()
        };

        console.log('[EmailService] Efetuando requisição POST para a API do Resend...');
        const { data, error } = await resend.emails.send(emailData);

        if (error) {
            console.error('[EmailService] Falha bloqueada pela API do provedor:', error.message || error);
            throw new Error(error.message || 'Falha no envio via Resend');
        }

        console.log(`[EmailService] E-mail enviado via HTTPS com sucesso! Resend ID: ${data?.id || 'N/A'}`);
        return data;
    } catch (error) {
        console.error('[EmailService] Falha geral ao enviar e-mail REST:', error.message || error);
        throw error;
    }
}

module.exports = {
    sendConfirmationEmail
};