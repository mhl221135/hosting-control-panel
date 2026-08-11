FROM jc21/nginx-proxy-manager:2.15.0

COPY default.conf /etc/nginx/conf.d/default.conf

RUN sed -i 's/real_ip_header X-Real-IP;/real_ip_header CF-Connecting-IP;/' /etc/nginx/nginx.conf \
    && grep -q 'real_ip_header CF-Connecting-IP;' /etc/nginx/nginx.conf \
    && grep -q 'listen 80 default_server;' /etc/nginx/conf.d/default.conf \
    && grep -q 'include conf.d/include/letsencrypt-acme-challenge.conf;' /etc/nginx/conf.d/default.conf
