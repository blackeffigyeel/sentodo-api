# Build stage
FROM node:20-alpine3.18 AS builder

WORKDIR /app

# openssl is required by Prisma's tooling during generate/migrate
RUN apk add --no-cache openssl

# Copy package files
COPY package*.json ./

# Install all dependencies for build
RUN npm ci

# Copy source code
COPY . .

# Build the application (generates the Prisma client, then compiles TypeScript)
RUN npm run build

# Production stage
FROM node:20-alpine3.18

# Runtime dependencies
# openssl = Prisma, curl = container health check
RUN apk add --no-cache \
    openssl \
    curl

# Create app user and group for security
RUN addgroup app && adduser -S -G app app

WORKDIR /app

# Copy package files, then node_modules (includes the generated Prisma client) from builder
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules

# Remove development dependencies
RUN npm prune --omit=dev

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Copy docs for Swagger
COPY --from=builder /app/docs ./docs

# Copy the Prisma schema and migrations (used by the one-off "migrate" service)
COPY --from=builder /app/prisma ./prisma

# Create writable directories BEFORE switching user
USER root

RUN mkdir -p /app/logs \
    && chown -R app:app /app/logs /app/dist

USER app

# Expose the port for the backend server
EXPOSE 3208

# The API. The queue worker runs the same image with: npm run worker
CMD ["npm", "start"]
