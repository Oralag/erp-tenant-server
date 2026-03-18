FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY src/ ./src/
ENV PORT=8888
EXPOSE 8888
CMD ["node", "src/index.js"]
