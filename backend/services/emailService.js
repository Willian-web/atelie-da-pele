const { Resend } = require('resend');

async function sendConfirmationEmail(appointmentData, serviceData) {
    console.log(`[EmailService] Iniciando envio via HTTPS REST (Resend)...`);
    console.log(`[EmailService] Variáveis - Destino: ${process.env.NOTIFICATION_EMAIL || 'NÃO DEFINIDO'}, Remetente: ${process.env.FROM_EMAIL || 'onboarding@resend.dev'}`);

    if (!process.env.RESEND_API_KEY) {
        console.error('[EmailService] ERRO CRÍTICO: RESEND_API_KEY não está definida no arquivo .env !');
        return;
    }

    if (!process.env.NOTIFICATION_EMAIL) {
        console.error('[EmailService] ERRO CRÍTICO: NOTIFICATION_EMAIL não está definido no arquivo .env !');
        return;
    }

    // Instancia o Resend apenas aqui dentro para não derrubar o NodeJS inteiro se a env estiver vazia na inicialização
    const resend = new Resend(process.env.RESEND_API_KEY);

    try {
        const emailData = {
            from: process.env.FROM_EMAIL || 'Atelie da Pele <onboarding@resend.dev>',
            to: process.env.NOTIFICATION_EMAIL,
            subject: `Novo Agendamento Confirmado - ${appointmentData.client_name || appointmentData.clientName || 'Cliente'}`,
            text: `
NOVO AGENDAMENTO CONFIRMADO!

O pagamento do adiantamento foi aprovado e um novo agendamento foi confirmado no sistema.

DETALHES DO AGENDAMENTO:
------------------------------------------
Cliente: ${appointmentData.client_name || appointmentData.clientName || 'Cliente'}
Serviço: ${serviceData ? serviceData.name : (appointmentData.service_id || 'Serviço')}
Data: ${appointmentData.date ? new Date((appointmentData.date) + 'T12:00:00').toLocaleDateString('pt-BR') : 'Sem data'}
Horário: ${appointmentData.time || 'Sem horário'}
Local do atendimento: Ateliê da Pele — Rua Rio Jaguaribe, nº 274 ${appointmentData.location ? `\nEndereço Cliente (A Domicílio): ${appointmentData.location}` : ''}
Valor do Serviço: ${serviceData && serviceData.price ? serviceData.price.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : 'N/A'}
Valor do Adiantamento: ${serviceData && serviceData.price ? (serviceData.price * 0.3).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : 'N/A'}
Status: Confirmado

------------------------------------------
Este é um e-mail automático enviado via API HTTPS.
            `
        };

        console.log('[EmailService] Efetuando requisição POST para a API do Resend...');
        const { data, error } = await resend.emails.send(emailData);

        if (error) {
            console.error('[EmailService] Falha bloqueada pela API do provedor:', error.message || error);
            throw new Error(error.message);
        }

        console.log(`[EmailService] E-mail enviado via HTTPS com sucesso! Resend ID: ${data.id}`);
        return data;
    } catch (error) {
        console.error('[EmailService] Falha geral ao enviar e-mail REST:', error.message || error);
        throw error;
    }
}

module.exports = {
    sendConfirmationEmail
};
