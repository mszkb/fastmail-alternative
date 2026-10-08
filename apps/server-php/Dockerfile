# syntax=docker/dockerfile:1
# PHP backend (ADR-0013): php-fpm serving /api/* behind caddy, and the same
# image runs bin/worker.php as the optional long-running worker.
# Build context: apps/server-php. Multi-arch (amd64, arm64) via buildx.
FROM composer:2 AS vendor
WORKDIR /app
COPY composer.json composer.lock ./
# Extensions are installed in the runtime stage, not in this one.
RUN composer install --no-dev --no-interaction --no-progress --no-scripts --prefer-dist --optimize-autoloader --ignore-platform-req='ext-*'

FROM php:8.3-fpm-alpine
# pdo_mysql for MySQL/MariaDB, pcntl for the worker's signal handling;
# openssl, mbstring, sodium and argon2 are part of the official image.
RUN docker-php-ext-install pdo_mysql pcntl \
    && mv "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini" \
    && { echo 'expose_php = Off'; echo 'memory_limit = 256M'; echo 'upload_max_filesize = 16M'; echo 'post_max_size = 16M'; } > "$PHP_INI_DIR/conf.d/fma.ini" \
    # FPM: keep the configured environment (MASTER_KEY, DATABASE_URL, ...).
    && echo 'clear_env = no' >> /usr/local/etc/php-fpm.d/www.conf

ARG APP_VERSION=0.0.0-dev
ENV APP_VERSION=$APP_VERSION \
    MAIL_DATA_DIR=/data/mail

WORKDIR /app
COPY --from=vendor /app/vendor ./vendor
COPY bin ./bin
COPY migrations ./migrations
COPY public ./public
COPY src ./src
COPY composer.json ./

RUN mkdir -p /data/mail && chown www-data:www-data /data/mail
USER www-data
# Migrations run on start; then php-fpm on 9000 (FastCGI, only in the compose network).
CMD ["sh", "-c", "php bin/migrate.php && exec php-fpm"]
EXPOSE 9000

