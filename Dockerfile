FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

RUN mkdir -p /app/data

EXPOSE 3000
CMD ["node", "dist/api/server.js"]
