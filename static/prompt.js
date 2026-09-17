(() => {
'use strict';

const CLIENT_ID     = 'prompt-ui-' + Math.random().toString(36).slice(2, 10);
const POLL_INTERVAL = 2000;
const POLL_MAX      = 90; // 3 min

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
const btnGenerate     = document.querySelector('.btn-generate');

// Result UI injected after the generate row
const statusEl  = Object.assign(document.createElement('div'), { className: 'gen-status', hidden: true });
const resultEl  = Object.assign(document.createElement('div'), { className: 'gen-result' });
const generateRow = document.querySelector('.generate-row');
generateRow.after(resultEl);
generateRow.after(statusEl);

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

// --- Main handler ---
btnGenerate.addEventListener('click', async () => {
  const base     = endpointInput.value.trim().replace(/\/$/, '');
  let   t5Text   = promptT5.value.trim();
  const clipText = promptClip.value.trim();

  btnGenerate.disabled = true;
  btnGenerate.textContent = 'Lädt…';
  resultEl.innerHTML = '';
  setStatus('');

  try {
    // Load workflow and extract model names
    const wfName = workflowSel.value;
    if (!wfName) throw new Error('Kein Workflow ausgewählt');
    setStatus('Lade Workflow…');
    const wfRes = await fetch(`/api/workflows/${encodeURIComponent(wfName)}`);
    if (!wfRes.ok) throw new Error(`Workflow nicht gefunden: ${wfName}`);
    const workflow = await wfRes.json();
    const models   = extractModels(workflow);
    if (!models.unet) throw new Error('Workflow hat keinen UnetLoaderGGUF-Node');

    // Optional translation
    if (translateToggle.checked && t5Text) {
      setStatus('Übersetze DE → EN…');
      t5Text = await translate(t5Text);
    }

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

    setStatus(`Generiere… (${promptId.slice(0, 8)})`);
    const image = await pollHistory(promptId);

    showImage(image.filename, image.subfolder);
    setStatus('Fertig.', 'success');

  } catch (err) {
    setStatus(err.message, 'error');
    console.error(err);
  } finally {
    btnGenerate.disabled = false;
    btnGenerate.textContent = 'Generieren →';
  }
});

// Load workflow list on page load
loadWorkflows();

})();
