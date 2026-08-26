# transformers.js in an MV3 extension: facts for a Chinese AI-vs-human classifier (150–300 chars)

All sizes from the HF API (`huggingface.co/api/models/<id>?blobs=true`, retrieved 2026-08-26); other claims cite sources inline.

## 1. transformers.js status & how it runs

- Runs models via ONNX Runtime Web (onnxruntime-web); WASM backend by default, WebGPU via `device: 'webgpu'` — [docs](https://huggingface.co/docs/transformers.js/guides/webgpu), [README](https://github.com/huggingface/transformers.js).
- npm latest: **4.2.0** (v4; registry.npmjs.org, retrieved today); docs site lists stable v3.8.1. v3 release: "WebGPU support (up to 100x faster than WASM!)", 120 supported architectures, 1200+ pre-converted ONNX models — [v3 blog](https://huggingface.co/blog/transformersjs-v3).
- `text-classification` task: supported; encoder architectures incl. BERT, RoBERTa, XLM-RoBERTa, DistilBERT, ALBERT, ELECTRA, DeBERTa, MobileBERT — [README tasks/models tables](https://github.com/huggingface/transformers.js).
- Content script: runs in an isolated world; the page CSP does not apply; content-script CSP allows `'wasm-unsafe-eval'` — [Chrome content-scripts doc](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts).
- Extension-page constraints: MV3 default `extension_pages` CSP is `script-src 'self'; object-src 'self'` → WebAssembly disabled unless you declare `'wasm-unsafe-eval'` (minimum policy `script-src 'self' 'wasm-unsafe-eval'`); remote/CDN code never allowed — [Chrome CSP doc](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy).
- Concrete failure: loading ort-wasm from jsdelivr in an MV3 extension → "no available backend found"; fix is bundling the wasm locally — [issue #1248](https://github.com/huggingface/transformers.js/issues/1248).
- MV3 service worker is suspended after ~30 s inactivity; an in-memory 22 MB pipeline is GC'd and re-init takes 2–4 s on midrange hardware; wasm worker-thread fetches are flaky in SW; Offscreen Document (Chrome 109+) is the persistent alternative — [dev.to (Sathiya)](https://dev.to/sathiyasenpai/why-i-moved-my-transformersjs-pipeline-out-of-the-chrome-mv3-service-worker-and-into-an-offscreen-1kk4).
- Official examples host the pipeline in the background SW; the content script only messages it — [HF browser-extension example](https://github.com/huggingface/transformers.js-examples/tree/main/browser-extension), [legacy example](https://github.com/kungfooman/transformers.js/tree/05ee202acad0ba5337d141fb06e772b6e18f179b/examples/extension).
- Official HF guide (Apr 2026): models loaded from the SW are cached under the extension origin (`chrome-extension://<id>`), one shared cache for the install; treat model state as recoverable because the SW restarts — [HF blog](https://huggingface.co/blog/transformersjs-chrome-extension).

## 2. Model candidates (file sizes, HF API)

| Model | Size | ONNX? | License |
|---|---|---|---|
| Xenova/bert-base-chinese | fp32 409.4 MB; fp16 204.9; int8 103.1; q4 120.8; q4f16 82.0 | yes (ready) | (HF-converted) |
| uer/chinese_roberta_L-10_H-256 | 54.2 MB fp32 | no (export via Optimum) | no tag |
| uer/roberta-base-finetuned-chinanews-chinese / -jd-binary-chinese | 409.2 MB fp32 | no | no tag |
| hfl/chinese-roberta-wwm-ext | 411.6 MB fp32 | no | Apache-2.0 |
| yuchuantian/AIGC_detector_zhv3 (Chinese AIGC detector) | 409.1 MB fp32 | no | Apache-2.0 |
| mokawa3018/cmj-chinese-aigc-text-detector (fine-tuned zhv3) | onnx/model.onnx 409.4 MB (no quantized) | yes | Apache-2.0 |
| huolongguo10/LLM_detect | 409.1 MB | no | — |
| bibbbu/multilingual-ai-human-detector_xlm-roberta-base | XLM-R-base class (~1 GB) | no | — |

- Detector metrics (card, full-length texts): mokawa3018 — 92.85% acc (mixed fixed test), HC3-Chinese 91.84% acc / 8.84% human FPR; ONNX matches PyTorch (max logit diff 1.43e-6) — [model card](https://huggingface.co/mokawa3018/cmj-chinese-aigc-text-detector).
- Inference speed: only sourced figure is HF's "up to 100x" WASM→WebGPU claim ([v3 blog](https://huggingface.co/blog/transformersjs-v3)); no independent per-inference benchmark for BERT-class classifiers was verified.

## 3. Caching / fallback

- Browser env caches models in the **Cache Storage API** by default (`env.useBrowserCache === true`); persists across reloads/sessions; Chrome quota ~60% of disk but evictable — [huggingface/skills CACHE.md](https://github.com/huggingface/skills/blob/main/skills/transformers-js/references/CACHE.md).
- Offline: first load needs network; later loads served from cache. Extension: load from the SW so cache lives under the extension origin ([HF blog](https://huggingface.co/blog/transformersjs-chrome-extension)).
- Recommended caching for an extension: bundle model + wasm locally (MV3 already forces local wasm) or pre-fetch into Cache Storage. `chrome.storage.local` default quota is 10 MB (unlimitedStorage permission raises it) — [Chrome storage doc](https://developer.chrome.com/docs/extensions/reference/storage/) — too small for a 100 MB model.
- If the model cannot load: no local detection is possible; a fully-local extension has no server fallback.

## 4. Accuracy caveats (short texts)

- OpenAI's classifier (Jan 2023, archived; later discontinued): "very unreliable on short texts (below 1,000 characters)", English-only, 26% TP / 9% FP on its challenge set, evadable by editing — [OpenAI (archived)](https://web.archive.org/web/20230202002402/https://openai.com/blog/new-ai-classifier-for-indicating-ai-written-text/).
- HC3 sentence-level (short) texts: fine-tuned BERT/RoBERTa detectors drop 97.6/97.4% → 57.7/58.6% accuracy; DetectGPT 87.4% → 63.3%; "most baselines perform poorly on short texts" — [arXiv 2305.18149](https://ar5iv.labs.arxiv.org/html/2305.18149).
- Paraphrase attacks on ~300-token passages significantly reduce detection rates; theoretical limits on detectability — [arXiv 2303.11156](https://arxiv.org/abs/2303.11156).
- Chinese-specific: BERT/RoBERTa detectors overfit in-domain; "previous methods struggle with sentence-level AI-generated text detection" (Chinese, 9 LLM families) — [arXiv 2402.01158](https://arxiv.org/abs/2402.01158).
- 150–300 Chinese characters is sentence/paragraph level: expect large degradation vs the 92% figures above, which are for full-length texts.
