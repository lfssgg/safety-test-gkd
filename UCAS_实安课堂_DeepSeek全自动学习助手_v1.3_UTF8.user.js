// ==UserScript==
// @name         UCAS 实安课堂 · DeepSeek 学习助手
// @namespace    https://ucas.jcedutec.cn/
// @version      1.3.0
// @description  视频习题出现时自动调用 DeepSeek、勾选并提交，提交后继续播放，播放结束自动切下一课；不伪造学习进度。
// @author       Zyoung&ChatGPT
// @match        http://ucas.jcedutec.cn:8822/*
// @match        https://// ==UserScript==
// @name         UCAS 实安课堂 · DeepSeek 学习助手
// @namespace    https://ucas.jcedutec.cn/
// @version      1.3.1
// @description  视频习题出现时自动调用 DeepSeek、勾选并提交，提交后继续播放，播放结束自动切下一课；不伪造学习进度。
// @author       ChatGPT
// @homepageURL  https://github.com/lfssgg/safety-test-gkd
// @supportURL   https://github.com/lfssgg/safety-test-gkd/issues
// @updateURL    https://raw.githubusercontent.com/lfssgg/safety-test-gkd/main/ucas-study.user.js
// @downloadURL  https://raw.githubusercontent.com/lfssgg/safety-test-gkd/main/ucas-study.user.js
// @match        http://ucas.jcedutec.cn:8822/*
// @match        https://ucas.jcedutec.cn:8822/*
// @match        http://ucas.jcedutec.cn/*
// @match        https://ucas.jcedutec.cn/*
// @connect      api.deepseek.com
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';
  const VERSION = '1.3.1';
  const ID = 'ucas-deepseek-study-assistant-v1';
  const RUN_KEY = 'ucas-ds-study-running';
  const API = 'https://api.deepseek.com/chat/completions';
  if (document.getElementById(ID)) return;

  const defaults = {
    apiKey: '', model: 'deepseek-flash', speed: 1.5,
    autoNext: true, autoAI: true, autoApply: true, autoSubmit: true, autoStart: true
  };
  // 迁移 v1.1 设置：沿用 API Key/倍速，首次升级时开启用户要求的完整自动模式。
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
  let running = sessionStorage.getItem(RUN_KEY) === '1' || (prefs.autoStart && Boolean(prefs.apiKey));
  let boundVideo = null;
  let boundSrc = null;
  const seenVideos = new WeakSet();
  let pendingNext = false;
  let navigating = false;
  let thinking = false;
  const retryAfter = new Map();
  let lastResult = null;
  const processed = new Set();
  const notes = [];

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
      input[type=password],input[type=text],select { display:block; width:100%; padding:6px 8px; margin-top:3px;
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
        <p id="answer"></p>
        <div class="buttons">
          <button id="start">开始全自动学习</button><button id="stop">暂停</button>
          <button id="solve">识别并解题</button><button id="next">下一课程</button>
        </div>
        <details id="settings">
          <summary>设置（首次使用请填写 API Key）</summary>
          <label>DeepSeek API Key <input id="apiKey" type="password" placeholder="sk-..." autocomplete="off"></label>
          <label>模型 <input id="model" type="text" placeholder="deepseek-flash"></label>
          <label>播放速度 <select id="speed">
             <option value="1">1 倍</option><option value="1.25">1.25 倍</option>
             <option value="1.5">1.5 倍</option><option value="1.75">1.75 倍</option><option value="2">2 倍</option>
          </select></label>
          <label><input id="autoNext" type="checkbox">课程播放完毕后切换下一节未学完课程</label>
          <label><input id="autoAI" type="checkbox">检测到习题时自动调用 DeepSeek</label>
          <label><input id="autoApply" type="checkbox">自动逐项勾选 AI 建议的选项（多选题逐项校验，不覆盖已有选择）</label>
          <label><input id="autoSubmit" type="checkbox">自动提交视频习题（默认开启）</label>
          <label><input id="autoStart" type="checkbox">网页刷新后自动恢复任务（已配置 API Key 时）</label>
          <p class="muted">工作流程：弹题→DeepSeek→选项→提交→续播→自然结束后下一课程。首次填写 API Key 后保存即可自动启动。AI 可能答错，调用会计费；仅处理视频习题，不操作考试页或伪造进度。</p>
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
    $('answer').style.display = 'block';
    $('answer').textContent = `题目：${question.stem.slice(0, 115)}\nAI 建议：${labels}\n解释：${result.explanation || '无'}\n可靠性：${result.confidence || '未评估'}`;
  }
  function readPanel() {
    prefs.apiKey = $('apiKey').value.trim();
    prefs.model = $('model').value.trim() || defaults.model;
    prefs.speed = Number($('speed').value) || 1;
    prefs.autoNext = $('autoNext').checked;
    prefs.autoAI = $('autoAI').checked;
    prefs.autoApply = $('autoApply').checked;
    prefs.autoSubmit = $('autoSubmit').checked;
    prefs.autoStart = $('autoStart').checked;
    save();
    if (boundVideo) boundVideo.playbackRate = prefs.speed;
  }
  function populatePanel() {
    $('apiKey').value = prefs.apiKey;
    $('model').value = prefs.model;
    $('speed').value = String(prefs.speed);
    for (const key of ['autoNext', 'autoAI', 'autoApply', 'autoSubmit', 'autoStart']) $(key).checked = prefs[key];
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
    if (!running || !boundVideo) return;
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
        setTimeout(() => { if (running && pendingNext) attemptNext(); }, 6000);
      });
    }
    log(changed ? '检测到课程视频地址变化' : '检测到 HTML5 视频播放器');
    if (running && !pendingNext) playVideo();
  }
  function treeLeaf(li) {
    const target = li?.querySelector(':scope > .ant-tree-node-content-wrapper');
    const title = clean(target?.querySelector('.ant-tree-title')?.textContent || target?.getAttribute('title'));
    if (!target || !title) return null;
    if (/^[（(]\s*学完\s*[）)]/.test(title)) return null;
    if (/^[（(]\s*(?:未学|\d+(?:\.\d+)?%)\s*[）)]/.test(title)) return { target, title };
    return null;
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
    if (navigating) return false;
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
    goNext(false);
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
    const signature = [courseTitle(), typeName, stem,
      ...choices.map(o => `${o.letter}.${o.text}${o.imageUrl ? '@' + o.imageUrl : ''}`)].join('\n');
    return [{ stem, typeName, choices, multiple, signature, container: modal,
      group: modal.querySelector('.can-scroll') || modal }];
  }
  function hasChoice(el) {
    const input = el.querySelector('input[type=radio], input[type=checkbox]');
    return Boolean(input?.checked || el.querySelector('.ant-radio-checked,.ant-checkbox-checked') || el.getAttribute('aria-checked') === 'true');
  }
  function normalizeAnswers(raw, count, multiple) {
    let entries = Array.isArray(raw) ? raw : String(raw || '').toUpperCase().match(/[A-H]/g) || [];
    entries = [...new Set(entries.flatMap(x => String(x).toUpperCase().match(/[A-H]/g) || []))];
    return entries.filter(x => x.charCodeAt(0) - 65 < count).slice(0, multiple ? count : 1);
  }
  function askDeepSeek(question) {
    return new Promise((resolve, reject) => {
      if (!prefs.apiKey) { reject(new Error('请在设置中填写 DeepSeek API Key')); return; }
      const textPrompt = `题型：${question.typeName || (question.multiple ? '多选' : '单选/判断')}\n题干：${question.stem}\n${question.choices.map(o => `${o.letter}. ${o.text}`).join('\n')}\n请结合实验室安全规范分析，输出 JSON 对象：answers 为字母数组，explanation 为依据，confidence 为高/中/低；如不确定则 answers 为空数组。`;
      const hasImages = question.choices.some(o => o.imageUrl);
      const content = hasImages ? [{ type:'text', text:textPrompt }] : textPrompt;
      if (hasImages) {
        for (const option of question.choices) {
          if (!option.imageUrl) continue;
          if (!/^(https?:|data:image\/)/i.test(option.imageUrl)) {
            reject(new Error('发现图片选项，但图片地址不受支持；请手动答题'));
            return;
          }
          content.push({ type:'text', text:`选项 ${option.letter} 对应的图片：` });
          content.push({ type:'image_url', image_url: { url:option.imageUrl } });
        }
      }
      const data = {
        model: prefs.model || 'deepseek-flash',
        messages: [
          { role:'system', content: '你是实验室安全教育辅导助手。依据题干、选项、图片（如有）及可靠的实验室安全知识作答，缺少依据时返回空答案。不得猜测。仅输出 JSON 对象，字段为 answers(字母数组)、explanation(中文简短解释)、confidence(高/中/低)。单选或判断只选一项，多选可选多个。' },
          { role:'user', content }
        ],
        response_format: { type:'json_object' },
        reasoning_effort: 'none',
        max_tokens: 550,
        stream: false
      };
      GM_xmlhttpRequest({
        method: 'POST', url: API, timeout: 50000,
        headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${prefs.apiKey}` },
        data: JSON.stringify(data),
        onload: (res) => {
          try {
            const body = JSON.parse(res.responseText || '{}');
            if (res.status < 200 || res.status >= 300)
              throw new Error(`DeepSeek HTTP ${res.status}: ${clean(body.error?.message).slice(0, 180) || '请检查 API Key/余额/模型'}`);
            let raw = clean(body.choices?.[0]?.message?.content);
            raw = raw.replace(/^```(?:json)?\s*/i,'').replace(/```$/,'').trim();
            const parsed = JSON.parse(raw);
            resolve({
              answers: normalizeAnswers(parsed.answers, question.choices.length, question.multiple),
              explanation: clean(parsed.explanation).slice(0, 750),
              confidence: clean(parsed.confidence).slice(0, 12) || '未评估'
            });
          } catch (e) { reject(e); }
        },
        ontimeout: () => reject(new Error('DeepSeek 请求超时')),
        onerror: () => reject(new Error('API 连接失败，请检查网络与油猴跨域权限'))
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
    if (!prefs.apiKey) { log('未配置 API Key，无法请求 DeepSeek'); setStatus('需配置 API Key'); return; }
    processed.add(q.signature);
    thinking = true;
    setStatus('DeepSeek 正在分析题目...');
    log(`发现题目：${q.stem.slice(0, 58)}${q.stem.length > 58 ? '...' : ''}`);
    try {
      const answer = await askDeepSeek(q);
      lastResult = { q, answer };
      showAnswer(q, answer);
      log(`DeepSeek 建议：${answer.answers.join('、') || '不确定'}；可靠性 ${answer.confidence}`);
      if (running && prefs.autoApply && answer.answers.length) {
        if (answer.confidence === '低') log('提醒：AI 自评可靠性低，自动选择仍可能答错');
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
    attachVideo();
    playVideo();
    log('开始学习，视频按正常播放进度运行');
    if (prefs.autoAI) solveOne();
  }
  function stop() {
    running = false;
    pendingNext = false;
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
  $('next').addEventListener('click', () => { readPanel(); goNext(true); });
  $('save').addEventListener('click', () => {
    readPanel(); log('设置已保存');
    if (!running && prefs.autoStart && prefs.apiKey) start();
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
  log(`脚本 ${VERSION} 就绪：已修复多选题逐个勾选及核验；弹题自动解答、提交、续播、切课`);
  if (document.getElementById('ucas-study-helper')) log('发现另一个实安课堂助手，请避免同时开启两个自动学习脚本');
  setStatus(running ? '全自动运行中' : '待机：填写 API Key 后保存并开始');
  attachVideo();
  updateProgress();
  if (running) {
    sessionStorage.setItem(RUN_KEY, '1');
    log('已自动恢复完整学习流程');
    playVideo();
    if (prefs.autoAI) solveOne(false);
  }
  let ticks = 0;
  setInterval(() => {
    if (!activeVideoQuiz()) processed.clear(); // 弹窗关闭后允许下一次出现相同题目
    attachVideo();
    if (++ticks % 2 === 0) updateProgress();
    if (running && prefs.autoAI && !thinking) solveOne(false);
    if (running && pendingNext && !thinking && !navigating && ticks % 4 === 0) attemptNext();
    // 弹题提交成功后通常由网站自己恢复播放；偶发未续播时作辅助恢复。
    if (running && !pendingNext && !thinking && ticks % 4 === 0 && boundVideo &&
        boundVideo.paused && !boundVideo.ended && !activeVideoQuiz() &&
        boundVideo.readyState >= 2) playVideo();
  }, 1600);
})();
ucas.jcedutec.cn:8822/*
// @match        http://ucas.jcedutec.cn/*
// @match        https://ucas.jcedutec.cn/*
// @connect      api.deepseek.com
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';
  const VERSION = '1.3.0';
  const ID = 'ucas-deepseek-study-assistant-v1';
  const RUN_KEY = 'ucas-ds-study-running';
  const API = 'https://api.deepseek.com/chat/completions';
  if (document.getElementById(ID)) return;

  const defaults = {
    apiKey: '', model: 'deepseek-flash', speed: 1.5,
    autoNext: true, autoAI: true, autoApply: true, autoSubmit: true, autoStart: true
  };
  // 迁移 v1.1 设置：沿用 API Key/倍速，首次升级时开启用户要求的完整自动模式。
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
  let running = sessionStorage.getItem(RUN_KEY) === '1' || (prefs.autoStart && Boolean(prefs.apiKey));
  let boundVideo = null;
  let boundSrc = null;
  const seenVideos = new WeakSet();
  let pendingNext = false;
  let navigating = false;
  let thinking = false;
  const retryAfter = new Map();
  let lastResult = null;
  const processed = new Set();
  const notes = [];

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
      input[type=password],input[type=text],select { display:block; width:100%; padding:6px 8px; margin-top:3px;
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
        <p id="answer"></p>
        <div class="buttons">
          <button id="start">开始全自动学习</button><button id="stop">暂停</button>
          <button id="solve">识别并解题</button><button id="next">下一课程</button>
        </div>
        <details id="settings">
          <summary>设置（首次使用请填写 API Key）</summary>
          <label>DeepSeek API Key <input id="apiKey" type="password" placeholder="sk-..." autocomplete="off"></label>
          <label>模型 <input id="model" type="text" placeholder="deepseek-flash"></label>
          <label>播放速度 <select id="speed">
             <option value="1">1 倍</option><option value="1.25">1.25 倍</option>
             <option value="1.5">1.5 倍</option><option value="1.75">1.75 倍</option><option value="2">2 倍</option>
          </select></label>
          <label><input id="autoNext" type="checkbox">课程播放完毕后切换下一节未学完课程</label>
          <label><input id="autoAI" type="checkbox">检测到习题时自动调用 DeepSeek</label>
          <label><input id="autoApply" type="checkbox">自动逐项勾选 AI 建议的选项（多选题逐项校验，不覆盖已有选择）</label>
          <label><input id="autoSubmit" type="checkbox">自动提交视频习题（默认开启）</label>
          <label><input id="autoStart" type="checkbox">网页刷新后自动恢复任务（已配置 API Key 时）</label>
          <p class="muted">工作流程：弹题→DeepSeek→选项→提交→续播→自然结束后下一课程。首次填写 API Key 后保存即可自动启动。AI 可能答错，调用会计费；仅处理视频习题，不操作考试页或伪造进度。</p>
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
    $('answer').style.display = 'block';
    $('answer').textContent = `题目：${question.stem.slice(0, 115)}\nAI 建议：${labels}\n解释：${result.explanation || '无'}\n可靠性：${result.confidence || '未评估'}`;
  }
  function readPanel() {
    prefs.apiKey = $('apiKey').value.trim();
    prefs.model = $('model').value.trim() || defaults.model;
    prefs.speed = Number($('speed').value) || 1;
    prefs.autoNext = $('autoNext').checked;
    prefs.autoAI = $('autoAI').checked;
    prefs.autoApply = $('autoApply').checked;
    prefs.autoSubmit = $('autoSubmit').checked;
    prefs.autoStart = $('autoStart').checked;
    save();
    if (boundVideo) boundVideo.playbackRate = prefs.speed;
  }
  function populatePanel() {
    $('apiKey').value = prefs.apiKey;
    $('model').value = prefs.model;
    $('speed').value = String(prefs.speed);
    for (const key of ['autoNext', 'autoAI', 'autoApply', 'autoSubmit', 'autoStart']) $(key).checked = prefs[key];
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
    if (!running || !boundVideo) return;
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
        setTimeout(() => { if (running && pendingNext) attemptNext(); }, 6000);
      });
    }
    log(changed ? '检测到课程视频地址变化' : '检测到 HTML5 视频播放器');
    if (running && !pendingNext) playVideo();
  }
  function treeLeaf(li) {
    const target = li?.querySelector(':scope > .ant-tree-node-content-wrapper');
    const title = clean(target?.querySelector('.ant-tree-title')?.textContent || target?.getAttribute('title'));
    if (!target || !title) return null;
    if (/^[（(]\s*学完\s*[）)]/.test(title)) return null;
    if (/^[（(]\s*(?:未学|\d+(?:\.\d+)?%)\s*[）)]/.test(title)) return { target, title };
    return null;
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
    if (navigating) return false;
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
    goNext(false);
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
    const signature = [courseTitle(), typeName, stem,
      ...choices.map(o => `${o.letter}.${o.text}${o.imageUrl ? '@' + o.imageUrl : ''}`)].join('\n');
    return [{ stem, typeName, choices, multiple, signature, container: modal,
      group: modal.querySelector('.can-scroll') || modal }];
  }
  function hasChoice(el) {
    const input = el.querySelector('input[type=radio], input[type=checkbox]');
    return Boolean(input?.checked || el.querySelector('.ant-radio-checked,.ant-checkbox-checked') || el.getAttribute('aria-checked') === 'true');
  }
  function normalizeAnswers(raw, count, multiple) {
    let entries = Array.isArray(raw) ? raw : String(raw || '').toUpperCase().match(/[A-H]/g) || [];
    entries = [...new Set(entries.flatMap(x => String(x).toUpperCase().match(/[A-H]/g) || []))];
    return entries.filter(x => x.charCodeAt(0) - 65 < count).slice(0, multiple ? count : 1);
  }
  function askDeepSeek(question) {
    return new Promise((resolve, reject) => {
      if (!prefs.apiKey) { reject(new Error('请在设置中填写 DeepSeek API Key')); return; }
      const textPrompt = `题型：${question.typeName || (question.multiple ? '多选' : '单选/判断')}\n题干：${question.stem}\n${question.choices.map(o => `${o.letter}. ${o.text}`).join('\n')}\n请结合实验室安全规范分析，输出 JSON 对象：answers 为字母数组，explanation 为依据，confidence 为高/中/低；如不确定则 answers 为空数组。`;
      const hasImages = question.choices.some(o => o.imageUrl);
      const content = hasImages ? [{ type:'text', text:textPrompt }] : textPrompt;
      if (hasImages) {
        for (const option of question.choices) {
          if (!option.imageUrl) continue;
          if (!/^(https?:|data:image\/)/i.test(option.imageUrl)) {
            reject(new Error('发现图片选项，但图片地址不受支持；请手动答题'));
            return;
          }
          content.push({ type:'text', text:`选项 ${option.letter} 对应的图片：` });
          content.push({ type:'image_url', image_url: { url:option.imageUrl } });
        }
      }
      const data = {
        model: prefs.model || 'deepseek-flash',
        messages: [
          { role:'system', content: '你是实验室安全教育辅导助手。依据题干、选项、图片（如有）及可靠的实验室安全知识作答，缺少依据时返回空答案。不得猜测。仅输出 JSON 对象，字段为 answers(字母数组)、explanation(中文简短解释)、confidence(高/中/低)。单选或判断只选一项，多选可选多个。' },
          { role:'user', content }
        ],
        response_format: { type:'json_object' },
        reasoning_effort: 'none',
        max_tokens: 550,
        stream: false
      };
      GM_xmlhttpRequest({
        method: 'POST', url: API, timeout: 50000,
        headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${prefs.apiKey}` },
        data: JSON.stringify(data),
        onload: (res) => {
          try {
            const body = JSON.parse(res.responseText || '{}');
            if (res.status < 200 || res.status >= 300)
              throw new Error(`DeepSeek HTTP ${res.status}: ${clean(body.error?.message).slice(0, 180) || '请检查 API Key/余额/模型'}`);
            let raw = clean(body.choices?.[0]?.message?.content);
            raw = raw.replace(/^```(?:json)?\s*/i,'').replace(/```$/,'').trim();
            const parsed = JSON.parse(raw);
            resolve({
              answers: normalizeAnswers(parsed.answers, question.choices.length, question.multiple),
              explanation: clean(parsed.explanation).slice(0, 750),
              confidence: clean(parsed.confidence).slice(0, 12) || '未评估'
            });
          } catch (e) { reject(e); }
        },
        ontimeout: () => reject(new Error('DeepSeek 请求超时')),
        onerror: () => reject(new Error('API 连接失败，请检查网络与油猴跨域权限'))
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
    if (!prefs.apiKey) { log('未配置 API Key，无法请求 DeepSeek'); setStatus('需配置 API Key'); return; }
    processed.add(q.signature);
    thinking = true;
    setStatus('DeepSeek 正在分析题目...');
    log(`发现题目：${q.stem.slice(0, 58)}${q.stem.length > 58 ? '...' : ''}`);
    try {
      const answer = await askDeepSeek(q);
      lastResult = { q, answer };
      showAnswer(q, answer);
      log(`DeepSeek 建议：${answer.answers.join('、') || '不确定'}；可靠性 ${answer.confidence}`);
      if (running && prefs.autoApply && answer.answers.length) {
        if (answer.confidence === '低') log('提醒：AI 自评可靠性低，自动选择仍可能答错');
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
    attachVideo();
    playVideo();
    log('开始学习，视频按正常播放进度运行');
    if (prefs.autoAI) solveOne();
  }
  function stop() {
    running = false;
    pendingNext = false;
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
  $('next').addEventListener('click', () => { readPanel(); goNext(true); });
  $('save').addEventListener('click', () => {
    readPanel(); log('设置已保存');
    if (!running && prefs.autoStart && prefs.apiKey) start();
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
  log(`脚本 ${VERSION} 就绪：已修复多选题逐个勾选及核验；弹题自动解答、提交、续播、切课`);
  if (document.getElementById('ucas-study-helper')) log('发现另一个实安课堂助手，请避免同时开启两个自动学习脚本');
  setStatus(running ? '全自动运行中' : '待机：填写 API Key 后保存并开始');
  attachVideo();
  updateProgress();
  if (running) {
    sessionStorage.setItem(RUN_KEY, '1');
    log('已自动恢复完整学习流程');
    playVideo();
    if (prefs.autoAI) solveOne(false);
  }
  let ticks = 0;
  setInterval(() => {
    if (!activeVideoQuiz()) processed.clear(); // 弹窗关闭后允许下一次出现相同题目
    attachVideo();
    if (++ticks % 2 === 0) updateProgress();
    if (running && prefs.autoAI && !thinking) solveOne(false);
    if (running && pendingNext && !thinking && !navigating && ticks % 4 === 0) attemptNext();
    // 弹题提交成功后通常由网站自己恢复播放；偶发未续播时作辅助恢复。
    if (running && !pendingNext && !thinking && ticks % 4 === 0 && boundVideo &&
        boundVideo.paused && !boundVideo.ended && !activeVideoQuiz() &&
        boundVideo.readyState >= 2) playVideo();
  }, 1600);
})();
