FROM node:20-slim
WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci || npm install

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
COPY top500.json ./
RUN npm run build

# Runtime env
ENV PORT=8080 HOST=0.0.0.0 NODE_ENV=production
EXPOSE 8080

# Run paper runner (background) + API server (foreground).
# Paper state lives in paper-report.json; it regenerates every cycle.
# 5-min cycles to catch NORMAL signals faster (user requested).
CMD ["sh", "-c", "node dist/scripts/paper-run.js --symbols-file top500.json --batch 100 --every-min 5 >> paper-trading.log 2>&1 & exec node dist/index.js"]
