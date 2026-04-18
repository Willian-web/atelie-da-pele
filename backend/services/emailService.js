const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.ethereal.email',
    port: process.env.SMTP_PORT || 587,
    secure: process.env.SMTP_PORT == 465, // true for 465, false for other ports
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
    tls: {
       rejectUnauthorized: false
    },
    // Forçar IPv4 para resolver o bug de rede no Railway
    family: 4,
});

async function sendConfirmationEmail(appointmentData, serviceData) {
    try {
        const mailOptions = {
            from: `"Ateliê da Pele" <${process.env.SMTP_USER || 'no-reply@ateliedapele.com'}>`,
            to: process.env.NOTIFICATION_EMAIL,
            subject: `Novo Agendamento Confirmado - ${appointmentData.client_name || appointmentData.clientName}`,
            text: `
NOVO AGENDAMENTO CONFIRMADO!

O pagamento do adiantamento foi aprovado e um novo agendamento foi confirmado no sistema.

DETALHES DO AGENDAMENTO:
------------------------------------------
Cliente: ${appointmentData.client_name || appointmentData.clientName}
Serviço: ${serviceData ? serviceData.name : appointmentData.service_id}
Data: ${new Date((appointmentData.date) + 'T12:00:00').toLocaleDateString('pt-BR')}
Horário: ${appointmentData.time}
Local do atendimento: Ateliê da Pele — Rua Rio Jaguaribe, nº 274 ${appointmentData.location ? `\nEndereço Cliente (A Domicílio): ${appointmentData.location}` : ''}
Valor do Serviço: ${serviceData ? serviceData.price.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : 'N/A'}
Valor do Adiantamento: ${serviceData ? (serviceData.price * 0.3).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : 'N/A'}
Status: Confirmado

------------------------------------------
Este é um e-mail automático do sistema.
            `
        };

        const info = await transporter.sendMail(mailOptions);
        console.log(`[EmailService] Notificação enviada: ${info.messageId}`);
        return info;
    } catch (error) {
        console.error('[EmailService] Falha ao enviar notificação por e-mail:', error);
        throw error;
    }
}

module.exports = {
    sendConfirmationEmail
};
