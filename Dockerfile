FROM node:20-alpine

# Install chromium and required libs for Remotion headless rendering
RUN apk add --no-cache \
  chromium \
  nss \
  freetype \
  harfbuzz \
  ca-certificates \
  ttf-freefont

# Tell Remotion/Puppeteer to use system chromium instead of downloading its own
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV REMOTION_CHROME_PATH=/usr/bin/chromium-browser
ENV CHROMIUM_FLAGS="--no-sandbox --disable-setuid-sandbox"

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY src/ ./src/
EXPOSE 10000
CMD ["node", "src/index.js"]
