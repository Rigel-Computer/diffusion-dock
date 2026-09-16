# Stage 1: Download + convert model (needs torch + transformers, stays out of final image)
FROM python:3.12-slim AS builder

RUN pip install --no-cache-dir \
    torch --index-url https://download.pytorch.org/whl/cpu \
    transformers sentencepiece huggingface_hub ctranslate2

# Download Helsinki-NLP/opus-mt-de-en from HuggingFace
RUN python -c "\
from huggingface_hub import snapshot_download; \
snapshot_download('Helsinki-NLP/opus-mt-de-en', local_dir='/tmp/src', \
    ignore_patterns=['*.msgpack','flax_model*','tf_model*','rust_model*'])"

# Convert to CTranslate2 format with int8 quantization (~75 MB)
RUN ct2-opus-mt-converter --model /tmp/src --output_dir /app/model --quantization int8 --force

# SPM tokenizers are not copied by the converter — add them manually
RUN cp /tmp/src/source.spm /tmp/src/target.spm /app/model/


# Stage 2: Lean runtime image (no torch, no transformers)
FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir ctranslate2 sentencepiece fastapi uvicorn

COPY --from=builder /app/model /app/model
COPY app.py .

EXPOSE 5000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "5000"]
