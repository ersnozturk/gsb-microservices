FROM node:24.13.1-alpine

WORKDIR /app

# Önce package.json kopyala ve bağımlılıkları kur
COPY src/package.json ./
RUN npm install

EXPOSE 7000

# Volume mount node_modules'ü ezebilir, bu yüzden her başlangıçta kontrol et
CMD ["sh", "-c", "npm install && node index.js"]
