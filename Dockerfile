# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies for tsx)
RUN npm ci

# Copy source code
COPY . .

# Production stage
FROM node:22-alpine AS runner

WORKDIR /app

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 appuser

# Copy package files
COPY package*.json ./

# Install dependencies (tsx is needed to run TypeScript)
RUN npm ci --omit=dev && \
    npm install tsx typescript && \
    npm cache clean --force

# Copy source code
COPY --chown=appuser:nodejs src ./src
COPY --chown=appuser:nodejs tsconfig.json ./

# Set environment variables
ENV NODE_ENV=production
ENV PORT=4111

# Switch to non-root user
USER appuser

# Expose port
EXPOSE 4111

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4111/health || exit 1

# Start the application
ENTRYPOINT ["dumb-init", "--"]
CMD ["npx", "tsx", "src/index.ts"]
