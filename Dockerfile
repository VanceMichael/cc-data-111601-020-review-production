FROM node:22.23.4-bookworm-slim
WORKDIR /app
COPY . .
RUN npm ci --offline --ignore-scripts && npm run build
CMD ["npm", "run", "demo"]
