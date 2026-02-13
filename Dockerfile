FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN npm run build

RUN mkdir -p /app/data /app/logs

ENV NODE_ENV=production

EXPOSE 3001

CMD ["node", "dist/index.js"]
