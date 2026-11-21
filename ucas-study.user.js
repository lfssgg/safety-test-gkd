// ==UserScript==
// @name         UCAS 实安课堂 · 题库驱动全自动学习助手
// @namespace    https://ucas.jcedutec.cn/
// @version      2.0.1
// @description  以题干和选项为主匹配 4304 道题库，题目 ID 仅作辅助；未命中时使用 DeepSeek；自动答题并续刷未完成课程。
// @author       Zyoung&GPT
// @homepageURL  https://github.com/lfssgg/safety-test-gkd
// @supportURL   https://github.com/lfssgg/safety-test-gkd/issues
// @updateURL    https://raw.githubusercontent.com/lfssgg/safety-test-gkd/main/ucas-study.user.js
// @downloadURL  https://raw.githubusercontent.com/lfssgg/safety-test-gkd/main/ucas-study.user.js
// @match        http://ucas.jcedutec.cn:8822/*
// @match        https://ucas.jcedutec.cn:8822/*
// @match        http://ucas.jcedutec.cn/*
// @match        https://ucas.jcedutec.cn/*
// @connect      api.deepseek.com
// @connect      raw.githubusercontent.com
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';
  const VERSION = '2.0.1';
  const ID = 'ucas-deepseek-study-assistant-v1';
  const RUN_KEY = 'ucas-ds-study-running';
  const API = 'https://api.deepseek.com/chat/completions';
  const QUESTION_BANK_URL = 'https://raw.githubusercontent.com/lfssgg/safety-test-gkd/main/ucas_all_20_categories_4304_raw.json';
  const QUESTION_BANK_CACHE_KEY = 'ucas-ds-question-bank-cache-v2';
  const QUESTION_BANK_CHECK_KEY = 'ucas-ds-question-bank-last-check-v2';
  const QUESTION_BANK_UPDATED_KEY = 'ucas-ds-question-bank-last-update-v2';
  const QUESTION_BANK_REFRESH_INTERVAL = 24 * 60 * 60 * 1000;
  if (document.getElementById(ID)) return;

  const defaults = {
    apiKey: '', model: 'deepseek-v4-pro', speed: 1.5,
    reasoningEffort: 'high', doubleCheck: true, webVerify: true, reference: '',
    useQuestionBank: true,
    autoNext: true, autoAI: true, autoApply: true, autoSubmit: true, autoStart: true,
    autoLocate: true, refreshAfterEnd: true
  };
  // 沿用 v1.4 的 API Key、倍速等配置；质量模式的升级迁移独立处理。
  const saved = GM_getValue('ucas-ds-options-v1', {}) || {};
  let prefs = { ...defaults, ...saved };
  if (!GM_getValue('ucas-ds-migrated-v12', false)) {
    prefs.autoAI = true;
    prefs.autoApply = true;
    prefs.autoSubmit = true;
    prefs.autoNext = true;
    prefs.autoStart = true;
    GM_setValue('ucas-ds-options-v1', prefs);
    GM_setValue('ucas-ds-migrated-v12', true);
  }
  if (!GM_getValue('ucas-ds-migrated-v15', false)) {
    if (!saved.model || saved.model === 'deepseek-flash') prefs.model = 'deepseek-v4-pro';
    prefs.reasoningEffort = 'high';
    prefs.doubleCheck = true;
    savePreferencesEarly();
    GM_setValue('ucas-ds-migrated-v15', true);
  }
  function savePreferencesEarly() { GM_setValue('ucas-ds-options-v1', prefs); }
  let running = sessionStorage.getItem(RUN_KEY) === '1' || (prefs.autoStart && (Boolean(prefs.apiKey) || prefs.useQuestionBank !== false));
  let boundVideo = null;
  let boundSrc = null;
  const seenVideos = new WeakSet();
  let pendingNext = false;
  let navigating = false;
  let reloading = false;
  let locating = Boolean(running && prefs.autoLocate && /\/students\/courseDetail/i.test(location.pathname));
  let locateTask = null;
  let thinking = false;
  const retryAfter = new Map();
  let lastResult = null;
  const processed = new Set();
  const notes = [];
  const vueQuestionCache = new WeakMap();
  let questionBankIndex = null;
  let questionBankLoading = null;
  let questionBankStatus = '尚未加载';
  let questionBankUpdatedAt = Number(GM_getValue(QUESTION_BANK_UPDATED_KEY, 0)) || 0;

  function save() { GM_setValue('ucas-ds-options-v1', prefs); }
  function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  function visible(el) {
    if (!el || !el.isConnected || !el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }
  function time() { return new Date().toLocaleTimeString('zh-CN', { hour12: false }); }

  const host = document.createElement('div');
  host.id = ID;
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      #panel { position: fixed; right: 16px; bottom: 16px; width: 342px; max-width: calc(100vw - 32px);
        z-index: 2147483646; background: #fff; color: #21364b; border: 1px solid #d0dce7;
        border-radius: 12px; box-shadow: 0 10px 32px #10263d35; overflow: hidden;
        font: 13px/1.5 -apple-system, BlinkMacSystemFont, 'Microsoft YaHei', sans-serif; }
      header { background:#0c5c91; color:white; padding: 10px 12px; display:flex; justify-content:space-between; align-items:center; }
      strong { font-size: 14px; }
      main { padding: 12px; max-height: 72vh; overflow: auto; }
      p { margin: 5px 0; overflow-wrap: anywhere; }
      .muted { color:#617386; font-size:12px; }
      .buttons { display:flex; flex-wrap:wrap; gap:6px; margin: 8px 0; }
      button { background:#edf4f9; color:#19496b; border:1px solid #bfd0de; border-radius:6px;
        padding: 6px 9px; font-size: 12px; cursor:pointer; }
      button:hover { background:#dcecf7; }
      #start { background:#0c5c91; color:white; border-color:#0c5c91; }
      #stop { background:#fff6f2; color:#b94b25; border-color:#ecc8b6; }
      header button { color:white; background:transparent; border:0; padding:0 5px; font-size:18px; }
      label { display:block; margin:7px 0; }
      input[type=password],input[type=text],select,textarea { display:block; width:100%; padding:6px 8px; margin-top:3px;
        background:#fff; color:#172e41; border:1px solid #c3ced7; border-radius:5px; font:inherit; }
      input[type=checkbox] { vertical-align:middle; margin-right:6px; }
      details { border-top: 1px solid #e3eaf0; padding-top:8px; margin-top:9px; }
      summary { cursor:pointer; font-weight:600; }
      #answer { background:#edf6fd; border:1px solid #cddfec; padding:8px; border-radius:6px; display:none;
        white-space:pre-wrap; max-height:160px; overflow:auto; }
      pre { font:11px/1.45 Consolas,monospace; white-space:pre-wrap; background:#f5f7fa;
        border-radius:5px; padding:6px; max-height:95px; overflow-y:auto; margin:8px 0 0; }
      #body[hidden] { display:none; }
    </style>
    <section id="panel">
      <header><strong>实安课堂 · DeepSeek 助手 v${VERSION}</strong><button id="fold" title="折叠/展开">−</button></header>
      <main id="body">
        <p id="state">状态：待机</p>
        <p id="course" class="muted">等待检测课程...</p>
        <p id="progress" class="muted"></p>
        <p id="bankStatus" class="muted">题库：正在初始化...</p>
        <p id="answer"></p>
        <div class="buttons">
          <button id="start">开始全自动学习</button><button id="stop">暂停</button>
          <button id="solve">识别并解题</button><button id="next">下一课程</button>
        </div>
        <details id="settings">
          <summary>设置（题库命中无需 API Key）</summary>
          <label>DeepSeek API Key <input id="apiKey" type="password" placeholder="sk-..." autocomplete="off"></label>
          <label><input id="useQuestionBank" type="checkbox">优先使用本地题库（题干 + 选项匹配；题目 ID 仅辅助）</label>
          <div class="buttons"><button id="refreshBank">检查 / 更新题库</button></div>
          <label>文字题模型（推荐 deepseek-v4-pro）
            <select id="model"><option value="deepseek-v4-pro">deepseek-v4-pro（高准确率）</option><option value="deepseek-flash">deepseek-flash（较省费用）</option></select>
          </label>
          <label>思考强度 <select id="reasoningEffort"><option value="high">high · 深度思考（推荐）</option><option value="max">max · 更深入（可能较慢）</option><option value="low">low · 较快</option><option value="none">none · 关闭思考（不推荐）</option></select></label>
          <label><input id="doubleCheck" type="checkbox">二次独立复核：文字题用另一模型校对；不一致时不自动提交</label>
          <label><input id="webVerify" type="checkbox">联网核实答案（推荐）：使用 DeepSeek 官方搜索，必须有真实网页来源且答案一致才提交</label>
          <label>课程参考资料（可选；例如学校提供的实验室安全守则）
            <textarea id="reference" rows="4" maxlength="4500" placeholder="粘贴课程材料中与答题相关的规定；将随问题一起发送给 DeepSeek"></textarea></label>
          <label>播放速度 <select id="speed">
             <option value="1">1 倍</option><option value="1.25">1.25 倍</option>
             <option value="1.5">1.5 倍</option><option value="1.75">1.75 倍</option><option value="2">2 倍</option>
          </select></label>
          <label><input id="autoNext" type="checkbox">课程播放完毕后继续下一节未完成课程</label>
          <label><input id="autoLocate" type="checkbox">进入或刷新网页时，自动定位首个未完成视频</label>
          <label><input id="refreshAfterEnd" type="checkbox">视频正常结束后刷新网页，读取平台最新进度</label>
          <label><input id="autoAI" type="checkbox">检测到习题时自动调用 DeepSeek</label>
          <label><input id="autoApply" type="checkbox">自动逐项勾选 AI 建议的选项（多选题逐项校验，不覆盖已有选择）</label>
          <label><input id="autoSubmit" type="checkbox">自动提交视频习题（默认开启）</label>
          <label><input id="autoStart" type="checkbox">网页刷新后自动恢复任务（已配置 API Key 时）</label>
          <p class="muted">文字题默认 Pro+深度思考，图片题自动使用 Flash。联网核实使用同一个 DeepSeek Key 和官方 deepseek_web_search 工具；启用联网核实+独立复核时最多会发起三轮模型请求。没有实际搜索来源、答案分歧或置信度低时不自动提交。联网结果可能不准确，课程资料会发送给 DeepSeek，请勿填写隐私或密钥。</p>
          <button id="save">保存设置</button><button id="export">导出日志</button>
        </details>
        <pre id="log"></pre>
      </main>
    </section>`;
  const $ = id => shadow.getElementById(id);
  const setStatus = text => { $('state').textContent = `状态：${text}`; };
  function log(msg) {
    const line = `${time()}  ${msg}`;
    notes.push(line);
    if (notes.length > 160) notes.shift();
    $('log').textContent = notes.slice(-24).join('\n');
  }
  function showAnswer(question, result) {
    const labels = (result.answers || []).join('、') || '未能确定';
    const fromBank = result.source === 'question-bank';
    $('answer').style.display = 'block';
    $('answer').textContent = `题目：${question.stem.slice(0, 115)}\n${fromBank ? '题库标准答案' : 'AI 建议'}：${labels}\n答案来源：${fromBank ? `本地题库（${result.matchMethod || '匹配成功'}）` : (result.model || 'DeepSeek')}\n题库类别：${fromBank ? (result.category || '未标注') : '未命中，使用 AI'}\n页面题目 ID（仅辅助）：${question.questionId || '未获取'}\n解释：${result.explanation || '无'}\n可靠性：${result.confidence || '未评估'}\n联网核实：${fromBank ? '未调用（题库命中）' : (result.webVerified ? '已检索并与首轮一致' : (result.webChecked ? '证据不足/未通过' : '尚未核实/未开启'))}\n网页来源：${(result.sources || []).map(v => v.url).slice(0, 4).join('\n') || '无'}\n独立复核：${fromBank ? '未调用（题库标准答案）' : (result.verified ? '两轮一致' : '未通过/未开启')}`;
  }
  function readPanel() {
    prefs.apiKey = $('apiKey').value.trim();
    prefs.model = $('model').value || defaults.model;
    prefs.reasoningEffort = $('reasoningEffort').value || 'high';
    prefs.doubleCheck = $('doubleCheck').checked;
    prefs.webVerify = $('webVerify').checked;
    prefs.reference = $('reference').value.slice(0, 4500);
    prefs.useQuestionBank = $('useQuestionBank').checked;
    if (prefs.useQuestionBank && !questionBankIndex) {
      restoreQuestionBankCache();
      refreshQuestionBank(false);
    }
    prefs.speed = Number($('speed').value) || 1;
    prefs.autoNext = $('autoNext').checked;
    prefs.autoAI = $('autoAI').checked;
    prefs.autoApply = $('autoApply').checked;
    prefs.autoSubmit = $('autoSubmit').checked;
    prefs.autoStart = $('autoStart').checked;
    prefs.autoLocate = $('autoLocate').checked;
    prefs.refreshAfterEnd = $('refreshAfterEnd').checked;
    save();
    if (boundVideo) boundVideo.playbackRate = prefs.speed;
  }
  function populatePanel() {
    $('apiKey').value = prefs.apiKey;
    $('model').value = ['deepseek-flash', 'deepseek-v4-pro'].includes(prefs.model) ? prefs.model : defaults.model;
    $('reasoningEffort').value = prefs.reasoningEffort || 'high';
    $('doubleCheck').checked = prefs.doubleCheck !== false;
    $('webVerify').checked = prefs.webVerify !== false;
    $('reference').value = prefs.reference || '';
    $('useQuestionBank').checked = prefs.useQuestionBank !== false;
    $('speed').value = String(prefs.speed);
    for (const key of ['autoNext', 'autoAI', 'autoApply', 'autoSubmit', 'autoStart', 'autoLocate', 'refreshAfterEnd']) $(key).checked = prefs[key];
  }

  function normalizeMatchText(value) {
    return String(value == null ? '' : value)
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\s\u200b-\u200f\uFEFF]+/g, '')
      .replace(/[，。！？、；：,.!?;:（）()\[\]{}"'“”‘’《》]/g, '');
  }
  function parseBankAnswer(raw) {
    const parts = String(raw || '').toUpperCase().split(/[,，、;；\s]+/).filter(Boolean);
    if (!parts.length || parts.some(value => !/^[A-D]$/.test(value))) return null;
    return [...new Set(parts)].sort();
  }
  function buildQuestionBankIndex(raw) {
    if (!raw || !Array.isArray(raw.categories)) throw new Error('题库格式不正确：缺少 categories 数组');
    const byId = new Map();
    const byStem = new Map();
    let count = 0;
    for (const category of raw.categories) {
      if (!Array.isArray(category.questions)) continue;
      for (const item of category.questions) {
        if (!item || !item.id || !item.stem || !item.correctAnswer) continue;
        const q = { ...item, categoryName: category.name || item.type_dictText || '未分类' };
        const id = String(q.id);
        if (!byId.has(id)) byId.set(id, q);
        const stemKey = normalizeMatchText(q.stem);
        if (!byStem.has(stemKey)) byStem.set(stemKey, []);
        byStem.get(stemKey).push(q);
        count++;
      }
    }
    if (count < 100) throw new Error(`题库有效题目数量异常：${count}`);
    return { byId, byStem, count, categoryCount: raw.categories.length, total: Number(raw.total) || count };
  }
  function restoreQuestionBankCache() {
    try {
      const cached = GM_getValue(QUESTION_BANK_CACHE_KEY, null);
      if (!cached) return false;
      questionBankIndex = buildQuestionBankIndex(cached);
      questionBankStatus = `本地缓存 ${questionBankIndex.count} 题 / ${questionBankIndex.categoryCount} 类`;
      questionBankUpdatedAt = Number(GM_getValue(QUESTION_BANK_UPDATED_KEY, 0)) || 0;
      return true;
    } catch (error) {
      questionBankIndex = null;
      questionBankStatus = `缓存不可用：${error.message || error}`;
      return false;
    }
  }
  function renderQuestionBankStatus() {
    const el = $('bankStatus');
    if (el) {
      const updated = questionBankUpdatedAt
        ? ` · 更新于 ${new Date(questionBankUpdatedAt).toLocaleString('zh-CN', { hour12: false })}`
        : '';
      el.textContent = `题库：${questionBankStatus}${updated}`;
    }
  }
  function refreshQuestionBank(force = false) {
    if (questionBankLoading) return questionBankLoading;
    const lastCheck = Number(GM_getValue(QUESTION_BANK_CHECK_KEY, 0)) || 0;
    if (!force && questionBankIndex && Date.now() - lastCheck < QUESTION_BANK_REFRESH_INTERVAL) {
      renderQuestionBankStatus();
      return Promise.resolve(true);
    }
    questionBankStatus = questionBankIndex ? '本地缓存可用，正在检查 GitHub 更新...' : '正在从 GitHub 下载题库...';
    renderQuestionBankStatus();
    questionBankLoading = new Promise(resolve => {
      let settled = false;
      const finish = (ok, message) => {
        if (settled) return;
        settled = true;
        questionBankLoading = null;
        questionBankStatus = message;
        renderQuestionBankStatus();
        resolve(ok);
      };
      try {
        GM_xmlhttpRequest({
          method: 'GET',
          url: QUESTION_BANK_URL,
          timeout: 60000,
          headers: { 'Accept': 'application/json' },
          onload: response => {
            try {
              if (response.status < 200 || response.status >= 300) {
                throw new Error(`HTTP ${response.status}`);
              }
              const raw = JSON.parse(response.responseText || '{}');
              const index = buildQuestionBankIndex(raw);
              questionBankIndex = index;
              questionBankUpdatedAt = Date.now();
              try {
                GM_setValue(QUESTION_BANK_CACHE_KEY, raw);
                GM_setValue(QUESTION_BANK_UPDATED_KEY, questionBankUpdatedAt);
              } catch (cacheError) {
                log(`题库已载入，但本地缓存保存失败：${cacheError.message || cacheError}`);
              }
              GM_setValue(QUESTION_BANK_CHECK_KEY, Date.now());
              processed.clear();
              finish(true, `GitHub 在线题库 ${index.count} 题 / ${index.categoryCount} 类`);
              log(`题库更新成功：${index.count} 道题，${index.categoryCount} 个类别`);
            } catch (error) {
              GM_setValue(QUESTION_BANK_CHECK_KEY, Date.now());
              finish(false, questionBankIndex
                ? `在线更新失败，继续使用本地缓存（${questionBankIndex.count} 题）`
                : `题库加载失败：${error.message || error}`);
              log(`题库更新失败：${error.message || error}`);
            }
          },
          onerror: () => {
            GM_setValue(QUESTION_BANK_CHECK_KEY, Date.now());
            finish(false, questionBankIndex
              ? `网络不可用，使用本地缓存（${questionBankIndex.count} 题）`
              : '题库下载失败：网络或 GitHub Raw 不可用');
            log('题库下载失败：网络或 GitHub Raw 不可用');
          },
          ontimeout: () => {
            GM_setValue(QUESTION_BANK_CHECK_KEY, Date.now());
            finish(false, questionBankIndex
              ? `下载超时，使用本地缓存（${questionBankIndex.count} 题）`
              : '题库下载超时：暂时没有可用缓存');
            log('题库下载超时');
          }
        });
      } catch (error) {
        GM_setValue(QUESTION_BANK_CHECK_KEY, Date.now());
        finish(false, questionBankIndex
          ? `更新异常，使用本地缓存（${questionBankIndex.count} 题）`
          : `题库初始化失败：${error.message || error}`);
      }
    });
    return questionBankLoading;
  }
  function findVueQuestionState(modal, stem) {
    const wantedStem = normalizeMatchText(stem);
    const cached = vueQuestionCache.get(modal);
    if (cached?.stemKey === wantedStem && cached.vm) {
      const data = cached.vm.$data || cached.vm._data || {};
      const model = cached.vm.model || data.model;
      const questionId = cached.vm.questionId || data.questionId || model?.questionId || '';
      if (questionId && model?.stem && normalizeMatchText(model.stem) === wantedStem) {
        return { questionId: String(questionId), model };
      }
    }
    const roots = [];
    for (let el = modal; el; el = el.parentElement) {
      if (el.__vue__) roots.push(el.__vue__);
    }
    const appRoot = document.querySelector('#app') || document.body;
    if (appRoot?.__vue__) roots.push(appRoot.__vue__);
    const seen = new Set();
    const queue = roots.slice();
    let visited = 0;
    while (queue.length && visited < 1800) {
      const vm = queue.shift();
      if (!vm || seen.has(vm)) continue;
      seen.add(vm);
      visited++;
      const data = vm.$data || vm._data || {};
      const model = vm.model || data.model;
      const questionId = vm.questionId || data.questionId || model?.questionId || '';
      if (questionId && model?.stem && normalizeMatchText(model.stem) === wantedStem) {
        vueQuestionCache.set(modal, { stemKey: wantedStem, vm });
        return { questionId: String(questionId), model };
      }
      if (Array.isArray(vm.$children)) queue.push(...vm.$children);
    }
    return null;
  }
  // 题库匹配以题干为主、选项为二次确认；平台 questionId 只作辅助信息，绝不单独决定答案。
  function mapBankAnswers(bankQuestion, question, bankAnswers) {
    const letters = ['A', 'B', 'C', 'D'];
    const bankOptions = letters
      .map(letter => ({ letter, text: bankQuestion[`option${letter.toLowerCase()}`] }))
      .filter(option => option.text != null && String(option.text).trim() !== '');
    if (bankOptions.length !== question.choices.length) return null;

    const groups = new Map();
    for (const option of bankOptions) {
      const key = normalizeMatchText(option.text);
      if (!key) return null;
      if (!groups.has(key)) groups.set(key, { bank: [], current: [] });
      groups.get(key).bank.push(option.letter);
    }
    for (const option of question.choices) {
      const key = normalizeMatchText(option.text);
      if (!key || !groups.has(key)) return null;
      groups.get(key).current.push(option.letter);
    }

    const mappedAnswers = [];
    for (const group of groups.values()) {
      if (group.bank.length !== group.current.length) return null;
      const selected = group.bank.filter(letter => bankAnswers.includes(letter));
      if (!selected.length) continue;
      if (selected.length === group.bank.length) {
        // 同文案选项全部被选中时，映射整组，不受组内顺序影响。
        mappedAnswers.push(...group.current);
      } else if (group.bank.length === 1) {
        mappedAnswers.push(group.current[0]);
      } else {
        // 重复文案中只选了部分，无法仅凭文本判断是哪一个页面字母，拒绝猜测。
        return null;
      }
    }
    return mappedAnswers.sort();
  }

  function stemSimilarity(a, b) {
    if (a === b) return 1;
    const maxLen = Math.max(a.length, b.length);
    if (Math.min(a.length, b.length) < 12 || Math.abs(a.length - b.length) > Math.max(2, Math.floor(maxLen * 0.04))) return 0;
    // 两行 Levenshtein，题库仅约 4.3k 条；只在没有精确题干时执行。
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    let curr = new Array(b.length + 1);
    for (let i = 1; i <= a.length; i++) {
      curr[0] = i;
      let rowMin = curr[0];
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        if (curr[j] < rowMin) rowMin = curr[j];
      }
      if (rowMin > Math.max(2, Math.floor(maxLen * 0.04))) return 0;
      [prev, curr] = [curr, prev];
    }
    return 1 - prev[b.length] / maxLen;
  }

  function findQuestionBankAnswer(question) {
    if (!questionBankIndex) return { matched: false, reason: '题库尚未加载' };
    const stemKey = normalizeMatchText(question.stem);
    if (!stemKey) return { matched: false, reason: '当前题干为空，无法匹配' };

    // 第一优先级：规范化后的题干完全一致。
    let candidates = questionBankIndex.byStem.get(stemKey) || [];
    let matchMethod = '题干精确匹配 + 选项核对';
    let similarity = 1;

    // 第二优先级：题干存在少量格式/录入差异时，进行严格近似匹配。
    // 近似匹配必须同时通过全部选项文本核对，否则不会自动采用。
    if (!candidates.length) {
      const near = [];
      let best = 0;
      for (const [bankStem, records] of questionBankIndex.byStem.entries()) {
        const score = stemSimilarity(stemKey, bankStem);
        if (score >= 0.96) {
          if (score > best) best = score;
          near.push({ records, score });
        }
      }
      if (near.length) {
        candidates = near.filter(item => item.score >= best - 0.005).flatMap(item => item.records);
        similarity = best;
        matchMethod = `题干近似匹配 ${(best * 100).toFixed(1)}% + 选项核对`;
      }
    }
    if (!candidates.length) {
      const idRecord = question.questionId ? questionBankIndex.byId.get(String(question.questionId)) : null;
      const idHint = idRecord ? '；虽然 ID 存在记录，但题干不一致，已忽略该 ID' : '';
      return { matched: false, reason: `题库没有相同或足够接近的题干${idHint}` };
    }

    const matches = [];
    for (const bankQuestion of candidates) {
      if (normalizeMatchText(bankQuestion.stem) === '' ||
          (similarity === 1 && normalizeMatchText(bankQuestion.stem) !== stemKey)) continue;
      const bankAnswers = parseBankAnswer(bankQuestion.correctAnswer);
      if (!bankAnswers) continue;

      // 以题库答案数量辅助纠正少量 kind 字段异常；最终仍必须与网页真实控件类型一致。
      const bankMultiple = String(bankQuestion.kind) === '3' || bankAnswers.length > 1;
      if (bankMultiple !== Boolean(question.multiple)) continue;
      if (!question.multiple && bankAnswers.length !== 1) continue;

      const answers = mapBankAnswers(bankQuestion, question, bankAnswers);
      if (!answers || !answers.length) continue;
      matches.push({
        answers,
        category: bankQuestion.categoryName || bankQuestion.type_dictText || '未分类',
        bankQuestion,
        matchMethod,
        similarity
      });
    }

    if (!matches.length) {
      return { matched: false, reason: '题干已匹配，但题型或选项内容不一致，拒绝套用答案' };
    }

    // 同一题干可能在多个类别/记录中重复；只有所有通过选项核对的记录映射到同一答案时才接受。
    const answerSignatures = new Set(matches.map(item => item.answers.join(',')));
    if (answerSignatures.size !== 1) {
      return { matched: false, reason: '相同题干和选项对应到不同答案，存在题库冲突，拒绝自动匹配' };
    }

    // ID 仅用于在已经通过题干+选项验证的候选中优先显示对应记录，不参与建立匹配。
    const idMatched = question.questionId
      ? matches.find(item => String(item.bankQuestion.id) === String(question.questionId))
      : null;
    const chosen = idMatched || matches[0];
    return {
      matched: true,
      ...chosen,
      matchMethod: `${chosen.matchMethod}${idMatched ? '（ID 辅助确认）' : '（ID 不参与判定）'}`,
      candidateCount: candidates.length,
      verifiedCandidateCount: matches.length
    };
  }

  // 根据实际 HTML：右侧 .right .title、HTML5 video、左侧 ant-tree 目录。
  function courseTitle() {
    return clean(document.querySelector('.right > .title')?.textContent)
      || clean(document.querySelector('[class*="course"] h2')?.textContent)
      || '当前课程';
  }
  function updateProgress() {
    $('course').textContent = `课程：${courseTitle()}`;
    if (!boundVideo) { $('progress').textContent = '未检测到视频播放器'; return; }
    const t = Number.isFinite(boundVideo.currentTime) ? boundVideo.currentTime : 0;
    const d = Number.isFinite(boundVideo.duration) ? boundVideo.duration : 0;
    const fmt = v => `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2,'0')}`;
    $('progress').textContent = `播放：${fmt(t)} / ${d ? fmt(d) : '--:--'} · ${boundVideo.playbackRate}×`;
  }
  async function playVideo() {
    if (!running || !boundVideo || locating || reloading || pendingNext) return;
    if (activeVideoQuiz()) { log('视频习题弹窗打开中，保持暂停等待答题'); return; }
    try {
      boundVideo.playbackRate = prefs.speed;
      if (!boundVideo.ended && boundVideo.paused) await boundVideo.play();
      log(`播放器启动，${prefs.speed}×`);
    } catch (e) {
      log('浏览器阻止自动播放：请手动点击视频播放键');
    }
  }
  function attachVideo() {
    const v = document.querySelector('.right video, video');
    if (!v) return;
    const src = v.currentSrc || v.getAttribute('src') || '';
    if (v === boundVideo && src === boundSrc) return;
    const changed = v === boundVideo;
    boundVideo = v;
    boundSrc = src;
    v.playbackRate = prefs.speed;
    // 结束事件已触发时保留等待切课状态，避免页面重渲染导致任务丢失。
    if (!seenVideos.has(v)) {
      seenVideos.add(v);
      v.addEventListener('ended', () => {
        if (!running || !prefs.autoNext) return;
        pendingNext = true;
        log('视频自然播放结束，等待平台记录和可能出现的随堂题');
        // 留出平台提交学习进度、显示随堂题的时间；不进行进度伪造。
        setTimeout(() => { if (running && pendingNext) attemptNext(); }, 8500);
      });
    }
    log(changed ? '检测到课程视频地址变化' : '检测到 HTML5 视频播放器');
    if (running && !pendingNext && !locating && !reloading) playVideo();
  }
  // 网站课程目录由 myCourseTypeTree 异步加载，当前页面 URL 的 id 并不随
  // 目录内切课同步更新。因此刷新后必须重新选择未完成课程，不能直接播放默认视频。
  function treeLeaf(li) {
    const target = li?.querySelector(':scope > .ant-tree-node-content-wrapper');
    const title = clean(target?.querySelector('.ant-tree-title')?.textContent || target?.getAttribute('title'));
    if (!target || !title) return null;
    const marker = title.match(/^[（(]\s*(学完|已学|完成|未学|\d+(?:\.\d+)?\s*%)\s*[）)]/);
    if (!marker) return null;
    const state = marker[1].replace(/\s/g, '');
    if (/^(学完|已学|完成)$/.test(state) || state === '100%') return { target, title, complete: true };
    return { target, title, complete: false };
  }
  function directChildren(parent) {
    if (!parent) return [];
    return Array.from(parent.children).filter(el => el.matches('li[role="treeitem"]'));
  }
  function parentGroup(li, tree) {
    let node = li;
    while (node && node.parentElement !== tree) {
      node = node.parentElement?.closest('li[role="treeitem"]');
    }
    return node;
  }
  function selectedLesson() {
    const tree = document.querySelector('ul.custom-tree.ant-tree');
    return tree?.querySelector('li.ant-tree-treenode-selected') ||
      tree?.querySelector('.ant-tree-node-selected')?.closest('li[role="treeitem"]') || null;
  }
  function isCourseDetail() { return /\/students\/courseDetail/i.test(location.pathname); }
  async function waitForCourseTree() {
    for (let n = 0; n < 65; n++) {
      if (!running || !isCourseDetail()) return null;
      const tree = document.querySelector('ul.custom-tree.ant-tree');
      if (tree && directChildren(tree).length && tree.querySelector('.ant-tree-title')) return tree;
      await sleep(400);
    }
    return null;
  }
  async function expandSection(section) {
    let childTree = section.querySelector(':scope > ul.ant-tree-child-tree');
    if (childTree && childTree.classList.contains('ant-tree-child-tree-open')) return childTree;
    const switcher = section.querySelector(':scope > .ant-tree-switcher');
    if (!switcher || switcher.classList.contains('ant-tree-switcher-noop')) return childTree;
    if (!section.classList.contains('ant-tree-treenode-switcher-open')) {
      switcher.click();
      await sleep(250);
    }
    for (let n = 0; n < 6; n++) {
      childTree = section.querySelector(':scope > ul.ant-tree-child-tree');
      if (childTree && childTree.classList.contains('ant-tree-child-tree-open')) return childTree;
      // a-tree 中没有子节点的标题点击后仍然保持 close，无须逐项长时间等待。
      if (!section.classList.contains('ant-tree-treenode-switcher-open')) return null;
      await sleep(170);
    }
    return null;
  }
  // 按课程目录顺序扫描所有大章节；遇到“未学”或 0%~99% 即停止。
  // 不依赖 selectedKeys，也不从 URL 的旧 id 推断观看进度。
  async function firstUnfinishedLesson(tree) {
    let inspected = 0;
    let canceled = false;
    async function inspect(node, depth) {
      if (!running || !locating || activeVideoQuiz()) { canceled = true; return null; }
      const leaf = treeLeaf(node);
      if (leaf) { // 有实际课程进度标识的节点是视频，不能把章节当作视频点击。
        inspected++;
        return leaf.complete ? null : leaf;
      }
      if (depth >= 6) return null;
      const subTree = await expandSection(node);
      if (!subTree) return null;
      for (const child of directChildren(subTree)) {
        const found = await inspect(child, depth + 1);
        if (found || canceled) return found;
      }
      return null;
    }
    // 所有一级章节均在这里扫描，不再依赖刷新后网页默认的 selectedKeys。
    const count = directChildren(tree).length;
    for (let index = 0; index < count; index++) {
      const root = directChildren(tree)[index];
      if (!root) continue;
      const leaf = await inspect(root, 0);
      if (leaf || canceled) return { leaf, inspected, canceled };
    }
    return { leaf: null, inspected };
  }
  async function selectAndConfirmLesson(leaf) {
    if (!leaf?.target?.isConnected) return false;
    const previous = selectedLesson();
    const wasSelected = previous?.contains(leaf.target) || previous === leaf.target.closest('li[role="treeitem"]');
    if (wasSelected) {
      log(`定位结果：当前即为首个未完成课程 ${leaf.title}`);
      return true;
    }
    const oldTitle = courseTitle();
    const oldSrc = document.querySelector('.right video, video')?.getAttribute('src') || '';
    log(`重新定位：${leaf.title}`);
    leaf.target.click(); // 仅操作网页 UI，按站点原有逻辑加载视频
    for (let n = 0; n < 36; n++) {
      if (!running || !locating) return false;
      await sleep(350);
      attachVideo();
      const now = selectedLesson();
      const correctSelected = now?.contains(leaf.target) || now === leaf.target.closest('li[role="treeitem"]');
      const newSrc = document.querySelector('.right video, video')?.getAttribute('src') || '';
      // 只在 Vue 的视频/标题完成切换后播放，避免仍在播刷新后默认的旧课程。
      if (correctSelected && (courseTitle() !== oldTitle || (newSrc && oldSrc && newSrc !== oldSrc))) {
        log('已确认课程切换成功，开始播放选中的未完成视频');
        return true;
      }
    }
    log('课程目录已点击，但未确认视频已切换；为避免误播已完成视频，暂停自动播放');
    return false;
  }
  function beginLocate(reason = '进入课程页面') {
    if (locateTask) return locateTask;
    if (!running) return Promise.resolve(false);
    if (!prefs.autoLocate || !isCourseDetail()) {
      locating = false;
      playVideo();
      return Promise.resolve(true);
    }
    locating = true;
    locateTask = (async () => {
      let canPlay = false;
      try {
        setStatus('读取课程进度中...');
        log(`${reason}：等待课程目录加载，定位第一个未完成视频`);
        const tree = await waitForCourseTree();
        if (!tree) {
          log('课程目录等待超时；未启动默认视频，防止误刷已完成课程');
          setStatus('未加载课程目录');
          return false;
        }
        const found = await firstUnfinishedLesson(tree);
        if (found.canceled) return false;
        if (!found.leaf) {
          log(found.inspected ? `已检查 ${found.inspected} 节：未发现未完成课程` : '目录中没有可识别的进度标记，请核对页面是否加载完毕');
          setStatus(found.inspected ? '未发现未完成课程' : '无法识别进度标记');
          return false;
        }
        canPlay = await selectAndConfirmLesson(found.leaf);
        if (canPlay) {
          attachVideo();
          setStatus('已定位未完成课程');
        } else setStatus('课程切换未确认');
        return canPlay;
      } catch (e) {
        log(`定位未完成课程异常：${e?.message || e}`);
        setStatus('课程定位异常');
        return false;
      } finally {
        locating = false;
        locateTask = null;
        if (canPlay && running) playVideo();
      }
    })();
    return locateTask;
  }
  function refreshForNextLesson() {
    if (!running || reloading || !isCourseDetail()) return false;
    if (activeVideoQuiz()) return false;
    reloading = true;
    pendingNext = false;
    const current = selectedLesson()?.querySelector(':scope > .ant-tree-node-content-wrapper .ant-tree-title')?.textContent || courseTitle();
    sessionStorage.setItem(RUN_KEY, '1');
    sessionStorage.setItem('ucas-ds-last-finished', JSON.stringify({ title: clean(current), at: Date.now() }));
    setStatus('视频结束，刷新课程进度...');
    log('视频正常结束并等待平台记录；即将刷新并重新查找第一个未完成视频');
    setTimeout(() => location.reload(), 450);
    return true;
  }
  async function resolveNextLesson() {
    const tree = document.querySelector('ul.custom-tree.ant-tree');
    const selected = tree?.querySelector('li.ant-tree-treenode-selected');
    if (!tree || !selected) return null;

    // 优先处理本章节中当前视频后面的未学完小节。
    const siblings = directChildren(selected.parentElement);
    for (const li of siblings.slice(siblings.indexOf(selected) + 1)) {
      const found = treeLeaf(li);
      if (found) return found;
    }

    // 本章节完成后，按树目录原有顺序展开后续大章节，寻找未学完小节。
    const roots = directChildren(tree);
    const root = parentGroup(selected, tree);
    const index = roots.indexOf(root);
    if (index < 0) return null;
    for (const section of roots.slice(index + 1)) {
      if (!running || activeVideoQuiz()) return null;
      let subTree = section.querySelector(':scope > ul.ant-tree-child-tree');
      if (!subTree || !subTree.classList.contains('ant-tree-child-tree-open')) {
        const switcher = section.querySelector(':scope > .ant-tree-switcher');
        if (!switcher || switcher.classList.contains('ant-tree-switcher-noop')) continue;
        log(`展开下一章节：${clean(section.querySelector(':scope > .ant-tree-node-content-wrapper')?.textContent)}`);
        switcher.click();
        for (let wait = 0; wait < 14; wait++) {
          await sleep(250);
          subTree = section.querySelector(':scope > ul.ant-tree-child-tree');
          if (subTree && subTree.classList.contains('ant-tree-child-tree-open')) break;
        }
      }
      if (!subTree) continue;
      for (const li of directChildren(subTree)) {
        const found = treeLeaf(li);
        if (found) return found;
      }
    }
    return null;
  }
  async function goNext(manual = false) {
    if (navigating || locating || reloading) return false;
    if (activeVideoQuiz()) { log('当前有尚未处理的视频习题，暂不切课'); return false; }
    if (!manual && (!running || !prefs.autoNext)) return false;
    navigating = true;
    try {
      const next = await resolveNextLesson();
      if (!next) {
        log('未找到后续未学完的课程；如课程列表没有加载完整，请自行展开查看');
        pendingNext = false;
        return false;
      }
      if (!manual && !running) return false;
      if (activeVideoQuiz()) return false;
      const oldSrc = boundVideo?.currentSrc || boundVideo?.src;
      log(`切换课程：${next.title}`);
      pendingNext = false;
      next.target.click(); // 通过网站课程树正常切换，不修改学习完成记录。
      setTimeout(() => {
        const v = document.querySelector('.right video, video');
        if (v && (v !== boundVideo || (v.currentSrc || v.src) !== oldSrc)) boundVideo = null;
        attachVideo();
        if (running) playVideo();
        updateProgress();
      }, 1600);
      return true;
    } catch (e) {
      log(`切课失败：${e?.message || e}`);
      return false;
    } finally {
      navigating = false;
    }
  }
  function attemptNext() {
    if (!pendingNext || thinking || navigating || !running) return;
    const currentQuestions = getQuestions();
    if (currentQuestions.length) {
      log('检测到视频习题，等待自动答题成功后再切课');
      return;
    }
    if (prefs.refreshAfterEnd && isCourseDetail()) refreshForNextLesson();
    else goNext(false);
  }

  // 基于用户保存的真实「视频习题」DOM 和课程路由 chunk-c4b12c1e.js 精确适配。
  // kind=1/2 为 radio（单选或判断），kind=3 为 checkbox（多选）；题目数据由页面自己载入。
  function activeVideoQuiz() {
    return Array.from(document.querySelectorAll('.ant-modal-wrap .modal')).find(modal => {
      if (!visible(modal)) return false;
      const title = clean(modal.closest('.ant-modal')?.querySelector('.ant-modal-title')?.textContent);
      return title === '视频习题';
    }) || null;
  }
  function getQuestions() {
    const modal = activeVideoQuiz();
    if (!modal) return [];
    const heading = modal.querySelector('.sub-title');
    if (!heading) return [];
    const typeName = clean(heading.querySelector('.type')?.textContent).replace(/[()（）]/g, '');
    const headingClone = heading.cloneNode(true);
    headingClone.querySelector('.type')?.remove();
    const stem = clean(headingClone.textContent);
    if (stem.length < 3) return [];

    const rows = Array.from(modal.querySelectorAll('.can-scroll .mb-12.d-f'));
    const choices = [];
    for (const row of rows) {
      if (!visible(row)) continue;
      const label = row.querySelector('label.ant-radio-wrapper, label.ant-checkbox-wrapper');
      const input = label?.querySelector('input[type="radio"],input[type="checkbox"]');
      if (!label || !input) continue;
      const letterMatch = clean(row.querySelector('.letter')?.textContent).match(/([A-D])/i);
      const letter = (letterMatch?.[1] || input.value || '').toUpperCase();
      if (!/^[A-D]$/.test(letter)) continue;
      const img = label.querySelector('img');
      const imageUrl = img ? (img.currentSrc || img.src || '') : '';
      const content = clean(label.querySelector('.option')?.textContent || label.textContent);
      choices.push({
        letter, text: content || (img ? '[图片选项]' : ''),
        el: label, input, imageUrl
      });
    }
    if (choices.length < 2 || new Set(choices.map(o => o.letter)).size !== choices.length) return [];
    const multiple = choices.some(o => o.input.type === 'checkbox') || /多选/.test(typeName);
    const vueState = findVueQuestionState(modal, stem);
    const questionId = vueState?.questionId || '';
    const signature = [questionId, courseTitle(), typeName, stem,
      ...choices.map(o => `${o.letter}.${o.text}${o.imageUrl ? '@' + o.imageUrl : ''}`)].join('\n');
    return [{ questionId, stem, typeName, choices, multiple, signature, container: modal,
      group: modal.querySelector('.can-scroll') || modal }];
  }
  function hasChoice(el) {
    const input = el.querySelector('input[type=radio], input[type=checkbox]');
    return Boolean(input?.checked || el.querySelector('.ant-radio-checked,.ant-checkbox-checked') || el.getAttribute('aria-checked') === 'true');
  }
  function normalizeAnswers(raw, choices, multiple) {
    const valid = new Set(choices.map(o => o.letter));
    // JSON answers must be an array of option labels. Reject explanatory prose and unknown options.
    if (!Array.isArray(raw)) throw new Error('AI 未按 JSON 数组返回答案，已取消自动提交');
    const answers = [];
    for (const item of raw) {
      if (typeof item !== 'string') throw new Error('AI 答案不是字母字符串');
      const letter = item.trim().toUpperCase();
      if (!valid.has(letter)) throw new Error(`AI 返回了无效选项 ${letter.slice(0, 10)}`);
      if (!answers.includes(letter)) answers.push(letter);
    }
    if (!multiple && answers.length > 1) throw new Error('单选/判断题返回多个答案');
    return answers.sort();
  }
  function sameLetters(a, b) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
      a.every((v, i) => v === b[i]);
  }
  function validateChecks(rawChecks, choices, answers) {
    if (!rawChecks || typeof rawChecks !== 'object' || Array.isArray(rawChecks))
      throw new Error('AI 未逐项核验选项，本题停止自动作答');
    const yes = [];
    for (const choice of choices) {
      const value = rawChecks[choice.letter];
      if (value !== true && value !== false)
        throw new Error(`AI 对选项 ${choice.letter} 未明确给出是否应选`);
      if (value) yes.push(choice.letter);
    }
    if (!sameLetters(yes, answers))
      throw new Error(`AI 答案与逐项核验矛盾：答案=${answers.join('、')}，逐项=${yes.join('、')}`);
  }
  const SYSTEM_PROMPT = `你是实验室安全教育题目核对助手。严格按照题干的提问方向逐项独立审查 A、B、C、D。
  1. 先识别问法：如“正确的是”“错误的是”“不属于”“不能”“例外”“不正确”等。checks 的 true 表示【该项应被选中】，不是说该陈述事实为真。
  2. 对每项分析相关实验室安全知识、化学品管理、电气与消防、生物安全、废物分类、PPE等；不可编造法律法规、国标编号、具体参数。
  3. 多选题必须分别判断每一项，无论有几个正确选项都完整输出，不允许因为已选中一项而停止分析。
  4. 判断题/单选题只能选择一项，且需要区分“正确”“错误”对应的选项文字。
  5. 如课程资料与一般常识不一致，优先说明冲突并返回空答案；如果图片看不清、依据不足、或题目存在歧义，设置 confidence=低、answers=[]，并将 checks 各项都设为 false。
  输出严格 JSON 对象（不要 Markdown）：{"answers":["A"],"checks":{"A":true,"B":false},"explanation":"简述问法及每项判断依据，尤其指出排除项原因","confidence":"高"}。checks 必须包含题目所有实际选项且值必须是 JSON 布尔值。`;
  function askDeepSeek(question, { model, review = false } = {}) {
    return new Promise((resolve, reject) => {
      if (!prefs.apiKey) { reject(new Error('请在设置中填写 DeepSeek API Key')); return; }
      const hasImages = question.choices.some(o => o.imageUrl);
      // Pro does not support vision; use Flash for image questions.
      const actualModel = hasImages ? 'deepseek-flash' : (model || prefs.model || defaults.model);
      const reference = clean(prefs.reference).slice(0, 4500);
      const textPrompt = [
        review ? '请独立重新解答此题。你不知道前一位模型的答案；请不要假定任何已有答案。' : '请完整独立解答此题。',
        `题型：${question.typeName || (question.multiple ? '多选题' : '单选或判断题')}`,
        `选择方式：${question.multiple ? '复选框（可以有多个答案）' : '单选框（只能有一个答案）'}`,
        `题干（必须留意否定、例外或“错误”）：${question.stem}`,
        ...question.choices.map(o => `${o.letter}. ${o.text || '[该项为图片，请查看图片]'}`),
        reference ? `学校课程参考资料（只作参考，不代表题目提供的正确答案）：\n${reference}` : '',
        '请对每个选项输出 checks，true 表示该选项应该被勾选；answers 必须严格等于所有 true 的字母集合。' 
      ].filter(Boolean).join('\n');
      const content = hasImages ? [{ type: 'text', text: textPrompt }] : textPrompt;
      if (hasImages) {
        for (const option of question.choices) {
          if (!option.imageUrl) continue;
          if (!/^(https?:|data:image\/)/i.test(option.imageUrl)) {
            reject(new Error('发现图片选项，但图片地址不受支持；请手动答题'));
            return;
          }
          content.push({ type: 'text', text: `选项 ${option.letter} 的图片：` });
          content.push({ type: 'image_url', image_url: { url: option.imageUrl } });
        }
      }
      const effort = ['none', 'low', 'high', 'max'].includes(prefs.reasoningEffort) ? prefs.reasoningEffort : 'high';
      const data = {
        model: actualModel,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content }
        ],
        response_format: { type: 'json_object' },
        reasoning_effort: effort,
        // In thinking mode, the limit covers reasoning tokens as well as the final JSON answer.
        max_tokens: effort === 'max' ? 16000 : effort === 'high' ? 10000 : 2500,
        stream: false
      };
      GM_xmlhttpRequest({
        method: 'POST', url: API, timeout: 150000,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${prefs.apiKey}` },
        data: JSON.stringify(data),
        onload: res => {
          try {
            const body = JSON.parse(res.responseText || '{}');
            if (res.status < 200 || res.status >= 300)
              throw new Error(`DeepSeek HTTP ${res.status}: ${clean(body.error?.message).slice(0, 180) || '请检查 API Key/余额/模型'}`);
            if (body.choices?.[0]?.finish_reason === 'length')
              throw new Error('AI 输出超出长度限制，已取消本题自动提交');
            let raw = clean(body.choices?.[0]?.message?.content);
            raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
            if (!raw) throw new Error('AI 返回了空答案（可能是 JSON 模式输出异常）');
            const parsed = JSON.parse(raw);
            const answers = normalizeAnswers(parsed.answers, question.choices, question.multiple);
            validateChecks(parsed.checks, question.choices, answers);
            const confidence = clean(parsed.confidence);
            if (!['高', '中', '低'].includes(confidence)) throw new Error('AI 未返回明确可靠性等级');
            resolve({
              answers,
              explanation: clean(parsed.explanation).slice(0, 1100),
              confidence,
              model: actualModel,
              verified: false
            });
          } catch (error) { reject(error); }
        },
        ontimeout: () => reject(new Error('DeepSeek 请求超时，请检查网络或降低思考强度')),
        onerror: () => reject(new Error('API 连接失败，请检查网络与油猴跨域权限'))
      });
    });
  }
  // v1.6 使用 DeepSeek 官方联网工具：Chat Completions + deepseek_web_search。
  // 官方要求：声明联网工具时 response_format 只能是 text；不能传 json_object。
  // 将联网答案作为独立校对，且从服务端工具实际执行记录提取来源，不能只信模型编造的 URL。
  function parseSearchJson(text) {
    let raw = String(text || '').trim();
    if (!raw) throw new Error('联网核实返回空正文');
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    try { return JSON.parse(raw); } catch (_) { /* 有时联网回答会多一行引导文字 */ }
    for (let start = raw.indexOf('{'); start >= 0; start = raw.indexOf('{', start + 1)) {
      let depth = 0, quoted = false, escaped = false;
      for (let pos = start; pos < raw.length; pos++) {
        const c = raw[pos];
        if (quoted) {
          if (escaped) escaped = false;
          else if (c === '\\') escaped = true;
          else if (c === '"') quoted = false;
        } else if (c === '"') quoted = true;
        else if (c === '{') depth++;
        else if (c === '}') {
          depth--;
          if (depth === 0) {
            try { return JSON.parse(raw.slice(start, pos + 1)); } catch (_) { break; }
          }
        }
      }
    }
    throw new Error('联网核实未返回可解析的 JSON：保留当前题目人工核对');
  }
  function actualSearchSources(message, body) {
    const sources = new Map();
    let completed = 0;
    function record(url, title) {
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
      try {
        const normalized = new URL(url);
        if (!['http:', 'https:'].includes(normalized.protocol)) return;
        const safe = normalized.href.slice(0, 500);
        if (!sources.has(safe)) sources.set(safe, { url: safe, title: clean(title).slice(0, 110) });
      } catch (_) { /* 忽略无法打开的来源 */ }
    }
    for (const step of message.server_tool_calls || []) {
      for (const call of step.calls || []) {
        if (call.type !== 'deepseek_web_search' || call.status !== 'completed') continue;
        if (['search', 'deep_search', 'image_search', 'deep_image_search'].includes(call.kind)) completed++;
        for (const source of call.sources || []) record(source.url, source.title);
        if (call.page && call.action?.type === 'open_page') record(call.page.url, call.page.title);
      }
    }
    const usage = body.usage?.server_tool_use || {};
    const toolCount = Number(usage.tool_search || 0) + Number(usage.tool_fetch || 0) + Number(usage.tool_image_search || 0);
    // annotations 只能在真的存在服务端联网活动时作为来源；不能独立用来证明联网。
    if (completed > 0 || toolCount > 0) {
      for (const ann of message.annotations || []) {
        if (ann.type === 'url_citation') record(ann.url_citation?.url, ann.url_citation?.title);
      }
    }
    return { sources: [...sources.values()].slice(0, 8), searched: completed > 0 || toolCount > 0, toolCount };
  }
  function askWebVerify(question) {
    return new Promise((resolve, reject) => {
      if (!prefs.apiKey) { reject(new Error('请先填写 DeepSeek API Key')); return; }
      const imageOptions = question.choices.filter(o => o.imageUrl);
      const userText = [
        `请务必先使用已提供的 deepseek_web_search 工具进行网络检索，尽量检索两种不同关键词，并优先依据实验室安全规范、学校教材和消防/化学品权威部门内容。`,
        `请独立于任何先前答案，以网络事实证据逐个判断所有选项。搜索结果可能过时、错误或以题库网站为主，不能仅凭一条未经核实的答案采信。`,
        `题型：${question.typeName || (question.multiple ? '多选' : '单选/判断')}。${question.multiple ? '可以选多个字母' : '只能选一个字母'}。`,
        `题干：${question.stem}`,
        ...question.choices.map(o => `${o.letter}. ${o.text || '[图片选项]'}`),
        clean(prefs.reference) ? `课程资料：${clean(prefs.reference).slice(0, 4500)}` : '',
        '注意“错误的是”“不属于”“不能”等反向提问；checks=true 的意思是该项应被选中。',
        '如果确有可支持结论的联网证据，请仅输出严格 JSON（不需代码围栏）：{"answers":["A"],"checks":{"A":true,"B":false},"explanation":"注明检索的关键事实及相互矛盾之处","confidence":"高"}。',
        '如果查不到能支持判断的证据、题目歧义或图片无法识别，请返回 answers=[]、全部 checks=false 且 confidence="低"。字母和 checks 必须涵盖本题所有选项。'
      ].filter(Boolean).join('\n');
      const content = imageOptions.length ? [{ type: 'text', text: userText }] : userText;
      if (imageOptions.length) {
        for (const o of imageOptions) {
          if (!/^(https?:|data:image\/)/i.test(o.imageUrl)) {
            reject(new Error('图片选项地址不受支持，请人工核对')); return;
          }
          content.push({ type: 'text', text: `选项 ${o.letter} 的图片` });
          content.push({ type: 'image_url', image_url: { url: o.imageUrl } });
        }
      }
      const requestData = {
        model: 'deepseek-flash',
        messages: [
          { role: 'system', content: '你是实验室安全知识联网核实助手。必须先实际搜索证据，逐个核对题干及选项；不允许编造网页来源。仅在有依据时选答案，输出可解析的 JSON 对象。' },
          { role: 'user', content }
        ],
        tools: [{ type: 'deepseek_web_search' }],
        tool_choice: 'auto',
        reasoning_effort: 'high',
        max_tokens: 14000,
        stream: false
        // 不得设置 response_format: {type:'json_object'}：官方联网工具只允许 text。
      };
      GM_xmlhttpRequest({
        method: 'POST', url: API, timeout: 210000,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${prefs.apiKey}` },
        data: JSON.stringify(requestData),
        onload: res => {
          try {
            const body = JSON.parse(res.responseText || '{}');
            if (res.status < 200 || res.status >= 300 || body.error)
              throw new Error(`DeepSeek 联网 HTTP ${res.status}: ${clean(body.error?.message).slice(0, 160) || '检查余额和联网权限'}`);
            const first = body.choices?.[0];
            if (!first || first.finish_reason !== 'stop')
              throw new Error(`联网核实未完整结束（${first?.finish_reason || '未知'}）`);
            const evidence = actualSearchSources(first.message || {}, body);
            if (!evidence.searched || evidence.sources.length === 0)
              throw new Error('模型未实际完成可核验的联网搜索，或没有返回网页来源；不会自动提交');
            const parsed = parseSearchJson(first.message?.content);
            const answers = normalizeAnswers(parsed.answers, question.choices, question.multiple);
            validateChecks(parsed.checks, question.choices, answers);
            const confidence = clean(parsed.confidence);
            if (!['高', '中', '低'].includes(confidence)) throw new Error('联网核实未提供可靠性等级');
            resolve({
              answers, confidence,
              explanation: clean(parsed.explanation).slice(0, 1100),
              sources: evidence.sources, searched: true, model: 'deepseek-flash'
            });
          } catch (error) { reject(error); }
        },
        onerror: () => reject(new Error('DeepSeek 联网请求失败，请检查网络/跨域权限')),
        ontimeout: () => reject(new Error('DeepSeek 联网核实超时；本题暂不自动提交'))
      });
    });
  }

  // Vue / Ant Design Vue 的 checkbox-group 通过 v-model 更新 selectedValues。
  // 若在同一轮事件循环内对多个选项连续 click，后一次可能使用旧的 group value
  // 覆盖前一次，表现为多选只勾住最后一个。必须每点击一次都等待 Vue 完成更新。
  async function applyAnswers(question, answers) {
    const currentQuestion = () => {
      const active = getQuestions()[0];
      return active && active.signature === question.signature &&
        active.container === question.container ? active : null;
    };
    const active = currentQuestion();
    if (!active) {
      log('题目已切换或弹窗已关闭，取消填写过期的 AI 答案'); return false;
    }
    if (!answers.length) return false;
    if (active.choices.some(o => hasChoice(o.el))) {
      log('该题已有选项被选中，尊重已有选择，不自动覆盖');
      return false;
    }
    if (!question.multiple && answers.length !== 1) {
      log('题型为单选/判断，但 AI 返回了多个答案，不自动勾选');
      return false;
    }
    for (const letter of answers) {
      let chosen = false;
      // 在页面渲染较慢时，仅对尚未选中的目标做最多两次尝试。
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!running) return false;
        const fresh = currentQuestion();
        if (!fresh) { log('题目已发生变化，停止勾选'); return false; }
        const choice = fresh.choices.find(o => o.letter === letter);
        if (!choice || !visible(choice.el)) {
          log(`找不到可操作的选项 ${letter}，停止自动提交`);
          return false;
        }
        if (!hasChoice(choice.el)) choice.el.click();
        // 允许 checkbox-group 的 change 事件、v-model 和下一轮 DOM 渲染完成。
        await sleep(260);
        const after = currentQuestion();
        if (!after) { log('题目已关闭或切换，停止勾选'); return false; }
        chosen = hasChoice(after.choices.find(o => o.letter === letter)?.el);
        if (chosen) break;
        log(`选项 ${letter} 状态尚未更新，准备重试`);
      }
      if (!chosen) {
        log(`选项 ${letter} 未能稳定勾选，保留题目供人工处理`);
        return false;
      }
      log(`选项 ${letter} 已勾选并确认`);
    }
    await sleep(160);
    const finalQuestion = currentQuestion();
    if (!finalQuestion) return false;
    const actual = finalQuestion.choices.filter(o => hasChoice(o.el)).map(o => o.letter);
    const match = finalQuestion.choices.every(o => hasChoice(o.el) === answers.includes(o.letter));
    if (!match) {
      log(`多选状态不一致：DeepSeek=${answers.join('、')}，实际=${actual.join('、') || '无'}；不会自动提交`);
      return false;
    }
    log(`已核验勾选完成：${actual.join('、')}`);
    return true;
  }
  function isExamPage() {
    const path = location.pathname.toLowerCase();
    return /exam|paper|test/.test(path) || Boolean(document.querySelector('[class*="exam-countdown"], .exam-timer'));
  }
  async function maybeSubmit(question, answers) {
    if (!prefs.autoSubmit || isExamPage()) return;
    await sleep(900);
    if (!running) return;
    const active = getQuestions()[0];
    if (!active || active.signature !== question.signature || active.container !== question.container) {
      log('题目已变化，取消自动提交'); return;
    }
    const allMatch = active.choices.every(o => hasChoice(o.el) === answers.includes(o.letter));
    if (!allMatch) {
      log('实际勾选状态与 AI 建议不一致，取消自动提交以免误答'); return;
    }
    const button = active.container.querySelector('.submit-container button.ant-btn-primary');
    if (!button || !visible(button) || button.disabled || clean(button.textContent).replace(/\s/g, '') !== '提交') {
      log('未找到已验证的「视频习题→提交」按钮，请人工提交'); return;
    }
    button.click();
    log('已通过网站原有「视频习题→提交」按钮提交；等待平台处理并恢复播放');
  }
  async function solveOne(force = false) {
    if (thinking) return;
    const questions = getQuestions();
    const q = questions.find(item => force || (!processed.has(item.signature) && Date.now() >= (retryAfter.get(item.signature) || 0)));
    if (!q) {
      if (force) log('当前未检测到可识别的视频习题，请先打开视频习题弹窗');
      return;
    }
    processed.add(q.signature);
    thinking = true;
    setStatus('正在匹配题库...');
    log(`发现题目：${q.stem.slice(0, 58)}${q.stem.length > 58 ? '...' : ''}${q.questionId ? `（ID ${q.questionId}）` : ''}`);
    try {
      if (prefs.useQuestionBank !== false) {
        if (!questionBankIndex && questionBankLoading) {
          setStatus('等待题库加载...');
          await questionBankLoading;
        }
        const bankResult = findQuestionBankAnswer(q);
        if (bankResult.matched) {
          const answer = {
            answers: bankResult.answers,
            explanation: `命中本地题库，按 correctAnswer 字段直接匹配；匹配方式：${bankResult.matchMethod}。`,
            confidence: '题库标准答案',
            model: '本地题库',
            source: 'question-bank',
            matchMethod: bankResult.matchMethod,
            category: bankResult.category,
            bankQuestion: bankResult.bankQuestion
          };
          lastResult = { q, answer };
          showAnswer(q, answer);
          log(`题库命中：${answer.answers.join('、')}；类别 ${answer.category}；方式 ${answer.matchMethod}；候选 ${bankResult.candidateCount} 条，选项核对通过 ${bankResult.verifiedCandidateCount} 条`);
          let applied = false;
          if (running && prefs.autoApply) {
            applied = await applyAnswers(q, answer.answers);
            if (applied) await maybeSubmit(q, answer.answers);
          }
          setStatus(!running ? '已匹配题库答案' :
            (!prefs.autoApply ? '题库已匹配，自动勾选已关闭' :
              (applied ? '题库已匹配并完成勾选' : '题库命中，但选项未能确认')));
          return;
        }
        log(`题库未命中：${bankResult.reason || '无匹配记录'}；准备使用 DeepSeek`);
      }
      if (!prefs.apiKey) {
        processed.delete(q.signature);
        retryAfter.set(q.signature, Date.now() + 45000);
        log('题库未命中且未配置 DeepSeek API Key；本题暂时无法自动解答');
        setStatus('题库未命中，需配置 API Key');
        return;
      }
      setStatus('DeepSeek 正在分析题目...');
      const answer = await askDeepSeek(q);
      lastResult = { q, answer };
      showAnswer(q, answer);
      log(`首轮 ${answer.model}：${answer.answers.join('、') || '不确定'}；可靠性 ${answer.confidence}`);
      if (!running) { setStatus('已给出建议，请人工核对'); return; }
      if (!answer.answers.length || answer.confidence === '低') {
        log('AI 无法确定或自评可靠性低：不自动勾选/提交，等待人工核对');
        setStatus('该题需人工核对'); return;
      }
      if (prefs.webVerify !== false) {
        setStatus('DeepSeek 正在联网检索并核实...');
        log('联网核实：调用 DeepSeek 官方 deepseek_web_search（深度搜索）');
        let online;
        try {
          online = await askWebVerify(q);
        } catch (e) {
          answer.webChecked = true;
          answer.explanation += `\n【联网核实失败】${e.message || e}`;
          showAnswer(q, answer);
          log(`联网核实失败：${e.message || e}；不会自动提交`);
          setStatus('联网核实失败，待人工核对'); return;
        }
        answer.webChecked = true;
        answer.sources = online.sources;
        log(`联网核实 ${online.model}：${online.answers.join('、') || '不确定'}；可靠性 ${online.confidence}；来源 ${online.sources.length} 个`);
        for (const v of online.sources.slice(0, 3)) log(`检索来源：${v.url}`);
        if (!online.answers.length || online.confidence === '低' || !sameLetters(answer.answers, online.answers)) {
          answer.confidence = '低';
          answer.explanation += `\n【联网核实存在分歧】联网建议：${online.answers.join('、') || '不确定'}；${online.explanation}`;
          showAnswer(q, answer);
          log('联网核实意见不一致、依据不足或可信度低：暂停自动提交');
          setStatus('联网核实分歧，待人工核对'); return;
        }
        answer.webVerified = true;
        showAnswer(q, answer);
        log('联网检索已返回来源且答案与首轮一致');
      }
      if (prefs.doubleCheck) {
        const hasImages = q.choices.some(o => o.imageUrl);
        const reviewModel = hasImages ? 'deepseek-flash' : (answer.model === 'deepseek-v4-pro' ? 'deepseek-flash' : 'deepseek-v4-pro');
        setStatus(`第二轮独立复核（${reviewModel}）...`);
        log(`正在调用 ${reviewModel} 独立复核（不向第二模型展示首轮答案）`);
        let second;
        try {
          second = await askDeepSeek(q, { model: reviewModel, review: true });
        } catch (e) {
          log(`二次复核失败：${e.message || e}；不会自动提交`);
          setStatus('二次复核异常，待人工核对'); return;
        }
        log(`复核 ${reviewModel}：${second.answers.join('、') || '不确定'}；可靠性 ${second.confidence}`);
        if (!sameLetters(answer.answers, second.answers) || second.confidence === '低') {
          answer.confidence = '低';
          answer.explanation += `
【复核存在分歧】第二轮建议：${second.answers.join('、') || '不确定'}；${second.explanation}`;
          showAnswer(q, answer);
          log('两轮结果不一致或复核可靠性低：暂停自动提交，请人工核对');
          setStatus('两轮答案分歧，待人工核对'); return;
        }
        answer.verified = true;
        log('两轮独立答案一致，准备按原有方式逐项勾选');
      }
      showAnswer(q, answer);
      if (running && prefs.autoApply) {
        const applied = await applyAnswers(q, answer.answers);
        if (applied) await maybeSubmit(q, answer.answers);
      }
      setStatus(running ? '运行中' : '已给出答案，请人工核对');
    } catch (error) {
      processed.delete(q.signature); // 冷却后可重试，防止 Key/余额失败导致请求风暴
      retryAfter.set(q.signature, Date.now() + 45000);
      setStatus('答题失败');
      log(`API 异常：${error.message || error}`);
    } finally {
      thinking = false;
    }
  }
  function start() {
    readPanel();
    running = true;
    prefs.autoStart = true;
    $('autoStart').checked = true;
    save();
    sessionStorage.setItem(RUN_KEY, '1');
    setStatus('运行中');
    locating = Boolean(prefs.autoLocate && isCourseDetail());
    attachVideo();
    if (locating) beginLocate('手动启动');
    else playVideo();
    log('开始学习：先定位未完成课程，再按正常播放进度运行');
    if (prefs.autoAI) solveOne();
  }
  function stop() {
    running = false;
    pendingNext = false;
    locating = false;
    prefs.autoStart = false;
    $('autoStart').checked = false;
    save();
    sessionStorage.removeItem(RUN_KEY);
    boundVideo?.pause();
    setStatus('已暂停');
    log('已暂停（不会继续自动播放、切课和处理新题）');
  }
  $('start').addEventListener('click', start);
  $('stop').addEventListener('click', stop);
  $('solve').addEventListener('click', () => { readPanel(); solveOne(true); });
  $('refreshBank').addEventListener('click', async () => {
    readPanel();
    const button = $('refreshBank');
    button.disabled = true;
    button.textContent = '正在更新...';
    const ok = await refreshQuestionBank(true);
    button.disabled = false;
    button.textContent = '检查 / 更新题库';
    if (ok) {
      processed.clear();
      log('题库已刷新；当前弹窗如尚未处理，将重新尝试匹配');
      if (running) solveOne(false);
    }
  });
  $('next').addEventListener('click', () => { readPanel(); goNext(true); });
  $('save').addEventListener('click', () => {
    readPanel(); log('设置已保存');
    if (!running && prefs.autoStart && (prefs.apiKey || prefs.useQuestionBank)) start();
  });
  $('fold').addEventListener('click', () => {
    $('body').hidden = !$('body').hidden;
    $('fold').textContent = $('body').hidden ? '+' : '−';
  });
  $('export').addEventListener('click', () => {
    const blob = new Blob([notes.join('\n')], { type:'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `实安课堂助手日志_${Date.now()}.txt`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  populatePanel();
  if (prefs.useQuestionBank !== false) {
    restoreQuestionBankCache();
    renderQuestionBankStatus();
    refreshQuestionBank(false);
  } else {
    questionBankStatus = '已关闭';
    renderQuestionBankStatus();
  }
  log(`脚本 ${VERSION} 就绪：题干优先 + 选项核对，题目 ID 仅作辅助；未命中时回退 DeepSeek`);
  if (document.getElementById('ucas-study-helper')) log('发现另一个实安课堂助手，请避免同时开启两个自动学习脚本');
  setStatus(running ? '全自动运行中' : '待机：可用题库自动答题；未命中题目需配置 API Key');
  attachVideo();
  updateProgress();
  if (running) {
    sessionStorage.setItem(RUN_KEY, '1');
    log('已自动恢复学习流程，先读取最新课程完成状态');
    if (locating) beginLocate('刷新/首次进入');
    else playVideo();
    if (prefs.autoAI) solveOne(false);
  }
  let ticks = 0;
  setInterval(() => {
    if (!activeVideoQuiz()) processed.clear(); // 弹窗关闭后允许下一次出现相同题目
    attachVideo();
    if (++ticks % 2 === 0) updateProgress();
    if (running && prefs.autoAI && !thinking) solveOne(false);
    if (running && pendingNext && !thinking && !navigating && !locating && !reloading && ticks % 4 === 0) attemptNext();
    // 弹题提交成功后通常由网站自己恢复播放；偶发未续播时作辅助恢复。
    if (running && !pendingNext && !thinking && !locating && !reloading && ticks % 4 === 0 && boundVideo &&
        boundVideo.paused && !boundVideo.ended && !activeVideoQuiz() &&
        boundVideo.readyState >= 2) playVideo();
  }, 1600);
})();
