// backend/services/infinitepayService.js

const FIXED_SIGNAL_AMOUNT_CENTS = 3000;

async function createCheckoutLink(appointment) {
    const apiKey = process.env.INFINITEPAY_API_KEY;
    const handle = process.env.INFINITEPAY_HANDLE;
    const webhookUrl = process.env.INFINITEPAY_WEBHOOK_URL;
    const successUrl = process.env.INFINITEPAY_SUCCESS_URL;

    if (!handle) {
        console.warn('[InfinitePayService] INFINITEPAY_HANDLE ausente no .env');
    }

    const payload = {
        handle: handle || 'ateliedapele',
        order_nsu: String(appointment.id),
        redirect_url: successUrl || '',
        webhook_url: webhookUrl || '',
        items: [
            {
                id: appointment.serviceId || 'sinal_agendamento',
                description: 'Sinal do agendamento (Ateliê da Pele)',
                quantity: 1,
                price: FIXED_SIGNAL_AMOUNT_CENTS
            }
        ]
    };

    console.log(
        `[InfinitePayService] Criando checkout. order_nsu=${payload.order_nsu}, valor=${FIXED_SIGNAL_AMOUNT_CENTS}`
    );

    try {
        const response = await fetch(
            'https://api.infinitepay.io/invoices/public/checkout/links',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
                },
                body: JSON.stringify(payload)
            }
        );

        const data = await response.json();

        if (!response.ok) {
            console.error('[InfinitePayService] Falha ao criar checkout:', JSON.stringify(data));
            throw new Error(
                `InfinitePay API Error: ${response.status} - ${JSON.stringify(data)}`
            );
        }

        if (!data?.url) {
            console.error('[InfinitePayService] Resposta sem URL:', JSON.stringify(data));
            throw new Error('InfinitePay não retornou a URL de checkout');
        }

        console.log(`[InfinitePayService] Checkout gerado com sucesso: ${data.url}`);
        return data.url;
    } catch (error) {
        console.error('[InfinitePayService] Exception:', error.message || error);
        throw error;
    }
}

async function checkPaymentStatus(orderNsu) {
    const apiKey = process.env.INFINITEPAY_API_KEY;

    if (!apiKey) {
        console.warn('[InfinitePayService] INFINITEPAY_API_KEY ausente. Fallback não executado.');
        return null;
    }

    try {
        console.log(`[InfinitePayService] Fallback check para order_nsu=${orderNsu}`);

        const response = await fetch(
            `https://api.infinitepay.io/v2/orders?external_id=${encodeURIComponent(orderNsu)}`,
            {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    Accept: 'application/json'
                }
            }
        );

        if (!response.ok) {
            const err = await response.text();
            console.warn(
                `[InfinitePayService] Aviso ao testar fallback (ignorar se webhook estiver OK): ${err}`
            );
            return null;
        }

        const data = await response.json();
        const order =
            data?.results && Array.isArray(data.results) && data.results.length > 0
                ? data.results[0]
                : null;

        if (!order) {
            console.warn(`[InfinitePayService] Nenhum pedido encontrado para ${orderNsu}`);
            return false;
        }

        const normalizedStatus = String(order.status || '').toLowerCase();

        if (normalizedStatus === 'approved' || normalizedStatus === 'paid') {
            console.log(`[InfinitePayService] Status confirmado manualmente para ${orderNsu}`);
            return true;
        }

        console.log(
            `[InfinitePayService] Pedido ${orderNsu} encontrado com status ${normalizedStatus}`
        );
        return false;
    } catch (error) {
        console.error('[InfinitePayService] Erro no fallback verify:', error.message || error);
        return null;
    }
}

module.exports = {
    createCheckoutLink,
    checkPaymentStatus
};