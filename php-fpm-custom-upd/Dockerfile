FROM php:8.4-fpm

RUN rm -f /usr/local/etc/php-fpm.d/www.conf \
    && rm -f /usr/local/etc/php-fpm.d/www.conf.default

# System deps for PHP extensions
RUN apt-get update && apt-get install -y \
    libpng-dev \
    libjpeg62-turbo-dev \
    libfreetype6-dev \
    libzip-dev \
    libicu-dev \
    libexif-dev \
    libxml2-dev \
    imagemagick \
    libfcgi-bin \
    libmagickwand-dev \
    unzip \
    git \
    curl \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

RUN docker-php-ext-configure gd --with-freetype --with-jpeg

RUN docker-php-ext-install -j"$(nproc)" \
    mysqli \
    pdo_mysql \
    gd \
    exif \
    intl \
    zip \
    soap \
    opcache

RUN MAKEFLAGS="-j$(nproc)" pecl install imagick redis \
    && docker-php-ext-enable imagick redis \
    && apt-get purge -y --auto-remove libmagickwand-dev \
    && rm -rf /var/lib/apt/lists/*

ARG WP_CLI_VERSION=2.12.0
RUN curl -fsSL "https://github.com/wp-cli/wp-cli/releases/download/v${WP_CLI_VERSION}/wp-cli-${WP_CLI_VERSION}.phar" \
      -o /usr/local/bin/wp \
    && chmod 0755 /usr/local/bin/wp \
    && wp --allow-root --info

RUN usermod -u 33 www-data && groupmod -g 33 www-data

WORKDIR /var/www
