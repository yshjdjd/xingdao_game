# 联机服务镜像：单进程，同时提供静态页与 WebSocket。
# 构建上下文 = xingdao/（只需要 src / data / server / web 四个目录）
FROM node:22-alpine
WORKDIR /app

COPY package.json ./
COPY src ./src
COPY data ./data
COPY server ./server
COPY web ./web

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# 云托管会探活这里
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "server/index.mjs"]
