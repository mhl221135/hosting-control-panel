FROM jc21/nginx-proxy-manager:2.15.0

RUN sed -i 's/real_ip_header X-Real-IP;/real_ip_header CF-Connecting-IP;/' /etc/nginx/nginx.conf \
    && grep -q 'real_ip_header CF-Connecting-IP;' /etc/nginx/nginx.conf
