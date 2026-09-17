(() => {
'use strict';

const CLIENT_ID     = 'prompt-ui-' + Math.random().toString(36).slice(2, 10);
const POLL_INTERVAL = 2000;
const POLL_MAX      = 300; // 10 min

const $ = id => document.getElementById(id);

const endpointInput   = document.querySelector('.conn-bar input[type="text"]');
const apiKeyInput     = document.querySelector('.conn-bar input[type="password"]');
const translateToggle = $('translateToggle');
const workflowSel     = $('workflowSel');
const promptT5        = $('promptT5');
const promptClip      = $('promptClip');
const stepsText       = $('stepsText');
const cfgText         = $('cfgText');
const denoiseText     = $('denoiseText');
const seedInput       = $('seedInput');
const samplerSel      = $('samplerSel');
const schedulerSel    = $('schedulerSel');
const btnStop               = $('btnStop');
const btnTranslate          = $('btnTranslate');
const translateResult       = $('translateResult');
const promptT5Translated    = $('promptT5Translated');
const btnTranslateClip      = $('btnTranslateClip');
const translateResultClip   = $('translateResultClip');
const promptClipTranslated  = $('promptClipTranslated');
const btnGenerate     = document.querySelector('.btn-generate');
const genProgress     = $('genProgress');
const progressFill    = $('progressFill');
const progressLabel   = $('progressLabel');

// Result UI injected after the generate row
const statusEl  = Object.assign(document.createElement('div'), { className: 'gen-status', hidden: true });
const resultEl  = Object.assign(document.createElement('div'), { className: 'gen-result' });
const generateRow = document.querySelector('.generate-row');
generateRow.after(resultEl);
generateRow.after(statusEl);

// --- WebSocket Progress ---
let _ws = null;
let _currentPromptId = null;
let _abort = false;

function openProgressWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  _ws = new WebSocket(`${proto}//${location.host}/api/comfy/ws?clientId=${CLIENT_ID}`);
  _ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'executing' && msg.data.prompt_id === _currentPromptId && msg.data.node) {
        setStatus(`Generiere… (${_currentPromptId.slice(0, 8)})`);
      }
      if (msg.type === 'progress') {
        const { value, max } = msg.data;
        const pct = max > 0 ? (value / max * 100).toFixed(1) : 0;
        progressFill.style.width = `${pct}%`;
        progressLabel.textContent = `${value} / ${max}`;
      }
    } catch { /* binary oder kein JSON */ }
  };
}

function closeProgressWS() {
  if (_ws) { _ws.close(); _ws = null; }
}

// Translate button: visible only when toggle is on
function syncTranslateBtn() {
  const v = translateToggle.checked ? '' : 'none';
  btnTranslate.style.display     = v;
  btnTranslateClip.style.display = v;
  btnGenerate.textContent = translateToggle.checked ? 'Übersetzen & Generieren →' : 'Generieren →';
}
translateToggle.addEventListener('change', syncTranslateBtn);
syncTranslateBtn();

async function runTranslate(srcEl, dstEl, resultEl, btn) {
  const text = srcEl.value.trim();
  if (!text) return;
  btn.disabled = true;
  btn.textContent = '…';
  setStatus('Übersetze DE → EN…');
  try {
    dstEl.value = await translate(text);
    resultEl.hidden = false;
    setStatus('Übersetzt — bitte prüfen, dann Generieren klicken.', 'success');
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'DE → EN';
  }
}

btnTranslate.addEventListener('click',     () => runTranslate(promptT5,   promptT5Translated,   translateResult,     btnTranslate));
btnTranslateClip.addEventListener('click', () => runTranslate(promptClip, promptClipTranslated, translateResultClip, btnTranslateClip));

function setStatus(msg, type = 'info') {
  statusEl.textContent = msg;
  statusEl.dataset.type = type;
  statusEl.hidden = !msg;
}

function showImage(filename, subfolder) {
  const url = `/api/comfy/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder || '')}&type=output`;
  resultEl.innerHTML = '';
  const img   = Object.assign(document.createElement('img'),
    { src: url, alt: 'Generiertes Bild', className: 'gen-img' });
  const label = Object.assign(document.createElement('div'),
    { textContent: filename, className: 'gen-filename' });
  resultEl.append(img, label);
}

function comfyHeaders() {
  const key = apiKeyInput.value.trim();
  const h = { 'Content-Type': 'application/json' };
  if (key) h['Authorization'] = `Bearer ${key}`;
  return h;
}

// --- Workflow loading ---
async function loadWorkflows() {
  try {
    const res  = await fetch('/api/workflows/list');
    const data = await res.json();
    if (!data.workflows?.length) throw new Error('leer');
    workflowSel.innerHTML = data.workflows
      .map(w => `<option value="${w}">${w.replace(/\.json$/i, '')}</option>`)
      .join('');
  } catch {
    workflowSel.innerHTML = '<option value="">– keine Workflows –</option>';
  }
}

// Extract model filenames from workflow node list
function extractModels(workflow) {
  const m = {};
  for (const node of workflow.nodes ?? []) {
    if (node.type === 'UnetLoaderGGUF')  m.unet  = node.widgets_values?.[0];
    if (node.type === 'DualCLIPLoader') { m.clip1 = node.widgets_values?.[0]; m.clip2 = node.widgets_values?.[1]; }
    if (node.type === 'VAELoader')        m.vae   = node.widgets_values?.[0];
  }
  return m;
}

// --- Translation ---
async function translate(text) {
  const res = await fetch('/api/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  });
  if (!res.ok) throw new Error(`Übersetzung fehlgeschlagen (${res.status})`);
  return (await res.json()).translated;
}

// --- ComfyUI API ---
// CLIPTextEncodeFlux gives T5-XXL and CLIP-L separate inputs — proper Flux dual-prompt encoding
// guidance (~3.5) is Flux-internal attention guidance, separate from KSampler cfg
function buildPayload(t5Text, clipText, p, m) {
  return {
    client_id: CLIENT_ID,
    prompt: {
      "1": { class_type: "UnetLoaderGGUF",     inputs: { unet_name: m.unet } },
      "2": { class_type: "DualCLIPLoader",      inputs: { clip_name1: m.clip1, clip_name2: m.clip2, type: "flux" } },
      "3": { class_type: "VAELoader",           inputs: { vae_name: m.vae } },
      "4": { class_type: "CLIPTextEncodeFlux",  inputs: { clip: ["2", 0], t5xxl: t5Text, clip_l: clipText || t5Text, guidance: 3.5 } },
      "5": { class_type: "CLIPTextEncode",      inputs: { clip: ["2", 0], text: "" } },
      "6": { class_type: "EmptySD3LatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
      "7": { class_type: "KSampler",            inputs: {
        model: ["1", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["6", 0],
        seed: p.seed, steps: p.steps, cfg: p.cfg,
        sampler_name: p.sampler, scheduler: p.scheduler, denoise: p.denoise
      }},
      "8": { class_type: "VAEDecode",           inputs: { samples: ["7", 0], vae: ["3", 0] } },
      "9": { class_type: "SaveImage",           inputs: { images: ["8", 0], filename_prefix: "flux" } }
    }
  };
}

async function submitPrompt(payload) {
  const res = await fetch('/api/comfy/prompt', {
    method: 'POST', headers: comfyHeaders(), body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`ComfyUI /prompt ${res.status}${detail ? ': ' + detail : ''}`);
  }
  return (await res.json()).prompt_id;
}

async function pollHistory(promptId) {
  for (let i = 0; i < POLL_MAX; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
    if (_abort) throw new Error('Abgebrochen.');
    try {
      const res = await fetch(`/api/comfy/history/${promptId}`, { headers: comfyHeaders() });
      if (!res.ok) continue;
      const data  = await res.json();
      const entry = data[promptId];
      if (!entry?.outputs) continue;
      for (const node of Object.values(entry.outputs)) {
        if (node.images?.length) return node.images[0];
      }
    } catch { /* network hiccup, retry */ }
  }
  throw new Error(`Timeout: kein Ergebnis nach ${Math.round(POLL_MAX * POLL_INTERVAL / 60000)} Minuten`);
}

// --- Stop handler ---
btnStop.addEventListener('click', async () => {
  _abort = true;
  btnStop.disabled = true;
  setStatus('Wird abgebrochen…');
  try {
    await fetch('/api/comfy/interrupt', { method: 'POST', headers: comfyHeaders() });
  } catch { /* best effort */ }
});

// --- Main handler ---
btnGenerate.addEventListener('click', async () => {
  const needsT5   = translateToggle.checked && promptT5.value.trim()   && !promptT5Translated.value.trim();
  const needsClip = translateToggle.checked && promptClip.value.trim() && !promptClipTranslated.value.trim();

  // Schritt 1: nur übersetzen, dann warten
  if (needsT5 || needsClip) {
    btnGenerate.disabled = true;
    btnGenerate.textContent = 'Übersetze…';
    setStatus('Übersetze DE → EN…');
    try {
      if (needsT5) {
        promptT5Translated.value = await translate(promptT5.value.trim());
        translateResult.hidden = false;
      }
      if (needsClip) {
        promptClipTranslated.value = await translate(promptClip.value.trim());
        translateResultClip.hidden = false;
      }
      btnGenerate.textContent = 'Übersetztes generieren →';
      btnGenerate.disabled = false;
      setStatus('Übersetzung fertig — prüfen, dann generieren.', 'success');
    } catch (err) {
      setStatus(err.message, 'error');
      btnGenerate.disabled = false;
      syncTranslateBtn();
    }
    return;
  }

  // Schritt 2: generieren
  const base = endpointInput.value.trim().replace(/\/$/, '');

  btnGenerate.disabled = true;
  btnGenerate.textContent = 'Lädt…';
  resultEl.innerHTML = '';
  setStatus('');
  progressFill.style.width = '0%';
  progressLabel.textContent = `0 / ${parseInt(stepsText.value) || 20}`;
  genProgress.hidden = false;
  btnStop.hidden = false;
  _abort = false;
  openProgressWS();

  try {
    const t5Text   = promptT5Translated.value.trim()   || promptT5.value.trim();
    const clipText = promptClipTranslated.value.trim() || promptClip.value.trim();

    // Load workflow and extract model names
    const wfName = workflowSel.value;
    if (!wfName) throw new Error('Kein Workflow ausgewählt');
    setStatus('Lade Workflow…');
    const wfRes = await fetch(`/api/workflows/${encodeURIComponent(wfName)}`);
    if (!wfRes.ok) throw new Error(`Workflow nicht gefunden: ${wfName}`);
    const workflow = await wfRes.json();
    const models   = extractModels(workflow);
    if (!models.unet) throw new Error('Workflow hat keinen UnetLoaderGGUF-Node');

    const params = {
      seed:      parseInt(seedInput.value)     || Math.floor(Math.random() * 9999999999999),
      steps:     parseInt(stepsText.value)     || 20,
      cfg:       parseFloat(cfgText.value)     || 1.0,
      sampler:   samplerSel.value,
      scheduler: schedulerSel.value,
      denoise:   parseFloat(denoiseText.value) || 1.0,
    };

    setStatus('Sende Workflow…');
    const promptId = await submitPrompt(buildPayload(t5Text, clipText, params, models));
    _currentPromptId = promptId;

    setStatus('Modell wird geladen…');
    const image = await pollHistory(promptId);

    showImage(image.filename, image.subfolder);
    setStatus('Fertig.', 'success');

  } catch (err) {
    setStatus(err.message, 'error');
    console.error(err);
  } finally {
    closeProgressWS();
    _currentPromptId = null;
    _abort = false;
    genProgress.hidden = true;
    btnStop.hidden = true;
    btnStop.disabled = false;
    btnGenerate.disabled = false;
    syncTranslateBtn(); // setzt korrektes Label je nach Toggle-Zustand
  }
});

// Load workflow list on page load
loadWorkflows();

})();
