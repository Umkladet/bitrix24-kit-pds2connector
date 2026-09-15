FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY schema.sql ./
COPY src ./src
USER node
EXPOSE 3000
CMD ["node", "src/index.js"]
