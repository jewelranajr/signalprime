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

# Run paper runner (background, auto-restart on crash) + API server (foreground).
# Paper state lives in paper-report.json; it regenerates every cycle.
# 15-min cycles: 5-min proved too heavy for Render free tier (runner stalls).
CMD ["sh", "-c", "while true; do node dist/scripts/paper-run.js --symbols-file top500.json --batch 150 --every-min 15 >> paper-trading.log 2>&1; echo \"paper-runner exited at $(date), restarting in 10s\" >> paper-trading.log; sleep 10; done & exec node dist/index.js"]
