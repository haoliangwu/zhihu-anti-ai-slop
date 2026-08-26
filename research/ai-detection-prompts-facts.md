# AI-Text Detection Research: Prompts, Features, Reusable Skills

Research for the Zhihu AI-answer detector (local rule engine + DeepSeek second opinion). All facts verified against primary sources, July 2026.

## 1. Proven LLM prompts for AI-text detection

- **harshaneel/humanize `ai-check` skill** (the best copyable template): instructs the model to score **9 signal categories 0–3** with an explicit severity→score map ("No flagged instances = 0; one weak instance = 1; one moderate or 2+ weak = 2; one strong or 2+ moderate or 4+ weak = 3"), total cap 27, a double-counting policy, **"every fired signal cites evidence"** (exact quote), and output = verdict + confidence + AI-edited-fraction estimate. https://github.com/harshaneel/humanize (ai-check/SKILL.md)
- **BetterPromptme `ai-text-detection` skill**: "evaluate a provided text for signs of AI, human, or mixed authorship by examining observable linguistic, structural, semantic, and repetition-based features, then assign a composite AI-likelihood score with evidence-based indicators, a confidence level, and a final classification in a fixed, interpretable output format." https://github.com/BetterPromptme/skills (skills/ai-text-detection)
- **G-Eval (Liu et al. 2023)**: chain-of-thought through rubric steps *before* returning the score; weight final score by token probability of each score value. Higher human agreement than direct scoring. https://arxiv.org/abs/2303.16634 ; prompt template at https://raw.githubusercontent.com/agentii-ai/pmf-kit/refs/heads/main/specs/003-workflow-optimization/research/g-eval-prompt.md
- Anthropic prompt-engineering guide: require reasoning/evidence before verdict; use structured output. https://platform.claude.com/docs/build-with-claude/prompt-engineering

## 2. Discriminative features (rule-engine deductions)

**Chinese AI cliches** — VincentOld/stop-slop-zh `references/phrases.md` is a ready-made blacklist with 12 categories: opening boilerplate (在当今XX的时代/随着XX的发展/众所周知/在这个信息爆炸的时代); connector skeletons (首先/其次/最后, 综上所述/总而言之/由此可见, 与此同时, 一方面…另一方面…); empty emphatics (值得注意的是/值得一提的是/毫无疑问/不容忽视); biz jargon (赋能/抓手/打通/闭环/底层逻辑/颗粒度/心智); intensifiers (非常/十分/极其, "很" >5/千字); nominalized verbs (进行+N/实现+N/加以+N); meta-commentary (让我们来探讨/接下来我将/在本文中/以下分几点讲); inspirational closers (愿你/未来可期/道阻且长/向阳而生/"这，就是XX的力量"); tricolon templates ("是XX，是XX，更是XX"); fake intimacy (亲爱的读者/家人们/小伙伴们); superlatives (重要/显著/卓越/极致); idiom clusters (博大精深/源远流长/欣欣向荣/砥砺前行); dead metaphors (双刃剑/灯塔/基石/引擎/马拉松/钥匙). https://github.com/VincentOld/stop-slop-zh/blob/main/references/phrases.md

**Statistical signals**:
- **Perplexity**: old GPTZero — per-sentence perplexity >85 leans human; low perplexity = predictable = AI. **Burstiness**: variance of perplexity across sentences; AI has consistently low burstiness. (GPTZero retired P/B in 2023 for deep learning: https://arxiv.org/abs/2602.13042) https://support.gptzero.me/articles/9585228410-how-do-i-interpret-burstiness-or-perplexity
- **DetectGPT (ICML'23)**: perturbations of AI text drop in model log-probability far more than human text — "probability curvature" zero-shot. https://arxiv.org/abs/2301.11305
- **Sentence-length variance**: 3+ consecutive sentences within 5 words of each other = AI; a 150-word block with no sentence <8 words = AI. https://github.com/harshaneel/humanize (Signal B)
- **Punctuation**: >1 em dash per 300 words; double em-dash wrapping (— X —); mid-sentence colon ("The problem: nobody tests this"). https://github.com/harshaneel/humanize (Signal G). Chinese: 破折号"——"反复、句号当顿号（"苹果。香蕉。橘子。"）、"。。。"
- **Chinese deep-learning paper (AIMS 2025)**: low sentence-length variation + dense punctuation → AI; LLM text has repetitive lexical selection; Qwen2.5 hardest to detect (88.91% acc) vs Phi4/DeepSeek-R1 (100% recall). https://www.aimspress.com/article/doi/10.3934/bdia.2025016
- **Six "AI味" features** (Chinese blog, well-cited): template 总-分-总 structure; connector overuse; uniform sentence rhythm; "safe mediocrity" (既要又要, hedged claims); specificity deficit (许多研究表明/近年来显著提升); flat emotion curve. https://www.cnblogs.com/jiangaigc/articles/22684257
- **Chinese webnovel detector**: ready-made weighted 0–10 scoring table — 比喻密度 ≤3/千字, 连续同句式 ≥3 连发, 段内最长句/最短句 ≥3 倍, 极端词 ≤2–3/千字, tell 密度, 排比 ≤1/章. https://github.com/tance-mang/chinese-webnovel-skills/blob/main/references/ai-detector.md

## 3. Existing skills/tools

- **anthropics/skills: NO detection skill.** Contents: academy-guide, algorithmic-art, brand-guidelines, canvas-design, claude-api, discernment-nudge, doc-coauthoring, docx, frontend-design, internal-comms, mcp-builder, pdf, pptx, skill-creator, slack-gif-creator, theme-factory, web-artifacts-builder, webapp-testing, xlsx. https://github.com/anthropics/skills
- Third-party: `harshaneel/humanize` (ai-check), `BetterPromptme/skills` (ai-text-detection), `tance-mang/chinese-webnovel-skills` (aidetect skill + ai-detector.md + anti-ai-checklist.md — Chinese), `VincentOld/stop-slop-zh` (Chinese phrase lists), `Gx664/AIGC` (local Chinese detector toolbox: SimpleAI/GLTR/Fast-DetectGPT, MIT), `YuchuanTian/AIGC_text_detector` (ICLR'24 Spotlight, multiscale PU), `ssamba1/untell` (humanizer with live detector loop).

## 4. Calibration advice for the cloud verdict

- **DeepSeek JSON mode**: `response_format: {"type": "json_object"}` + "Please output JSON" forces a parseable verdict. https://api-docs.deepseek.com/guides/json_mode/ — schema: `{"score": 0-100, "ai_signals": [...], "human_signals": [...], "verdict": "human|mixed|ai"}`. Ask for evidence first, score last.
- **G-Eval trick**: derive score from token log-probabilities of score tokens rather than raw output text — more stable than prose.
- **Known judge biases** (https://futureagi.com/blog/llm-as-a-judge/): position bias, verbosity bias, **self-preference** (don't let DeepSeek judge text plausibly written by DeepSeek — bias it toward "AI"), self-enhancement; **score compression** (judges cluster mid-scale — your 20–80 uncertain band will attract scores); calibrate against human labels (Cohen's kappa >0.6).
- **Pitfalls**: (a) false positives on literary/classical Chinese — 《滕王阁序》 scored ~100% AI by real detectors (https://www.cssn.cn/skgz/bwyc/202506/t20250610_5878364.shtml); (b) LLMs disagree wildly on AI text — a Lu Xun-style AI essay was judged human by Gemini/GLM/DeepSeek/Grok but 70–85% AI by ChatGPT (https://www.suiyan.cc/blog/20260725191701); (c) SHAP analysis shows detectors rely on dataset-specific stylistic cues, not stable authorship signals — down-weight "too smooth" for registers that reward polish (academic/marketing) (cited in ai-check).
- **Practical fix**: instruct "assume the text is human unless strong evidence; report confidence; flag low-information text (under ~50 chars) as 'insufficient'". Anchor with both AI-typical AND human-typical feature lists to reduce bias.
