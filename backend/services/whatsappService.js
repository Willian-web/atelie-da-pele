const twilio = require('twilio');

class WhatsappService {
    constructor() {
        console.log('🔗 Preparando Integração Leve com a API Oficial do Twilio...');
        
        // Puxa as Chaves do Arquivo .env / Railway Variaveis
        this.accountSid = process.env.TWILIO_ACCOUNT_SID;
        this.authToken = process.env.TWILIO_AUTH_TOKEN;
        this.twilioNumber = process.env.TWILIO_WHATSAPP_NUMBER; // Ex: whatsapp:+14155238886

        if (this.accountSid && this.authToken) {
            this.client = twilio(this.accountSid, this.authToken);
            this.isReady = true;
            console.log('✅ Twilio Iniciado: Chaves encontradas no cofre.');
        } else {
            console.warn('⚠️ Alerta: Conexão incompleta. Por favor configure as chaves do Twilio no .env!');
            this.isReady = false;
        }
    }

    async sendMessage(to, message) {
        if (!this.isReady) {
            console.error('🚫 Erro de Disparo: Twilio não está configurado.');
            return { success: false, error: 'API do Twilio não configurada' };
        }

        try {
            // Formata o número para o padrão internacional do WhatsApp Exigido pelo Twilio
            // Aceita tanto com 55 quanto sem, e injeta o `whatsapp:+` na frente
            let formattedNumber = to.replace(/\D/g, ''); 
            if (!formattedNumber.startsWith('55')) {
                formattedNumber = '55' + formattedNumber;
            }
            formattedNumber = 'whatsapp:+' + formattedNumber;

            console.log(`📡 Disparando Torpedo Twilio para ${formattedNumber}...`);

            const response = await this.client.messages.create({
                body: message,
                from: this.twilioNumber, // Número Oficial Sandbox ou Produção do Twilio
                to: formattedNumber
            });

            console.log(`✅ [Twilio] Mensagem Despachada com Sucesso! SID: ${response.sid}`);
            return { success: true, sid: response.sid };
        } catch (error) {
            console.error('❌ Erro no Disparo:', error);
            return { success: false, error: error.message };
        }
    }
}

module.exports = new WhatsappService();
