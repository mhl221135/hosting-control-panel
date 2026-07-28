FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache docker-cli

COPY package.json /app/
COPY app /app/

ENV PORT=8790

EXPOSE 8790

CMD ["node", "/app/server.js"]
