FROM node:20-alpine
RUN apk add --no-cache docker-cli git
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
# config.json must be mounted at /app/config.json
CMD ["node", "src/index.js"]
