/**
 * 台湾沿海 · 夏日晴天 → 黄昏单车骑行
 * 青春互动网页
 */

(function () {
  'use strict';

  // ========== DOM 元素 ==========
  const sceneSummer = document.getElementById('scene-summer');
  const sceneSunset = document.getElementById('scene-sunset');
  const answerInput = document.getElementById('answer-input');
  const submitBtn = document.getElementById('submit-btn');
  const hintText = document.getElementById('hint-text');
  const questionCard = document.querySelector('.question-card');
  const bgm = document.getElementById('bgm');
  const musicInfo = document.getElementById('music-info');
  const loveText = document.getElementById('love-text');
  const heartsArea = document.getElementById('hearts-area');
  const starsContainer = document.getElementById('stars-container');

  // ========== 状态 ==========
  let transitionDone = false;
  let heartsInterval = null;

  // ========== 正确答案 ==========
  const CORRECT_ANSWER = '刘克';

  // ========== 错误提示语 ==========
  const wrongHints = [
    '再想想看～💭',
    '不对哦，仔细想一想～',
    '提示：是一个很特别的人 ✨',
    '答案就在你心中 ❤️',
    '那个人名字有两个字哦～',
    '再试试吧！你一定知道的 🌟',
  ];

  let wrongCount = 0;

  // ========== 事件监听 ==========
  submitBtn.addEventListener('click', handleSubmit);
  answerInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') handleSubmit();
  });

  // ========== 提交答案 ==========
  function handleSubmit() {
    if (transitionDone) return;

    var answer = answerInput.value.trim();

    if (!answer) {
      showHint('请输入答案哦～');
      return;
    }

    if (answer === CORRECT_ANSWER) {
      triggerTransition();
    } else {
      showWrongHint();
    }
  }

  // ========== 错误提示 ==========
  function showWrongHint() {
    var idx = wrongCount % wrongHints.length;
    showHint(wrongHints[idx]);
    wrongCount++;

    // 抖动卡片
    questionCard.classList.remove('shake');
    void questionCard.offsetWidth; // reflow
    questionCard.classList.add('shake');

    // 清空输入
    answerInput.value = '';
    answerInput.focus();

    // 自动清除抖动
    setTimeout(function () {
      questionCard.classList.remove('shake');
    }, 500);
  }

  // ========== 显示提示 ==========
  function showHint(msg) {
    hintText.textContent = msg;
    hintText.style.opacity = '0';
    hintText.style.transform = 'translateY(-5px)';
    void hintText.offsetWidth;
    hintText.style.opacity = '1';
    hintText.style.transform = 'translateY(0)';
    hintText.style.transition = 'all 0.3s ease';
  }

  // ========== 场景切换 ==========
  function triggerTransition() {
    transitionDone = true;

    // 禁用输入
    answerInput.disabled = true;
    submitBtn.disabled = true;
    showHint('✨ 答对了！✨');

    // 短暂延迟后切换场景
    setTimeout(function () {
      // 隐藏夏日场景
      sceneSummer.classList.remove('active');

      // 显示黄昏场景
      sceneSunset.classList.add('active');

      // 初始化黄昏场景元素
      initSunsetScene();

      // 延迟显示文字和音乐
      setTimeout(function () {
        playMusic();
        revealLoveText();
        startHeartParticles();
        showMusicInfo();
      }, 1500);
    }, 1200);
  }

  // ========== 初始化黄昏场景 ==========
  function initSunsetScene() {
    generateStars();
    animateGuardrails();
  }

  // ========== 生成星星 ==========
  function generateStars() {
    var count = 40;
    var fragment = document.createDocumentFragment();

    for (var i = 0; i < count; i++) {
      var star = document.createElement('div');
      star.className = 'star';
      star.style.left = Math.random() * 90 + '%';
      star.style.top = Math.random() * 60 + '%';
      star.style.animationDelay = Math.random() * 3 + 's';
      star.style.animationDuration = 2 + Math.random() * 3 + 's';
      star.style.width = 1 + Math.random() * 3 + 'px';
      star.style.height = star.style.width;
      fragment.appendChild(star);
    }

    starsContainer.appendChild(fragment);
  }

  // ========== 动画护栏 ==========
  function animateGuardrails() {
    var posts = document.querySelectorAll('.guardrail-post');
    posts.forEach(function (post, index) {
      post.style.animationDelay = -(index * 0.25) + 's';
    });
  }

  // ========== 播放音乐 ==========
  function playMusic() {
    if (bgm) {
      bgm.volume = 0;
      bgm.play().then(function () {
        // 渐入音量
        fadeInVolume(bgm, 0.6, 3000);
      }).catch(function () {
        // 浏览器可能阻止自动播放，显示提示
        console.log('请点击页面任意位置以开始播放音乐');
        document.addEventListener('click', function playOnClick() {
          bgm.play().then(function () {
            fadeInVolume(bgm, 0.6, 2000);
          }).catch(function () {});
          document.removeEventListener('click', playOnClick);
        }, { once: true });
      });
    }
  }

  // ========== 音量渐入 ==========
  function fadeInVolume(audioEl, targetVol, duration) {
    var startVol = audioEl.volume;
    var startTime = performance.now();

    function step(currentTime) {
      var elapsed = currentTime - startTime;
      var progress = Math.min(elapsed / duration, 1);
      // ease-out
      var eased = 1 - Math.pow(1 - progress, 3);
      audioEl.volume = startVol + (targetVol - startVol) * eased;

      if (progress < 1) {
        requestAnimationFrame(step);
      }
    }

    requestAnimationFrame(step);
  }

  // ========== 显示音乐提示 ==========
  function showMusicInfo() {
    musicInfo.classList.add('visible');
  }

  // ========== 逐字浮现"我爱你" ==========
  function revealLoveText() {
    var chars = loveText.querySelectorAll('.char');
    var delays = [600, 1800, 3000]; // 每个字的延迟

    chars.forEach(function (charEl, i) {
      setTimeout(function () {
        charEl.classList.add('visible');
      }, delays[i]);
    });

    // 全部显示后，添加呼吸动画
    setTimeout(function () {
      loveText.classList.add('breathing');
    }, 4500);
  }

  // ========== 爱心粒子效果 ==========
  function startHeartParticles() {
    // 生成初始爱心爆发
    burstHearts(15);

    // 持续生成爱心
    heartsInterval = setInterval(function () {
      spawnHeart();
    }, 2000);

    // 每30秒来一次小爆发
    setInterval(function () {
      burstHearts(8);
    }, 15000);
  }

  // ========== 爱心爆发 ==========
  function burstHearts(count) {
    for (var i = 0; i < count; i++) {
      setTimeout(function () {
        spawnHeart(true);
      }, i * 120);
    }
  }

  // ========== 生成单颗爱心 ==========
  function spawnHeart(isBurst) {
    var heart = document.createElement('span');
    heart.className = 'heart-particle';

    var hearts = ['❤️', '💕', '💖', '💗', '💝', '✨', '💫', '🌸'];
    heart.textContent = hearts[Math.floor(Math.random() * hearts.length)];

    // 随机位置
    var startX = isBurst ? 30 + Math.random() * 40 : Math.random() * 90;
    heart.style.left = startX + '%';
    heart.style.bottom = '10%';

    // 随机大小
    var size = 1 + Math.random() * 2;
    heart.style.fontSize = size + 'rem';

    // 随机动画时长
    var duration = 3 + Math.random() * 4;
    heart.style.animationDuration = duration + 's';

    heartsArea.appendChild(heart);

    // 动画结束后移除
    setTimeout(function () {
      if (heart.parentNode) {
        heart.parentNode.removeChild(heart);
      }
    }, duration * 1000 + 500);
  }

  // ========== 键盘事件：空格键触发音乐 ==========
  document.addEventListener('keydown', function (e) {
    if (e.code === 'Space' && transitionDone && bgm && bgm.paused) {
      e.preventDefault();
      bgm.play().catch(function () {});
    }
  });

  // ========== 页面可见性变化时处理音乐 ==========
  document.addEventListener('visibilitychange', function () {
    if (!transitionDone) return;
    if (document.hidden) {
      if (bgm && !bgm.paused) bgm.pause();
    } else {
      if (bgm && bgm.paused) bgm.play().catch(function () {});
    }
  });

  // ========== 初始聚焦 ==========
  answerInput.focus();

  // ========== 点击页面任意位置聚焦输入框 ==========
  document.addEventListener('click', function (e) {
    if (!transitionDone && e.target !== answerInput && e.target !== submitBtn) {
      answerInput.focus();
    }
  });

})();
