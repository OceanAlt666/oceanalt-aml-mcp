# OceanAlt AML MCP server — reproducible image for Glama / any MCP host.
# Thin stdio client for oceanalt.com's public AML / compliance API. No secrets baked in.
FROM node:20-slim

# App lives under /app; run as the built-in non-root `node` user.
WORKDIR /app
ENV NODE_ENV=production

# Install deps from the lockfile first (better layer caching).
# npm ci --omit=dev installs runtime deps (@modelcontextprotocol/sdk, zod) plus the
# optional x402 deps (@x402/core, @x402/evm, viem) that enable the paid tools.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source.
COPY server.mjs README.md LICENSE ./

USER node

# MCP server speaks over stdio (no port to expose).
CMD ["node", "server.mjs"]
