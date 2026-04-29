async function createCheckoutLink(appointment) {
    const handle = process.env.INFINITEPAY_HANDLE;
    const webhookUrl = process.env.INFINITEPAY_WEBHOOK_URL;
    const successUrl = process.env.INFINITEPAY_SUCCESS_URL;

    if (!handle) {
        throw new Error('INFINITEPAY_HANDLE não configurado.');
    }

    const amountInCents = Number(appointment?.paymentCents);
    if (!Number.isFinite(amountInCents) || amountInCents <= 0) {
        throw new Error('paymentCents inválido ou ausente: não é possível criar checkout InfinitePay.');
    }

    const itemDescription = 'Pagamento do agendamento - Ateliê da Pele';

    let redirectUrl = successUrl || undefined;
    if (redirectUrl && appointment?.id != null && String(appointment.id).trim() !== '') {
        const id = String(appointment.id).trim();
        try {
            const u = new URL(redirectUrl);
            u.searchParams.set('return', 'booking');
            u.searchParams.set('order_nsu', id);
            redirectUrl = u.toString();
        } catch {
            const sep = redirectUrl.includes('?') ? '&' : '?';
            redirectUrl = `${redirectUrl}${sep}return=booking&order_nsu=${encodeURIComponent(id)}`;
        }
    }

    const payload = {
        handle,
        order_nsu: String(appointment.id),
        redirect_url: redirectUrl,
        webhook_url: webhookUrl || undefined,
        items: [
            {
                quantity: 1,
                price: amountInCents,
                description: itemDescription
            }
        ],
        customer: {
            name: appointment.clientName || 'Cliente',
            phone_number: appointment.clientPhone
                ? `+55${String(appointment.clientPhone).replace(/\D/g, '')}`
                : undefined
        }
    };

    console.log(`[InfinitePayService] Criando checkout para order_nsu=${payload.order_nsu}`);
    console.log(`[InfinitePayService] Valor enviado (centavos)=${amountInCents}`);

    const response = await fetch('https://api.infinitepay.io/invoices/public/checkout/links', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    console.log(`[InfinitePayService] checkout/links HTTP status=${response.status}`);
    const data = await response.json();

    if (!response.ok) {
        console.error('[InfinitePayService] Erro ao criar checkout:', JSON.stringify(data));
        throw new Error(`Falha ao criar checkout InfinitePay: ${response.status} - ${JSON.stringify(data)}`);
    }

    if (!data?.url) {
        console.error('[InfinitePayService] Resposta sem URL:', JSON.stringify(data));
        throw new Error('InfinitePay não retornou URL de pagamento.');
    }

    console.log(`[InfinitePayService] Checkout criado com sucesso: ${data.url}`);
    return data.url;
}

async function checkPaymentStatus({ orderNsu, transactionNsu, slug }) {
    const handle = process.env.INFINITEPAY_HANDLE;

    if (!handle) {
        throw new Error('INFINITEPAY_HANDLE não configurado.');
    }

    const payload = {
        handle,
        order_nsu: String(orderNsu),
        transaction_nsu: String(transactionNsu),
        slug: String(slug)
    };

    console.log(`[InfinitePayService] Consultando status de pagamento para order_nsu=${payload.order_nsu}`);

    const response = await fetch('https://api.infinitepay.io/invoices/public/checkout/payment_check', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    console.log(`[InfinitePayService] payment_check HTTP status=${response.status}`);
    const data = await response.json();

    if (!response.ok) {
        console.error('[InfinitePayService] Erro ao consultar pagamento:', JSON.stringify(data));
        throw new Error(`Falha ao consultar pagamento InfinitePay: ${response.status} - ${JSON.stringify(data)}`);
    }

    console.log('[InfinitePayService] Status retornado (resumo):', JSON.stringify({
        success: data?.success,
        paid: data?.paid,
        paid_amount: data?.paid_amount,
        capture_method: data?.capture_method
    }));
    return data;
}

module.exports = {
    createCheckoutLink,
    checkPaymentStatus
};
