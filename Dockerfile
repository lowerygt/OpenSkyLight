FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm rebuild better-sqlite3
COPY . .
RUN npm run build:web && npm run build:companion
EXPOSE 8420
ENV PORT=8420
ENV OSL_DATA_DIR=/data
CMD ["npm", "run", "start:web"]
