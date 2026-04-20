# App Ateliê da Pele - Sistema de Agendamento

Uma aplicação Web SPA (Single Page Application) focada no agendamento de consultas de estética. Construída com um visual rose/nude feminino, elegante, simples e funcional sob arquitetura de Componentes React.

## Tecnologias e Arquitetura 👩‍💻
Devido à necessidade de alta disponibilidade local e zero dependência de configuração ambiente (ausência de Node/NPM), o sistema foi construído da seguinte maneira:
- **React 18 & ReactDOM:** Importados via CDN global para permitir uma arquitetura madura baseada em Componentes e Estados.
- **Babel Standalone:** Compilação just-in-time no próprio browser para dar suporte à sintaxe moderna (JSX e ES6+), permitindo manutenções fluídas no arquivo `app.js`.
- **CSS Customizado (Vanilla):** Sistema de Design com tipografia rica (Google Fonts: *Playfair Display* e *Outfit*) com propriedades responsivas.
- **LocalStorage:** Banco de dados invisível alojado diretamente no seu navegador, não perdendo informações.

## Funcionalidades Principais
1. **Área da Cliente:** 
   - Cardápio de serviços elegante com preços claros.
   - Calendário inteligente: oculta sábados de noite e domingos fechados.
   - Motor de colisão de horários: Se uma cliente agenda um serviço 15:00 de amanhã, este horário não é mais votável pela próxima que tentar agendar para amanhã.
2. **Área da Profissional / Admin:**
   - Protegida por login no backend (`POST /admin/login`) com senha em variável de ambiente e token de sessão (sem senha no frontend).
   - Listagem completa ranqueada por temporalidade (quem vem primeiro em cima).
   - Possibilidade de exclusão (liberando a data e hora na tela original).

## Como Instalar e Rodar 🚀

Não precisa instalar, compilar ou abrir terminais.
1. Abra a pasta correspondente no seu computador.
2. Dê dois cliques em **`index.html`** (Abre em qualquer navegador atualizado).
3. **E pronto!**

> **Importante para Manutenção de Valores:** Se futuramente os preços ou nomes de serviços mudarem, basta abrir o código do arquivo `app.js`  blocos de notas tradicional e alterar no topo dentro do bloco constante `SERVICES` mantendo as aspas. A tela inteira se adapta sozinha.
