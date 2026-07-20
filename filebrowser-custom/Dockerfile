FROM filebrowser/filebrowser:v2.63.18

USER root
COPY entrypoint.sh /usr/local/bin/hosting-filebrowser-entrypoint
RUN chmod 0755 /usr/local/bin/hosting-filebrowser-entrypoint
USER user
ENTRYPOINT ["tini", "--", "/usr/local/bin/hosting-filebrowser-entrypoint"]
