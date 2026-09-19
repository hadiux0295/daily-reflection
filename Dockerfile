FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY src ./src
COPY sim ./sim
ENV NODE_ENV=production PORT=8080 DR_DB_PATH=/data/reflection.sqlite
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
