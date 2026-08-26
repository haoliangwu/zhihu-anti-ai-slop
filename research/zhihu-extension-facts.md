# Zhihu question-page DOM + Manifest V3 facts (for a reading/badge extension)

## 1. Zhihu question-page DOM (zhihu.com/question/XXX)

- React SPA with **infinite scroll**: answers load in batches (~20) via XHR as the user scrolls; the DOM is re-rendered/appended, so a content script must use `MutationObserver` (zhihu-enhancement uses it ~23×, restarting it on SPA URL changes). Evidence: [egrcc/zhihu-python](https://github.com/egrcc/zhihu-python) paginates via POST to `zhihu.com/node/QuestionAnswerListV2` with `offset`, batches of 20 (zhihu.py L267, L429); a browser-automation reference notes scroll-to-load-more for answer lists ([site-patterns](https://git.hxr.so/desirecore/market/raw/commit/93fd40f6611b1c677fe13845a8c3ceab3a77b05a/skills/web-access/references/site-patterns/zhihu.com.md)).
- Stable selectors (corroborated across two actively maintained userscripts + the site-patterns reference):
  - Answer card: `.List-item`, `.Card.AnswerCard`, `.ContentItem.AnswerItem` (also `.AnswerItem`, `.ContentItem.ArticleItem`); comments `.CommentItemV2 .CommentRichText`.
  - Body: `.RichContent-inner` (`.RichText.ztext` inside); fallbacks `.RichContent`, `.HotItem-excerpt`; article body `.Post-RichText`.
  - **Collapsed long answers**: the truncated remainder is already in the DOM inside `.RichContent-collapsedText` (hidden) — zhihu-modifier unhides it without any fetch (zhihu-modifier L2103, L2186).
  - Data attributes: `data-za-detail-view-id`, `data-zop` (JSON incl. `authorName`), `data-za-extra-module` (JSON with `card.content`, e.g. upvote counts), `.AnswerItem-authorInfo>.AuthorInfo` for author; `#js-initialData` script tag carries `initialState.entities.*` keyed by question/answer IDs.
- First-150-300-chars extraction: `answerEl.querySelector('.RichContent-inner').textContent.trim()` — reading `textContent` of `.RichContent-inner` includes collapsed text (it is in the DOM).
- Unique identifiers: answer URL slug `zhihu.com/question/<qid>/answer/<aid>` (canonical per [zhihu-python Answer docs](https://deepwiki.com/egrcc/zhihu-python/2.2-answer)); card links contain `/answer/`; `data-za-extra-module` JSON. No documented stable `data-answer-id` attribute — key on the `/answer/<aid>` href or `#js-initialData`.
- Caveats: class names change often; long answers need "展开"; 盐选 (paid) content needs membership; full answers/展开阅读全文 require login.

## 2. Anti-bot / anti-extension behavior

- Login wall: logged-out visitors see limited answers; 展开阅读全文 prompts login ([LINUX DO thread](https://linux.do/t/topic/204895/11)).
- Risk control: abnormal UA / short-time high-frequency → slider captcha; auth state gated by `d_c0`, `z_c0` cookies ([site-patterns](https://git.hxr.so/desirecore/market/raw/commit/93fd40f6611b1c677fe13845a8c3ceab3a77b05a/skills/web-access/references/site-patterns/zhihu.com.md)).
- Plugins get broken: Obsidian Surfing extension got garbled 知乎 pages (anti-crawler; fixed by cookie change) ([forum](https://forum-zh.obsidian.md/t/topic/36833/2)); Selenium headless is restricted ([e-com-net](https://www.e-com-net.com/article/1686212392578527232.htm)); API traffic needs signed requests (`x-zse-96`) ([lostjay/zhihu_android_crawler](https://github.com/lostjay/zhihu_android_crawler)).
- No documented detection of the content-script isolated world; the real risk is SPA re-rendering + class-name churn (breakage reports live in userscript version histories, e.g. [zhihu-modifier versions](https://greasyfork.org/zh-CN/scripts/423404-知乎修改器/versions)).

## 3. Manifest V3 constraints

- Content scripts run in an **isolated world**; the **page CSP does not apply** (only when injected into the main world). Content-script CSP is `script-src 'self' 'wasm-unsafe-eval' ...` — WASM allowed, `eval()` not. DOM read/mutation is unrestricted. Directly accessible APIs: `dom`, `i18n`, `storage`, `runtime.*` ([content scripts doc](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)).
- Service worker: terminated after **30 s inactivity**; events/API calls reset the timer; a single request >5 min or a `fetch()` response >30 s kills it; `chrome.alarms` min period 30 s (Chrome 120+); offscreen-document messages reset timers (Chrome 109+). Design the SW to survive unexpected termination ([SW lifecycle doc](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)). Rule of thumb: DOM work in the content script; serialized/heavy work in SW or offscreen document.
- Storage: `chrome.storage` is available from content scripts with the `storage` permission; extension storage survives "clear browsing data" ([storage doc](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)). IndexedDB in content scripts works but lives on the **page origin**: shared with page scripts, wiped when site data is cleared, and invisible to the extension's own SW/background ([SO](https://stackoverflow.com/questions/13453418/is-it-possible-for-a-chrome-extension-to-access-an-indexeddb-database-created-by/13455572), [volcengine](https://www.volcengine.com/article/362120)).
- Local ML: transformers.js/ONNX Runtime Web run in MV3; recommended placement is the **service worker or offscreen document**, not the content script (SW can be killed mid-inference) — [HF guide](https://huggingface.co/blog/transformersjs-chrome-extension), [dev.to](https://dev.to/sathiyasenpai/why-i-moved-my-transformersjs-pipeline-out-of-the-chrome-mv3-service-worker-and-into-an-offscre-1kk4). Default CSP's `'wasm-unsafe-eval'` covers WASM; code must be bundled ([remote-code rejection, transformers.js#839](https://github.com/huggingface/transformers.js/issues/839)).

## 4. Known working examples

- [zhihu-enhancement](https://greasyfork.org/scripts/419081-zhihu-enhancement) (userscript, active): MutationObserver-driven; reads `.List-item`/`.Card.AnswerCard`/`.ContentItem.AnswerItem`, `.RichContent-inner`, `data-zop`/`data-za-extra-module`; inserts buttons into `.CornerAnimayedFlex`, appends `<style>`.
- [zhihu-modifier](https://greasyfork.org/zh-CN/scripts/423404-知乎修改器) (userscript, active): reads `.RichContent-inner`, `.RichContent-collapsedText`, `.AnswerItem-authorInfo>.AuthorInfo`; expands collapsed answers by hiding collapse state; injects CSS/UI.
- [mayooot/zhihu-hd-image-extractor](https://github.com/mayooot/zhihu-hd-image-extractor): userscript for answer images.
- MV3 reference: [nico-martin/gemma4-browser-extension](https://github.com/nico-martin/gemma4-browser-extension) — content script extracts page DOM, SW hosts transformers.js, side panel UI (per [HF guide](https://huggingface.co/blog/transformersjs-chrome-extension)).
