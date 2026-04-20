const { Resend } = require('resend');

const FIXED_SIGNAL_AMOUNT = 30;

function formatCurrencyBRL(value) {
    return Number(value || 0).toLocaleString('pt-BR', {
        style: 'currency',
        currency: 'BRL'
    });
}

/**
 * Valor exibido nos e-mails: em pagamento integral o checkout correto está em `amount_charged`;
 * o gateway às vezes envia `paid_amount` do sinal (ex.: R$ 30) — não priorizar isso sobre o total.
 */
function resolvePaidAmountForDisplay({ paymentType, paid_amount, amount_charged, servicePrice }) {
    const paid = paid_amount != null && paid_amount !== '' ? Number(paid_amount) : null;
    const charged = amount_charged != null && amount_charged !== '' ? Number(amount_charged) : null;
    const pOk = paid != null && Number.isFinite(paid) && paid > 0;
    const cOk = charged != null && Number.isFinite(charged) && charged > 0;
    const svc =
        servicePrice != null && Number.isFinite(Number(servicePrice)) && Number(servicePrice) > 0
            ? Number(servicePrice)
            : null;

    if (String(paymentType || '').toLowerCase() === 'full') {
        if (cOk) return charged;
        if (pOk) return paid;
        return svc;
    }
    if (pOk) return paid;
    if (cOk) return charged;
    return svc;
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

        const paymentType = appointmentData.payment_type || null;
        const captureMethod = appointmentData.capture_method || null;

        const paidAmountValue = appointmentData.paid_amount ?? null;
        const amountChargedValue = appointmentData.amount_charged ?? null;
        const remainingAmountValue = appointmentData.remaining_amount ?? null;

        const servicePriceNum =
            typeof serviceData?.price === 'number' && Number.isFinite(serviceData.price) ? serviceData.price : null;

        const paidNow = resolvePaidAmountForDisplay({
            paymentType,
            paid_amount: paidAmountValue,
            amount_charged: amountChargedValue,
            servicePrice: servicePriceNum
        });

        const remainingAmount = remainingAmountValue != null
            ? Number(remainingAmountValue)
            : null;

        const paymentMethodLine = captureMethod ? `Forma de pagamento: ${captureMethod}` : '';

        let paymentIntro = 'O pagamento do sinal foi aprovado e um novo agendamento foi confirmado no sistema.';
        let paymentLines = `Valor do Sinal: ${formatCurrencyBRL(FIXED_SIGNAL_AMOUNT)}`;

        if (paymentType === 'partial') {
            paymentIntro = 'Pagamento parcial aprovado e agendamento confirmado no sistema.';
            paymentLines = [
                paidNow != null ? `Valor pago agora: ${formatCurrencyBRL(paidNow)}` : '',
                remainingAmount != null ? `Valor restante (para o dia do atendimento): ${formatCurrencyBRL(remainingAmount)}` : '',
                paymentMethodLine,
                'Observação: o valor restante será acertado presencialmente no dia do atendimento.'
            ].filter(Boolean).join('\n');
        } else if (paymentType === 'full') {
            paymentIntro = 'Pagamento total aprovado e agendamento confirmado no sistema.';
            paymentLines = [
                'Procedimento totalmente pago.',
                paidNow != null ? `Valor pago: ${formatCurrencyBRL(paidNow)}` : '',
                paymentMethodLine
            ].filter(Boolean).join('\n');
        }

        const emailData = {
            from: process.env.FROM_EMAIL || 'Ateliê da Pele <onboarding@resend.dev>',
            to: process.env.NOTIFICATION_EMAIL,
            subject: `Novo Agendamento Confirmado - ${clientName}`,
            text: `
NOVO AGENDAMENTO CONFIRMADO!

${paymentIntro}

DETALHES DO AGENDAMENTO:
------------------------------------------
Cliente: ${clientName}
Serviço: ${serviceName}
Data: ${appointmentDate}
Horário: ${appointmentTime}
Local do atendimento: Ateliê da Pele — Rua Rio Jaguaribe, nº 274${clientAddress}
Valor do Serviço: ${serviceValue}
${paymentLines}
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

/**
 * E-mail voltado à cliente após pagamento confirmado (tom acolhedor, distinto do aviso administrativo).
 */
async function sendClientConfirmationEmail(appointmentRow, serviceData, clientEmailTo) {
    const to = String(clientEmailTo || '').trim().toLowerCase();
    console.log(`[EmailService] Confirmação à cliente → ${to}`);

    if (!process.env.RESEND_API_KEY) {
        console.error('[EmailService] RESEND_API_KEY ausente; não enviando e-mail à cliente.');
        return;
    }

    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        console.error('[EmailService] E-mail da cliente inválido; abortando envio ao cliente.');
        return;
    }

    const resend = new Resend(process.env.RESEND_API_KEY);

    const clientName =
        appointmentRow.client_name ||
        appointmentRow.clientName ||
        'Cliente';

    const serviceName =
        serviceData?.name ||
        appointmentRow.service_name ||
        appointmentRow.service_id ||
        'Serviço';

    const appointmentDate = appointmentRow.date
        ? new Date(`${appointmentRow.date}T12:00:00`).toLocaleDateString('pt-BR')
        : '—';

    const appointmentTime = appointmentRow.time || '—';

    const servicePrice =
        typeof serviceData?.price === 'number'
            ? formatCurrencyBRL(serviceData.price)
            : null;

    const paymentType = String(appointmentRow.payment_type || '').toLowerCase();
    const paidNow = resolvePaidAmountForDisplay({
        paymentType,
        paid_amount: appointmentRow.paid_amount,
        amount_charged: appointmentRow.amount_charged,
        servicePrice: typeof serviceData?.price === 'number' ? serviceData.price : null
    });
    const remaining =
        appointmentRow.remaining_amount != null && appointmentRow.remaining_amount !== ''
            ? Number(appointmentRow.remaining_amount)
            : null;

    const captureMethod = appointmentRow.capture_method || null;

    let paymentSummaryLines = '';
    if (paymentType === 'full') {
        paymentSummaryLines = [
            'Forma de pagamento: valor integral do procedimento.',
            paidNow != null && Number.isFinite(paidNow) ? `Valor pago: ${formatCurrencyBRL(paidNow)}` : '',
            captureMethod ? `Registro do pagamento: ${captureMethod}` : ''
        ]
            .filter(Boolean)
            .join('\n');
    } else {
        paymentSummaryLines = [
            'Forma de pagamento: sinal (reserva) + saldo no dia do atendimento.',
            paidNow != null && Number.isFinite(paidNow) ? `Valor pago agora (sinal): ${formatCurrencyBRL(paidNow)}` : '',
            remaining != null && Number.isFinite(remaining) && remaining > 0
                ? `Saldo restante (no atendimento): ${formatCurrencyBRL(remaining)}`
                : '',
            captureMethod ? `Registro do pagamento: ${captureMethod}` : ''
        ]
            .filter(Boolean)
            .join('\n');
    }

    const locationLine = appointmentRow.location
        ? `\nLocal informado: ${appointmentRow.location}`
        : '';

    const subject = `${clientName.split(' ')[0]}, seu horário está confirmado — Ateliê da Pele`;

    const text = `
Olá, ${clientName.split(' ')[0]}!

Seu pagamento foi confirmado e seu horário no Ateliê da Pele está garantido.

Resumo do seu agendamento
-------------------------
Procedimento: ${serviceName}
${servicePrice ? `Valor do procedimento (tabela): ${servicePrice}` : ''}
Data: ${appointmentDate}
Horário: ${appointmentTime}
${locationLine}

Sobre o pagamento
-----------------
${paymentSummaryLines}

Qualquer dúvida, fale com a gente pelo WhatsApp do Ateliê.

Um abraço,
Equipe Ateliê da Pele
    `.trim();

    try {
        const { data, error } = await resend.emails.send({
            from: process.env.FROM_EMAIL || 'Ateliê da Pele <onboarding@resend.dev>',
            to,
            subject,
            text
        });

        if (error) {
            console.error('[EmailService] Falha Resend (cliente):', error.message || error);
            throw new Error(error.message || 'Falha no envio ao cliente');
        }

        console.log(`[EmailService] E-mail à cliente enviado. Resend ID: ${data?.id || 'N/A'}`);
        return data;
    } catch (error) {
        console.error('[EmailService] Falha geral e-mail cliente:', error.message || error);
        throw error;
    }
}

module.exports = {
    sendConfirmationEmail,
    sendClientConfirmationEmail
};