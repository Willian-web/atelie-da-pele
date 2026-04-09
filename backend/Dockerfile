FROM node:20-bullseye-slim

# Instala as dependências vitais do Google Chrome e o próprio Chromium na máquina do Railway
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copia os arquivos de dependência
COPY package*.json ./
RUN npm install

# Copia todo o código do backend
COPY . .

# Variável ultra-importante que avisa o Robô para usar o Chrome Linux que acabamos de instalar!
ENV PUPPETEER_EXECUTABLE_PATH="/usr/bin/chromium"
ENV PORT=3000

EXPOSE 3000

# Executa o Node
CMD ["npm", "start"]
