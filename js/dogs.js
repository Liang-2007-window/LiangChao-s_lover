/**
 * 小狗角色生成器
 * 用法：Dogs.make({ breed: 'shiba', pose: 'sit', eyes: 'open', ... }) 返回一个 <svg> 字符串
 *
 * breed : 'shiba'（橙色柴犬）| 'pup'（奶油色垂耳小狗）| 'kuro'（黑色小狗，棕色眉点）
 * pose  : 'sit'（坐着，完整身体）| 'peek'（只露出脑袋和两只爪子，趴在边缘上）
 * eyes  : 'open'（圆眼睛，会眨）| 'joy'（笑眼 ^ ^）| 'sleep'（闭眼睡觉）
 * mouth : 'smile'（小 w 嘴）| 'tongue'（吐舌头）
 * acc   : 配饰数组：'sunglasses' | 'scarf' | 'flower' | 'bow' | 'heart'
 */
(function (root) {
  'use strict';

  var PALETTES = {
    shiba: { fur: '#F2A257', cream: '#FFF3DF', ear: '#FFB5A5', patch: '#F2A257', line: '#6A4030', brow: '#FFF3DF', mask: '#FFF3DF' },
    pup:   { fur: '#FFF4E4', cream: '#FFFFFF', ear: '#FFB5A5', patch: '#B9805A', line: '#6A4030', brow: '#B9805A', mask: '#FFFFFF' },
    kuro:  { fur: '#5E4B45', cream: '#F1C48B', ear: '#FFB5A5', patch: '#5E4B45', line: '#3B2A25', brow: '#F1C48B', mask: '#F1C48B' }
  };

  var INK = '#3A2318';

  function eye(cx, cy, mode) {
    if (mode === 'joy') {
      return '<path class="eye-line" d="M' + (cx - 9) + ',' + (cy + 3) + ' Q' + cx + ',' + (cy - 9) + ' ' + (cx + 9) + ',' + (cy + 3) + '"/>';
    }
    if (mode === 'sleep') {
      return '<path class="eye-line" d="M' + (cx - 9) + ',' + (cy - 1) + ' Q' + cx + ',' + (cy + 8) + ' ' + (cx + 9) + ',' + (cy - 1) + '"/>';
    }
    return '<g class="eye"><ellipse cx="' + cx + '" cy="' + cy + '" rx="7.6" ry="9.2" fill="' + INK + '"/>' +
      '<circle cx="' + (cx - 2.4) + '" cy="' + (cy - 3.2) + '" r="3" fill="#fff"/>' +
      '<circle cx="' + (cx + 2.6) + '" cy="' + (cy + 3.2) + '" r="1.4" fill="#fff"/></g>';
  }

  function mouth(kind) {
    var m = '<path class="mouth-line" d="M100,113 L100,118 M100,118 Q93,126 86,120 M100,118 Q107,126 114,120"/>';
    if (kind === 'tongue') {
      m = '<path d="M93,121 Q100,142 107,121 Q100,126 93,121 Z" fill="#FF8DA1" stroke="' + INK + '" stroke-width="2.4" stroke-linejoin="round"/>' +
          '<path d="M100,124 L100,131" stroke="#E5667F" stroke-width="2" stroke-linecap="round"/>' + m;
    }
    return m;
  }

  function accessories(list, pose) {
    var out = '';
    list = list || [];
    if (list.indexOf('scarf') >= 0 && pose !== 'peek') {
      out += '<g class="o-fill">' +
        '<path d="M58,134 Q100,156 142,134 L146,150 Q100,174 54,150 Z" fill="#FF7A6B"/>' +
        '<path d="M116,154 Q132,168 128,186 Q118,184 110,178 Q116,168 116,154 Z" fill="#FF7A6B"/>' +
        '<path d="M66,141 Q100,160 134,141" fill="none" stroke="#fff" stroke-width="2.4" stroke-dasharray="1 7" stroke-linecap="round"/></g>';
    }
    return out;
  }

  function faceAcc(list) {
    var out = '';
    list = list || [];
    if (list.indexOf('sunglasses') >= 0) {
      out += '<g class="sunnies">' +
        '<rect x="46" y="76" width="42" height="30" rx="14" fill="#2B2540" stroke="' + INK + '" stroke-width="3"/>' +
        '<rect x="112" y="76" width="42" height="30" rx="14" fill="#2B2540" stroke="' + INK + '" stroke-width="3"/>' +
        '<path d="M88,88 Q100,82 112,88" fill="none" stroke="' + INK + '" stroke-width="3.2" stroke-linecap="round"/>' +
        '<path d="M54,84 L66,84 M120,84 L132,84" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".55"/></g>';
    }
    if (list.indexOf('flower') >= 0) {
      var f = '';
      for (var i = 0; i < 5; i++) {
        f += '<ellipse cx="0" cy="-8.5" rx="6" ry="7.5" transform="rotate(' + (i * 72) + ')" fill="#FF8CA5" stroke="' + INK + '" stroke-width="2"/>';
      }
      out += '<g transform="translate(150,44)">' + f + '<circle r="5" fill="#FFD84D" stroke="' + INK + '" stroke-width="2"/></g>';
    }
    if (list.indexOf('bow') >= 0) {
      out += '<g transform="translate(56,42)" class="o-fill" fill="#FF7A6B">' +
        '<path d="M0,0 L-18,-11 Q-22,0 -18,11 Z"/><path d="M0,0 L18,-11 Q22,0 18,11 Z"/><circle r="5"/></g>';
    }
    return out;
  }

  function head(breed, opts) {
    var P = PALETTES[breed];
    var floppy = (breed === 'pup');
    var s = '';

    // —— 耳朵（画在脑袋后面）——
    if (floppy) {
      s += '<g class="ear ear-l"><path class="o" fill="' + P.patch + '" d="M44,50 C16,52 8,96 20,128 C32,138 52,122 58,98 C62,78 60,58 44,50 Z"/></g>' +
           '<g class="ear ear-r"><path class="o" fill="' + P.patch + '" d="M156,50 C184,52 192,96 180,128 C168,138 148,122 142,98 C138,78 140,58 156,50 Z"/></g>';
    } else {
      s += '<g class="ear ear-l"><path class="o" fill="' + P.fur + '" d="M30,76 C22,50 30,24 49,19 C67,26 84,38 92,52 Z"/>' +
           '<path fill="' + P.ear + '" d="M40,66 C36,50 40,38 50,35 C60,37 70,44 76,52 Z"/></g>' +
           '<g class="ear ear-r"><path class="o" fill="' + P.fur + '" d="M170,76 C178,50 170,24 151,19 C133,26 116,38 108,52 Z"/>' +
           '<path fill="' + P.ear + '" d="M160,66 C164,50 160,38 150,35 C140,37 130,44 124,52 Z"/></g>';
    }

    // —— 脑袋 ——
    s += '<path class="o" fill="' + P.fur + '" d="M30,94 C26,52 62,34 100,34 C138,34 174,52 170,94 C168,122 136,141 100,141 C64,141 32,122 30,94 Z"/>';
    // 高光
    s += '<path d="M56,52 C68,42 84,40 94,41" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" opacity=".28"/>';

    if (floppy) {
      // 眼周的棕色斑块（只在左眼，更有个性）
      s += '<ellipse cx="68" cy="88" rx="23" ry="21" fill="' + P.patch + '"/>';
    }

    // 口鼻部浅色区域
    s += '<path fill="' + P.mask + '" d="M45,106 C46,88 66,86 84,98 C92,102 108,102 116,98 C134,86 154,88 155,106 C157,126 132,135 100,135 C68,135 43,126 45,106 Z"/>';
    if (!floppy) {
      // 柴犬标志性的"四只眼睛"眉点
      s += '<circle cx="70" cy="64" r="5.2" fill="' + P.brow + '"/><circle cx="130" cy="64" r="5.2" fill="' + P.brow + '"/>';
    } else {
      s += '<circle cx="132" cy="66" r="0" />';
    }

    // —— 五官 ——
    s += '<g class="eyes">' + eye(69, 94, opts.eyes) + eye(131, 94, opts.eyes) + '</g>';
    s += '<path d="M92,103 Q100,98 108,103 Q106,111 100,113 Q94,111 92,103 Z" fill="' + INK + '"/>' +
         '<ellipse cx="98" cy="102.5" rx="3" ry="1.4" fill="#fff" opacity=".7"/>';
    s += mouth(opts.mouth);
    s += '<ellipse cx="49" cy="110" rx="10" ry="6" fill="#FF8DA1" opacity=".5"/><ellipse cx="151" cy="110" rx="10" ry="6" fill="#FF8DA1" opacity=".5"/>';

    s += faceAcc(opts.acc);
    return s;
  }

  function make(opts) {
    opts = opts || {};
    var breed = opts.breed || 'shiba';
    var pose = opts.pose || 'sit';
    var P = PALETTES[breed];
    var cls = 'dog dog-' + breed + ' pose-' + pose + (opts.cls ? ' ' + opts.cls : '');
    var vb = pose === 'peek' ? '0 0 200 168' : '0 0 200 222';
    var style = '--line:' + P.line + ';';
    var s = '<svg class="' + cls + '" viewBox="' + vb + '" style="' + style + '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="' + (opts.label || '可爱的小狗') + '">';

    if (pose === 'peek') {
      s += '<g class="dog-head">' + head(breed, opts) + '</g>';
      // 两只爪子搭在边缘上（画在最前面，盖住下巴）
      s += '<g class="paws">' +
        '<path class="o" fill="' + P.cream + '" d="M38,168 C34,142 44,126 63,126 C82,126 92,142 88,168 Z"/>' +
        '<path class="o" fill="' + P.cream + '" d="M112,168 C108,142 118,126 137,126 C156,126 166,142 162,168 Z"/>' +
        '<path class="toe" d="M55,138 L55,147 M71,138 L71,147 M129,138 L129,147 M145,138 L145,147"/></g>';
    } else {
      s += '<ellipse cx="100" cy="214" rx="62" ry="7" fill="#7A5230" opacity=".16"/>';
      // 尾巴
      s += '<g class="tail"><path d="M136,196 C178,204 192,160 166,140" fill="none" stroke="' + P.line + '" stroke-width="29" stroke-linecap="round"/>' +
           '<path d="M136,196 C178,204 192,160 166,140" fill="none" stroke="' + P.fur + '" stroke-width="22" stroke-linecap="round"/></g>';
      // 身体
      s += '<path class="o" fill="' + P.fur + '" d="M56,214 C38,160 60,124 100,124 C140,124 162,160 144,214 Z"/>';
      s += '<path fill="' + P.cream + '" d="M80,213 C76,182 84,152 100,150 C116,152 124,182 120,213 Z"/>';
      // 前腿
      s += '<rect class="o" x="70" y="172" width="24" height="42" rx="12" fill="' + P.cream + '"/>' +
           '<rect class="o" x="106" y="172" width="24" height="42" rx="12" fill="' + P.cream + '"/>' +
           '<path class="toe" d="M82,202 L82,209 M118,202 L118,209"/>';
      s += accessories(opts.acc, pose);
      s += '<g class="dog-head">' + head(breed, opts) + '</g>';
    }
    s += '</svg>';
    return s;
  }

  root.Dogs = { make: make, PALETTES: PALETTES };
})(window);
