const { Resend } = require('resend');

const FIXED_SIGNAL_AMOUNT = 30;

/** Endereço físico do ateliê (texto único nos e-mails). */
const ATELIE_SALON_LOCATION_LINE = 'Ateliê da Pele — Rua Rio Jaguaribe, nº 274';

/** Rodapé padrão em todos os e-mails (identidade e aviso automático). */
const ATELIE_EMAIL_STANDARD_FOOTER = `Ateliê da Pele
WhatsApp: (41) 8485-0169

Este é um e-mail automático.`;

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

/**
 * Corpo de e-mail em texto plano no padrão único Ateliê da Pele.
 * @param {'confirmation'|'cancellation'|'payment'|'pending'} type — categorização lógica (rodapé e hierarquia iguais para todos)
 * @param {'client'|'admin'} audience
 * @param {object} data
 * @param {string} [data.greeting] — ex.: "Olá, Maria!" (só cliente)
 * @param {string} data.title
 * @param {string} data.subtitle
 * @param {string} data.clientName
 * @param {string} data.serviceName
 * @param {string} data.dateStr
 * @param {string} data.timeStr
 * @param {string[]} data.paymentBulletLines — linhas já redigidas (sem prefixo "- ")
 * @param {string} [data.complement] — mensagem por cenário
 * @param {string} [data.clientInformedAddress] — endereço informado pela cliente (domicílio / observação)
 */
function buildEmailTemplate(type, audience, data) {
    /* type / audience reservados para extensões (ex.: tema HTML); o corpo em texto é o mesmo padrão. */
    void type;
    void audience;

    const {
        greeting,
        title,
        subtitle,
        clientName,
        serviceName,
        dateStr,
        timeStr,
        paymentBulletLines,
        complement,
        clientInformedAddress
    } = data;

    const parts = [];
    if (greeting && String(greeting).trim()) {
        parts.push(String(greeting).trim());
        parts.push('');
    }
    parts.push(title);
    parts.push(subtitle);
    parts.push('');
    parts.push('Cliente:');
    parts.push(`- Nome: ${clientName}`);
    parts.push('');
    parts.push('Agendamento:');
    parts.push(`- Serviço: ${serviceName}`);
    parts.push(`- Data: ${dateStr}`);
    parts.push(`- Horário: ${timeStr}`);
    parts.push('');
    parts.push('Pagamento:');
    const payLines = Array.isArray(paymentBulletLines) ? paymentBulletLines.filter((s) => String(s || '').trim()) : [];
    if (payLines.length === 0) {
        parts.push('- (ver detalhes no sistema)');
    } else {
        for (const line of payLines) {
            parts.push(`- ${line}`);
        }
    }
    parts.push('');
    parts.push('Local:');
    parts.push(`- ${ATELIE_SALON_LOCATION_LINE}`);
    if (clientInformedAddress && String(clientInformedAddress).trim()) {
        parts.push(`- Endereço informado: ${String(clientInformedAddress).trim()}`);
    }
    if (complement && String(complement).trim()) {
        parts.push('');
        parts.push(String(complement).trim());
    }
    parts.push('');
    parts.push(ATELIE_EMAIL_STANDARD_FOOTER);

    return parts.join('\n');
}

function escapeHtml(text) {
    if (text == null) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Monta linhas de detalhe para o card HTML (cliente/admin — confirmação e cancelamento com mesmo bloco).
 * Se `stripPaymentLinkLine` e `ctaHref` forem verdadeiros, remove a linha bruta do link (evita duplicar com o botão).
 */
function buildStandardBookingDetailRows({
    clientName,
    serviceName,
    dateStr,
    timeStr,
    paymentBulletLines,
    clientInformedAddress,
    stripPaymentLinkLine,
    ctaHref
}) {
    const rows = [
        { label: 'Cliente', value: clientName },
        { label: 'Serviço(s)', value: serviceName },
        { label: 'Data', value: dateStr },
        { label: 'Horário', value: timeStr }
    ];
    const payLines = Array.isArray(paymentBulletLines) ? paymentBulletLines.filter((s) => String(s || '').trim()) : [];
    for (const line of payLines) {
        const t = String(line).trim();
        if (stripPaymentLinkLine && ctaHref && /^link\s+para\s+pagamento\s*:/i.test(t)) continue;
        const idx = t.indexOf(':');
        if (idx === -1) {
            rows.push({ label: 'Pagamento', value: t });
        } else {
            rows.push({ label: t.slice(0, idx).trim(), value: t.slice(idx + 1).trim() });
        }
    }
    rows.push({ label: 'Local do atendimento', value: ATELIE_SALON_LOCATION_LINE });
    if (clientInformedAddress && String(clientInformedAddress).trim()) {
        rows.push({ label: 'Endereço informado', value: String(clientInformedAddress).trim() });
    }
    return rows;
}

/** Largura máxima do card central (px) — entre 600 e 680, padrão único para todos os e-mails. */
const ATELIE_EMAIL_LAYOUT_MAX_PX = 640;

/** Fundo externo neutro (canvas Gmail — evita faixa lilás ampla). */
const ATELIE_EMAIL_OUTER_BG = '#f5f6fa';

/**
 * Estilos globais: mobile, dark mode (fallback seguro com cores explícitas nos inlines).
 */
function getEmailGlobalStyles() {
    return `<style type="text/css">
@media only screen and (max-width: 600px) {
  .atelie-shell { width: 100% !important; max-width: 100% !important; }
  .atelie-outer-pad { padding: 14px 10px !important; }
  .atelie-header { padding: 22px 18px 18px !important; }
  .atelie-main { padding: 22px 18px 10px !important; }
  .atelie-content { padding: 0 18px 24px !important; }
  .atelie-footer { padding: 18px 18px 24px !important; }
  .atelie-card-inner { padding: 16px 14px !important; }
  .atelie-email-label { display: block !important; width: 100% !important; max-width: 100% !important; padding: 0 0 6px 0 !important; }
  .atelie-email-value { display: block !important; width: 100% !important; max-width: 100% !important; padding: 0 0 14px 0 !important; }
  .atelie-btn-pay { display: block !important; width: 100% !important; max-width: 100% !important; box-sizing: border-box !important; text-align: center !important; }
}
@media (prefers-color-scheme: dark) {
  body.atelie-body { background-color: #121218 !important; color: #e8e4f2 !important; }
  .atelie-outer-wrap { background-color: #121218 !important; }
  .atelie-shell { background-color: #1c1c24 !important; border-color: #353542 !important; box-shadow: 0 4px 24px rgba(0,0,0,0.4) !important; }
  .atelie-header { background: linear-gradient(135deg, #2a2435 0%, #322a42 100%) !important; border-bottom-color: #403a52 !important; }
  .atelie-hbrand { color: #f0e8fc !important; }
  .atelie-subbrand { color: #a89bc4 !important; }
  .atelie-main .atelie-greet { color: #b4aac8 !important; }
  .atelie-main h1 { color: #ebe4f8 !important; }
  .atelie-main .atelie-lead { color: #a8a0bc !important; }
  .atelie-card { background-color: #22222c !important; border-color: #353542 !important; }
  .atelie-label { color: #8a82a0 !important; border-bottom-color: #353542 !important; }
  .atelie-value { color: #f2f0f8 !important; border-bottom-color: #353542 !important; }
  .atelie-note { color: #a8a0bc !important; }
  .atelie-footer { background-color: #18181f !important; border-top-color: #353542 !important; }
  .atelie-footer p { color: #a8a0bc !important; }
  .atelie-footer .atelie-foot-muted { color: #7a7490 !important; }
  .atelie-btn-pay { background-color: #7d55c4 !important; border-color: #6340a0 !important; box-shadow: 0 2px 12px rgba(0,0,0,0.35) !important; }
}
</style>`;
}

/** Cabeçalho da marca (lilás só no topo do card, compacto). */
function buildPremiumHeaderHtml() {
    return `<tr>
<td class="atelie-header" style="padding:26px 28px 22px;text-align:center;background:linear-gradient(180deg,#f7f2fc 0%,#f0e8f8 100%);border-bottom:1px solid #e8dff0;">
<div class="atelie-hbrand" style="font-size:22px;line-height:1.25;color:#3d2d55;font-weight:700;letter-spacing:-0.02em;font-family:Georgia,'Times New Roman',serif;">Ateliê da Pele</div>
<div class="atelie-subbrand" style="font-size:12px;color:#6f5d88;margin-top:6px;font-weight:600;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;">Estética &amp; Bem-estar</div>
</td></tr>`;
}

/** Rodapé institucional (centralizado, discreto). */
function buildEmailFooterHtml() {
    return `<tr>
<td class="atelie-footer" style="padding:22px 28px 28px;border-top:1px solid #eceef2;background:#fafbfc;text-align:center;">
<p style="margin:0;font-size:13px;line-height:1.6;color:#5a5668;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;"><strong>Ateliê da Pele</strong><br/>WhatsApp: (41) 8485-0169</p>
<p class="atelie-foot-muted" style="margin:12px 0 0;font-size:11px;line-height:1.5;color:#8b8898;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;">Este é um e-mail automático.</p>
</td></tr>`;
}

/** Linhas internas do card de detalhes (labels discretas, valores em destaque). */
function buildDetailsCardRowsHtml(details) {
    return (Array.isArray(details) ? details : [])
        .map((row) => {
            const lb = escapeHtml(row.label || '');
            const vl = escapeHtml(row.value || '').replace(/\n/g, '<br/>');
            return `
<tr>
<td class="atelie-label atelie-email-label" width="26%" style="padding:12px 12px 12px 0;border-bottom:1px solid #eceef2;font-size:11px;color:#6b6a78;width:26%;max-width:180px;vertical-align:top;word-wrap:break-word;overflow-wrap:break-word;line-height:1.45;font-weight:600;text-transform:none;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;">${lb}</td>
<td class="atelie-value atelie-email-value" width="74%" style="padding:12px 0 12px 12px;border-bottom:1px solid #eceef2;font-size:15px;color:#1f2937;font-weight:600;vertical-align:top;word-wrap:break-word;overflow-wrap:break-word;line-height:1.55;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;">${vl}</td>
</tr>`;
        })
        .join('');
}

/** Card de detalhes (fundo neutro claro, borda suave). */
function buildDetailsCardHtml(detailRowsHtml) {
    return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" class="atelie-card" style="background:#f9fafb;border-radius:12px;border:1px solid #eceef2;">
<tr><td class="atelie-card-inner" style="padding:20px 22px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0">${detailRowsHtml}</table>
</td></tr></table>`;
}

/** Botão de ação (InfinitePay / CTA) — centralizado no fluxo do conteúdo. */
function buildActionButtonHtml(href, label) {
    const h = escapeHtml(href);
    const lab = escapeHtml(label);
    return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:22px 0 0;"><tr><td align="center" style="padding:0;">
<a href="${h}" class="atelie-btn-pay" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:#6f45b6;color:#ffffff;padding:14px 28px;border-radius:12px;text-decoration:none;font-weight:700;font-size:15px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;letter-spacing:0.02em;border:1px solid #5c3a9e;box-shadow:0 3px 12px rgba(111,69,182,0.28);">${lab}</a>
</td></tr></table>`;
}

/**
 * Documento HTML: fundo externo neutro, card branco centralizado (padrão SaaS).
 */
function buildEmailLayoutHtml(titleEscaped, shellInnerRowsHtml) {
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<meta name="color-scheme" content="light dark"/>
<meta name="supported-color-schemes" content="light dark"/>
<title>${titleEscaped}</title>
${getEmailGlobalStyles()}
</head>
<body class="atelie-body" style="margin:0;padding:0;background:${ATELIE_EMAIL_OUTER_BG};color:#2f243f;-webkit-text-size-adjust:100%;">
<table role="presentation" class="atelie-outer-wrap" width="100%" cellspacing="0" cellpadding="0" style="background:${ATELIE_EMAIL_OUTER_BG};">
<tr>
<td class="atelie-outer-pad" align="center" style="padding:28px 16px;font-family:Georgia,'Times New Roman',serif;">
<table role="presentation" class="atelie-shell" width="100%" cellspacing="0" cellpadding="0" align="center" style="width:100%;max-width:${ATELIE_EMAIL_LAYOUT_MAX_PX}px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e2e5eb;box-shadow:0 2px 12px rgba(15,23,42,0.06);">
${shellInnerRowsHtml}
</table>
</td>
</tr>
</table>
</body>
</html>`;
}

/**
 * Layout HTML único (inline + classes para dark/mobile) — cartão central, fundo neutro.
 * @param {object} opts
 * @param {string} [opts.greeting]
 * @param {string} opts.title
 * @param {string} opts.subtitle
 * @param {{ label: string, value: string }[]} opts.details
 * @param {string} [opts.noteAfterCard] — parágrafo opcional abaixo do card
 * @param {{ href: string, label: string } | null} [opts.actionButton]
 */
function buildEmailHtmlTemplate(opts) {
    const greeting = opts.greeting && String(opts.greeting).trim() ? escapeHtml(String(opts.greeting).trim()) : '';
    const title = escapeHtml(opts.title || '');
    const subtitle = escapeHtml(opts.subtitle || '');
    const note = opts.noteAfterCard && String(opts.noteAfterCard).trim()
        ? `<p class="atelie-note" style="margin:20px 0 0;font-size:14px;line-height:1.6;color:#4b5563;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(String(opts.noteAfterCard).trim()).replace(/\n/g, '<br/>')}</p>`
        : '';

    const detailRowsHtml = buildDetailsCardRowsHtml(opts.details);

    const detailsCard = buildDetailsCardHtml(detailRowsHtml);

    const btn =
        opts.actionButton && opts.actionButton.href && opts.actionButton.label
            ? buildActionButtonHtml(opts.actionButton.href, opts.actionButton.label)
            : '';

    const mainBlock = `<tr>
<td class="atelie-main" style="padding:28px 28px 12px;text-align:left;background:#ffffff;">
${greeting ? `<p class="atelie-greet" style="margin:0 0 16px;font-size:15px;color:#4b5563;line-height:1.55;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;">${greeting}</p>` : ''}
<h1 style="margin:0 0 10px;font-size:22px;line-height:1.3;color:#1f1630;font-weight:700;font-family:Georgia,'Times New Roman',serif;">${title}</h1>
<p class="atelie-lead" style="margin:0;font-size:15px;line-height:1.6;color:#5b6472;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;">${subtitle}</p>
</td></tr>
<tr>
<td class="atelie-content" style="padding:0 28px 32px;text-align:left;background:#ffffff;">
${detailsCard}
${btn}
${note}
</td></tr>`;

    const shellInner = `${buildPremiumHeaderHtml()}${mainBlock}${buildEmailFooterHtml()}`;

    return buildEmailLayoutHtml(title, shellInner);
}

/** HTML da cópia administrativa de cancelamento (estrutura alinhada ao texto já enviado). */
function buildAdminCancelEmailHtml({
    clientName,
    serviceName,
    appointmentDate,
    appointmentTime,
    paymentLine,
    cancelledByLabel,
    cancelReason
}) {
    const details = [
        { label: 'Cliente', value: clientName },
        { label: 'Serviço(s)', value: serviceName },
        { label: 'Data e horário', value: `${appointmentDate} às ${appointmentTime}` },
        { label: 'Forma de pagamento', value: paymentLine },
        { label: 'Cancelado por', value: cancelledByLabel },
        { label: 'Status', value: 'Cancelado' }
    ];
    if (cancelReason) {
        details.push({ label: 'Motivo registrado', value: cancelReason });
    }
    return buildEmailHtmlTemplate({
        title: 'Agendamento cancelado',
        subtitle: 'Um agendamento foi cancelado.',
        details,
        noteAfterCard: '',
        actionButton: null
    });
}

/** Linha única de “forma de pagamento” para o e-mail de cancelamento (somente leitura do registro). */
function describePaymentForCancelEmail(appointmentRow) {
    const kind = normalizePaymentKindForEmail(appointmentRow.payment_type);
    const cap = String(appointmentRow.capture_method || '').trim().toLowerCase();
    const paid = toMoneyNumberEmail(appointmentRow.paid_amount);
    const charged = toMoneyNumberEmail(appointmentRow.amount_charged);
    const paidOk = paid != null && paid > 0.005;
    const chargedOk = charged != null && charged > 0.005;
    const hadCheckoutLink =
        appointmentRow.payment_url != null && String(appointmentRow.payment_url).trim().toLowerCase().startsWith('http');
    const gateway = cap && cap !== 'manual' && cap !== 'manual_balance' && cap !== 'presencial';

    if (kind === 'local') {
        return 'Pagamento no local (valor a acertar presencialmente no atendimento).';
    }
    if (kind === 'full') {
        if (gateway) {
            return 'Pagamento online (InfinitePay) — valor integral.';
        }
        if (hadCheckoutLink && !paidOk && !chargedOk) {
            return 'Pagamento online (InfinitePay) — valor integral; pagamento ainda não confirmado no momento do cancelamento.';
        }
        if (paidOk || chargedOk) {
            return 'Pagamento integral registrado no sistema (online ou confirmação manual).';
        }
        return 'Pagamento integral (registro no sistema).';
    }
    return 'Pagamento parcial (histórico) — com saldo previsto para o dia do atendimento.';
}

/** Contexto de quem registrou o cancelamento (usa `cancelled_by` já gravado no registro). */
function noteWhoCancelledAppointment(appointmentRow) {
    const by = String(appointmentRow.cancelled_by || appointmentRow.cancelledBy || '').trim().toLowerCase();
    if (by === 'admin') {
        return 'Este agendamento foi cancelado pela equipe do Ateliê da Pele.';
    }
    if (by === 'client') {
        return 'Este cancelamento foi registrado por você na área Meus agendamentos.';
    }
    if (by === 'system') {
        return 'Este agendamento foi cancelado automaticamente pelo sistema (ex.: prazo de pagamento online).';
    }
    return '';
}

/** Rótulo curto para cópia administrativa (e-mail interno). */
function labelCancelledByForAdminEmail(appointmentRow) {
    const by = String(appointmentRow.cancelled_by || appointmentRow.cancelledBy || '').trim().toLowerCase();
    if (by === 'admin') return 'Admin';
    if (by === 'client') return 'Cliente';
    if (by === 'system') return 'Sistema';
    if (by) return by.charAt(0).toUpperCase() + by.slice(1);
    return 'Não informado';
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

        const clientInformedAddress = appointmentData.location ? String(appointmentData.location).trim() : '';

        const paymentType = normalizePaymentKindForEmail(appointmentData.payment_type);
        const captureMethod = appointmentData.capture_method || null;
        const statusNorm = String(appointmentData.status || '').trim().toLowerCase();

        const paidAmountValue = appointmentData.paid_amount ?? null;
        const amountChargedValue = appointmentData.amount_charged ?? null;
        const remainingAmountValue = appointmentData.remaining_amount ?? null;

        const servicePriceNum =
            typeof serviceData?.price === 'number' && Number.isFinite(serviceData.price) ? serviceData.price : null;

        const valorTotalStr =
            servicePriceNum != null ? formatCurrencyBRL(servicePriceNum) : serviceValue;

        const captureNote = captureMethod ? `Registro: ${captureMethod}` : '';

        let subject = `Novo Agendamento Confirmado - ${clientName}`;
        let title = 'Agendamento confirmado';
        let subtitle = 'Um novo agendamento foi registrado no sistema.';
        let paymentBulletLines = [];
        let complement = '';

        if (paymentType === 'local') {
            const rem = toMoneyNumberEmail(remainingAmountValue);
            const remTxt =
                rem != null && Number.isFinite(rem) && rem >= 0 ? formatCurrencyBRL(rem) : valorTotalStr;
            subject = `Novo agendamento (pagamento no local) - ${clientName}`;
            title = 'Agendamento confirmado';
            subtitle = 'Um novo agendamento foi registrado com pagamento no local.';
            paymentBulletLines = [
                'Forma de pagamento: Pagamento no local',
                `Valor total: ${valorTotalStr}`,
                `Saldo previsto no atendimento: ${remTxt}`,
                captureNote
            ].filter(Boolean);
            complement =
                'O valor será acertado presencialmente no dia do atendimento. Nada foi cobrado online.';
        } else if (statusNorm === 'pending_payment' && paymentType === 'full') {
            const link = appointmentData.payment_url ? String(appointmentData.payment_url).trim() : '';
            subject = `Agendamento aguardando pagamento online - ${clientName}`;
            title = 'Aguardando pagamento';
            subtitle = 'Um novo agendamento aguarda confirmação de pagamento online.';
            paymentBulletLines = [
                'Forma de pagamento: Pagamento online',
                `Valor total: ${valorTotalStr}`,
                link ? `Link para pagamento: ${link}` : 'Link para pagamento: (indisponível — verifique no sistema)',
                'Prazo: em geral o horário é liberado após cerca de 15 minutos sem confirmação de pagamento.'
            ];
            complement =
                'Para confirmar o agendamento, a cliente deve finalizar o pagamento pelo link enviado.';
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
                subject = `Novo Agendamento Confirmado - ${clientName}`;
                title = 'Pagamento confirmado';
                subtitle = 'Pagamento online confirmado e agendamento registrado no sistema.';
                paymentBulletLines = [
                    'Forma de pagamento: Pagamento online',
                    `Valor total: ${valorTotalStr}`,
                    paidNow != null ? `Valor recebido nesta operação: ${formatCurrencyBRL(paidNow)}` : '',
                    captureNote
                ].filter(Boolean);
                complement = 'Procedimento quitado integralmente nesta etapa.';
            } else if (paymentType === 'partial') {
                subject = `Novo Agendamento Confirmado - ${clientName}`;
                title = 'Agendamento confirmado';
                subtitle = 'Novo agendamento com histórico de pagamento parcial no sistema.';
                const paidLine =
                    paidNow != null && Number.isFinite(paidNow) && paidNow > 0 ? formatCurrencyBRL(paidNow) : null;
                paymentBulletLines = [
                    'Forma de pagamento: Parcial (histórico)',
                    `Valor total: ${valorTotalStr}`,
                    paidLine ? `Valor já registrado: ${paidLine}` : 'Valor já registrado: (consulte o registro no sistema)',
                    remainingAmount != null && Number.isFinite(remainingAmount) && remainingAmount >= 0
                        ? `Saldo no dia do atendimento: ${formatCurrencyBRL(remainingAmount)}`
                        : '',
                    captureNote,
                    'O saldo restante será acertado presencialmente no dia do atendimento.'
                ].filter(Boolean);
                complement = '';
            }
        }

        const text = buildEmailTemplate('confirmation', 'admin', {
            title,
            subtitle,
            clientName,
            serviceName,
            dateStr: appointmentDate,
            timeStr: appointmentTime,
            paymentBulletLines,
            complement,
            clientInformedAddress
        });

        const pendingLink =
            statusNorm === 'pending_payment' && paymentType === 'full' && appointmentData.payment_url
                ? String(appointmentData.payment_url).trim()
                : '';
        const html = buildEmailHtmlTemplate({
            title,
            subtitle,
            details: buildStandardBookingDetailRows({
                clientName,
                serviceName,
                dateStr: appointmentDate,
                timeStr: appointmentTime,
                paymentBulletLines,
                clientInformedAddress,
                stripPaymentLinkLine: Boolean(pendingLink),
                ctaHref: pendingLink
            }),
            noteAfterCard: complement,
            actionButton:
                pendingLink && /^https?:\/\//i.test(pendingLink)
                    ? { href: pendingLink, label: 'Pagar agora' }
                    : null
        });

        const emailData = {
            from: process.env.FROM_EMAIL || 'Ateliê da Pele <onboarding@resend.dev>',
            to: process.env.NOTIFICATION_EMAIL,
            subject,
            text,
            html
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

    const firstName = (String(clientName).trim().split(/\s+/)[0] || 'Cliente').trim();

    const serviceName =
        serviceData?.name ||
        appointmentRow.service_name ||
        appointmentRow.service_id ||
        'Serviço';

    const appointmentDate = appointmentRow.date
        ? new Date(`${appointmentRow.date}T12:00:00`).toLocaleDateString('pt-BR')
        : '—';

    const appointmentTime = appointmentRow.time || '—';

    const paymentKind = normalizePaymentKindForEmail(appointmentRow.payment_type);
    const statusNorm = String(appointmentRow.status || '').trim().toLowerCase();
    const servicePriceNum =
        typeof serviceData?.price === 'number' && Number.isFinite(serviceData.price) ? serviceData.price : null;

    const valorTotalStr =
        servicePriceNum != null ? formatCurrencyBRL(servicePriceNum) : null;

    const captureMethod = appointmentRow.capture_method || null;
    const paymentUrl = appointmentRow.payment_url ? String(appointmentRow.payment_url).trim() : '';

    const captureNote = captureMethod ? `Registro: ${captureMethod}` : '';

    let subject = `${firstName}, seu horário está confirmado — Ateliê da Pele`;
    let title = 'Agendamento confirmado';
    let subtitle = 'Seu agendamento foi confirmado com sucesso.';
    let paymentBulletLines = [];
    let complement = 'Seu pagamento foi confirmado.';
    let templateType = 'payment';

    if (paymentKind === 'local') {
        subject = `${firstName}, agendamento confirmado (pagamento no local) — Ateliê da Pele`;
        title = 'Agendamento confirmado';
        subtitle = 'Seu agendamento foi confirmado com sucesso.';
        const rem = toMoneyNumberEmail(appointmentRow.remaining_amount);
        const remTxt =
            rem != null && Number.isFinite(rem) && rem >= 0
                ? formatCurrencyBRL(rem)
                : valorTotalStr || '';
        paymentBulletLines = [
            'Forma de pagamento: Pagamento no local',
            valorTotalStr ? `Valor total: ${valorTotalStr}` : '',
            remTxt ? `Saldo a acertar no atendimento: ${remTxt}` : '',
            captureNote
        ].filter(Boolean);
        complement = 'O valor será pago presencialmente no dia do atendimento.';
        templateType = 'confirmation';
    } else if (statusNorm === 'pending_payment' && paymentKind === 'full') {
        subject = `${firstName}, finalize o pagamento do seu agendamento — Ateliê da Pele`;
        title = 'Aguardando pagamento';
        subtitle = 'Seu agendamento aguarda confirmação de pagamento.';
        paymentBulletLines = [
            'Forma de pagamento: Pagamento online',
            valorTotalStr ? `Valor total: ${valorTotalStr}` : '',
            paymentUrl ? `Link para pagamento: ${paymentUrl}` : '',
            'Em geral, o sistema libera o horário reservado após cerca de 15 minutos sem a confirmação do pagamento.',
            'Quando o pagamento for confirmado, enviaremos outro e-mail confirmando seu horário.'
        ].filter(Boolean);
        complement = 'Para confirmar seu agendamento, finalize o pagamento pelo link enviado.';
        templateType = 'pending';
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
            paymentBulletLines = [
                'Forma de pagamento: Pagamento online',
                valorTotalStr ? `Valor total: ${valorTotalStr}` : '',
                paidNow != null && Number.isFinite(paidNow) && paidNow > 0
                    ? `Valor recebido nesta operação: ${formatCurrencyBRL(paidNow)}`
                    : '',
                captureNote
            ].filter(Boolean);
            complement = 'Seu pagamento foi confirmado.';
            templateType = 'payment';
        } else {
            const paidDisplay =
                paidNow != null && Number.isFinite(paidNow) && paidNow > 0 ? formatCurrencyBRL(paidNow) : null;
            paymentBulletLines = [
                'Forma de pagamento: Parcial (histórico)',
                valorTotalStr ? `Valor total: ${valorTotalStr}` : '',
                paidDisplay ? `Valor pago nesta etapa: ${paidDisplay}` : 'Valor pago nesta etapa: (veja o registro no sistema ou entre em contato)',
                remaining != null && Number.isFinite(remaining) && remaining > 0
                    ? `Saldo no atendimento: ${formatCurrencyBRL(remaining)}`
                    : '',
                captureNote,
                'O saldo restante será acertado presencialmente no dia do atendimento.'
            ].filter(Boolean);
            complement =
                'Seu agendamento foi confirmado com sucesso. O saldo indicado será acertado presencialmente no dia do atendimento.';
            templateType = 'confirmation';
        }
    }

    const clientInformedAddress = appointmentRow.location ? String(appointmentRow.location).trim() : '';

    const text = buildEmailTemplate(templateType, 'client', {
        greeting: `Olá, ${firstName}!`,
        title,
        subtitle,
        clientName,
        serviceName,
        dateStr: appointmentDate,
        timeStr: appointmentTime,
        paymentBulletLines,
        complement,
        clientInformedAddress
    });

    const showPayCta =
        statusNorm === 'pending_payment' &&
        paymentKind === 'full' &&
        paymentUrl &&
        /^https?:\/\//i.test(paymentUrl);

    const html = buildEmailHtmlTemplate({
        greeting: `Olá, ${firstName}!`,
        title,
        subtitle,
        details: buildStandardBookingDetailRows({
            clientName,
            serviceName,
            dateStr: appointmentDate,
            timeStr: appointmentTime,
            paymentBulletLines,
            clientInformedAddress,
            stripPaymentLinkLine: showPayCta,
            ctaHref: showPayCta ? paymentUrl : ''
        }),
        noteAfterCard: complement,
        actionButton: showPayCta ? { href: paymentUrl, label: 'Pagar agora' } : null
    });

    try {
        const { data, error } = await resend.emails.send({
            from: process.env.FROM_EMAIL || 'Ateliê da Pele <onboarding@resend.dev>',
            to,
            subject,
            text,
            html
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

/**
 * Aviso à cliente quando o agendamento é cancelado (admin, cliente ou fluxo que use o mesmo PATCH).
 * Mesmo modelo para todos os casos; mensagem alinhada ao combinado com o Ateliê.
 */
async function sendClientAppointmentCancelledEmail(appointmentRow, serviceData, clientEmailTo) {
    const to = String(clientEmailTo || '').trim().toLowerCase();

    if (!process.env.RESEND_API_KEY) {
        console.error('[EmailService] RESEND_API_KEY ausente; não enviando e-mail de cancelamento ao cliente.');
        return;
    }

    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        console.error('[EmailService] E-mail da cliente inválido; não enviando aviso de cancelamento.');
        return;
    }

    const resend = new Resend(process.env.RESEND_API_KEY);

    const clientName =
        appointmentRow.client_name || appointmentRow.clientName || 'Cliente';

    const firstName = (String(clientName).trim().split(/\s+/)[0] || 'Cliente').trim();

    const serviceName =
        serviceData?.name ||
        appointmentRow.service_name ||
        appointmentRow.service_id ||
        'Serviço';

    const appointmentDate = appointmentRow.date
        ? new Date(`${appointmentRow.date}T12:00:00`).toLocaleDateString('pt-BR')
        : '—';

    const appointmentTime = appointmentRow.time || '—';

    const paymentLine = describePaymentForCancelEmail(appointmentRow);
    const whoNote = noteWhoCancelledAppointment(appointmentRow);
    const clientInformedAddress = appointmentRow.location ? String(appointmentRow.location).trim() : '';

    const subject = 'Agendamento cancelado';

    const complementParts = [whoNote, 'Se precisar reagendar, estaremos à disposição.'].filter(Boolean);
    const complement = complementParts.join('\n\n');

    const cancelPayBullets = [`Forma de pagamento: ${paymentLine}`];

    const text = buildEmailTemplate('cancellation', 'client', {
        greeting: `Olá, ${firstName}!`,
        title: 'Agendamento cancelado',
        subtitle: 'Seu agendamento foi cancelado.',
        clientName,
        serviceName,
        dateStr: appointmentDate,
        timeStr: appointmentTime,
        paymentBulletLines: cancelPayBullets,
        complement,
        clientInformedAddress
    });

    const html = buildEmailHtmlTemplate({
        greeting: `Olá, ${firstName}!`,
        title: 'Agendamento cancelado',
        subtitle: 'Seu agendamento foi cancelado.',
        details: buildStandardBookingDetailRows({
            clientName,
            serviceName,
            dateStr: appointmentDate,
            timeStr: appointmentTime,
            paymentBulletLines: cancelPayBullets,
            clientInformedAddress,
            stripPaymentLinkLine: false,
            ctaHref: ''
        }),
        noteAfterCard: complement,
        actionButton: null
    });

    try {
        const { data, error } = await resend.emails.send({
            from: process.env.FROM_EMAIL || 'Ateliê da Pele <onboarding@resend.dev>',
            to,
            subject,
            text,
            html
        });

        if (error) {
            console.error('[EmailService] Falha Resend (cancelamento cliente):', error.message || error);
            throw new Error(error.message || 'Falha no envio ao cliente');
        }

        console.log(`[EmailService] E-mail de cancelamento à cliente enviado. Resend ID: ${data?.id || 'N/A'}`);
        return data;
    } catch (error) {
        console.error('[EmailService] Falha geral e-mail cancelamento cliente:', error.message || error);
        throw error;
    }
}

/**
 * Cópia interna para o profissional quando um agendamento é cancelado (mesmo fluxo do PATCH ao cliente).
 * Usa NOTIFICATION_EMAIL; falha de envio não deve afetar o cancelamento (apenas log no chamador).
 */
async function sendAdminAppointmentCancelledEmail(appointmentRow, serviceData) {
    if (!process.env.RESEND_API_KEY) {
        console.error('[EmailService] RESEND_API_KEY ausente; não enviando cópia de cancelamento ao admin.');
        return;
    }

    const adminTo = String(process.env.NOTIFICATION_EMAIL || '').trim();
    if (!adminTo) {
        console.error('[EmailService] NOTIFICATION_EMAIL ausente; não enviando cópia de cancelamento ao admin.');
        return;
    }

    const resend = new Resend(process.env.RESEND_API_KEY);

    const clientName =
        appointmentRow.client_name || appointmentRow.clientName || 'Cliente';

    const serviceName =
        (serviceData && String(serviceData.name || '').trim()) ||
        appointmentRow.service_name ||
        appointmentRow.service_id ||
        'Serviço';

    const appointmentDate = appointmentRow.date
        ? new Date(`${appointmentRow.date}T12:00:00`).toLocaleDateString('pt-BR')
        : '—';

    const appointmentTime = appointmentRow.time || '—';

    const paymentLine = describePaymentForCancelEmail(appointmentRow);
    const cancelledByLabel = labelCancelledByForAdminEmail(appointmentRow);
    const cancelReasonRaw = appointmentRow.cancel_reason || appointmentRow.cancelReason;
    const cancelReason =
        cancelReasonRaw != null && String(cancelReasonRaw).trim() ? String(cancelReasonRaw).trim() : '';

    const subject = 'Agendamento cancelado — Ateliê da Pele';

    const parts = [
        'Agendamento cancelado',
        '',
        'Um agendamento foi cancelado.',
        '',
        'Cliente:',
        clientName,
        '',
        'Serviço(s):',
        serviceName,
        '',
        'Data e horário:',
        `${appointmentDate} às ${appointmentTime}`,
        '',
        'Forma de pagamento:',
        paymentLine,
        '',
        'Cancelado por:',
        cancelledByLabel,
        '',
        'Status:',
        'Cancelado'
    ];

    if (cancelReason) {
        parts.push('');
        parts.push('Motivo registrado:');
        parts.push(cancelReason);
    }

    parts.push('');
    parts.push('Este é um e-mail automático.');

    const text = parts.join('\n');

    const html = buildAdminCancelEmailHtml({
        clientName,
        serviceName,
        appointmentDate,
        appointmentTime,
        paymentLine,
        cancelledByLabel,
        cancelReason
    });

    try {
        const { data, error } = await resend.emails.send({
            from: process.env.FROM_EMAIL || 'Ateliê da Pele <onboarding@resend.dev>',
            to: adminTo,
            subject,
            text,
            html
        });

        if (error) {
            console.error('[EmailService] Falha Resend (cancelamento admin):', error.message || error);
            throw new Error(error.message || 'Falha no envio ao admin');
        }

        console.log(`[EmailService] Cópia de cancelamento ao admin enviada. Resend ID: ${data?.id || 'N/A'}`);
        return data;
    } catch (error) {
        console.error('[EmailService] Falha geral e-mail cancelamento admin:', error.message || error);
        throw error;
    }
}

module.exports = {
    sendConfirmationEmail,
    sendClientConfirmationEmail,
    sendClientAppointmentCancelledEmail,
    sendAdminAppointmentCancelledEmail,
    buildEmailTemplate,
    buildEmailHtmlTemplate,
    buildStandardBookingDetailRows,
    /** Aliases reutilizáveis ao layout premium (mesmas funções internas). */
    buildEmailLayout: buildEmailLayoutHtml,
    buildDetailsCard: buildDetailsCardHtml,
    buildActionButton: buildActionButtonHtml,
    ATELIE_EMAIL_LAYOUT_MAX_PX,
    ATELIE_EMAIL_OUTER_BG,
    ATELIE_SALON_LOCATION_LINE,
    ATELIE_EMAIL_STANDARD_FOOTER
};
