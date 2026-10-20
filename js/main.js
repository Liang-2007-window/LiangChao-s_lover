/**
 * 夏日海岸 → 黄昏单车骑行
 * 青春互动网页
 */

(function () {
  'use strict';

  // ==================== 可以自己改的设置 ====================
  var CORRECT_ANSWER = '刘克';

  // 答错时小狗会依次说这些话
  var WRONG_HINTS = [
    '再想想看～💭',
    '不对哦，仔细想一想～',
    '提示：是一个很特别的人 ✨',
    '答案就在你心中 ❤️',
    '那个人名字有两个字哦～',
    '再试试吧！你一定知道的 🌟'
  ];

  var MUSIC_VOLUME = 0.6;
  // =========================================================

  // ---------- DOM ----------
  var sceneSummer = document.getElementById('scene-summer');
  var sceneSunset = document.getElementById('scene-sunset');
  var answerInput = document.getElementById('answer-input');
  var submitBtn = document.getElementById('submit-btn');
  var hintText = document.getElementById('hint-text');
  var cardWrap = document.querySelector('.card-wrap');
  var peekSlot = document.getElementById('peek-slot');
  var bgm = document.getElementById('bgm');
  var musicBtn = document.getElementById('music-info');
  var musicLabel = document.getElementById('music-label');
  var loveText = document.getElementById('love-text');
  var heartsArea = document.getElementById('hearts-area');
  var driftArea = document.getElementById('drift');
  var groundEl = document.getElementById('ground');

  var prefersReducedMotion = !!(window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // ---------- 状态 ----------
  var transitionDone = false;
  var heartsInterval = null;
  var burstInterval = null;
  var userPaused = false;
  var pausedByHidden = false;
  var audioWarmed = false;
  var fadeToken = 0;
  var wrongCount = 0;
  var typingTimer = null;

  // ==================== 小狗登场 ====================
  function put(el, opts, extraHTML) {
    if (!el) return;
    el.innerHTML = (extraHTML || '') + Dogs.make(opts);
  }

  // 随机的眨眼 / 抖耳朵节奏，让每只小狗不同步
  function desync() {
    var dogs = document.querySelectorAll('.dog');
    dogs.forEach(function (d) {
      d.style.setProperty('--blink', (-Math.random() * 4.6).toFixed(2) + 's');
      d.style.setProperty('--ear', (-Math.random() * 6).toFixed(2) + 's');
    });
  }

  function setupBeachDogs() {
    put(peekSlot, { breed: 'shiba', pose: 'peek', eyes: 'open', mouth: 'smile', label: '趴在卡片上的小柴犬' });
    put(document.querySelector('.dog-cool'), { breed: 'kuro', pose: 'sit', eyes: 'open', mouth: 'smile', acc: ['sunglasses'], label: '戴墨镜的小黑狗' });
    put(document.querySelector('.dog-flower'), { breed: 'pup', pose: 'sit', eyes: 'open', mouth: 'tongue', acc: ['flower'], label: '戴小花的小狗' });
  }

  var BALLOON = '<svg class="balloon" viewBox="0 0 60 120"><path d="M30,68 C-8,44 8,4 30,26 C52,4 68,44 30,68 Z" fill="#FF7A6B" stroke="#6A4030" stroke-width="3" stroke-linejoin="round"/>' +
    '<path d="M30,68 L25,75 L35,75 Z" fill="#FF7A6B" stroke="#6A4030" stroke-width="2.6" stroke-linejoin="round"/>' +
    '<path d="M16,26 Q17,18 24,16" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" opacity=".75"/>' +
    '<path d="M30,75 C25,92 36,104 28,120" fill="none" stroke="#6A4030" stroke-width="2.4" stroke-linecap="round"/></svg>';

  function setupSunsetDogs() {
    var seat = '<span class="cloud-seat"></span>';
    put(document.getElementById('st-1'), { breed: 'shiba', pose: 'sit', eyes: 'joy', mouth: 'tongue', acc: ['flower'] }, seat);
    put(document.getElementById('st-2'), { breed: 'pup', pose: 'sit', eyes: 'open', mouth: 'tongue', acc: ['bow'] }, seat + BALLOON);
    put(document.getElementById('st-3'), { breed: 'kuro', pose: 'sit', eyes: 'sleep', mouth: 'smile', acc: ['bow'] }, seat + '<span class="zzz">Zzz</span>');
    put(document.getElementById('st-4'), { breed: 'shiba', pose: 'sit', eyes: 'open', mouth: 'smile', acc: ['scarf'] }, seat);
    put(document.getElementById('bike-dog'), { breed: 'shiba', pose: 'peek', eyes: 'joy', mouth: 'tongue' });
    desync();
  }

  // ==================== 小狗的眼睛跟着鼠标 ====================
  var lookRAF = 0;
  var pointer = null;
  var MAX_LOOK = 4.6;

  function updateEyes() {
    lookRAF = 0;
    if (!pointer) return;
    var dogs = document.querySelectorAll('.scene.active .dog');
    dogs.forEach(function (dog) {
      var eyes = dog.querySelector('.eyes');
      if (!eyes) return;
      var r = dog.getBoundingClientRect();
      if (!r.width) return;
      var cx = r.left + r.width / 2;
      var cy = r.top + r.height * (dog.classList.contains('pose-peek') ? 0.55 : 0.4);
      var dx = pointer.x - cx, dy = pointer.y - cy;
      var dist = Math.sqrt(dx * dx + dy * dy) || 1;
      var k = Math.min(1, dist / 220);
      dog.style.setProperty('--dx', (dx / dist * MAX_LOOK * k).toFixed(2) + 'px');
      dog.style.setProperty('--dy', (dy / dist * MAX_LOOK * k).toFixed(2) + 'px');
    });
  }

  function onPointer(e) {
    pointer = { x: e.clientX, y: e.clientY };
    if (!lookRAF) lookRAF = requestAnimationFrame(updateEyes);
  }
  if (!prefersReducedMotion) {
    window.addEventListener('pointermove', onPointer, { passive: true });
    window.addEventListener('pointerdown', onPointer, { passive: true });
  }

  // 打字时，柴犬低头看着输入框
  function peekLookDown() {
    var dog = peekSlot.querySelector('.dog');
    if (!dog) return;
    var len = answerInput.value.length;
    dog.style.setProperty('--dx', ((len - 1) * 1.2 - 1.5).toFixed(2) + 'px');
    dog.style.setProperty('--dy', '4.4px');
    pointer = null; // 暂时不跟鼠标，免得打断
    clearTimeout(typingTimer);
    typingTimer = setTimeout(function () { pointer = null; }, 1500);
  }

  // ==================== 提交答案 ====================
  submitBtn.addEventListener('click', handleSubmit);
  answerInput.addEventListener('keydown', function (e) {
    // 中文输入法拼写时的回车只是"选字"，不能当作提交
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) handleSubmit();
  });
  answerInput.addEventListener('input', function () { warmAudio(); peekLookDown(); });

  function warmAudio() {
    if (audioWarmed || !bgm) return;
    audioWarmed = true;
    bgm.preload = 'auto';
    try { bgm.load(); } catch (err) { /* 忽略 */ }
  }

  function normalize(str) {
    // 全角转半角、去掉所有空白，避免多打了空格就判错
    var s = str.normalize ? str.normalize('NFKC') : str;
    return s.replace(/\s+/g, '');
  }

  function handleSubmit() {
    if (transitionDone) return;
    var answer = normalize(answerInput.value);
    if (!answer) { showHint('请输入答案哦～'); return; }
    if (answer === CORRECT_ANSWER) triggerTransition();
    else showWrongHint();
  }

  function showHint(msg) {
    hintText.textContent = '';
    void hintText.offsetWidth; // 重新触发气泡弹出动画
    hintText.textContent = msg;
  }

  function showWrongHint() {
    showHint(WRONG_HINTS[wrongCount % WRONG_HINTS.length]);
    wrongCount++;

    cardWrap.classList.remove('shake');
    void cardWrap.offsetWidth;
    cardWrap.classList.add('shake');
    setTimeout(function () { cardWrap.classList.remove('shake'); }, 520);

    // 小狗歪头
    var dog = peekSlot.querySelector('.dog');
    if (dog) {
      dog.classList.remove('tilt');
      void dog.getBoundingClientRect();
      dog.classList.add('tilt');
      setTimeout(function () { dog.classList.remove('tilt'); }, 1150);
    }

    answerInput.value = '';
    answerInput.focus();
  }

  // ==================== 场景切换 ====================
  function triggerTransition() {
    transitionDone = true;
    answerInput.disabled = true;
    submitBtn.disabled = true;
    showHint('答对啦！✨');

    // 所有小狗开心地跳起来
    put(peekSlot, { breed: 'shiba', pose: 'peek', eyes: 'joy', mouth: 'tongue' });
    document.querySelectorAll('#scene-summer .dog').forEach(function (d, i) {
      setTimeout(function () { d.classList.add('hop'); }, i * 140);
    });
    desync();

    // iPhone / Safari 只允许在点击的同一时刻开始播放，所以现在就调用 play()，
    // 音量先设为 0，场景切换后再渐入。
    startMusic();

    setTimeout(function () {
      setupSunsetDogs();
      buildGround();
      buildMotes();

      sceneSummer.classList.remove('active');
      sceneSunset.classList.remove('idle');
      sceneSunset.classList.add('active');

      setTimeout(function () { sceneSummer.classList.add('idle'); }, 1900);

      setTimeout(function () {
        revealLoveText();
        startHeartParticles();
        showMusicInfo();
      }, 1500);
    }, 1800);
  }

  // ==================== 黄昏场景的布景 ====================
  function tuftSVG() {
    var kind = Math.floor(Math.random() * 4);
    var blades = '<path d="M8,40 C6,26 10,14 14,6 C17,18 17,30 17,40 Z" fill="#7CCB7E"/>' +
                 '<path d="M17,40 C19,28 25,19 33,13 C31,24 27,33 25,40 Z" fill="#58B06E"/>' +
                 '<path d="M1,40 C5,33 11,28 18,26 C14,31 12,36 12,40 Z" fill="#46A062"/>';
    var flower = '';
    if (kind > 0) {
      var petal = ['', '#FFFFFF', '#FFB6C8', '#FFE27A'][kind];
      var f = '';
      for (var a = 0; a < 5; a++) {
        f += '<ellipse cx="0" cy="-5.2" rx="3.4" ry="4.6" transform="rotate(' + (a * 72) + ')" fill="' + petal + '"/>';
      }
      flower = '<path d="M20,40 L20,16" stroke="#46A062" stroke-width="2.4" stroke-linecap="round"/>' +
               '<g transform="translate(20,12)">' + f + '<circle r="3" fill="#FFB347"/></g>';
    }
    return '<svg class="tuft" viewBox="0 0 40 44" style="top:' + (Math.random() * 40 + 2).toFixed(0) + '%">' + blades + flower + '</svg>';
  }

  function buildGround() {
    if (!groundEl || groundEl.firstChild) return;
    var n = 18, html = '';
    for (var half = 0; half < 2; half++) {
      for (var i = 0; i < n; i++) {
        var left = (half * 50 + (i + Math.random() * 0.6) / n * 50).toFixed(2);
        html += tuftSVG().replace('<svg class="tuft"', '<svg class="tuft" data-x="' + left + '"');
      }
    }
    var wrap = document.createElement('div');
    wrap.className = 'ground-scroll';
    wrap.innerHTML = html;
    // 两半要一模一样才能无缝循环：复制前一半
    var tufts = wrap.querySelectorAll('.tuft');
    for (var k = 0; k < n; k++) {
      var a = tufts[k], b = tufts[n + k];
      b.outerHTML = a.outerHTML;
    }
    wrap.querySelectorAll('.tuft').forEach(function (t, idx) {
      var x = parseFloat(t.getAttribute('data-x'));
      if (idx >= n) x = parseFloat(wrap.querySelectorAll('.tuft')[idx - n].getAttribute('data-x')) + 50;
      t.style.left = x + '%';
    });
    groundEl.appendChild(wrap);
  }

  function buildMotes() {
    if (prefersReducedMotion || !driftArea || driftArea.firstChild) return;
    var frag = document.createDocumentFragment();
    for (var i = 0; i < 26; i++) {
      var m = document.createElement('span');
      m.className = 'mote';
      var s = 4 + Math.random() * 6;
      m.style.left = (Math.random() * 100).toFixed(1) + '%';
      m.style.width = m.style.height = s.toFixed(1) + 'px';
      m.style.animationDuration = (10 + Math.random() * 12).toFixed(1) + 's';
      m.style.animationDelay = (-Math.random() * 20).toFixed(1) + 's';
      m.style.setProperty('--sway', ((Math.random() - 0.5) * 120).toFixed(0) + 'px');
      frag.appendChild(m);
    }
    driftArea.appendChild(frag);
  }

  // ==================== 音乐 ====================
  function setMusicUI(playing) {
    musicBtn.classList.toggle('paused', !playing);
    musicLabel.textContent = playing ? '正在播放...' : '已暂停，点击播放';
    musicBtn.setAttribute('aria-label', playing ? '暂停音乐' : '播放音乐');
  }

  if (bgm) {
    bgm.addEventListener('playing', function () { setMusicUI(true); });
    bgm.addEventListener('pause', function () { setMusicUI(false); });
    bgm.addEventListener('error', function () { musicLabel.textContent = '音乐加载失败'; });
  }

  function startMusic() {
    if (!bgm) return;
    warmAudio();
    bgm.volume = 0;
    var p = bgm.play();
    if (p && p.then) {
      p.then(function () {
        setTimeout(function () { if (!bgm.paused) fadeInVolume(bgm, MUSIC_VOLUME, 3000); }, 2700);
      }).catch(function () { setMusicUI(false); });
    }
  }

  function toggleMusic() {
    if (!bgm) return;
    if (bgm.paused) {
      userPaused = false;
      bgm.play().then(function () { fadeInVolume(bgm, MUSIC_VOLUME, 800); }).catch(function () {});
    } else {
      userPaused = true;
      bgm.pause();
    }
  }
  musicBtn.addEventListener('click', toggleMusic);

  function fadeInVolume(audioEl, targetVol, duration) {
    var token = ++fadeToken;
    var startVol = audioEl.volume;
    var startTime = performance.now();
    function step(now) {
      if (token !== fadeToken) return;
      var progress = Math.min(Math.max((now - startTime) / duration, 0), 1);
      var eased = 1 - Math.pow(1 - progress, 3);
      audioEl.volume = Math.min(1, Math.max(0, startVol + (targetVol - startVol) * eased));
      if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function showMusicInfo() {
    musicBtn.disabled = false;
    musicBtn.classList.add('visible');
  }

  // ==================== "我爱你" ====================
  function revealLoveText() {
    var chars = loveText.querySelectorAll('.char');
    var delays = [500, 1500, 2500];
    chars.forEach(function (el, i) {
      setTimeout(function () { el.classList.add('visible'); }, delays[i]);
    });
    setTimeout(function () { loveText.classList.add('breathing'); }, 4200);
    // 「我爱你」都出来、站稳之后，登录入口再轻轻浮现
    setTimeout(function () {
      var login = document.getElementById('login');
      if (login) login.classList.add('visible');
    }, 4600);
  }

  // ==================== 飘起的爱心 ====================
  var HEART_COLORS = ['#FF7A6B', '#FF8FB0', '#FFD66B', '#FFFFFF', '#FF5E7A'];

  function startHeartParticles() {
    if (prefersReducedMotion) return;
    burstHearts(14);
    startHeartTimers();
  }

  function startHeartTimers() {
    if (prefersReducedMotion || !transitionDone) return;
    stopHeartTimers();
    heartsInterval = setInterval(function () { spawnHeart(); }, 1600);
    burstInterval = setInterval(function () { burstHearts(8); }, 15000);
  }

  function stopHeartTimers() {
    clearInterval(heartsInterval);
    clearInterval(burstInterval);
    heartsInterval = burstInterval = null;
  }

  function burstHearts(count) {
    for (var i = 0; i < count; i++) {
      setTimeout(function () { spawnHeart(true); }, i * 130);
    }
  }

  function spawnHeart(isBurst) {
    if (heartsArea.childElementCount > 36) return;
    var ns = 'http://www.w3.org/2000/svg';
    var heart = document.createElementNS(ns, 'svg');
    heart.setAttribute('viewBox', '0 0 32 30');
    heart.setAttribute('class', 'heart-particle');
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M16,28 C-6,14 4,-4 16,8 C28,-4 38,14 16,28 Z');
    var color = HEART_COLORS[Math.floor(Math.random() * HEART_COLORS.length)];
    path.setAttribute('fill', color);
    path.setAttribute('stroke', '#6A4030');
    path.setAttribute('stroke-width', '2.2');
    path.setAttribute('stroke-linejoin', 'round');
    heart.appendChild(path);

    heart.style.left = (isBurst ? 30 + Math.random() * 40 : Math.random() * 92) + '%';
    heart.style.bottom = (8 + Math.random() * 10) + '%';
    var size = 18 + Math.random() * 30;
    heart.style.width = size + 'px';
    var duration = 4 + Math.random() * 4;
    heart.style.animationDuration = duration + 's';
    heart.style.setProperty('--sway', ((Math.random() - 0.5) * 120).toFixed(0) + 'px');
    heart.style.setProperty('--rot', ((Math.random() - 0.5) * 50).toFixed(0) + 'deg');

    heartsArea.appendChild(heart);
    setTimeout(function () { if (heart.parentNode) heart.parentNode.removeChild(heart); }, duration * 1000 + 300);
  }

  // ==================== 键盘 / 可见性 ====================
  document.addEventListener('keydown', function (e) {
    if (e.code !== 'Space' || !transitionDone || !bgm || !bgm.paused) return;
    // 在输入框里打空格、或在按钮上按空格，都不能被"恢复音乐"抢走
    if (e.target && e.target.closest && e.target.closest('input, textarea, select, button, a, [contenteditable]')) return;
    e.preventDefault();
    userPaused = false;
    bgm.play().then(function () { fadeInVolume(bgm, MUSIC_VOLUME, 800); }).catch(function () {});
  });

  document.addEventListener('visibilitychange', function () {
    if (!transitionDone) return;
    if (document.hidden) {
      stopHeartTimers();
      if (bgm && !bgm.paused) { pausedByHidden = true; bgm.pause(); }
    } else {
      startHeartTimers();
      if (bgm && pausedByHidden && !userPaused) bgm.play().catch(function () {});
      pausedByHidden = false;
    }
  });

  // 旧浏览器不支持 overflow: clip 时的保险：场景一旦被滚歪（草地比屏幕宽），立刻拨回原位
  document.querySelectorAll('.scene').forEach(function (s) {
    s.addEventListener('scroll', function () { s.scrollLeft = 0; s.scrollTop = 0; }, { passive: true });
  });

  // ==================== 启动 ====================
  setupBeachDogs();
  desync();
  answerInput.focus({ preventScroll: true });

  // 点击空白处聚焦输入框（点到小狗之类也算）
  document.addEventListener('click', function (e) {
    if (!transitionDone && e.target !== answerInput && e.target !== submitBtn) {
      answerInput.focus({ preventScroll: true });
    }
  });

})();
