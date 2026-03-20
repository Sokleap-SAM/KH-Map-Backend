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
# Only copy production dependencies
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force
# Copy compiled code from build stage
COPY --from=build /usr/src/app/dist ./dist
# Use non-root user for security
USER node
EXPOSE 3000
CMD ["node", "dist/main"]