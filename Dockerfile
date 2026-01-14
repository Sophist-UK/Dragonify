FROM node:22-slim AS build
COPY . /app
WORKDIR /app
RUN npm ci
RUN npm run build

FROM node:22-slim AS prod-deps
COPY package*.json /app/
WORKDIR /app
RUN npm ci --omit=dev

FROM gcr.io/distroless/nodejs22-debian12
COPY --from=build /app/dist/index.js /app/index.js
COPY --from=prod-deps /app/node_modules /app/node_modules
WORKDIR /app
CMD ["index.js"]