const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.ethereal.email',
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_PORT == 465, // true for 465, false for other ports
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
    tls: {
       rejectUnauthorized: false
    },
    family: 4, // Forçar IPv4 para resolver o bug de rede no Railway
});

async function sendConfirmationEmail(appointmentData, serviceData) {
    console.log(`[EmailService] Iniciando envio para: ${process.env.NOTIFICATION_EMAIL || 'NÃO DEFINIDO'}`);
    console.log(`[EmailService] SMTP configurado com host: ${process.env.SMTP_HOST}, porta: ${process.env.SMTP_PORT}, user: ${process.env.SMTP_USER}`);

    if (!process.env.NOTIFICATION_EMAIL) {
        console.error('[EmailService] ERRO CRÍTICO: NOTIFICATION_EMAIL não está definido no .env do Railway!');
        return;
    }

    try {
        const mailOptions = {
            from: `"Ateliê da Pele" <${process.env.SMTP_USER || 'no-reply@ateliedapele.com'}>`,
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
Este é um e-mail automático do sistema.
            `
        };

        const info = await transporter.sendMail(mailOptions);
        console.log(`[EmailService] E-mail enviado com sucesso! Message ID: ${info.messageId}`);
        return info;
    } catch (error) {
        console.error('[EmailService] Falha ao enviar e-mail:', error.message || error);
        throw error;
    }
}

module.exports = {
    sendConfirmationEmail,
    transporter
};
