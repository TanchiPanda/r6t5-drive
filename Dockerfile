# R6T5 Drive · 生产镜像
# 基础镜像：Node 22 Debian bookworm-slim（glibc，better-sqlite3 可直接用预编译包）
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=8080 \
    TZ=Asia/Shanghai

WORKDIR /app

# 先拷贝依赖清单，利用 Docker 层缓存：代码改动不必重装依赖
COPY package*.json ./

# better-sqlite3 在 glibc 上提供预编译二进制，多数情况可直接安装。
# 若所在平台/版本没有匹配的预编译包、必须从源码编译，先取消下面这行注释安装构建工具链：
#   RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm ci --omit=dev || npm install --omit=dev

# 拷贝应用代码（后端 / 静态前端 / 工具脚本 / 文档）
# server/index.html 是仓库根的介绍页（/ 路由直接读它），必须一起进镜像
COPY index.html ./index.html
COPY server/ ./server/
COPY public/ ./public/
COPY tools/ ./tools/
COPY docs/ ./docs/

# 数据目录：SQLite 库与上传文件均落在该目录，容器内以独立卷挂载
RUN mkdir -p /app/data && chown -R node:node /app

# 非 root 运行
USER node

VOLUME /app/data

EXPOSE 8080

# 健康检查：不额外安装 curl，直接用 Node 内置 fetch 探测初始化状态接口
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/setup/status').then(r=>{if(r.status!==200)process.exit(1);}).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
