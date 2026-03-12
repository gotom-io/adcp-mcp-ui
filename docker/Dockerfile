FROM node:lts

COPY app/ /app/
RUN cd /app && npm ci

EXPOSE 3000

ENTRYPOINT ["node", "/app/server.mjs"]
