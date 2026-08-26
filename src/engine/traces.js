/**
 * 知乎照妖镜 — AI 创作痕迹清单（规则初审扣分依据）
 * 来源：research/ai-detection-prompts-facts.md（中文 AI 味特征 + 统计信号）。
 * 每条痕迹：{ id, name, weight(每次命中扣分), cap(计入扣分的命中上限), test(text)->命中次数 }
 * 依赖：constants.js（先加载）。
 */
'use strict';

const ZD = globalThis.ZhihuDetector;
ZD.traces = [
  {
    id: 'opening-boilerplate',
    name: '开场套话',
    weight: 12,
    cap: 1,
    test(t) {
      return /(在当今[^，。]{1,20}的时代|随着[^，。]{1,20}的发展|众所周知|在这个信息爆炸的时代|近年来，随着|随着社会的不断发展)/.test(t) ? 1 : 0;
    },
  },
  {
    id: 'connector-skeleton',
    name: '连接词骨架',
    weight: 4,
    cap: 3,
    test(t) {
      let n = 0;
      const hasFirst = /(首先|第一，)/.test(t);
      const hasMid = /(其次|第二，)/.test(t);
      if (hasFirst) n++;
      if (hasMid) n++;
      // 强收尾词独立计分
      if (/(综上所述|总而言之|由此可见)/.test(t)) n++;
      // 单独的"最后"是人类常用词，仅成链时计分
      if (/(最后[，,、]|最后$)/.test(t) && (hasFirst || hasMid)) n++;
      if (/(与此同时|一方面[^，。]{0,20}另一方面)/.test(t)) n++;
      return n;
    },
  },
  {
    id: 'empty-emphatic',
    name: '空洞强调',
    weight: 7,
    cap: 1,
    test(t) {
      return /(值得注意的是|值得一提的是|毫无疑问|不容忽视|显而易见的是|不可否认，)/.test(t) ? 1 : 0;
    },
  },
  {
    id: 'biz-jargon',
    name: '商务黑话',
    weight: 6,
    cap: 3,
    test(t) {
      const m = t.match(/(赋能|抓手|打通|闭环|底层逻辑|颗粒度|心智|护城河|降本增效|破局)/g);
      return m ? m.length : 0;
    },
  },
  {
    id: 'intensifier',
    name: '强化词滥用',
    weight: 3,
    cap: 3,
    test(t) {
      const m = t.match(/(极其|十分|非常|极为)/g);
      return m ? m.length : 0;
    },
  },
  {
    id: 'nominalized-verb',
    name: '名词化动词',
    weight: 5,
    cap: 2,
    test(t) {
      let n = 0;
      if (/进行[了着]?[一二三四五六七八九十两]?[项次][^，。；]{0,12}/.test(t)) n++;
      if (/加以[^，。；]{1,10}/.test(t)) n++;
      if (/实现[了着]?[^，。；]{2,10}(化|提升|增长|突破)/.test(t)) n++;
      return n;
    },
  },
  {
    id: 'meta-commentary',
    name: '元评论',
    weight: 6,
    cap: 1,
    test(t) {
      return /(让我们(?:一起)?来(?:探讨|聊聊|看看)|我来(?:谈谈|说说|聊聊|探讨)|我们来(?:聊聊|探讨)|接下来我将|在本文中|以下分几点|我会从|我想分享|下面，我就)/.test(t) ? 1 : 0;
    },
  },
  {
    id: 'inspirational-closer',
    name: '励志结尾',
    weight: 6,
    cap: 1,
    test(t) {
      return /(愿你[^。！]{0,20}|未来可期|道阻且长|向阳而生|砥砺前行|这，就是[^。！]{1,20}的力量)/.test(t) ? 1 : 0;
    },
  },
  {
    id: 'tricolon',
    name: '排比模板（是X，是X，更是X）',
    weight: 8,
    cap: 1,
    test(t) {
      return /(?:是|不仅是|不只是|不光是|更是)[^，。！？]{2,12}，更是[^，。！？]{2,12}|是[^，。！？]{2,12}，是[^，。！？]{2,12}，更是[^，。！？]{2,12}/.test(t) ? 1 : 0;
    },
  },
  {
    id: 'fake-intimacy',
    name: '伪亲密称呼',
    weight: 5,
    cap: 1,
    test(t) {
      return /(亲爱的读者|家人们|小伙伴们|各位朋友|朋友们，)/.test(t) ? 1 : 0;
    },
  },
  {
    id: 'superlative',
    name: '最高级堆砌',
    weight: 4,
    cap: 2,
    test(t) {
      const m = t.match(/(至关重要|不可或缺|显著|卓越|极致|无可替代)/g);
      return m ? m.length : 0;
    },
  },
  {
    id: 'idiom-cluster',
    name: '成语堆砌',
    weight: 4,
    cap: 2,
    test(t) {
      const m = t.match(/(博大精深|源远流长|欣欣向荣|相辅相成|举足轻重|日新月异)/g);
      return m ? m.length : 0;
    },
  },
  {
    id: 'dead-metaphor',
    name: '死隐喻',
    weight: 4,
    cap: 2,
    test(t) {
      const m = t.match(/(双刃剑|灯塔|基石|引擎|马拉松|指明灯|试金石)/g);
      return m ? m.length : 0;
    },
  },
  {
    id: 'flat-sentence',
    name: '句长齐整（统计）',
    weight: 8,
    cap: 1,
    test(t) {
      // 连续 3+ 句长度相差 ≤8 字 → 句式单调
      const sents = t
        .split(/[。！？!?\n]/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 8 && s.length <= 60);
      let run = 1;
      for (let i = 1; i < sents.length; i++) {
        if (Math.abs(sents[i].length - sents[i - 1].length) <= 8) {
          run++;
          if (run >= 3) return 1;
        } else {
          run = 1;
        }
      }
      return 0;
    },
  },
  {
    id: 'period-as-comma',
    name: '句号当顿号',
    weight: 5,
    cap: 1,
    test(t) {
      // 连续 3+ 个短句都以句号结尾（苹果。香蕉。橘子。）
      return /([^。！？!?\n]{1,8}。){3,}/.test(t) ? 1 : 0;
    },
  },
  {
    id: 'dash-repetition',
    name: '破折号反复',
    weight: 4,
    cap: 1,
    test(t) {
      const m = t.match(/——/g);
      return m && m.length >= 2 ? 1 : 0;
    },
  },
];
