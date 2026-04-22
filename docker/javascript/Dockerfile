FROM node:20-alpine

# Non-root sandbox user
RUN addgroup -S sandbox && adduser -S sandbox -G sandbox

WORKDIR /sandbox
COPY run.js .

USER sandbox

ENTRYPOINT ["node", "/sandbox/run.js"]