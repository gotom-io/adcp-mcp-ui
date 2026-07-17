FROM node:lts

WORKDIR /app

COPY app/ .
COPY scripts/ /scripts/

RUN npm ci

EXPOSE 3000

ENTRYPOINT ["node", "/app/server.mjs"]
