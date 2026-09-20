FROM ghcr.io/lair404xyz/playwright-auth:latest

WORKDIR /app

COPY package.json ./
RUN npm install express dotenv

COPY src/ ./src/

ENV NODE_ENV=production
ENV PORT=3400

EXPOSE 3400

CMD ["node", "src/server.js"]
