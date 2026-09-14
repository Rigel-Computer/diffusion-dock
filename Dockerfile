FROM python:3.11-slim
RUN groupadd -g 1000 appuser && useradd -m -u 1000 -g 1000 appuser
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend.py .
COPY static/ ./static/
USER appuser
EXPOSE 8000
CMD ["uvicorn", "backend:app", "--host", "0.0.0.0", "--port", "8000"]
