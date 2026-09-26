FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
RUN set -e; \
    mkdir -p /tmp/web public; \
    find /app -path /app/node_modules -prune -o -type f -iname "*.zip" -print | while read -r z; do \
      echo "Extraindo: $z"; unzip -o -q "$z" -d /tmp/web; rm "$z"; \
    done; \
    html="$(find /tmp/web -name index.html | head -n 1)"; \
    if [ -n "$html" ]; then cp -r "$(dirname "$html")"/. public/; fi; \
    rm -rf /tmp/web; \
    echo "Arquivos do jogo em public/:"; ls -la public; \
    if [ ! -f public/index.html ]; then echo "ERRO: public/index.html nao existe. Envie um .zip com os arquivos index.* da exportacao Web para o repositorio."; exit 1; fi
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
