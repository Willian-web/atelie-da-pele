require('dotenv').config();

class PagbankService {
    constructor() {
        this.token = process.env.PAGBANK_TOKEN || 'COLOQUE_SEU_TOKEN_AQUI';
        this.isSandbox = process.env.PAGBANK_SANDBOX !== 'false';
        this.baseUrl = this.isSandbox ? 'https://sandbox.api.pagseguro.com' : 'https://api.pagseguro.com';
    }

    async createCheckoutLink({ clientName, clientPhone, serviceName, price }) {
        // Se ainda não tivermos o token real configurado, vamos retornar um MOCK (Simulação) visual para você testar na tela
        if (this.token === 'COLOQUE_SEU_TOKEN_AQUI' || !this.token) {
            console.log('💳 [PagBank] Modo Simulação Ativo (Nenhum Token Oficial ainda). Simulando Rota.');
            return {
                checkoutUrl: `https://sandbox.pagseguro.uol.com.br/checkout/payment.html?code=SIMULACAO_ATELIE_` + Date.now(),
                orderId: 'SIMULACAO_' + Date.now()
            };
        }

        console.log(`💳 [PagBank] Criando Pedido de Checkout Inteligente para: ${clientName}...`);

        try {
            // Limpa o Real Brasileiro para centavos (ex: "R$ 119,90" -> 11990)
            const cleanStr = price.replace('R$', '').replace(/\./g, '').replace(',', '.').trim();
            const numericPrice = parseFloat(cleanStr) * 100;

            const payload = {
                reference_id: `ATELIE-${Date.now()}`,
                customer: {
                    name: clientName,
                    email: 'cliente@ateliemock.com', 
                    tax_id: '00000000000', 
                },
                items: [
                    {
                        reference_id: "SERVICO",
                        name: serviceName,
                        quantity: 1,
                        unit_amount: Math.round(numericPrice)
                    }
                ],
                qr_codes: [
                    {
                        amount: { value: Math.round(numericPrice) }
                    }
                ]
            };

            // Implementação do Disparo Oficial do Pagbank via Axios (Pronto para Uso)
            /*
            const axios = require('axios');
            const response = await axios.post(`${this.baseUrl}/orders`, payload, {
                headers: { 
                    Authorization: `Bearer ${this.token}`, 
                    'Content-Type': 'application/json' 
                }
            });
            // Busca o link hospedado deles
            const linkObj = response.data.links.find(l => l.rel === 'checkout' || l.rel === 'PAY');
            return { checkoutUrl: linkObj.href, orderId: response.data.id };
            */

            // Retorno provisório seguro enquanto não habilita o Axios
            return {
                checkoutUrl: `https://sandbox.pagseguro.uol.com.br/checkout/payment.html?code=CONECTADO`,
                orderId: `ORDER-${Date.now()}`
            };

        } catch (error) {
            console.error('Falha fatal na comunicação PagBank:', error.response?.data || error.message);
            throw new Error('Falha ao gerar link de pagamento no ambiente da API PagBank');
        }
    }
}

module.exports = new PagbankService();
