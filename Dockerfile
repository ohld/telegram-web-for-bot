FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --include=dev

COPY . .

ARG APP_ENV=production
ARG BASE_URL
ARG TELEGRAM_API_ID
ARG TELEGRAM_API_HASH

ENV APP_ENV=$APP_ENV
ENV BASE_URL=$BASE_URL
ENV TELEGRAM_API_ID=$TELEGRAM_API_ID
ENV TELEGRAM_API_HASH=$TELEGRAM_API_HASH

RUN npm run build:production

FROM nginx:1.27-alpine

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
