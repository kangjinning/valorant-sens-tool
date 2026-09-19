/* =============================================================================
 * testflow.js — 灵敏度测试流程控制器（全屏引导式测试 + 综合评分 + 推荐）
 * -----------------------------------------------------------------------------
 * 目标：把「凭感觉调灵敏度」变成一套**有流程、有数据、有结论**的测试。
 *
 * 流程总览：
 *   准备（说明 + 选择档位数 + 可选鼠标垫宽度 + 进入全屏/锁定鼠标）
 *     ↓
 *   热身（用当前灵敏度跑一轮，数据丢弃，消除「刚开始手生」的偏差）
 *     ↓
 *   逐个候选档位循环 × N：
 *      切换画布灵敏度 → 倒计时 → 甩枪定位（x 个靶）→ 倒计时 → 跟枪（y 秒）
 *     ↓
 *   综合评分（四项指标 min-max 归一化后加权）→ 推荐灵敏度 + 数据表 + 结论可信度
 *     ↓
 *   [应用推荐] / [以推荐值为中心再精测一轮] / [重新测试]
 *
 * 方法论要点（决定了推荐结果是否可信）：
 *   1. **同题同卷**：所有候选档位使用同一组甩枪角度偏移与同一段跟枪波形，
 *      挑战完全一致，差异只可能来自灵敏度本身。
 *   2. **热身丢弃**：第一轮数据不计分，避免把学习效应误判成「这档更好」。
 *   3. **乱序测试**：候选顺序随机打乱，避免「越测越熟练 → 最后测的档位占便宜」。
 *   4. **锁定俯仰**：只考察 eDPI 真正影响的横向能力。
 *   5. **诚实结论**：若各档分差小于测量噪声阈值，会直接告诉用户
 *      「没有显著差异，建议保留当前值」，而不是硬推一个「最优解」。
 *
 * 依赖：js/canvas.js（VRangeTest 提供 drill）、js/calc.js（VCalc）、js/data.js
 * ============================================================================= */

/* eslint-disable no-var */
var VTestFlow = (function () {
  'use strict';

  /* ========================== 预设与常量 ========================== */

  /** 预设：档位数 + 每个子测试的长度。数字越小越快，越大越准。 */
  var PRESETS = {
    fast: {
      key: 'fast', label: '快速', desc: '3 档 · 每档 4 个甩枪靶 + 5 秒跟枪',
      candidates: 3, flicks: 4, trackMs: 5000, countdownMs: 1200,
      timeoutMs: 2200, warmup: true, warmupFlicks: 3, est: '约 1 分钟'
    },
    normal: {
      key: 'normal', label: '标准', desc: '5 档 · 每档 6 个甩枪靶 + 8 秒跟枪',
      candidates: 5, flicks: 6, trackMs: 8000, countdownMs: 1500,
      timeoutMs: 2600, warmup: true, warmupFlicks: 3, est: '约 2 分钟'
    },
    fine: {
      key: 'fine', label: '精细', desc: '7 档 · 每档 8 个甩枪靶 + 10 秒跟枪',
      candidates: 7, flicks: 8, trackMs: 10000, countdownMs: 1500,
      timeoutMs: 2600, warmup: true, warmupFlicks: 4, est: '约 3-4 分钟'
    }
  };

  /** 候选档位的等比倍数（以玩家当前灵敏度为中心向两侧展开） */
  var MULT_SETS = {
    3: [0.75, 1.0, 1.33],
    5: [0.65, 0.80, 1.0, 1.25, 1.56],
    7: [0.55, 0.68, 0.82, 1.0, 1.22, 1.48, 1.80]
  };

  /**
   * 甩枪靶的**水平**偏移幅值池（度）。
   * 刻意控制在 ±32° 以内：水平 FOV 103° 意味着画面左右各只有约 51.5°，
   * 偏移一旦超过这个范围，靶子就落在屏幕外，玩家只能「盲拖」——
   * 那测的就不是灵敏度而是运气了。
   */
  var FLICK_AZ_MAGS = [10, 20, 28, 14, 24, 32, 16, 26];

  /**
   * 甩枪靶的**垂直**偏移幅值池（度）。
   * 让测试覆盖「上下」方向：垂直 FOV 约 ±33°，因此 ±10° 保证始终可见。
   */
  var FLICK_EL_MAGS = [0, 6, -5, 9, -8, 4, -7, 10];

  /** 跟枪目标的正弦横移参数（所有档位一致） */
  var TRACK_AMPLITUDE = 16;   // 度
  var TRACK_PERIOD_MS = 2500; // 毫秒

  /** 评分指标权重（合计 1.0） */
  var METRIC_DEFS = [
    { key: 'flickHitRate', weight: 0.30, dir: 'high', label: '甩枪命中率' },
    { key: 'flickSpeed', weight: 0.25, dir: 'high', label: '甩枪速度' },
    { key: 'pathScore', weight: 0.20, dir: 'high', label: '路径效率（过冲少）' },
    { key: 'trackScore', weight: 0.25, dir: 'high', label: '跟枪稳定性' }
  ];

  /** 判定「差异是否显著」的分差阈值（满分 100） */
  var SIGNIFICANT_SPREAD = 4;

  /* ========================== 小工具 ========================== */
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function round3(v) { return Math.round(v * 1000) / 1000; }
  function fmt(v, d) { return VCalc.format(v, d === undefined ? 2 : d); }
  function fmtSens(v) { return VCalc.formatSens(v); }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  /** Fisher-Yates 乱序（不影响调用方数组） */
  function shuffled(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /**
   * 生成候选灵敏度档位。
   * 以当前灵敏度为中心等比向两侧展开，并处理两个边界情况：
   *   · 低于 0.01 / 高于 10 的值会被裁剪（游戏内合法范围）
   *   · 裁剪后若档位重复导致不足 2 个，则改为只向可用方向扩展
   */
  function buildCandidates(baseSens, count) {
    var mults = MULT_SETS[count] || MULT_SETS[5];
    var out = [];
    var seen = {};

    function push(v) {
      var s = round3(clamp(v, VCalc.SENS_MIN, VCalc.SENS_MAX));
      var k = s.toFixed(3);
      if (!seen[k]) { seen[k] = 1; out.push(s); }
    }

    for (var i = 0; i < mults.length; i++) push(baseSens * mults[i]);

    if (out.length < 2) {
      // 边界情况（如灵敏度已经贴着 10）：只朝一个方向扩展
      out = []; seen = {};
      var dir = baseSens > 1 ? (1 / 1.25) : 1.25;
      for (var j = 0; j < count; j++) push(baseSens * Math.pow(dir, j));
    }
    return out;
  }

  /**
   * 生成甩枪靶的相对偏移序列（水平 + 垂直，左右交替）。
   *
   * 设计要点：
   *   · 水平左右交替，避免形成单向肌肉记忆；
   *   · 幅度控制在视野内（±32° 水平 / ±10° 垂直），保证「看得到、够得着」，
   *     不会出现「要拉一整个屏幕才能看见下一个靶」的情况；
   *   · 垂直幅值混入 0（纯水平）、正负（向上/向下）与较大值，覆盖四个方向；
   *   · 每次会话生成一次，所有候选档位共用 → 同题同卷。
   * @param {number} n 目标数量
   * @returns {Array<{az:number, el:number}>}
   */
  function buildFlickOffsets(n) {
    var out = [];
    var sign = Math.random() < 0.5 ? 1 : -1;
    for (var i = 0; i < n; i++) {
      out.push({
        az: round3(sign * FLICK_AZ_MAGS[i % FLICK_AZ_MAGS.length]),
        el: round3(FLICK_EL_MAGS[i % FLICK_EL_MAGS.length])
      });
      if (i % 2 === 1) sign = -sign;    // 每两个换一次左右方向
    }
    return out;
  }

  /* ========================== 评分 ========================== */

  /**
   * 把一档的原始测量值转换成 4 个派生指标。
   * @param {Object} row { sens, flick:{...}, track:{...} }
   */
  function deriveMetrics(row) {
    var f = row.flick, t = row.track;
    var pathRatio = f ? f.pathRatio : null;
    return {
      flickHitRate: f ? f.hitRate : 0,                                  // 0~1
      // 速度：一个靶都没命中时按最慢处理（2000ms）——「打不到」本身就是最差信号
      flickAvgMs: (f && f.avgMs !== null && f.avgMs !== undefined) ? f.avgMs : 2000,
      // 路径效率：理想路径 ÷ 实际路径。1.0 = 一次到位，越小说明回拉/过冲越多。
      // 数据缺失（NaN/null）时返回 null，由归一化环节给「中性分」，
      // 避免把「没测到」误判成「最差」。
      pathScore: (pathRatio !== null && isFinite(pathRatio) && pathRatio > 0)
        ? clamp(1 / pathRatio, 0, 1) : null,
      trackScore: t ? clamp((t.onTargetPct || 0) / 100, 0, 1) : 0
    };
  }

  /**
   * 对所有档位做 min-max 归一化并加权求总分。
   * 归一化只在「本次会话的各档之间」进行 —— 我们只关心相对好坏，
   * 绝对分数没有意义（不同人、不同鼠标垫的绝对值不可比）。
   * @returns {Array} rows（原地补上 metrics 与 score 字段）
   */
  function scoreRows(rows) {
    if (!rows.length) return rows;

    rows.forEach(function (r) { r.metrics = deriveMetrics(r); });

    var keys = ['flickHitRate', 'flickAvgMs', 'pathScore', 'trackScore'];
    var range = {};
    keys.forEach(function (k) {
      // 只在「有效数值」之间求量程，缺失值不参与（否则会把量程拉坏）
      var vals = rows.map(function (r) { return r.metrics[k]; })
                     .filter(function (v) { return v !== null && v !== undefined && isFinite(v); });
      range[k] = vals.length
        ? { min: Math.min.apply(null, vals), max: Math.max.apply(null, vals) }
        : { min: 0, max: 0 };
    });

    rows.forEach(function (r) {
      var total = 0;
      METRIC_DEFS.forEach(function (def) {
        var k = def.key === 'flickSpeed' ? 'flickAvgMs' : def.key;
        var v = r.metrics[k];
        var rg = range[k];
        var norm;
        if (v === null || v === undefined || !isFinite(v)) {
          norm = 0.5;                    // 指标缺失 → 中性分，既不奖励也不惩罚
        } else if (rg.max - rg.min < 1e-9) {
          norm = 0.5;                    // 所有档位一样 → 中性分，不制造虚假差异
        } else if (k === 'flickAvgMs') {
          norm = (rg.max - v) / (rg.max - rg.min);   // 越慢分越低
        } else {
          norm = (v - rg.min) / (rg.max - rg.min);
        }
        r['norm_' + def.key] = norm;
        total += def.weight * norm;
      });
      r.score = total * 100;
    });

    return rows;
  }

  /* ========================== 剪贴板 ========================== */

  /**
   * 复制文本到剪贴板，带降级方案。
   * @param {string} text
   * @param {Function} done (ok:boolean) => void
   */
  function copyText(text, done) {
    // 首选异步剪贴板 API（需要安全上下文：https / localhost / file 视浏览器而定）
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { done(true); },
        function () { done(fallbackCopy(text)); }
      );
      return;
    }
    done(fallbackCopy(text));
  }

  /** 降级：临时 textarea + execCommand（file:// 等非安全上下文下仍可用） */
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', 'readonly');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    var ok = false;
    try {
      ta.select();
      ta.setSelectionRange(0, text.length);
      ok = document.execCommand('copy');
    } catch (e) {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }

  /* ========================== 构造函数 ========================== */

  /**
   * @param {{
   *   range: Object,                 VRangeTest 实例
   *   wrap: HTMLElement,             .canvas-wrap（全屏目标）
   *   panel: HTMLElement,            #flow-panel
   *   card: HTMLElement,             #flow-card（内容容器）
   *   countdownEl: HTMLElement,      #flow-countdown
   *   countdownNum: HTMLElement,     #flow-countdown-num
   *   strip: HTMLElement,            #drill-strip
   *   stripFields: Object,           条状实时读数元素
   *   getConfig: Function,           () => ({dpi, sens})
   *   applySens: Function,           (sens) => void  把推荐值写回输入框
   *   onFinish: Function,            () => void      流程结束后恢复画布参数
   *   toast: Function                (msg, type)
   * }} opts
   */
  function VTestFlow(opts) {
    this.range = opts.range;
    this.wrap = opts.wrap;
    this.panel = opts.panel;
    this.card = opts.card;
    this.countdownEl = opts.countdownEl;
    this.countdownNum = opts.countdownNum;
    this.strip = opts.strip;
    this.stripFields = opts.stripFields || {};
    this.getConfig = opts.getConfig || function () { return { dpi: null, sens: null }; };
    this.applySens = opts.applySens || function () {};
    this.onFinish = opts.onFinish || function () {};
    /** 关闭流程后回调（用于收起手动模式、恢复页面状态） */
    this.onClose = opts.onClose || function () {};
    this.toast = opts.toast || function () {};

    this.state = 'idle';        // idle | running | paused | report
    this.presetKey = 'normal';
    this.padWidth = null;       // 可选：鼠标垫可用宽度（cm）
    this.session = null;
    this.interruptReason = null;
    this._pendingResolve = null;

    this._bind();
  }

  /* ========================== 事件绑定 ========================== */

  VTestFlow.prototype._bind = function () {
    var self = this;

    // 面板内的所有按钮统一用事件委托处理
    this.panel.addEventListener('click', function (e) {
      var t = e.target;
      while (t && t !== self.panel && !(t.getAttribute && t.getAttribute('data-flow'))) {
        t = t.parentNode;
      }
      if (!t || t === self.panel || !t.getAttribute) return;
      self._handleAction(t.getAttribute('data-flow'), t);
    });

    // 鼠标锁定丢失 / 退出全屏 → 视为测试被中断（当前档数据作废，绝不将就使用）
    document.addEventListener('pointerlockchange', function () {
      if (self.state !== 'running') return;
      var locked = document.pointerLockElement === self.range.canvas;
      if (!locked && self._lockExpected) self._interrupt('locked-lost');
    });

    this._onFsChange = function () {
      // 全屏状态一变，先让画布按新尺寸重建缓冲区并立刻补画一帧
      self._syncCanvasForFullscreen(self._isFullscreen());
      if (self.state !== 'running') return;
      if (!self._isFullscreen() && self._fsExpected) self._interrupt('fullscreen-exit');
    };
    document.addEventListener('fullscreenchange', this._onFsChange);
    document.addEventListener('webkitfullscreenchange', this._onFsChange);

    /* 切走标签页 / 最小化窗口时主动暂停。
     * 若不处理：rAF 会被浏览器暂停，但计时是按真实时间走的，
     * 回来时这一档的靶早已全部"超时"，等于白测一轮还被计了低分。 */
    this._onVisibility = function () {
      if (self.state !== 'running') return;
      if (document.hidden) self._interrupt('page-hidden');
    };
    document.addEventListener('visibilitychange', this._onVisibility);
  };

  /**
   * 释放鼠标锁定。
   * 必须在显示报告/暂停面板之前调用 —— 否则光标被锁定、隐藏，
   * 用户根本点不到面板上的按钮。
   */
  VTestFlow.prototype._releaseInput = function () {
    this._lockExpected = false;      // 先解除「期望锁定」，避免解锁动作把自己判定成中断
    if (this.range.locked) this.range.unlock();
  };

  /* ========================== 对外接口 ========================== */

  VTestFlow.prototype.isRunning = function () {
    return this.state === 'running' || this.state === 'paused';
  };

  /**
   * 读取页面上的测试设置。
   * 「测试强度」与「鼠标垫宽度」直接放在页面上的测试入口卡片里，
   * 因此点「开始测试」会立即进入全屏开跑，不再有中间的准备面板。
   * @returns {{presetKey:string, pad:(number|null), error:(string|undefined)}}
   */
  VTestFlow.prototype.readLauncherSettings = function () {
    var presetKey = this.presetKey;
    var checked = document.querySelector('input[name="flow-preset"]:checked');
    if (checked && PRESETS[checked.value]) presetKey = checked.value;
    this.presetKey = presetKey;

    var pad = null;
    var padEl = document.getElementById('flow-pad');
    if (padEl && String(padEl.value).trim() !== '') {
      var v = parseFloat(String(padEl.value).replace(/[^\d.]/g, ''));
      if (!isFinite(v) || v < 15 || v > 200) {
        return { presetKey: presetKey, pad: null,
                 error: '鼠标垫宽度请填 15~200 之间的数字（单位 cm），或留空跳过' };
      }
      pad = v;
    }
    return { presetKey: presetKey, pad: pad };
  };

  /**
   * 开始测试（页面上「开始测试」按钮直接调用）。
   * 立即进入全屏并锁定鼠标；全屏被浏览器拒绝时自动降级为窗口模式继续跑完。
   */
  VTestFlow.prototype.startFromLauncher = function () {
    if (this.isRunning()) return;

    var cfg = this.getConfig();
    if (!cfg || cfg.dpi === null || cfg.sens === null) {
      this.toast('请先在上方填写有效的 DPI 与游戏内灵敏度，再开始测试', 'warn');
      return;
    }
    var s = this.readLauncherSettings();
    if (s.error) { this.toast(s.error, 'warn'); return; }

    this.start(s.presetKey, s.pad, true);
  };

  /** 关闭面板并恢复现场 */
  VTestFlow.prototype.close = function () {
    this.range.abortDrill('flow-close');
    this._releaseInput();
    this._exitFullscreen();
    this.panel.hidden = true;
    this.countdownEl.hidden = true;
    this.strip.hidden = true;
    this.state = 'idle';
    this._fsExpected = false;
    this._syncBodyClass();
    this.onFinish();
    this.onClose();
    this._restoreLauncherFocus();
  };

  /**
   * 开始一轮测试。
   * @param {string} presetKey 'fast' | 'normal' | 'fine'
   * @param {number|null} padWidth 鼠标垫可用宽度（cm），可为 null
   * @param {boolean} useFullscreen 是否进入全屏
   * @param {number[]} [explicitCandidates] 显式指定候选档位（用于「精测一轮」）
   */
  VTestFlow.prototype.start = function (presetKey, padWidth, useFullscreen, explicitCandidates) {
    var cfg = this.getConfig();
    if (!cfg || cfg.dpi === null || cfg.sens === null) {
      this.toast('请先填写有效的 DPI 与游戏内灵敏度', 'warn');
      return;
    }

    var preset = PRESETS[presetKey] || PRESETS.normal;
    this.presetKey = preset.key;
    this.padWidth = padWidth;

    var candidates = explicitCandidates && explicitCandidates.length >= 2
      ? explicitCandidates.slice()
      : buildCandidates(cfg.sens, preset.candidates);

    // 鼠标垫约束：180° 转身所需距离必须小于垫子可用宽度，否则这一档物理上不可用
    var infeasible = [];
    if (padWidth && padWidth > 10) {
      var minSens = (180 * VCalc.CM_PER_INCH) / (cfg.dpi * padWidth * VCalc.VALORANT_YAW_PER_COUNT);
      var feasible = candidates.filter(function (s) { return s >= minSens - 1e-9; });
      infeasible = candidates.filter(function (s) { return s < minSens - 1e-9; });
      if (feasible.length >= 2) candidates = feasible;
      else infeasible = [];    // 可用档位不足，取消过滤（改在报告里给警告）
    }

    this.session = {
      dpi: cfg.dpi,
      baseSens: cfg.sens,
      preset: preset,
      padWidth: padWidth,
      infeasible: infeasible,
      candidates: shuffled(candidates),      // 乱序测试，抵消学习效应
      offsets: buildFlickOffsets(preset.flicks),
      rows: [],
      startedAt: Date.now(),
      refined: !!(explicitCandidates && explicitCandidates.length)
    };

    this._runSession(useFullscreen);
  };

  /* ========================== 主流程 ========================== */

  VTestFlow.prototype._runSession = function (useFullscreen) {
    var self = this;
    var s = this.session;

    this.state = 'running';
    this.interruptReason = null;
    this._lockExpected = false;
    this._fsExpected = false;
    this._syncBodyClass();
    this.panel.hidden = true;
    this.strip.hidden = false;

    var prep = Promise.resolve(false);
    if (useFullscreen) {
      prep = this._enterFullscreen().then(function (ok) {
        self._fsExpected = ok;
        return ok;
      });
    }

    // 立刻给出反馈：进入全屏 / 锁定鼠标可能需要 1 秒以上，
    // 这段时间如果读数条是空的，用户会以为按钮没生效。
    this._setStrip({
      stage: '准备中',
      sens: s.baseSens,
      progress: useFullscreen ? '正在进入全屏并锁定鼠标…' : '正在锁定鼠标…'
    });

    prep.then(function (fsOk) {
      return self._lockPointer().then(function (lockOk) {
        self._lockExpected = lockOk;
        if (!lockOk) {
          self.toast('未能锁定鼠标（浏览器限制）。可用「按住左键拖动」继续测试，但建议重新开始并允许锁定', 'warn');
        }
        void fsOk;
        return self._runAllBlocks();
      });
    }).then(function () {
      self._finishSession();
    }).catch(function (err) {
      self.toast('测试流程异常：' + (err && err.message ? err.message : err), 'warn');
      self._finishSession();
    });
  };

  /** 依次跑完「热身 + 所有候选档位」 */
  VTestFlow.prototype._runAllBlocks = function () {
    var self = this;
    var s = this.session;
    var preset = s.preset;

    // 1) 热身（数据丢弃）
    if (preset.warmup) {
      self._setStrip({ stage: '热身（不计入成绩）', sens: s.baseSens, progress: '' });
      var warm = self._runOneBlock(s.baseSens, preset.warmupFlicks, preset.trackMs * 0.5, true);
      return warm.then(function (ok) {
        if (!ok) return;                 // 被中断
        return self._loopCandidates(0);
      });
    }
    return self._loopCandidates(0);
  };

  /** 逐个候选档位执行（串行，避免互相干扰） */
  VTestFlow.prototype._loopCandidates = function (i) {
    var self = this;
    var s = this.session;
    var preset = s.preset;

    if (i >= s.candidates.length) return Promise.resolve();
    if (self.state !== 'running') return Promise.resolve();

    var sens = s.candidates[i];
    self._setStrip({
      stage: '第 ' + (i + 1) + '/' + s.candidates.length + ' 档',
      sens: sens,
      progress: ''
    });

    return self._runOneBlock(sens, preset.flicks, preset.trackMs, false).then(function (ok) {
      if (!ok) return;                   // 被中断 → 停下来交给暂停面板处理
      return self._loopCandidates(i + 1);
    });
  };

  /**
   * 跑一个完整档位：倒计时 → 甩枪 → 倒计时 → 跟枪。
   * @returns {Promise<boolean>} true=完成并计入成绩；false=被中断（数据作废）
   */
  VTestFlow.prototype._runOneBlock = function (sens, flickCount, trackMs, isWarmup) {
    var self = this;
    var s = this.session;

    // 把画布切到该档灵敏度（只影响画布，不改玩家输入框里的值）
    this.range.setConfig({ dpi: s.dpi, sens: sens });

    var offsets = s.offsets.slice(0, flickCount);

    // ---- 倒计时 1：准备甩枪 ----
    return self._countdown('甩枪定位 · ' + flickCount + ' 个目标', sens)
      .then(function () {
        if (self.state !== 'running') return null;
        return self.range.runFlickDrill({
          offsets: offsets,
          timeoutMs: s.preset.timeoutMs,
          gapMs: 300,
          prepMs: 500
        });
      })
      .then(function (flick) {
        if (!flick || flick.aborted) return false;
        self._setStrip({ stage: '跟枪', sens: sens, progress: '' });

        // ---- 倒计时 2：准备跟枪 ----
        return self._countdown('跟枪 · 目标会左右匀速横移，把准星压在靶上', sens)
          .then(function () {
            if (self.state !== 'running') return null;
            return self.range.runTrackDrill({
              durationMs: trackMs,
              amplitudeDeg: TRACK_AMPLITUDE,
              periodMs: TRACK_PERIOD_MS,
              prepMs: 500
            });
          })
          .then(function (track) {
            if (!track || track.aborted) return false;

            if (!isWarmup) {
              s.rows.push({
                sens: sens,
                dpi: s.dpi,
                edpi: VCalc.edpi(s.dpi, sens),
                cm360: VCalc.cmPer360(s.dpi, sens),
                flick: flick,
                track: track
              });
            }

            // 档位小结：立刻给用户一点反馈，避免「测了半天不知道好坏」
            if (!isWarmup) self._flashBlockResult(flick, track);
            return true;
          });
      });
  };

  /** 结束一轮：评分 → 出报告 */
  VTestFlow.prototype._finishSession = function () {
    if (this.state === 'report' || this.state === 'idle') return;

    this.range.abortDrill('session-end');
    this._releaseInput();               // 让光标回来，否则点不到报告按钮
    this.strip.hidden = true;
    this.countdownEl.hidden = true;

    if (this.state === 'paused') {
      this._renderPaused();
      this.panel.hidden = false;
      this._focusPanel();
      return;
    }

    this.state = 'report';
    this._syncBodyClass();
    scoreRows(this.session.rows);
    this._renderReport();
    this.panel.hidden = false;
    this._focusPanel();
    this.onFinish();
  };

  /** 中断当前档位（丢失锁定 / 退出全屏） */
  VTestFlow.prototype._interrupt = function (reason) {
    if (this.state !== 'running') return;
    this.interruptReason = reason;
    this.state = 'paused';
    this._lockExpected = false;
    this.range.abortDrill(reason);
    if (this.range.locked) this.range.unlock();
    this.strip.hidden = true;
    this.countdownEl.hidden = true;
    this._syncBodyClass();
    this._renderPaused();
    this.panel.hidden = false;
    this._focusPanel();
  };

  /* ========================== 倒计时 / 实时读数 ========================== */

  /**
   * 倒计时。既让玩家做好准备（测量有效性），也用来提示「接下来测什么」。
   * 只数 2 个数（约 1.2~1.5 秒）—— 早期版本数到 3 且每次都要黑屏，
   * 一轮下来要黑十几次，观感很差。
   * @param {string} label 提示文案
   * @param {number} sens 当前档位灵敏度
   */
  VTestFlow.prototype._countdown = function (label, sens) {
    var self = this;
    var total = this.session.preset.countdownMs;
    var step = total / 2;

    this.countdownEl.hidden = false;
    this.countdownEl.querySelector('[data-cd-label]').textContent = label;
    this.countdownEl.querySelector('[data-cd-sens]').textContent =
      '当前档位灵敏度 ' + fmtSens(sens) + ' · EDPI ' + fmt(VCalc.edpi(this.session.dpi, sens), 0);

    var seq = ['2', '1'];
    var chain = Promise.resolve();
    seq.forEach(function (n) {
      chain = chain.then(function () {
        // 被中断时立刻收起倒计时，不要继续数
        if (self.state !== 'running') {
          self.countdownEl.hidden = true;
          return;
        }
        self.countdownNum.textContent = n;
        self.countdownNum.classList.remove('is-pop');
        void self.countdownNum.offsetWidth;      // 触发重排以重放动画
        self.countdownNum.classList.add('is-pop');
        return wait(step);
      });
    });

    return chain.then(function () {
      if (self.state !== 'running') { self.countdownEl.hidden = true; return false; }
      self.countdownNum.textContent = '开始';
      self.countdownNum.classList.add('is-pop');
      return wait(Math.min(380, step));
    }).then(function () {
      self.countdownEl.hidden = true;
      return true;
    });
  };

  /** 更新底部实时读数条 */
  VTestFlow.prototype._setStrip = function (info) {
    var f = this.stripFields;
    if (f.stage) f.stage.textContent = info.stage || '--';
    if (f.sens) f.sens.textContent = info.sens ? fmtSens(info.sens) : '--';
    if (f.edpi) f.edpi.textContent = info.sens ? fmt(VCalc.edpi(this.session.dpi, info.sens), 0) : '--';
    if (f.progress) f.progress.textContent = info.progress || '';
  };

  /**
   * 每帧回调（由 main.js 在画布读数更新时调用）。只在流程进行中工作。
   * @param {Object} snapshot 画布快照（含 drill 字段）
   */
  VTestFlow.prototype.onFrame = function (snapshot) {
    if (this.state !== 'running') return;
    var d = snapshot && snapshot.drill;
    var f = this.stripFields;
    if (!d || !f) return;

    if (d.type === 'flick') {
      var shown = Math.max(1, d.index + 1);
      if (f.progress) {
        f.progress.textContent = '靶 ' + shown + '/' + d.total +
          ' · 命中 ' + d.hits +
          (d.lastMs ? ' · 最近 ' + fmt(d.lastMs, 0) + ' ms' : '');
      }
    } else if (d.type === 'track') {
      if (f.progress) {
        f.progress.textContent = '剩余 ' + fmt((d.remainsMs || 0) / 1000, 1) + ' s' +
          (d.onTargetPct === null ? '' : ' · 在靶 ' + fmt(d.onTargetPct, 0) + '%');
      }
    }
  };

  /** 每档结束后的即时反馈（角标式提示，不打断节奏） */
  VTestFlow.prototype._flashBlockResult = function (flick, track) {
    this.toast(
      '本档完成：甩枪命中 ' + flick.hits + '/' + flick.total +
      (flick.avgMs !== null ? '（平均 ' + fmt(flick.avgMs, 0) + ' ms）' : '') +
      ' · 跟枪在靶 ' + fmt(track.onTargetPct, 0) + '%',
      'ok'
    );
  };

  /* ========================== 全屏与鼠标锁定 ========================== */

  VTestFlow.prototype._isFullscreen = function () {
    return !!(document.fullscreenElement || document.webkitFullscreenElement ||
              document.msFullscreenElement);
  };

  /**
   * 全屏切换后必须做的事：
   *   1. 通知画布重算尺寸并**立刻补画一帧**（改画布尺寸会清空缓冲区，
   *      不补画就会留下一整块黑屏 —— 这就是"全屏后屏幕变暗"的主因）
   *   2. 全屏期间强制渲染，不依赖 IntersectionObserver 的回调时机
   * @param {boolean} on 是否处于全屏
   */
  VTestFlow.prototype._syncCanvasForFullscreen = function (on) {
    if (!this.range) return;
    this.range.forcedVisible = !!on;
    if (typeof this.range.refreshSize === 'function') this.range.refreshSize();
  };

  /** 请求全屏（失败不阻塞流程，只提示） */
  VTestFlow.prototype._enterFullscreen = function () {
    var el = this.wrap;
    var self = this;
    var fn = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
    if (!fn) return Promise.resolve(false);
    try {
      var p = fn.call(el);
      if (p && typeof p.then === 'function') {
        return p.then(function () {
          self._syncCanvasForFullscreen(true);
          return true;
        }).catch(function () { return false; });
      }
      var ok = this._isFullscreen();
      if (ok) this._syncCanvasForFullscreen(true);
      return Promise.resolve(ok);
    } catch (e) {
      return Promise.resolve(false);
    }
  };

  VTestFlow.prototype._exitFullscreen = function () {
    try {
      var fn = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
      if (fn && this._isFullscreen()) fn.call(document);
    } catch (e) { /* 忽略 */ }
    this._fsExpected = false;
    // 退出全屏后恢复原尺寸并补画一帧；同时解除强制渲染
    this._syncCanvasForFullscreen(false);
  };

  /** 请求指针锁定（原始鼠标输入；失败则退回拖拽模式继续测） */
  VTestFlow.prototype._lockPointer = function (attempt) {
    var self = this;
    var el = this.range.canvas;
    var tries = typeof attempt === 'number' ? attempt : 0;
    if (!el.requestPointerLock) return Promise.resolve(false);

    return new Promise(function (resolve) {
      var settled = false;
      function done(v) {
        if (settled) return;
        settled = true;
        resolve(v);
      }

      // 最多等 1.2 秒：成功则由 pointerlockchange 事件确认
      var timer = setTimeout(function () {
        var ok = document.pointerLockElement === el;
        if (!ok && tries < 1) {
          /* 失败重试一次：Chrome 在按下 Esc 解除锁定后有一段冷却（约 1 秒），
           * 「暂停后继续」这个场景几乎必然撞上，不重试就会掉进拖拽模式。 */
          clearTimeout(timer);
          clearInterval(check);
          setTimeout(function () {
            self._lockPointer(tries + 1).then(done);
          }, 700);
          return;
        }
        done(ok);
      }, 1200);

      var check = setInterval(function () {
        if (document.pointerLockElement === el) {
          clearInterval(check);
          clearTimeout(timer);
          done(true);
        }
      }, 100);

      try {
        var p = el.requestPointerLock({ unadjustedMovement: true });
        if (p && typeof p.then === 'function') {
          p.catch(function () {
            // 不支持 unadjustedMovement → 退回普通锁定
            try { el.requestPointerLock(); } catch (e) { /* 忽略 */ }
          });
        }
      } catch (e) {
        try { el.requestPointerLock(); } catch (e2) { /* 忽略 */ }
      }
    });
  };

  /* ========================== 面板渲染 ========================== */

  VTestFlow.prototype._syncBodyClass = function () {
    document.body.classList.toggle('flow-active', this.state !== 'idle');
    document.body.classList.toggle('flow-running', this.state === 'running');
  };

  /**
   * 说明：这里**没有**「准备面板」。
   * 测试强度与鼠标垫宽度都放在页面上的测试入口卡片里，
   * 点「开始测试」就直接进全屏开跑；面板只在两种情况下出现：
   *   · 中断（按 Esc / 退出全屏）→ 暂停面板
   *   · 跑完 → 结果报告面板
   */

  /** 暂停界面 */
  VTestFlow.prototype._renderPaused = function () {
    var s = this.session;
    var why;
    if (this.interruptReason === 'fullscreen-exit') {
      why = '检测到退出了全屏';
    } else if (this.interruptReason === 'locked-lost') {
      why = '检测到鼠标锁定被解除（按了 Esc？）';
    } else if (this.interruptReason === 'page-hidden') {
      why = '你切换到了别的标签页 / 最小化了窗口';
    } else {
      why = '测试被中断';
    }

    this.card.innerHTML =
      '<div class="flow-head">' +
        '<h3>测试已暂停</h3>' +
        '<p>' + why + '。当前档位的数据已作废，不会计入成绩 —— ' +
        '半途被打断的测量不可靠，宁可重测。</p>' +
      '</div>' +
      '<div class="flow-block flow-meta">' +
        '<span>已完成档位：<b>' + (s ? s.rows.length : 0) + '</b> / ' + (s ? s.candidates.length : 0) + '</span>' +
      '</div>' +
      '<div class="flow-actions">' +
        '<button type="button" class="btn btn-primary" data-flow="resume">重新全屏并继续</button>' +
        '<button type="button" class="btn btn-ghost" data-flow="abort">结束并查看已有结果</button>' +
      '</div>';
  };

  /** 报告界面 */
  VTestFlow.prototype._renderReport = function () {
    var s = this.session;
    var rows = s.rows.slice().sort(function (a, b) { return b.score - a.score; });

    if (rows.length === 0) {
      this.card.innerHTML =
        '<div class="flow-head"><h3>没有有效数据</h3>' +
        '<p>所有档位都被中断了，没有可用于评分的成绩。</p></div>' +
        '<div class="flow-actions"><button type="button" class="btn btn-primary" data-flow="close">关闭</button></div>';
      return;
    }

    var top = rows[0];
    var runnerUp = rows[1] || null;
    var spread = runnerUp ? top.score - runnerUp.score : 99;
    var lowest = rows[rows.length - 1];

    // —— 结论可信度：分差太小 / 命中样本太少时，如实说明「差异不显著」——
    var minHits = Math.max(2, Math.floor(top.flick.total * 0.4));
    var lowSample = top.flick.hits < minHits;
    var smallSpread = spread < SIGNIFICANT_SPREAD;
    var confident = !lowSample && !smallSpread;

    // 可信度偏低时，必须说清楚到底为什么低（两个原因要分开表述）
    var lowReasons = [];
    if (smallSpread) {
      lowReasons.push('第一名与第二名只差 ' + fmt(spread, 1) + ' 分（阈值 ' + SIGNIFICANT_SPREAD + ' 分）');
    }
    if (lowSample) {
      lowReasons.push('最佳档位只命中了 ' + top.flick.hits + '/' + top.flick.total +
                      ' 个甩枪靶（至少需要 ' + minHits + ' 个）');
    }

    // —— 推荐理由：找出该档位相对最弱的档位，优势最大的两项指标 ——
    // —— 推荐理由：找出该档位相对最弱的档位，优势最大的两项指标 ——
    var currentIsTop = Math.abs(top.sens - s.baseSens) / s.baseSens < 0.04;
    var strengths = [];
    METRIC_DEFS.forEach(function (def) {
      var k = def.key === 'flickSpeed' ? 'flickAvgMs' : def.key;
      var a = top.metrics[k];
      var b = lowest.metrics[k];
      var better = (def.key === 'flickSpeed') ? (b - a) : (a - b);
      if (better > 1e-6) strengths.push({ label: def.label, delta: better, key: def.key });
    });
    strengths.sort(function (x, y) { return y.delta - x.delta; });
    var strengthText = strengths.slice(0, 2).map(function (x) { return x.label; }).join('、');

    // —— 表格 ——
    var bodyHtml = rows.map(function (r) {
      var isTop = r === top;
      var isCurrent = Math.abs(r.sens - s.baseSens) / s.baseSens < 0.04;
      return '<tr class="' + (isTop ? 'is-reco' : '') + '">' +
        '<th scope="row">' + fmtSens(r.sens) +
          (isCurrent ? '<em class="flow-badge-cur">当前</em>' : '') + '</th>' +
        '<td class="mono">' + fmt(r.edpi, 0) + '</td>' +
        '<td class="mono">' + fmt(r.cm360, 1) + '</td>' +
        '<td class="mono">' + r.flick.hits + '/' + r.flick.total + '</td>' +
        '<td class="mono">' + (r.flick.avgMs === null ? '--' : fmt(r.flick.avgMs, 0) + ' ms') + '</td>' +
        '<td class="mono">' + (r.flick.pathRatio === null ? '--' : fmt(r.flick.pathRatio, 2) + '×') + '</td>' +
        '<td class="mono">' + fmt(r.track.onTargetPct, 0) + '%</td>' +
        '<td class="mono flow-score">' + fmt(r.score, 1) + '</td>' +
      '</tr>';
    }).join('');

    // —— 鼠标垫校验（推荐值是否真的能用）——
    var padNote = '';
    if (s.padWidth) {
      var turn180 = VCalc.cmForTurn(180, s.dpi, top.sens);
      var ratio = turn180 / s.padWidth;
      padNote = '<li>180° 转身需要 <b>' + fmt(turn180, 1) + ' cm</b>，' +
        '你的鼠标垫可用宽度 ' + s.padWidth + ' cm → 占 ' + fmt(ratio * 100, 0) + '%。' +
        (ratio > 0.6
          ? ' <span class="flow-warn">占比偏高，转身会比较吃紧，建议优先挑更小 cm/360（更高 eDPI）的档位。</span>'
          : ' 空间充足。') + '</li>';
      if (s.infeasible && s.infeasible.length) {
        padNote += '<li>已排除 ' + s.infeasible.length + ' 个物理上转不过身的档位（' +
          s.infeasible.map(fmtSens).join(' / ') + '）。</li>';
      }
    }

    // —— 结论 ——
    var verdict, verdictClass;
    if (!confident) {
      verdict = '各档位成绩差异在测量噪声范围内，<b>没有哪一档显著更好</b>。' +
        '建议保留你当前的灵敏度（' + fmtSens(s.baseSens) + '），或选择表格里最接近当前值的一档。';
      verdictClass = 'is-warn';
    } else if (currentIsTop) {
      verdict = '你<b>当前的灵敏度就是本次测试里表现最好的一档</b>，继续保持即可。' +
        '如果还想再挤一点性能，可以用「以推荐值为中心精测」在 ±10% 范围内细调。';
      verdictClass = 'is-ok';
    } else {
      verdict = '推荐把游戏内灵敏度改为 <b>' + fmtSens(top.sens) + '</b>（DPI 保持 ' + s.dpi + ' 不变）。' +
        '该档位在' + (strengthText || '综合表现') + '上表现最好，' +
        '比最差的一档（' + fmtSens(lowest.sens) + '，' + fmt(lowest.score, 1) + ' 分）高出 ' +
        fmt(top.score - lowest.score, 1) + ' 分。';
      verdictClass = 'is-ok';
    }

    this.card.innerHTML =
      '<div class="flow-head">' +
        '<h3>测试完成</h3>' +
        '<p>共完成 <b>' + rows.length + '</b> 个档位，每档 ' + s.preset.flicks +
        ' 个甩枪靶 + ' + fmt(s.preset.trackMs / 1000, 0) + ' 秒跟枪。' +
        '所有档位使用同一套挑战与同一段跟枪波形。</p>' +
      '</div>' +

      '<div class="flow-reco-box ' + verdictClass + '">' +
        '<div class="flow-reco-value">' +
          '<span class="flow-reco-label">推荐灵敏度</span>' +
          '<strong>' + fmtSens(top.sens) + '</strong>' +
          '<span class="flow-reco-sub">' + s.dpi + ' DPI × ' + fmtSens(top.sens) +
            ' = ' + fmt(top.edpi, 0) + ' eDPI · cm/360 ' + fmt(top.cm360, 1) + ' cm</span>' +
        '</div>' +
        '<p class="flow-verdict">' + verdict + '</p>' +
        '<p class="flow-confidence">结论可信度：<b>' +
          (confident ? '较高' : '偏低') + '</b>（' +
          (confident
            ? '第一名领先第二名 ' + fmt(spread, 1) + ' 分，超过噪声阈值 ' + SIGNIFICANT_SPREAD +
              ' 分；该档命中 ' + top.flick.hits + '/' + top.flick.total + ' 个甩枪靶'
            : lowReasons.join('；')) +
          '）。' +
          (confident ? '' : ' 想拿到更可靠的结论，可以改用「标准 / 精细」强度重测一轮。') +
        '</p>' +
      '</div>' +

      '<div class="flow-block">' +
        '<h4>各档位成绩</h4>' +
        '<div class="table-scroll"><table class="data-table flow-table">' +
          '<thead><tr>' +
            '<th scope="col">灵敏度</th><th scope="col">eDPI</th><th scope="col">cm/360</th>' +
            '<th scope="col">甩枪命中</th><th scope="col">平均耗时</th>' +
            '<th scope="col">路径</th><th scope="col">跟枪在靶</th><th scope="col">综合分</th>' +
          '</tr></thead>' +
          '<tbody>' + bodyHtml + '</tbody>' +
        '</table></div>' +
        '<p class="flow-note">路径 = 实际鼠标角路程 ÷ 理想路程。1.00× 表示一次到位，' +
        '数值越大说明「冲过头再拉回来」的次数越多（过冲是灵敏度过高的典型表现）。' +
        '综合分只在本次测试的各档之间可比，没有绝对意义。</p>' +
        '<p class="flow-note">关于指标之间的取舍：<b>更低的灵敏度天然会让路径更平顺</b>' +
        '（每一 count 转过的角度更小，更容易停住），而<b>更高的灵敏度更容易拿到更快的甩枪时间</b>。' +
        '四项指标正是在这个取舍上求平衡 —— 所以推荐值往往落在你当前设置的附近，' +
        '而不是一味偏低或偏高。</p>' +
      '</div>' +

      '<div class="flow-block">' +
        '<h4>怎么用这个结果</h4>' +
        '<ul class="flow-list">' +
          '<li>把游戏内灵敏度改成 <b>' + fmtSens(top.sens) + '</b>，DPI 不用动。</li>' +
          padNote +
          '<li>至少实战 3 小时（或 2~3 天）再用它做判断 —— 在那之前你感受到的只是「陌生感」。</li>' +
          '<li>想再细一点，点下面的「以推荐值为中心精测」，会在 ±10% 范围内跑 3 个档位。</li>' +
          '<li>如果推荐值与当前值差异很小，说明你已经调得差不多了，不必改。</li>' +
        '</ul>' +
      '</div>' +

      '<div class="flow-actions">' +
        '<button type="button" class="btn btn-primary" data-flow="apply">' +
          '应用推荐灵敏度 ' + fmtSens(top.sens) + '</button>' +
        '<button type="button" class="btn" data-flow="refine">以推荐值为中心精测</button>' +
        '<button type="button" class="btn" data-flow="restart">重新完整测试</button>' +
        '<button type="button" class="btn" data-flow="copy">复制结果</button>' +
        '<button type="button" class="btn btn-ghost" data-flow="close">关闭</button>' +
      '</div>' +

      '<p class="flow-tip">测试数据只存在于当前页面，刷新即消失；不会上传，也没有任何统计埋点。' +
      ' 按 <kbd>Esc</kbd> 可退出全屏。</p>';
  };

  /* ========================== 按钮分发 ========================== */

  VTestFlow.prototype._handleAction = function (action, node) {
    var cfg = this.getConfig();

    if (action === 'close') { this.close(); return; }

    if (action === 'resume') {
      var self = this;
      this.state = 'running';
      this._syncBodyClass();
      this.panel.hidden = true;
      this.strip.hidden = false;
      // 只有「全屏」一种模式：恢复时重新进入全屏并锁定鼠标
      this._enterFullscreen().then(function (ok) {
        self._fsExpected = !!ok;
        return self._lockPointer();
      }).then(function (lockOk) {
        self._lockExpected = !!lockOk;
        // 重新跑「当前未完成的档位」：已完成的档位结果保留
        return self._loopCandidates(self.session.rows.length);
      }).then(function () {
        self._finishSession();
      }).catch(function () {
        self._finishSession();
      });
      return;
    }

    if (action === 'abort') {
      this.state = 'report';
      this._syncBodyClass();
      scoreRows(this.session.rows);
      this._renderReport();
      this.panel.hidden = false;
      this._focusPanel();
      this.onFinish();
      return;
    }

    if (action === 'apply') {
      var top = this.session.rows.slice().sort(function (a, b) { return b.score - a.score; })[0];
      if (!top) return;
      this.applySens(top.sens);
      this.toast('已应用推荐灵敏度：' + cfg.dpi + ' DPI × ' + fmtSens(top.sens) +
                 '（' + fmt(top.edpi, 0) + ' eDPI）', 'ok');
      return;
    }

    if (action === 'refine') {
      var best = this.session.rows.slice().sort(function (a, b) { return b.score - a.score; })[0];
      if (!best) return;
      var c = [
        round3(clamp(best.sens * 0.9, VCalc.SENS_MIN, VCalc.SENS_MAX)),
        round3(clamp(best.sens, VCalc.SENS_MIN, VCalc.SENS_MAX)),
        round3(clamp(best.sens * 1.1, VCalc.SENS_MIN, VCalc.SENS_MAX))
      ];
      // 去重后至少要有 2 档才有比较意义
      var uniq = c.filter(function (v, i) { return c.indexOf(v) === i; });
      if (uniq.length < 2) { this.toast('当前灵敏度已到边界，无法继续收敛', 'warn'); return; }
      this.toast('开始精测：' + uniq.map(fmtSens).join(' / '), 'ok');
      this.start(this.presetKey, this.padWidth, this._isFullscreen(), uniq);
      return;
    }

    if (action === 'copy') {
      var self2 = this;
      var txt = this._buildReportText();
      copyText(txt, function (ok) {
        self2.toast(ok ? '测试结果已复制到剪贴板' : '浏览器不允许自动复制，请手动选择文本复制',
                    ok ? 'ok' : 'warn');
      });
      return;
    }

    if (action === 'restart') {
      // 用同一套设置立刻重跑（此时在全屏里，不回到页面，保持手感连贯）
      this.start(this.presetKey, this.padWidth, true);
      return;
    }
  };

  /* ========================== 其它 ========================== */

  /**
   * 生成纯文本版结果，供「复制结果」使用（方便贴到群里/笔记里对比）。
   * @returns {string}
   */
  VTestFlow.prototype._buildReportText = function () {
    var s = this.session;
    if (!s || !s.rows.length) return '（没有可复制的测试结果）';

    var rows = s.rows.slice().sort(function (a, b) { return b.score - a.score; });
    var top = rows[0];
    var lines = [];

    lines.push('无畏契约灵敏度测试结果');
    lines.push('鼠标 DPI：' + s.dpi);
    lines.push('推荐灵敏度：' + fmtSens(top.sens) +
               '（' + fmt(top.edpi, 0) + ' eDPI · cm/360 ' + fmt(top.cm360, 1) + ' cm）');
    if (s.padWidth) {
      lines.push('180° 转身需要：' + fmt(VCalc.cmForTurn(180, s.dpi, top.sens), 1) +
                 ' cm（鼠标垫可用宽度 ' + s.padWidth + ' cm）');
    }
    lines.push('测试强度：' + s.preset.candidates + ' 档 × (' + s.preset.flicks +
               ' 个甩枪靶 + ' + fmt(s.preset.trackMs / 1000, 0) + ' 秒跟枪)');
    lines.push('');
    lines.push('各档位成绩（灵敏度 / eDPI / cm360 / 甩枪命中 / 平均耗时 / 路径 / 跟枪在靶 / 综合分）');
    rows.forEach(function (r, i) {
      lines.push('  ' + (i === 0 ? '★' : ' ') + ' ' + fmtSens(r.sens) +
                 ' / ' + fmt(r.edpi, 0) +
                 ' / ' + fmt(r.cm360, 1) +
                 ' / ' + r.flick.hits + '-' + (r.flick.total - r.flick.hits) +
                 ' / ' + (r.flick.avgMs === null ? '--' : fmt(r.flick.avgMs, 0) + 'ms') +
                 ' / ' + (r.flick.pathRatio === null ? '--' : fmt(r.flick.pathRatio, 2) + 'x') +
                 ' / ' + fmt(r.track.onTargetPct, 0) + '%' +
                 ' / ' + fmt(r.score, 1));
    });
    lines.push('');
    lines.push('（由「无畏契约灵敏度测试工具」生成：同题同卷、乱序测试、热身数据丢弃）');
    return lines.join('\n');
  };

  /**
   * 面板显示后把焦点移进去。
   * 全屏 + 鼠标锁定之后焦点还在画布上，键盘用户 Tab 不到面板里的按钮，
   * 因此每次显示暂停/结果面板都主动聚焦主按钮；关闭时再还回入口按钮。
   */
  VTestFlow.prototype._focusPanel = function () {
    var btn = this.card.querySelector('.btn-primary') || this.card.querySelector('button');
    if (btn && typeof btn.focus === 'function') {
      try { btn.focus({ preventScroll: true }); } catch (e) { btn.focus(); }
    }
  };

  /** 关闭面板后把焦点还给页面上的「开始测试」按钮 */
  VTestFlow.prototype._restoreLauncherFocus = function () {
    var b = document.getElementById('btn-flow');
    if (b && typeof b.focus === 'function') {
      try { b.focus({ preventScroll: true }); } catch (e) { b.focus(); }
    }
  };

  VTestFlow.prototype.destroy = function () {
    document.removeEventListener('fullscreenchange', this._onFsChange);
    document.removeEventListener('webkitfullscreenchange', this._onFsChange);
    if (this._onVisibility) document.removeEventListener('visibilitychange', this._onVisibility);
  };

  /* 静态导出，便于测试与外部复用 */
  VTestFlow.PRESETS = PRESETS;
  VTestFlow.buildCandidates = buildCandidates;
  VTestFlow.buildFlickOffsets = buildFlickOffsets;
  VTestFlow.scoreRows = scoreRows;
  VTestFlow.METRIC_DEFS = METRIC_DEFS;
  VTestFlow.SIGNIFICANT_SPREAD = SIGNIFICANT_SPREAD;

  return VTestFlow;
})();

/* Node.js 环境（单元测试用；依赖 VCalc） */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = VTestFlow;
}
