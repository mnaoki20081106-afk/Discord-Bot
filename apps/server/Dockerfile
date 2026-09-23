FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm install
COPY tsconfig.base.json ./
COPY apps/server ./apps/server
RUN npm run build --workspace @dsm/server

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm install --omit=dev
COPY --from=build /app/apps/server/dist ./apps/server/dist
CMD ["node", "apps/server/dist/server.js"]
