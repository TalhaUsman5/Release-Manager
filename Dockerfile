FROM node:20-slim

WORKDIR /app

COPY release-manager-v2/ ./release-manager-v2/
COPY release-manager-review-ui/ ./release-manager-review-ui/

WORKDIR /app/release-manager-review-ui

EXPOSE 3000

CMD ["node", "server.js"]
