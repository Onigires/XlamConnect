FROM node:22-alpine
WORKDIR /app
COPY server.js .
ENV XLAM_STATE=/data/state.json
VOLUME /data
EXPOSE 7777/tcp 7777/udp
CMD ["node", "server.js"]
