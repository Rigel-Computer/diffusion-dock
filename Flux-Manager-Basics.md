# Flux Manager – Grundlagen

Persönliche Referenz: Architektur, Modell-Rollen, Verzeichnisstruktur.
Kein Tutorial – nur die Dinge, die beim Aufbau unklar waren.

---

## Warum ComfyUI, nicht llama.cpp?

llama.cpp versteht ausschließlich autoregressive Text-LLMs.
Flux ist ein **Diffusionsmodell** – andere Architektur, anderes Inferenzprinzip.
ComfyUI ist der Standard-Runner für lokale Diffusionsmodelle.

---

## Wie Flux Bilder erzeugt

```
Text-Prompt
    │
    ├─► CLIP-L      (~235 MB)   → kurzes Embedding (77 Token, visuell-semantisch)
    └─► T5-XXL      (~9.4 GB)   → langes Embedding (256 Token, sprachlich-reich)
              │
              ▼
    Flux Diffusion Transformer   → startet mit reinem Rauschen,
    (das GGUF, ~9–13 GB VRAM)     verfeinert es 20–50 Schritte lang
              │                   anhand der Embeddings als Orientierung
              ▼
    VAE Decoder (~335 MB)       → wandelt das Latent-Bild in Pixel um
              │
              ▼
    PNG in outputs/
```

### Warum braucht man T5-XXL — ist das nicht nur Tokenisierung?

Tokenisierung (Text → Token-IDs) ist trivial und winzig (~1 MB Lookup-Tabelle).
T5-XXL macht etwas anderes: **semantische Codierung** — Token-IDs werden in
hochdimensionale Vektoren umgewandelt, die sprachliche Nuancen tragen.

### T5-XXL als "zweites Bein" — die entscheidende Erkenntnis

Beim Training wurden beide Modelle **gleichzeitig** optimiert:

```
Text → [T5-XXL] → Vektor ──┐
                            ├──► Diffusionsmodell lernt die Verbindung
Bild → [Rauschen] ──────────┘
```

T5-XXL und das Diffusionsmodell haben sich im Training aneinander "eingespielt".
Das GGUF ist das eine Bein — T5-XXL ist das andere Bein **derselben Person**.

Deshalb kann man T5-XXL nicht durch ein anderes, vielleicht sogar besseres
Sprachmodell ersetzen: Das Diffusionsmodell hat nie gelernt, was dessen Vektoren
visuell bedeuten. Es kennt nur die Zahlenstruktur, die T5-XXL während des Trainings
geliefert hat — und erwartet exakt diese Struktur bei der Inferenz.

```
Flux trainiert mit T5-XXL:    "Katze" → [0.34, -0.12, 0.87, ...]
Anderes Modell:                "Katze" → [0.71,  0.44, -0.23, ...]
                                          ↑ für das GGUF bedeutungslos
```

Das ist auch der Grund, warum T5-XXL **eingefroren** ist — es lernt bei der
Inferenz nichts dazu. Es ist ein festes Wörterbuch: immer dieselbe Eingabe,
immer derselbe Vektor. Deswegen reicht ein einziger Durchlauf im RAM.

### T5-XXL im RAM — kein Problem?

Bei llama.cpp ist RAM langsam, weil bei jedem Output-Token das gesamte Modell
durchlaufen wird (autoregressive Schleife, oft 200×).

T5-XXL läuft anders: **ein einziger Batch-Forward-Pass** über alle Prompt-Token
gleichzeitig. Danach ist seine Arbeit getan, das Embedding ist ein kleiner Vektor.
1–3 Sekunden im RAM, dann übernimmt die GPU für die Diffusionsschritte.

### Sind CLIP und VAE Flux-spezifisch?

- **CLIP-L**: identisch in SDXL und Flux — eine Datei für beide
- **VAE** (`ae.safetensors`): Flux-spezifisch, inkompatibel mit SD/SDXL-VAEs
- **T5-XXL**: Flux-spezifisch — SD-Modelle kennen ihn nicht

---

## Verzeichnisstruktur (weights/)

```
weights/                          ← ein Verzeichnis neben dem Repo
├── mein-modell-Q6_K.gguf         ← erscheint im Manager-Dropdown
├── anderes-modell.safetensors    ← erscheint im Manager-Dropdown
├── clip/
│   ├── clip_l.safetensors        ← CLIP-L Text-Encoder
│   └── t5xxl_fp16.safetensors   ← T5-XXL Text-Encoder (läuft auf CPU/RAM)
├── vae/
│   └── ae.safetensors            ← VAE-Decoder (Flux-spezifisch)
├── loras/                        ← LoRA-Gewichte (optional)
└── upscale_models/               ← Upscaler (optional)
```

**Warum Unterordner?** `list_checkpoints()` im Backend scannt nur den Root von
`weights/` — nicht rekursiv. Dateien in Unterordnern tauchen nicht im Dropdown
auf. Das hält den Auswahl-Bildschirm sauber: nur Diffusions-Checkpoints sichtbar,
keine Encoder oder VAEs.

Neue Encoder/VAE einfach in den passenden Unterordner legen — kein Neustart
des Managers nötig, ComfyUI findet sie beim nächsten Workflow-Run automatisch.

---

## extra_model_paths.yaml

```yaml
extra_models:
    base_path: /extra_models      # = weights/ auf dem Host, im Container als /extra_models gemountet
    clip: clip/                   # ComfyUI sucht CLIP-Modelle in /extra_models/clip/
    vae: vae/                     # VAE in /extra_models/vae/
    text_encoders: clip/          # T5-XXL ebenfalls in clip/ (ComfyUI-interner Typ-Name)
    loras: loras/
    upscale_models: upscale_models/
```

**Wo liegt die Datei?** `flux-manager/static/extra_model_paths.yaml` — versioniert
im Repo, gemountet über den bereits vorhandenen `static/`-Mount. Beim Container-Start
wird sie als `/root/ComfyUI/extra_model_paths.yaml` eingehängt — ComfyUI liest sie
automatisch aus seinem Basisverzeichnis, kein CLI-Flag nötig.

**Warum nicht in configs/?** `configs/` ist in `.gitignore` (Laufzeit-Daten).
Die yaml ist statisch — kein Grund, sie aus dem Repo auszuschließen oder
zur Laufzeit zu generieren.

---

## Wo landen generierte Bilder?

`flux-manager/outputs/` auf dem Host — direkt zugänglich, kein `docker cp`.
Der Ordner wird beim ersten Container-Start automatisch angelegt.
Inhalt ist in `.gitignore`, der Ordner selbst bleibt im Repo (via `.gitkeep`).

---

## ComfyUI-Workflow (Node-Editor)

ComfyUI ist kein simples Prompt-Feld, sondern ein **visueller Node-Editor**.
Nodes sind Funktionsbausteine — jeder macht genau eine Sache:

```
[T5-XXL laden] ──┐
[CLIP-L laden] ──┼─► [Text encodieren] ──► [KSampler] ──► [VAE decode] ──► [Bild speichern]
[GGUF laden]  ───┘         ▲
                     [Prompt-Text]
```

Ein **Workflow-JSON** ist ein gespeicherter Zustand dieses Node-Editors: welche
Nodes verbunden sind, welche Modelle ausgewählt, welche Parameter gesetzt.
Drag & Drop in ComfyUI lädt ihn fertig verdrahtet — nur Prompt eintippen, fertig.

LoRA ist ein optionaler Zusatz-Node, der Stil oder Konzepte einbringt.
Er ist kein Ersatz für Encoder oder VAE, sondern ein Modifikator obendrauf.

---

_Letzte Aktualisierung: 2026-09-15_
