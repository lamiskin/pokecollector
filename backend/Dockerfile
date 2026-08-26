FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    wget \
    gnupg \
    lsb-release \
    gcc \
    && install -d /etc/apt/keyrings \
    && wget --quiet -O - https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/keyrings/postgresql.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/postgresql.gpg] http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-18 \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Playwright/Chromium for the Suruga-ya JP price fetcher — personal, local-only feature.
# `--with-deps` doesn't know this base image's Debian release yet (falls back to an
# Ubuntu package list with two font packages that don't exist here), so the actual
# runtime libraries are installed explicitly instead, substituting fonts-unifont for
# the missing ttf-unifont/ttf-ubuntu-font-family.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libasound2 libpango-1.0-0 libcairo2 fonts-unifont \
    && rm -rf /var/lib/apt/lists/*
RUN playwright install chromium

COPY VERSION /app/VERSION
COPY backend/ .

RUN mkdir -p /app/backups /app/debug /app/data/pokedex-images/sprites /app/data/pokedex-images/artwork

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
