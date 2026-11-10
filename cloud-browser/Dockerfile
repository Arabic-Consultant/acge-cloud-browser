# Cloud browser runtime for Arabic Consultant Growth Engine.
# Uses the official Playwright image so the Chromium build matches the
# Playwright version pinned in package.json.
FROM mcr.microsoft.com/playwright:v1.58.0-noble

ENV NODE_ENV=production \
    BROWSER_AGENT_HOST=0.0.0.0 \
    BROWSER_AGENT_PORT=8787 \
    BROWSER_AGENT_DATA_DIR=/data \
    PNPM_HOME=/usr/local/bin

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Pin pnpm: Corepack would otherwise fetch the newest major, whose build-script
# approval rules reject the pinned lockfile.
RUN npm install --global pnpm@10.6.5  && pnpm install --frozen-lockfile --prod=false

COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

RUN mkdir -p /data && chown -R pwuser:pwuser /data /app
USER pwuser
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.BROWSER_AGENT_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
