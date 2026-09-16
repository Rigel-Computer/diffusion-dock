from contextlib import asynccontextmanager
from fastapi import FastAPI
from pydantic import BaseModel
import ctranslate2
import sentencepiece as spm

_translator = None
_src_sp = None
_tgt_sp = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _translator, _src_sp, _tgt_sp
    _translator = ctranslate2.Translator("/app/model", device="cpu", inter_threads=2)
    _src_sp = spm.SentencePieceProcessor(model_file="/app/model/source.spm")
    _tgt_sp = spm.SentencePieceProcessor(model_file="/app/model/target.spm")
    yield


app = FastAPI(lifespan=lifespan)


class TranslateRequest(BaseModel):
    text: str


@app.post("/translate")
def translate(req: TranslateRequest):
    tokens = _src_sp.encode(req.text, out_type=str)
    results = _translator.translate_batch([tokens])
    translated = _tgt_sp.decode(results[0].hypotheses[0])
    return {"translated": translated}


@app.get("/health")
def health():
    return {"ok": True}
