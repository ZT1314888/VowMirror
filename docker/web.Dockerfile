FROM nginx:1.28-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/security-headers.conf /etc/nginx/security-headers.conf
COPY docker/api-proxy.conf /etc/nginx/api-proxy.conf
COPY index.html /usr/share/nginx/html/index.html
COPY web/ /usr/share/nginx/html/web/
# .dockerignore admits web/public/venues/V00[1-7] display and thumbnail WebP only; drop the
# directory when no venue image is admitted so neither an empty nor a stray path is published.
RUN if [ -d /usr/share/nginx/html/web/public/venues ] \
    && [ -z "$(find /usr/share/nginx/html/web/public/venues -type f -print -quit)" ]; then rmdir /usr/share/nginx/html/web/public/venues; fi
