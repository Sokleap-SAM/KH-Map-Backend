# --- Stage 1: Base (Common for both Dev and Prod) ---
FROM node:20-alpine AS base
WORKDIR /usr/src/app
COPY package*.json ./

# --- Stage 2: Development (For Hot Reload) ---
FROM base AS development
# Install all dependencies including devDependencies
RUN npm install
COPY tsconfig*.json ./
COPY nest-cli.json ./
# We don't COPY . here; we use Volumes in Docker Compose for real-time updates
EXPOSE 3000
CMD ["npm", "run", "start:dev"]

# --- Stage 3: Build (Preparing for Production) ---
FROM base AS build
RUN npm ci
COPY . .
RUN npm run build

# --- Stage 4: Production (Small & Secure) ---
FROM node:20-alpine AS production
WORKDIR /usr/src/app
# Read by the app itself (config/app.config.ts) and by npm. Declared here so
# the image is correct even if the task definition forgets to set it.
ENV NODE_ENV=production
# Only copy production dependencies. `--only=production` is deprecated on the
# npm 10 that node:20-alpine ships; --omit=dev is the supported spelling.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
# Copy compiled code from build stage
COPY --from=build /usr/src/app/dist ./dist
# Use non-root user for security
USER node
EXPOSE 3000
# Alpine ships no curl, so probe with node itself. Mirrors the liveness route
# the ALB target group uses; keep the two in sync.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.CONTAINER_PORT||3000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "dist/main"]
