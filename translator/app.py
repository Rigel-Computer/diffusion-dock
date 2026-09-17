from contextlib import asynccontextmanager
from fastapi import FastAPI
from pydantic import BaseModel
from transformers import MarianMTModel, MarianTokenizer
import torch

_model = None
_tokenizer = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _model, _tokenizer
    _tokenizer = MarianTokenizer.from_pretrained("/app/model")
    _model = MarianMTModel.from_pretrained("/app/model")
    _model.eval()
    yield


app = FastAPI(lifespan=lifespan)


class TranslateRequest(BaseModel):
    text: str


@app.post("/translate")
def translate(req: TranslateRequest):
    inputs = _tokenizer(
        [req.text], return_tensors="pt", padding=True, truncation=True, max_length=512
    )
    with torch.no_grad():
        outputs = _model.generate(**inputs, num_beams=4, max_length=512)
    translated = _tokenizer.decode(outputs[0], skip_special_tokens=True)
    return {"translated": translated}


@app.get("/health")
def health():
    return {"ok": True}
