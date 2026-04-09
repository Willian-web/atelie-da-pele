const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

class WhatsappWebJS_Service {
    constructor() {
        console.log('🤖 Iniciando Robô do WhatsApp Local. Aguarde alguns segundos...');
        
        // Inicializa o Client garantindo salvamento de sessão (LocalAuth)
        this.client = new Client({
            authStrategy: new LocalAuth(),
            puppeteer: {
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            }
        });
        
        this.isReady = false;
        this.lastQr = '';

        // Quando o cliente pedir autenticação, geramos o QR no Terminal Visível
        this.client.on('qr', (qr) => {
            console.log('\n======================================================');
            console.log('📱 ESCANEIE ESTE QR CODE COM O SEU WHATSAPP (APARELHOS CONECTADOS)');
            console.log('======================================================');
            // small: true garante que no Windows o QR não fique gigantesco
            qrcode.generate(qr, { small: true });
            
            // Grava na memória ram do servidor para mostrar na página web
            this.lastQr = qr;
        });

        // Quando logado com sucesso e sincronizado
        this.client.on('ready', () => {
            console.log('\n✅ ROBO DO WHATSAPP CONECTADO COM SUCESSO! A partir de agora, os agendamentos já enviarão mensagens.');
            this.isReady = true;
            this.lastQr = '';
        });

        this.client.on('auth_failure', () => {
            console.error('\n❌ Falha na autenticação do WhatsApp!');
        });

        this.client.on('disconnected', (reason) => {
            console.log('\n⚠️ Whatsapp Desconectado! Motivo:', reason);
            this.isReady = false;
        });

        // "Liga" o robô de fato
        this.client.initialize();
    }

    getQrCode() {
        return this.lastQr;
    }

    async sendMessage(to, body) {
        if (!this.isReady) {
            console.warn(`[Aguardando Escaneamento] O sistema tentou enviar para ${to}, mas o celular não estava scaneado.`);
            throw new Error('Você precisa ler o QR Code no terminal primeiro!');
        }

        // Limpa tudo o que não for número
        let digits = to.replace(/\D/g, '');
        if (!digits) throw new Error('Telefone vazio.');
        if (digits.startsWith('0')) digits = digits.substring(1);
        
        // Garante o prefixo do Brasil 55
        if (!digits.startsWith('55')) {
            digits = '55' + digits;
        }

        console.log(`[WA-WEB] Verificando existência de WhatsApp para: ${digits}...`);
        
        try {
            // Essa função getNumberId é INCRÍVEL. 
            // Ela pega qualquer número e bate no servidor do WhatsApp para ver 
            // se o número real possui ou não o bendito 9º dígito.
            const registeredPhone = await this.client.getNumberId(digits);

            if (!registeredPhone) {
                console.error(`[WA-WEB] Erro letal: O número ${digits} não existe no WhatsApp.`);
                throw new Error('O número informado não está associado, ou está incorreto no Banco de Dados global.');
            }

            // Pega o ID Oficial formatado diretamente pela plataforma ('554184928985@c.us')
            const jidMapeado = registeredPhone._serialized;
            
            await this.client.sendMessage(jidMapeado, body);
            console.log(`[WA-WEB] Mensagem entregue para ${jidMapeado} com louvor.`);
            return true;
            
        } catch (error) {
            console.error(`[WA-WEB] Falha fatal ao entregar mensagem para ${digits}:`, error.message || error);
            throw error;
        }
    }
}

module.exports = new WhatsappWebJS_Service();
