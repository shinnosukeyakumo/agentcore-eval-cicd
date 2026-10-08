# python:3.13-slim をダイジェストで固定する。タグは中身が差し替わるため。
FROM --platform=linux/arm64 public.ecr.aws/docker/library/python:3.13-slim@sha256:bf44cdfcb76cd3b41e879bc058fc37ec5872002ccfde7fcb765e218cde0cd79c

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    DOCKER_CONTAINER=1

# requirements.txt は requirements.in から uv pip compile で生成した完全固定版
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

RUN useradd -m -u 1000 bedrock_agentcore
USER bedrock_agentcore

COPY src/ .

EXPOSE 8080

CMD ["opentelemetry-instrument", "python", "main.py"]
