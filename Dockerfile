FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
# O server.js extrai sozinho o .zip com a versão Web (se houver) ao iniciar.
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
