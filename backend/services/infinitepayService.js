async function createCheckoutLink(appointment) {
    const handle = process.env.INFINITEPAY_HANDLE;
    const webhookUrl = process.env.INFINITEPAY_WEBHOOK_URL;
    const successUrl = process.env.INFINITEPAY_SUCCESS_URL;

    if (!handle) {
        throw new Error('INFINITEPAY_HANDLE não configurado.');
    }

    const amountInCents = Number(appointment?.paymentCents) > 0
        ? Number(appointment.paymentCents)
        : 3000;

    const payload = {
        handle,
        order_nsu: String(appointment.id),
        redirect_url: successUrl || undefined,
        webhook_url: webhookUrl || undefined,
        items: [
            {
                quantity: 1,
                price: amountInCents,
                description: 'Sinal do agendamento (Ateliê da Pele)'
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

    const data = await response.json();

    if (!response.ok) {
        console.error('[InfinitePayService] Erro ao consultar pagamento:', JSON.stringify(data));
        throw new Error(`Falha ao consultar pagamento InfinitePay: ${response.status} - ${JSON.stringify(data)}`);
    }

    console.log('[InfinitePayService] Status retornado:', JSON.stringify(data));
    return data;
}

module.exports = {
    createCheckoutLink,
    checkPaymentStatus
};