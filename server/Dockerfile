# 远程 API 服务镜像（FastAPI + SQLite）
FROM python:3.12-slim

WORKDIR /app

# 安装依赖（利用镜像层缓存）
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 拷贝应用代码
COPY app ./app
COPY scripts ./scripts

# SQLite 数据目录（compose 挂载 volume 到 /data）
ENV DATABASE_URL=sqlite:////data/echotik.db
RUN mkdir -p /data

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
