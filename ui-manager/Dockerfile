FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache docker-cli tar tzdata \
    && mkdir -p /srv/websites /srv/configs/nginx/conf.d /srv/configs/php-fpm /app/data

COPY app/server.js /app/server.js
COPY app/lib /app/lib
COPY app/cli /app/cli
COPY app/public /app/public

ENV PORT=8687
ENV DATA_DIR=/app/data
ENV SITES_MAP_PATH=/srv/configs/nginx/conf.d/sites.map
ENV POOLS_PATH=/srv/configs/php-fpm/pools.conf

EXPOSE 8687

CMD ["node", "/app/server.js"]
