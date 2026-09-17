FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir \
    --extra-index-url https://download.pytorch.org/whl/cpu \
    torch transformers sentencepiece fastapi uvicorn

# Download model during build and save to fixed path (no HuggingFace cache structure)
RUN python -c "\
from transformers import MarianMTModel, MarianTokenizer; \
MarianMTModel.from_pretrained('Helsinki-NLP/opus-mt-de-en').save_pretrained('/app/model'); \
MarianTokenizer.from_pretrained('Helsinki-NLP/opus-mt-de-en').save_pretrained('/app/model')"

COPY app.py .

EXPOSE 5000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "5000"]
