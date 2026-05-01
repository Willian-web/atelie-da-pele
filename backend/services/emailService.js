const { Resend } = require('resend');

const FIXED_SIGNAL_AMOUNT = 30;

/** Rodapé de contato opcional em todos os e-mails ao cliente (número oficial). */
const ATELIE_CLIENT_WHATSAPP_FOOTER =
    'Se tiver alguma dúvida, fale com o Ateliê pelo WhatsApp: (41) 8485-0169.';

function formatCurrencyBRL(value) {
    return Number(value || 0).toLocaleString('pt-BR', {
        style: 'currency',
        currency: 'BRL'
    });
}

function roundMoney2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
}

/** Aceita número, string numérica do pg, etc. */
function toMoneyNumberEmail(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function normalizePaymentKindForEmail(raw) {
    const t = String(raw ?? '').trim().toLowerCase();
    if (t === 'local') return 'local';
    if (t === 'full' || t === 'integral' || t === 'total') return 'full';
    return 'partial';
}

/** Mesma regra do app: procedimentos de valor muito baixo no catálogo eram tratados como integral na comunicação (legado). */
function treatPaymentAsIntegralForEmail(paymentTypeNorm, servicePriceNum) {
    if (paymentTypeNorm === 'full') return true;
    const sp = Number(servicePriceNum);
    return Number.isFinite(sp) && sp > 0 && sp <= FIXED_SIGNAL_AMOUNT;
}

/**
 * Valor exibido nos e-mails: em pagamento integral o checkout correto está em `amount_charged`;
 * Em integral, o gateway pode enviar `paid_amount` menor que o total — não priorizar isso sobre `amount_charged`.
 */
function resolvePaidAmountForDisplay({ paymentType, paid_amount, amount_charged, servicePrice }) {
    const paid = toMoneyNumberEmail(paid_amount);
    const charged = toMoneyNumberEmail(amount_charged);
    const pOk = paid != null && paid > 0;
    const cOk = charged != null && charged > 0;
    const svc =
        servicePrice != null && Number.isFinite(Number(servicePrice)) && Number(servicePrice) > 0
            ? Number(servicePrice)
            : null;

    if (normalizePaymentKindForEmail(paymentType) === 'local') {
        return null;
    }
    if (normalizePaymentKindForEmail(paymentType) === 'full') {
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
    const maskAddr = (addr, fallback) => {
        const s = String(addr || '').trim();
        if (!s) return fallback;
        if (!s.includes('@')) return s;
        return s.replace(/^(.{1,2})[^@]*(@.*)$/, '$1***$2');
    };
    const destLog = maskAddr(process.env.NOTIFICATION_EMAIL, 'NÃO DEFINIDO');
    const fromLog = maskAddr(process.env.FROM_EMAIL, 'onboarding@resend.dev');
    console.log(`[EmailService] Variáveis - Destino: ${destLog}, Remetente: ${fromLog}`);

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

        const paymentType = normalizePaymentKindForEmail(appointmentData.payment_type);
        const captureMethod = appointmentData.capture_method || null;
        const statusNorm = String(appointmentData.status || '').trim().toLowerCase();

        const paidAmountValue = appointmentData.paid_amount ?? null;
        const amountChargedValue = appointmentData.amount_charged ?? null;
        const remainingAmountValue = appointmentData.remaining_amount ?? null;

        const servicePriceNum =
            typeof serviceData?.price === 'number' && Number.isFinite(serviceData.price) ? serviceData.price : null;

        const paymentMethodLine = captureMethod ? `Forma de pagamento: ${captureMethod}` : '';

        let paymentIntro = 'Pagamento aprovado e agendamento confirmado no sistema.';
        let paymentLines = '';
        let subject = `Novo Agendamento Confirmado - ${clientName}`;

        if (paymentType === 'local') {
            const rem = toMoneyNumberEmail(remainingAmountValue);
            const remTxt =
                rem != null && Number.isFinite(rem) && rem >= 0 ? formatCurrencyBRL(rem) : serviceValue;
            paymentIntro =
                'Agendamento confirmado com pagamento no local. Nada foi cobrado online; o valor será acertado presencialmente no dia do atendimento.';
            paymentLines = [
                'Forma de pagamento: pagamento no local (presencialmente no dia).',
                servicePriceNum != null ? `Valor total dos procedimentos: ${formatCurrencyBRL(servicePriceNum)}` : `Valor total dos procedimentos: ${serviceValue}`,
                `Saldo previsto a receber no atendimento: ${remTxt}`,
                paymentMethodLine
            ]
                .filter(Boolean)
                .join('\n');
            subject = `Novo agendamento (pagamento no local) - ${clientName}`;
        } else if (statusNorm === 'pending_payment' && paymentType === 'full') {
            const link = appointmentData.payment_url ? String(appointmentData.payment_url).trim() : '';
            paymentIntro =
                'Um novo agendamento foi criado e aguarda pagamento online (InfinitePay) pelo valor total dos procedimentos.';
            paymentLines = [
                servicePriceNum != null ? `Valor total a pagar online: ${formatCurrencyBRL(servicePriceNum)}` : `Valor total a pagar online: ${serviceValue}`,
                link ? `Link InfinitePay: ${link}` : 'Link de pagamento: (indisponível — verifique no sistema)',
                'Prazo: em geral o horário é liberado após 15 minutos sem confirmação de pagamento.'
            ].join('\n');
            subject = `Agendamento aguardando pagamento online - ${clientName}`;
        }

        const treatAsIntegral = paymentType !== 'local' ? treatPaymentAsIntegralForEmail(paymentType, servicePriceNum) : false;

        const paidNow = paymentType === 'local'
            ? null
            : resolvePaidAmountForDisplay({
                paymentType: treatAsIntegral ? 'full' : paymentType,
                paid_amount: paidAmountValue,
                amount_charged: amountChargedValue,
                servicePrice: servicePriceNum
            });

        let remainingAmount = toMoneyNumberEmail(remainingAmountValue);
        if (
            paymentType === 'partial' &&
            !treatAsIntegral &&
            (remainingAmount == null || !Number.isFinite(remainingAmount)) &&
            servicePriceNum != null
        ) {
            const basePaid = paidNow != null && Number.isFinite(paidNow) && paidNow > 0 ? paidNow : FIXED_SIGNAL_AMOUNT;
            remainingAmount = Math.max(0, roundMoney2(servicePriceNum - basePaid));
        }

        if (paymentType !== 'local' && !(statusNorm === 'pending_payment' && paymentType === 'full')) {
            if (treatAsIntegral) {
                paymentIntro = 'Pagamento integral aprovado e agendamento confirmado no sistema.';
                paymentLines = [
                    'Procedimento quitado integralmente nesta etapa.',
                    paidNow != null ? `Valor pago: ${formatCurrencyBRL(paidNow)}` : '',
                    paymentMethodLine
                ]
                    .filter(Boolean)
                    .join('\n');
            } else if (paymentType === 'partial') {
                paymentIntro = 'Pagamento com valor parcial (histórico no sistema) aprovado e agendamento confirmado.';
                const paidLine =
                    paidNow != null && Number.isFinite(paidNow) && paidNow > 0 ? formatCurrencyBRL(paidNow) : null;
                paymentLines = [
                    paidLine ? `Valor registrado na reserva: ${paidLine}` : 'Valor registrado na reserva: (consulte o registro no sistema)',
                    remainingAmount != null && Number.isFinite(remainingAmount) && remainingAmount >= 0
                        ? `Valor restante (para o dia do atendimento): ${formatCurrencyBRL(remainingAmount)}`
                        : '',
                    paymentMethodLine,
                    'Observação: o valor restante será acertado presencialmente no dia do atendimento.'
                ].filter(Boolean).join('\n');
            }
        }

        const statusLine =
            statusNorm === 'pending_payment' && paymentType === 'full'
                ? 'Aguardando pagamento online'
                : paymentType === 'local'
                    ? 'Confirmado — pagamento no local'
                    : appointmentData.status || 'Confirmado';

        const emailData = {
            from: process.env.FROM_EMAIL || 'Ateliê da Pele <onboarding@resend.dev>',
            to: process.env.NOTIFICATION_EMAIL,
            subject,
            text: `
NOVO AGENDAMENTO — ATELIÊ DA PELE

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
Status: ${statusLine}

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

    const paymentKind = normalizePaymentKindForEmail(appointmentRow.payment_type);
    const statusNorm = String(appointmentRow.status || '').trim().toLowerCase();
    const servicePriceNum =
        typeof serviceData?.price === 'number' && Number.isFinite(serviceData.price) ? serviceData.price : null;

    const captureMethod = appointmentRow.capture_method || null;
    const paymentUrl = appointmentRow.payment_url ? String(appointmentRow.payment_url).trim() : '';

    let paymentSummaryLines = '';
    let subject = `${clientName.split(' ')[0]}, seu horário está confirmado — Ateliê da Pele`;
    let opening = 'Seu pagamento foi confirmado e seu horário no Ateliê da Pele está garantido.';

    if (paymentKind === 'local') {
        opening =
            'Seu agendamento está confirmado. O pagamento será realizado presencialmente no dia do atendimento.';
        const rem = toMoneyNumberEmail(appointmentRow.remaining_amount);
        const remTxt =
            rem != null && Number.isFinite(rem) && rem >= 0 ? formatCurrencyBRL(rem) : servicePrice || '';
        paymentSummaryLines = [
            'Forma de pagamento: pagamento no local.',
            servicePriceNum != null ? `Valor total dos procedimentos: ${formatCurrencyBRL(servicePriceNum)}` : '',
            remTxt ? `Valor a acertar no atendimento: ${remTxt}` : '',
            captureMethod ? `Registro: ${captureMethod}` : ''
        ]
            .filter(Boolean)
            .join('\n');
        subject = `${clientName.split(' ')[0]}, agendamento confirmado (pagamento no local) — Ateliê da Pele`;
    } else if (statusNorm === 'pending_payment' && paymentKind === 'full') {
        opening =
            'Recebemos seu pedido de agendamento. Para garantir o horário, finalize o pagamento online pelo valor total dos procedimentos (InfinitePay).';
        paymentSummaryLines = [
            'Forma de pagamento: pagamento online — valor total dos procedimentos.',
            servicePriceNum != null ? `Valor total a pagar: ${formatCurrencyBRL(servicePriceNum)}` : '',
            paymentUrl ? `Link para pagamento: ${paymentUrl}` : '',
            'Em geral, o sistema libera o horário reservado após cerca de 15 minutos sem a confirmação do pagamento.',
            'Quando o pagamento for confirmado, enviaremos outro e-mail confirmando seu horário.'
        ].join('\n');
        subject = `${clientName.split(' ')[0]}, finalize o pagamento do seu agendamento — Ateliê da Pele`;
    } else {
        const treatAsIntegralClient = treatPaymentAsIntegralForEmail(paymentKind, servicePriceNum);

        const paidNow = resolvePaidAmountForDisplay({
            paymentType: treatAsIntegralClient ? 'full' : paymentKind,
            paid_amount: appointmentRow.paid_amount,
            amount_charged: appointmentRow.amount_charged,
            servicePrice: servicePriceNum
        });

        let remaining = toMoneyNumberEmail(appointmentRow.remaining_amount);
        if (
            paymentKind === 'partial' &&
            !treatAsIntegralClient &&
            (remaining == null || !Number.isFinite(remaining)) &&
            servicePriceNum != null
        ) {
            const basePaid =
                paidNow != null && Number.isFinite(paidNow) && paidNow > 0 ? paidNow : FIXED_SIGNAL_AMOUNT;
            remaining = Math.max(0, roundMoney2(servicePriceNum - basePaid));
        }

        if (treatAsIntegralClient || paymentKind === 'full') {
            paymentSummaryLines = [
                'Forma de pagamento: valor integral do procedimento (quitado nesta etapa).',
                paidNow != null && Number.isFinite(paidNow) && paidNow > 0 ? `Valor pago: ${formatCurrencyBRL(paidNow)}` : '',
                captureMethod ? `Registro do pagamento: ${captureMethod}` : ''
            ]
                .filter(Boolean)
                .join('\n');
        } else {
            const paidDisplay =
                paidNow != null && Number.isFinite(paidNow) && paidNow > 0 ? formatCurrencyBRL(paidNow) : null;
            paymentSummaryLines = [
                'Forma de pagamento (histórico): reserva com valor parcial + saldo no dia do atendimento.',
                paidDisplay ? `Valor pago nesta etapa: ${paidDisplay}` : 'Valor pago nesta etapa: (veja o registro no sistema ou entre em contato)',
                remaining != null && Number.isFinite(remaining) && remaining > 0
                    ? `Saldo restante (no atendimento): ${formatCurrencyBRL(remaining)}`
                    : '',
                captureMethod ? `Registro do pagamento: ${captureMethod}` : '',
                'Observação: o saldo restante será acertado presencialmente no dia do atendimento.'
            ]
                .filter(Boolean)
                .join('\n');
        }
    }

    const locationLine = appointmentRow.location
        ? `\nLocal informado: ${appointmentRow.location}`
        : '';

    const text = `
Olá, ${clientName.split(' ')[0]}!

${opening}

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

${ATELIE_CLIENT_WHATSAPP_FOOTER}

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