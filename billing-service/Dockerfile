FROM node:22-alpine

WORKDIR /app

RUN mkdir -p /app/data /srv/backups \
    && chown -R 33:33 /app/data /srv/backups

COPY package.json /app/
COPY app /app/
COPY test /app/test

ENV PORT=8787
ENV DATA_DIR=/app/data
ENV BACKUPS_ROOT=/srv/backups

EXPOSE 8787

USER 33:33

CMD ["node", "/app/server.js"]
