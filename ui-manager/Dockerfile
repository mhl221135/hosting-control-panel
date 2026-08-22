FROM restic/restic:0.18.1 AS restic

FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache tar tzdata unzip zip \
    && mkdir -p /srv/websites /srv/configs/nginx/conf.d /srv/configs/php-fpm /app/data

COPY --from=restic /usr/bin/restic /usr/local/bin/restic

COPY package.json package-lock.json /app/
RUN npm ci --omit=dev && npm cache clean --force

COPY app/server.js /app/server.js
COPY app/lib /app/lib
COPY app/cli /app/cli
COPY app/wordpress /app/wordpress
COPY app/public /app/public
COPY docker-rpc.js /usr/local/bin/docker
RUN chmod -R a=rX /app/server.js /app/lib /app/cli /app/wordpress /app/public \
    && chmod 0555 /usr/local/bin/docker

ENV PORT=8687
ENV DATA_DIR=/app/data
ENV SITES_MAP_PATH=/srv/configs/nginx/conf.d/sites.map
ENV POOLS_PATH=/srv/configs/php-fpm/pools.conf

EXPOSE 8687

USER 33:33

CMD ["node", "/app/server.js"]
