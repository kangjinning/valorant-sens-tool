/* =============================================================================
 * canvas.js — 灵敏度测试画布模块
 * -----------------------------------------------------------------------------
 * 设计要点（与需求「鼠标移动采样尽量贴近桌面鼠标原始输入，不要过度平滑失真」对应）：
 *
 *  1. 采样：优先使用 Pointer Lock（指针锁定）+ `unadjustedMovement: true`，
 *     由浏览器直接给出鼠标硬件的原始位移（movementX/movementY），
 *     绕过系统「提高指针精确度」加速曲线。这与游戏引擎读取鼠标的方式最接近。
 *  2. 不做任何平滑、插值、阻尼、加速度：每次 mousemove 事件把原始位移
 *     立即累加到状态里（角度直接按公式算），渲染只在 requestAnimationFrame 里
 *     按最新状态绘制。中间不存在橡皮筋或缓动，因此不存在失真。
 *  3. 无法锁定时降级为「按住左键拖拽」（用 movementX 或坐标差兜底），
 *     拖拽模式受窗口边界限制（拖到边缘就转不动），因此只是备用方案。
 *  4. 角度换算严格使用无畏契约公式：Δ角度 = Δcounts × 0.07 × 游戏内灵敏度。
 *     位移距离换算：cm = |Δcounts| ÷ DPI × 2.54。
 *
 *  场景渲染为程序化绘制（无任何图片资源）：地面网格 + 距离环 + 靶场后墙 +
 *  12 个靶位 + 罗盘 + 准星。视角只做水平旋转（yaw），并允许 ±22° 俯仰（pitch），
 *  定位测试模式下俯仰锁定为 0，保证测的是纯横向转向能力。
 *
 *  API：
 *    var test = new VRangeTest(canvasEl, { onUpdate, onEvent });
 *    test.setConfig({ dpi, sens })   设置参数（null 表示无效）
 *    test.setMode('free'|'spin'|'target')
 *    test.toggleLock() / lock() / unlock()
 *    test.resetView()                重置视角与计数
 *    test.getSnapshot()              读取当前所有读数
 *    test.destroy()
 * ============================================================================= */

/* eslint-disable no-var */
var VRangeTest = (function () {
  'use strict';

  /* ------------------------------ 场景常量 ------------------------------ */
  var FOV_DEG = 103;          // 无畏契约默认水平 FOV（16:9 下的官方值）
  var CAM_HEIGHT = 1.6;       // 视点（眼睛）高度，单位：米
  var WALL_RADIUS = 16;       // 后墙所在圆柱半径，单位：米
  var WALL_HEIGHT = 7;        // 后墙高度（米）：抬高到 7m，抬头看高处靶位时不会「露出墙外」
  var TARGET_RADIUS_M = 0.65; // 靶面半径（米）：略大于真人身宽，让命中主要反映"转向是否到位"，
                              // 而不是考验亚像素级精度（0.65m @ 14m ≈ 角半径 2.66°，屏幕半径约 22px）
  var TARGET_DIST = 14;       // 靶位距离，单位：米（后墙在 16m，留 2m 余量避免穿模）
  /**
   * 俯仰角范围。放宽到 ±85° 意味着画布支持真正的「上下左右」自由观察：
   * 抬头能看到后墙顶部与天空，低头能看到脚下的地面网格。
   * （真实 FPS 也是这样：水平可转无限圈，垂直被限制在 ±89° 附近以防万向节翻转。）
   */
  var MAX_PITCH = 85;
  /** 近裁剪面（米）：z 小于它的点在相机后方或贴脸，直接判定为不可见 */
  var NEAR = 0.25;
  var CULL_DEG = 92;          // 方位差超过该角度不再参与绘制
  var HIT_FACTOR = 0.9;       // 命中判定系数（靶面角半径的 90%）
  var COMPASS_SPAN = 240;     // 顶部罗盘显示的方位跨度（度）
  var UPDATE_HZ = 12;         // 读数回调频率（Hz），避免高频操作 DOM
  /**
   * 画布缓冲区的像素上限（约 420 万）。
   * 全屏时若按 devicePixelRatio=2 建缓冲区，2K 屏就是 900 万像素以上，
   * 场景每帧上百条路径会让帧率明显下降。用像素预算反推一个合适的 DPR，
   * 保证全屏下依然跟手。
   */
  var MAX_BUFFER_PIXELS = 4200000;
  var RAD = Math.PI / 180;
  var DEG = 180 / Math.PI;

  /**
   * 靶面的角半径（度）：半径 0.5 m 的靶在 14 m 处张开的角度 ≈ 2.05°。
   * 命中判定用「视线的方向」与「靶心的方向」之间的夹角来衡量，
   * 因此判定与屏幕分辨率、窗口大小、是否全屏、俯仰角都无关 ——
   * 测试流程依赖这一点，保证同一个挑战在不同灵敏度下难度一致。
   */
  var TARGET_ANGULAR_RADIUS_DEG = Math.atan(TARGET_RADIUS_M / TARGET_DIST) * DEG;
  var HIT_ANGLE_DEG = TARGET_ANGULAR_RADIUS_DEG * HIT_FACTOR;   // ≈ 1.84°

  /* ------------------------------ 小工具 ------------------------------ */
  function clamp(v, min, max) { return v < min ? min : (v > max ? max : v); }

  /** 把角度差规范化到 (-180, 180]，用于计算两个方位之间的最短夹角 */
  function angleDelta(target, current) {
    var d = (target - current) % 360;
    if (d > 180) d -= 360;
    if (d <= -180) d += 360;
    return d;
  }

  /** 把角度规范化到 [0, 360) */
  function normalize360(deg) {
    var d = deg % 360;
    if (d < 0) d += 360;
    return d;
  }

  /** 每个模式对应的中文名（供 HUD 使用） */
  var MODE_LABEL = {
    free: '自由转向',
    spin: '360° 校准',
    target: '定位测试',
    flick: '甩枪定位测试',
    track: '跟枪测试'
  };

  /* ============================ 构造函数 ============================ */
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{onUpdate?:Function, onEvent?:Function}} [opts]
   */
  function VRangeTest(canvas, opts) {
    if (!canvas || !canvas.getContext) {
      throw new Error('VRangeTest: 需要一个 canvas 元素');
    }
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts || {};
    this.onUpdate = typeof this.opts.onUpdate === 'function' ? this.opts.onUpdate : function () {};
    this.onEvent = typeof this.opts.onEvent === 'function' ? this.opts.onEvent : function () {};

    /* ---- 参数（由 setConfig 注入；null 表示无效，此时不响应鼠标） ---- */
    this.dpi = null;
    this.sens = null;

    /* ---- 视角状态 ---- */
    this.yaw = 0;        // 累计水平旋转角度（度，未规范化，可为负）
    this.pitch = 0;      // 俯仰角度（度，向上为正）

    /* ---- 鼠标采样累加器 ---- */
    this.totalCountsX = 0;  // 累计横向移动的 |counts| 之和（物理移动总量）
    this.totalCountsY = 0;  // 累计纵向移动的 |counts| 之和
    this.eventCount = 0;    // 采样到的 mousemove 事件数（用于判断采样是否正常）

    /* ---- 360° 校准状态 ---- */
    this.spinActive = false;   // 是否已开始校准
    this.spinCounts = 0;       // 本次校准的净水平 counts（正负表示方向，回拉会减少进度）
    this.spinStartTime = 0;
    this.spinDone = false;
    this.spinResult = null;    // { cm360, elapsedMs, theoreticalCm, deviationPct }

    /* ---- 定位测试状态 ---- */
    this.targetAz = 0;         // 当前靶位方位角
    this.targetSpawnTime = 0;
    this.hits = 0;
    this.misses = 0;
    this.totalHitMs = 0;
    this.bestHitMs = null;
    this.lastHitMs = null;
    this.hitFlashTime = 0;     // 命中/脱靶闪烁时间戳（仅用于画面反馈）
    this.hitFlashOk = false;

    /* ---- 交互状态 ---- */
    this.mode = 'free';
    this.dragging = false;
    this.locked = false;
    this.visible = true;
    /** 由外部（全屏时）强制置为 true，确保一定参与渲染 */
    this.forcedVisible = false;
    this.lastClient = null;

    /* ---- 灵敏度测试流程（drill）状态 ----
     * drill 为 null 表示当前没有流程在跑；由 runFlickDrill / runTrackDrill 建立。
     * 与上面的「手动模式」互斥：drill 激活时 try 会接管渲染与射击判定。 */
    this.drill = null;
    this.lastFlickResult = null;
    this.lastTrackResult = null;
    /** 命中波纹：{az, el, t, ok}，命中后短暂播放 */
    this._hitBurst = null;

    /* ---- 渲染尺寸（CSS 像素） ---- */
    this.w = canvas.width;
    this.h = canvas.height;
    this.cx = this.w / 2;
    this.cy = this.h / 2;
    this.focal = (this.w / 2) / Math.tan((FOV_DEG / 2) * RAD);
    this.dpr = 1;

    this._lastUpdate = 0;
    this._rafId = 0;
    this._destroyed = false;
    this._vignette = null;    // 暗角渐变缓存（按画布尺寸生成一次）

    this._bindEvents();
    this._setupHiDPI();
    this._loop = this._loop.bind(this);
    this._rafId = window.requestAnimationFrame(this._loop);
  }

  /* ============================ 事件绑定 ============================ */
  VRangeTest.prototype._bindEvents = function () {
    var self = this;

    /* ---- 鼠标移动：核心采样入口 ---- */
    this._onMouseMove = function (e) {
      // 只有锁定或按住拖拽时才响应，避免页面滚动时误触发
      if (!self.locked && !self.dragging) {
        self.lastClient = { x: e.clientX, y: e.clientY };
        return;
      }

      var mx = 0, my = 0;

      if (typeof e.movementX === 'number' && typeof e.movementY === 'number') {
        mx = e.movementX;
        my = e.movementY;
      }

      // 兜底：少数环境下 movementX 恒为 0，则用两次事件的坐标差代替
      if (mx === 0 && my === 0 && self.lastClient) {
        mx = e.clientX - self.lastClient.x;
        my = e.clientY - self.lastClient.y;
      }
      self.lastClient = { x: e.clientX, y: e.clientY };

      self._applyMouseDelta(mx, my);
    };

    /* ---- 拖拽模式（未锁定时的备用方案） ---- */
    this._onMouseDown = function (e) {
      if (e.button !== 0) return;

      // 需要射击的场合（手动定位测试 / 流程甩枪测试）：锁定时用 mousedown 触发
      if (self.locked && (self.drill || self.mode === 'target')) {
        self.shoot();
        return;
      }
      if (self.locked) return;

      self.dragging = true;
      self.lastClient = { x: e.clientX, y: e.clientY };
      self.canvas.classList.add('is-dragging');
      if (e.preventDefault) e.preventDefault();
    };

    this._onMouseUp = function () {
      if (!self.dragging) return;
      self.dragging = false;
      self.canvas.classList.remove('is-dragging');
    };

    this._onClick = function () {
      // 未锁定时用 click 判定射击（拖拽模式下 mouseup 之后触发）
      if (!self.locked && (self.drill || self.mode === 'target')) {
        self.shoot();
      }
    };

    this._onContextMenu = function (e) {
      if (self.dragging) e.preventDefault();   // 拖拽中屏蔽右键菜单
    };

    /* ---- Pointer Lock 状态变化 ---- */
    this._onPointerLockChange = function () {
      var locked = (document.pointerLockElement === self.canvas) ||
                   (document.mozPointerLockElement === self.canvas);
      if (locked === self.locked) return;
      self.locked = locked;
      self.dragging = false;
      self.canvas.classList.toggle('is-locked', locked);
      self.canvas.classList.remove('is-dragging');
      self.lastClient = null;
      self.onEvent('lockchange', { locked: locked });
    };

    this._onPointerLockError = function () {
      // 浏览器拒绝锁定（例如刚按过 Esc、或 iframe 权限限制）→ 提示改用拖拽
      self.locked = false;
      self.canvas.classList.remove('is-locked');
      self.onEvent('lockerror', {});
    };

    /* ---- 触屏拖动（平板应急，手机端页面会提示用电脑） ---- */
    this._onTouchStart = function (e) {
      if (e.touches.length !== 1) return;
      self.dragging = true;
      self.lastClient = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      if (self.mode === 'target') self.shoot();
    };
    this._onTouchMove = function (e) {
      if (!self.dragging || e.touches.length !== 1) return;
      var t = e.touches[0];
      var mx = t.clientX - self.lastClient.x;
      var my = t.clientY - self.lastClient.y;
      self.lastClient = { x: t.clientX, y: t.clientY };
      // 触屏没有 counts 概念，按 1 像素 = 1 count 近似，仅用于体验画面旋转
      self._applyMouseDelta(mx, my);
      if (e.preventDefault) e.preventDefault();
    };
    this._onTouchEnd = function () { self.dragging = false; };

    /* ---- 窗口失焦时停止拖拽，避免状态卡住 ---- */
    this._onBlur = function () { self.dragging = false; self.canvas.classList.remove('is-dragging'); };

    var c = this.canvas;
    c.addEventListener('mousemove', this._onMouseMove);
    c.addEventListener('mousedown', this._onMouseDown);
    c.addEventListener('click', this._onClick);
    c.addEventListener('contextmenu', this._onContextMenu);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('blur', this._onBlur);
    document.addEventListener('pointerlockchange', this._onPointerLockChange);
    document.addEventListener('pointerlockerror', this._onPointerLockError);
    c.addEventListener('touchstart', this._onTouchStart, { passive: true });
    c.addEventListener('touchmove', this._onTouchMove, { passive: false });
    c.addEventListener('touchend', this._onTouchEnd);

    /* ---- 尺寸自适应 ---- */
    var self2 = this;
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(function () { self2._setupHiDPI(); });
      this._ro.observe(this.canvas);
    } else {
      this._onResize = function () { self2._setupHiDPI(); };
      window.addEventListener('resize', this._onResize);
    }

    /* ---- 不可见时暂停渲染，省电 ---- */
    if (typeof IntersectionObserver !== 'undefined') {
      this._io = new IntersectionObserver(function (entries) {
        self2.visible = entries[0].isIntersecting;
      }, { threshold: 0 });
      this._io.observe(this.canvas);
    }
  };

  /* ============================ 画布尺寸/DPI ============================ */
  VRangeTest.prototype._setupHiDPI = function () {
    var rect = this.canvas.getBoundingClientRect();
    var cssW = Math.max(320, Math.round(rect.width || 1200));
    // 高度取 CSS 实际布局高度：普通模式下由 aspect-ratio 决定，
    // 全屏模式下由 .canvas-wrap:fullscreen 撑满整屏 —— 两种情况都能自适应。
    var cssH = Math.round(rect.height || 0);
    if (!cssH || cssH < 120) cssH = Math.round(cssW * 620 / 1200);   // 兜底：与默认比例一致

    /* DPR 与「像素预算」：
     * 全屏（尤其 2K/4K + HiDPI）时，画布缓冲区可能有 800 万像素以上，
     * 而本场景每帧要画上百条路径 —— 缓冲区一大就会明显掉帧（画面发涩、拖影）。
     * 这里给缓冲区设一个像素上限，超出时自动降低 DPR（最低降到 1，
     * 再低会糊），用极小的清晰度代价换回流畅度。 */
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var budget = Math.sqrt(MAX_BUFFER_PIXELS / Math.max(1, cssW * cssH));
    if (dpr > budget) dpr = Math.max(1, budget);

    this.dpr = dpr;
    this.w = cssW;
    this.h = cssH;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   // 之后所有绘制都用 CSS 像素坐标

    this.cx = cssW / 2;
    this.cy = cssH / 2;
    // 焦距：把水平 FOV 映射到画布宽度上（垂直 FOV 由宽高比自然决定）
    this.focal = (cssW / 2) / Math.tan((FOV_DEG / 2) * RAD);

    // 尺寸相关的缓存全部失效（暗角渐变按画布尺寸生成）
    this._vignette = null;

    /* 关键：改画布尺寸会清空缓冲区。
     * 如果这一帧不重画，用户看到的就是一整块黑屏（"全屏后屏幕变暗"的元凶之一）。
     * 因此尺寸变化后立刻补画一帧，不等下一次 rAF。 */
    this._render(this._now());
  };

  /**
   * 强制重新计算画布尺寸并立即重绘。
   * 进入/退出全屏后调用 —— 全屏切换时布局与 DPR 都会变，
   * 靠 ResizeObserver 有时会晚一两帧，期间就是黑屏。
   */
  VRangeTest.prototype.refreshSize = function () {
    this._setupHiDPI();
    return this;
  };

  /* ============================ 参数设置 ============================ */
  /**
   * 设置 DPI 与灵敏度。传入非正数或 null 表示参数无效，此时画布会暂停响应鼠标。
   * @param {{dpi:(number|null), sens:(number|null)}} cfg
   */
  VRangeTest.prototype.setConfig = function (cfg) {
    var dpiOk = cfg && typeof cfg.dpi === 'number' && isFinite(cfg.dpi) && cfg.dpi > 0;
    var sensOk = cfg && typeof cfg.sens === 'number' && isFinite(cfg.sens) && cfg.sens > 0;

    this.dpi = dpiOk ? cfg.dpi : null;
    this.sens = sensOk ? cfg.sens : null;

    var ready = this.isReady();
    if (!ready) {
      // 参数失效时结束进行中的校准/测试，避免出现无意义的数据
      this.spinActive = false;
    }
    return ready;
  };

  /** 参数是否有效（有效的 DPI 与灵敏度都已设置） */
  VRangeTest.prototype.isReady = function () {
    return this.dpi !== null && this.sens !== null;
  };

  /* ============================ 鼠标位移 → 状态 ============================ */
  /**
   * 应用一次鼠标位移（counts）。这是全部「物理量 → 游戏角度」的换算入口，
   * 严格按照无畏契约公式执行，不做任何额外处理。
   * @param {number} mx 水平 counts（右为正）
   * @param {number} my 垂直 counts（下为正）
   */
  VRangeTest.prototype._applyMouseDelta = function (mx, my) {
    if (!this.isReady()) return;

    // 每 count 旋转角度 = 0.07 × 灵敏度（度）
    var degPerCount = VCalc.degPerCount(this.sens);

    /** 1) 水平转向：鼠标右移 → 视角右转（yaw 增加） */
    this.yaw += mx * degPerCount;

    /** 2) 累计物理位移（用于「累计横向移动」读数，取绝对值求和 = 实际走的总路程） */
    this.totalCountsX += Math.abs(mx);
    this.totalCountsY += Math.abs(my);
    this.eventCount++;

    /** 3) 垂直俯仰：鼠标下移 → 视角向下（pitch 减小）。
     *     所有模式都允许上下观察（画布支持完整的上下左右测试），只做 ±85° 夹紧，
     *     避免越过天顶导致画面翻转。 */
    this.pitch = clamp(this.pitch - my * degPerCount, -MAX_PITCH, MAX_PITCH);

    /** 4) 360° 校准：累计净 counts（正负相抵，往回转会扣进度） */
    if (this.mode === 'spin' && this.spinActive && !this.spinDone) {
      this.spinCounts += mx;
      var progress = Math.abs(this.spinCounts) * degPerCount;
      if (progress >= 360) {
        this._completeSpin();
      }
    }

    /** 5) 测试流程：记录「甩枪路径」与「过冲次数」。
     *    路径长度是二维的角路程（水平 + 垂直的欧氏合成），单位是度，
     *    因此与分辨率、窗口大小、俯仰角都无关。 */
    var d = this.drill;
    if (d && d.type === 'flick' && d.phase === 'live') {
      var stepDeg = Math.sqrt(mx * mx + my * my) * degPerCount;
      d.pathDeg += stepDeg;
      d.totalPathDeg += stepDeg;

      // 过冲判定：先进入过命中圈、随后又离开 → 记一次「过冲/回拉」
      var offAngle = this._angularDistance(d.targetAz, d.targetEl || 0);
      if (offAngle <= d.hitAngleDeg) {
        if (!d.insideCircle) {
          d.insideCircle = true;
          if (d.firstInsideTime === null) d.firstInsideTime = this._now();
        }
      } else if (d.insideCircle) {
        d.insideCircle = false;
        d.overshoots++;      // 冲过头又拉回来
      }
    } else if (d && d.type === 'track') {
      d.mousePathDeg += Math.sqrt(mx * mx + my * my) * degPerCount;
    }
  };

  /** 统一的「当前时刻」取值（performance.now 与 rAF 时间戳同源） */
  VRangeTest.prototype._now = function () {
    return (window.performance && window.performance.now) ? window.performance.now() : Date.now();
  };

  /* ============================ 模式切换 ============================ */
  /**
   * 切换手动模式。若测试流程正在运行，会先安全中止它（避免状态互相污染）。
   * @param {'free'|'spin'|'target'} mode
   */
  VRangeTest.prototype.setMode = function (mode) {
    if (mode !== 'free' && mode !== 'spin' && mode !== 'target') return this;   // 未知/流程模式：忽略
    if (this.drill) this.abortDrill('mode-change');
    if (mode === this.mode) {
      // 重复点击同一个模式按钮 = 重置该模式
    }
    this.mode = mode;

    // 进入定位测试：重置统计并生成第一个靶
    if (mode === 'target') {
      this._resetTargetStats();
      this.pitch = 0;              // 锁定俯仰，保证是纯横向定位测试
      this._spawnTarget();
    }
    // 进入 360° 校准：等待用户点击/开始
    if (mode === 'spin') {
      this.spinActive = false;
      this.spinDone = false;
      this.spinCounts = 0;
      this.spinResult = null;
    }
    return this;
  };

  VRangeTest.prototype.getModeLabel = function () {
    return MODE_LABEL[this.mode] || this.mode;
  };

  /* ============================ 360° 校准 ============================ */
  /** 开始一次 360° 校准（清空进度并开始计时） */
  VRangeTest.prototype.startSpin = function () {
    if (!this.isReady()) {
      this.onEvent('needconfig', {});
      return false;
    }
    this.spinActive = true;
    this.spinDone = false;
    this.spinCounts = 0;
    this.spinResult = null;
    this.spinStartTime = (window.performance && performance.now) ? performance.now() : Date.now();
    return true;
  };

  /** 完成一次校准：记录实测厘米数与耗时 */
  VRangeTest.prototype._completeSpin = function () {
    var degrees = Math.abs(this.spinCounts) * VCalc.degPerCount(this.sens);
    var cm = VCalc.cmFromCounts(Math.abs(this.spinCounts), this.dpi);   // 实际走过的厘米数
    var theoretical = VCalc.cmPer360(this.dpi, this.sens);
    var now = (window.performance && performance.now) ? performance.now() : Date.now();
    var elapsed = now - this.spinStartTime;

    this.spinDone = true;
    this.spinActive = false;
    this.spinResult = {
      degrees: degrees,
      cm360: cm,
      elapsedMs: elapsed,
      theoreticalCm: theoretical,
      // 实测与理论值的偏差（%）——两者必然接近，用于确认参数填写是否正确
      deviationPct: theoretical > 0 ? ((cm - theoretical) / theoretical) * 100 : 0
    };
    this.onEvent('spincomplete', this.spinResult);
  };

  /** 取消/重置 360° 校准进度 */
  VRangeTest.prototype.resetSpin = function () {
    this.spinActive = false;
    this.spinDone = false;
    this.spinCounts = 0;
    this.spinResult = null;
  };

  /* ============================ 定位测试 ============================ */
  VRangeTest.prototype._resetTargetStats = function () {
    this.hits = 0;
    this.misses = 0;
    this.totalHitMs = 0;
    this.bestHitMs = null;
    this.lastHitMs = null;
    this.hitFlashTime = 0;
  };

  /**
   * 在距离当前视角至少 55° 的位置生成新靶（手动「定位测试」用）
   * @deprecated 被 _spawnTargetInView 取代，仅保留以防外部调用
   */
  VRangeTest.prototype._spawnTarget = function () {
    this._spawnTargetInView();
  };

  /**
   * 在**当前视野内**随机位置生成一个新靶（含上下偏移）。
   *
   * 位置约束的依据：水平 FOV 103° 意味着画面左右各只有约 51.5°，垂直约 ±33°。
   *   · 水平偏移取 12°~30°：既够远（能测出真实的甩枪幅度），又保证整个靶面
   *     完整落在画面内（30° 时靶心约在半宽的 62% 处，靶面仍完全可见），
   *     不需要"拉动一个屏幕"去找靶；
   *   · 垂直偏移取 ±8°：远小于垂直半 FOV，抬头/低头都能轻松看到；
   *   · 左右方向随机，避免连续同侧形成单向肌肉记忆。
   */
  VRangeTest.prototype._spawnTargetInView = function () {
    var minAz = 12, maxAz = 30;
    var maxEl = 8;
    var sign = Math.random() < 0.5 ? -1 : 1;
    var dAz = sign * (minAz + Math.random() * (maxAz - minAz));
    var dEl = (Math.random() * 2 - 1) * maxEl;

    this.targetAz = this.yaw + dAz;
    this.targetEl = clamp(this.pitch + dEl, -MAX_PITCH, MAX_PITCH);
    this.targetSpawnTime = this._now();
  };

  /**
   * 射击判定入口（手动「定位测试」与流程「甩枪测试」共用）。
   * 命中条件：**视线方向与靶心方向的夹角** ≤ 靶面角半径 × HIT_FACTOR。
   * 这是真正的球面角距离判定，因此上下左右任何方向的靶都使用同一套标准，
   * 且与分辨率、窗口大小、是否全屏无关。
   */
  VRangeTest.prototype.shoot = function () {
    if (!this.isReady()) return;

    // 流程进行中：交给流程处理器
    if (this.drill && this.drill.type === 'flick') {
      this._drillFlickShoot();
      return;
    }
    if (this.mode !== 'target') return;

    var offAngle = this._angularDistance(this.targetAz, this.targetEl || 0);
    var hit = offAngle <= HIT_ANGLE_DEG;

    var now = this._now();
    this.hitFlashTime = now;
    this.hitFlashOk = hit;
    this._hitBurst = { az: this.targetAz, el: this.targetEl || 0, t: now, ok: hit };

    if (hit) {
      var ms = now - this.targetSpawnTime;
      this.hits++;
      this.totalHitMs += ms;
      this.lastHitMs = ms;
      if (this.bestHitMs === null || ms < this.bestHitMs) this.bestHitMs = ms;
      this.onEvent('hit', { ms: ms, offAngleDeg: offAngle });
      this._spawnTargetInView();
    } else {
      this.misses++;
      this.onEvent('miss', { offAngleDeg: offAngle });
    }
  };

  VRangeTest.prototype.getAccuracy = function () {
    var total = this.hits + this.misses;
    return total === 0 ? null : this.hits / total;
  };

  /* ==================== 灵敏度测试流程（drill，供 testflow.js 调用） ====================
   * 提供两个可量化的子测试：
   *   runFlickDrill()  甩枪定位 —— 靶出现在固定角度偏移处，考察「转向到位 + 停稳」的能力
   *   runTrackDrill()  跟枪     —— 匀速横移的目标，考察「持续跟随的精度」
   *
   * 公平性设计（这是「用测试结果推荐灵敏度」能成立的前提）：
   *   1. 靶的角度偏移由调用方预先给定，所有候选档位使用同一组偏移序列，
   *      因此每个档位面对的挑战完全一致，差异只来自灵敏度本身。
   *   2. 命中判定用「角度」而不是像素 → 与分辨率、窗口大小、是否全屏无关。
   *   3. 俯仰锁定，只考察 eDPI 真正影响的横向能力。
   *   4. 记录鼠标路径长度与过冲次数，用于量化「冲过头再拉回来」的程度。
   * ================================================================================= */

  /** 跟枪的命中角：准星落在靶面内即算「在靶上」（不乘 0.9，比甩枪略宽松） */
  var TRACK_HIT_ANGLE_DEG = TARGET_ANGULAR_RADIUS_DEG;

  /**
   * 甩枪定位测试。
   * @param {{offsets:Array, timeoutMs?:number, gapMs?:number, prepMs?:number}} opts
   *        offsets：每个靶相对「当前视线」的偏移。支持两种写法：
   *          · 数字：只做水平偏移（度，正数向右）
   *          · 对象 {az, el}：水平 + 垂直偏移（度），用于上下左右的二维甩枪
   * @returns {Promise<Object>} 结果；aborted=true 表示被中止，数据应丢弃
   */
  VRangeTest.prototype.runFlickDrill = function (opts) {
    var self = this;
    var o = opts || {};
    var offsets = o.offsets ? o.offsets.slice() : [];

    if (this.drill) this.abortDrill('restart');
    if (!this.isReady()) return Promise.resolve({ aborted: true, type: 'flick', reason: 'noconfig' });

    return new Promise(function (resolve) {
      self.mode = 'flick';
      self.hitFlashTime = 0;
      self.drill = {
        type: 'flick',
        offsets: offsets,
        index: -1,                       // -1 表示尚未生成第一个靶
        phase: 'gap',
        spawnAt: self._now() + (o.prepMs || 400),
        targetAz: 0,
        targetEl: 0,
        startTime: 0,
        timeoutMs: o.timeoutMs || 2500,
        gapMs: o.gapMs || 320,
        hitAngleDeg: HIT_ANGLE_DEG,
        // 统计
        hits: 0, misses: 0, timeouts: 0,
        clicksForTarget: 0, pathDeg: 0, idealPathDeg: 0, totalPathDeg: 0,
        insideCircle: false, firstInsideTime: null, overshoots: 0,
        totalOvershoots: 0, lastMs: null,
        results: [],
        _resolve: resolve
      };
      self.onEvent('drillstart', { type: 'flick', total: offsets.length });
    });
  };

  /** 进入下一个甩枪靶，或结束整轮 */
  VRangeTest.prototype._nextFlickTarget = function () {
    var d = this.drill;
    if (!d) return;

    d.index++;
    if (d.index >= d.offsets.length) { this._finishFlickDrill(); return; }

    // 兼容「数字 = 纯水平偏移」与「{az, el} = 二维偏移」两种写法
    var off = d.offsets[d.index];
    var oAz = (typeof off === 'number') ? off : (off && off.az) || 0;
    var oEl = (typeof off === 'number') ? 0 : ((off && off.el) || 0);

    d.currentAz = oAz;
    d.currentEl = oEl;
    d.targetAz = this.yaw + oAz;                                   // 相对当前视线，保证挑战一致
    d.targetEl = clamp(this.pitch + oEl, -MAX_PITCH, MAX_PITCH);

    d.startTime = this._now();
    d.pathDeg = 0;
    // 理想路径 = 从「靶生成瞬间的视线」到「靶心方向」的角距离（最小必要转动量）
    d.idealPathDeg += this._angularDistance(d.targetAz, d.targetEl);
    d.clicksForTarget = 0;
    d.insideCircle = false;
    d.firstInsideTime = null;
    d.overshoots = 0;
    d.phase = 'live';
  };

  /** 收尾：汇总甩枪结果 */
  VRangeTest.prototype._finishFlickDrill = function () {
    var d = this.drill;
    if (!d) return;
    var resolve = d._resolve;

    var total = d.results.length;
    var hitList = d.results.filter(function (r) { return r.hit; });
    var avgMs = null, bestMs = null;
    if (hitList.length) {
      var sum = 0;
      for (var i = 0; i < hitList.length; i++) {
        sum += hitList[i].ms;
        if (bestMs === null || hitList[i].ms < bestMs) bestMs = hitList[i].ms;
      }
      avgMs = sum / hitList.length;
    }

    var result = {
      aborted: false,
      type: 'flick',
      total: total,
      hits: hitList.length,
      clickMisses: d.misses,
      timeouts: d.timeouts,
      hitRate: total ? hitList.length / total : 0,
      avgMs: avgMs,
      bestMs: bestMs,
      // 路径效率：实际路径 ÷ 理想路径（理想路径 = 偏移角度之和）。1.0 ≈ 一次到位
      pathRatio: d.idealPathDeg > 0.5 ? d.totalPathDeg / d.idealPathDeg : null,
      avgOvershoot: total ? d.totalOvershoots / total : 0,
      targets: d.results
    };

    this.lastFlickResult = result;
    this.drill = null;
    if (this.mode === 'flick') this.mode = 'free';
    this.onEvent('drillcomplete', result);
    if (resolve) resolve(result);
  };

  /** 甩枪测试中的一次点击判定 */
  VRangeTest.prototype._drillFlickShoot = function () {
    var d = this.drill;
    if (!d || d.phase !== 'live') return;

    var now = this._now();
    var offAngle = this._angularDistance(d.targetAz, d.targetEl || 0);
    var hit = offAngle <= d.hitAngleDeg;

    d.clicksForTarget++;

    this.hitFlashTime = now;
    this.hitFlashOk = hit;
    this._hitBurst = { az: d.targetAz, el: d.targetEl || 0, t: now, ok: hit };

    if (hit) {
      var ms = now - d.startTime;
      d.hits++;
      d.lastMs = ms;
      d.totalOvershoots += d.overshoots;
      d.results.push({
        az: d.currentAz,
        el: d.currentEl,
        ms: ms,
        hit: true,
        clicks: d.clicksForTarget,
        pathDeg: d.pathDeg,
        overshoots: d.overshoots,
        firstInsideMs: d.firstInsideTime === null ? null : d.firstInsideTime - d.startTime
      });
      d.phase = 'gap';
      d.spawnAt = now + d.gapMs;
      this.onEvent('drillhit', { ms: ms, index: d.index, total: d.offsets.length });
    } else {
      d.misses++;
      this.onEvent('drillmiss', {
        offAngleDeg: offAngle,
        index: d.index,
        total: d.offsets.length
      });
    }
  };

  /**
   * 跟枪测试：目标以固定振幅/周期做正弦横移，玩家需持续把准星压在靶面上。
   * @param {{durationMs?:number, amplitudeDeg?:number, periodMs?:number, prepMs?:number}} opts
   * @returns {Promise<Object>}
   */
  VRangeTest.prototype.runTrackDrill = function (opts) {
    var self = this;
    var o = opts || {};

    if (this.drill) this.abortDrill('restart');
    if (!this.isReady()) return Promise.resolve({ aborted: true, type: 'track', reason: 'noconfig' });

    return new Promise(function (resolve) {
      self.mode = 'track';
      self.hitFlashTime = 0;
      self.drill = {
        type: 'track',
        phase: 'live',
        t0: self._now() + (o.prepMs || 400),   // 准备时间：目标先停在中点
        durationMs: o.durationMs || 8000,
        amplitudeDeg: o.amplitudeDeg || 18,
        periodMs: o.periodMs || 2600,
        hitAngleDeg: TRACK_HIT_ANGLE_DEG,
        originYaw: self.yaw,
        targetAz: self.yaw,
        targetEl: 0,                            // 跟枪目标固定在水平线上，只做横向平移
        started: false,
        samples: 0, onTarget: 0, sumAbsErr: 0, sumSqErr: 0,
        mousePathDeg: 0, idealPathDeg: 0,
        // 保持与甩枪一致的正数字段，便于 HUD 统一渲染
        hits: 0, misses: 0, timeouts: 0, index: 0, offsets: null,
        _resolve: resolve
      };
      self.onEvent('drillstart', { type: 'track', durationMs: self.drill.durationMs });
    });
  };

  /** 收尾：汇总跟枪结果 */
  VRangeTest.prototype._finishTrackDrill = function () {
    var d = this.drill;
    if (!d) return;
    var resolve = d._resolve;

    var result = {
      aborted: false,
      type: 'track',
      durationMs: d.durationMs,
      samples: d.samples,
      onTargetPct: d.samples ? (d.onTarget / d.samples) * 100 : 0,
      meanErrDeg: d.samples ? d.sumAbsErr / d.samples : null,
      rmsErrDeg: d.samples ? Math.sqrt(d.sumSqErr / d.samples) : null,
      // 跟随路径比：鼠标实际走的角路程 ÷ 目标实际走的角路程。
      // 越接近 1 越「跟得平顺」，明显大于 1 说明在反复修正/抖动。
      pathRatio: d.idealPathDeg > 0.5 ? d.mousePathDeg / d.idealPathDeg : null,
      idealPathDeg: d.idealPathDeg
    };

    this.lastTrackResult = result;
    this.drill = null;
    if (this.mode === 'track') this.mode = 'free';
    this.onEvent('drillcomplete', result);
    if (resolve) resolve(result);
  };

  /**
   * 中止当前流程。会把 Promise 以 aborted=true 结束，调用方据此丢弃本档数据。
   * @param {string} reason
   */
  VRangeTest.prototype.abortDrill = function (reason) {
    var d = this.drill;
    if (!d) return;
    this.drill = null;
    if (this.mode === 'flick' || this.mode === 'track') this.mode = 'free';
    var out = { aborted: true, type: d.type, reason: reason || 'abort' };
    this.onEvent('drillabort', out);
    if (d._resolve) d._resolve(out);
  };

  /** 每帧推进流程：处理靶位生成、超时判定、跟枪采样 */
  VRangeTest.prototype._tickDrill = function () {
    var d = this.drill;
    if (!d) return;
    var now = this._now();

    if (d.type === 'flick') {
      if (d.phase === 'gap') {
        if (now >= d.spawnAt) this._nextFlickTarget();
      } else if (d.phase === 'live') {
        // 超时未命中：计入未命中并进入下一个靶
        if (now - d.startTime > d.timeoutMs) {
          var ms = now - d.startTime;
          d.timeouts++;
          d.totalOvershoots += d.overshoots;
          d.results.push({
            az: d.currentAz,
            el: d.currentEl,
            ms: ms,
            hit: false,
            clicks: d.clicksForTarget,
            pathDeg: d.pathDeg,
            overshoots: d.overshoots,
            firstInsideMs: d.firstInsideTime === null ? null : d.firstInsideTime - d.startTime
          });
          d.phase = 'gap';
          d.spawnAt = now + d.gapMs;
          this.onEvent('drilltimeout', { index: d.index, total: d.offsets.length });
        }
      }
      return;
    }

    if (d.type === 'track') {
      var t = now - d.t0;
      if (t < 0) { d.targetAz = d.originYaw; return; }        // 准备阶段：目标停在中点
      if (t >= d.durationMs) { this._finishTrackDrill(); return; }

      // 目标方位按正弦横移（世界坐标固定，因此需要玩家去跟随）
      var az = d.originYaw + d.amplitudeDeg * Math.sin(2 * Math.PI * t / d.periodMs);

      if (!d.started) {
        // 正式开始采样：清零累计量，避免把准备阶段的鼠标移动算进去
        d.started = true;
        d.mousePathDeg = 0;
        d.idealPathDeg = 0;
        d.prevAz = d.targetAz;
      }

      d.idealPathDeg += Math.abs(az - d.prevAz);
      d.prevAz = az;
      d.targetAz = az;

      // 每帧采样一次准星误差（这是跟枪精度的原始数据）。
      // 用球面角距离，因此玩家把视角上下拉偏也会被如实计入误差。
      var err = this._angularDistance(az, 0);
      d.samples++;
      if (err <= d.hitAngleDeg) d.onTarget++;
      d.sumAbsErr += err;
      d.sumSqErr += err * err;
    }
  };

  /** 流程实时读数（供 HUD / 测试面板显示） */
  VRangeTest.prototype.getDrillSnapshot = function () {
    var d = this.drill;
    if (!d) return null;
    var now = this._now();
    var out = {
      type: d.type,
      phase: d.phase,
      sens: this.sens,
      dpi: this.dpi,
      hits: d.hits || 0,
      misses: d.misses || 0,
      timeouts: d.timeouts || 0,
      lastMs: d.lastMs || null,
      index: d.index,
      total: d.offsets ? d.offsets.length : 0,
      elapsedMs: null,
      remainsMs: null,
      onTargetPct: null
    };

    if (d.type === 'flick') {
      out.elapsedMs = d.phase === 'live' ? now - d.startTime : 0;
      out.targetAz = d.currentAz;
      out.targetEl = d.currentEl;
    } else {
      var t = now - d.t0;
      out.elapsedMs = Math.max(0, t);
      out.remainsMs = Math.max(0, d.durationMs - Math.max(0, t));
      out.onTargetPct = d.samples ? (d.onTarget / d.samples) * 100 : null;
    }
    return out;
  };

  /* ============================ 视角重置 ============================ */
  VRangeTest.prototype.resetView = function () {
    // 流程进行中不允许重置视角（否则当前靶位的计时/路径数据会失真）
    if (this.drill) this.abortDrill('view-reset');

    this.yaw = 0;
    this.pitch = 0;
    this.totalCountsX = 0;
    this.totalCountsY = 0;
    this.eventCount = 0;
    this.resetSpin();
    if (this.mode === 'target') {
      this._resetTargetStats();
      this._spawnTarget();
    }
    // 通知 UI 立即刷新一次读数
    this._emitUpdate(true);
    return this;
  };

  /* ============================ Pointer Lock ============================ */
  /**
   * 请求指针锁定。优先请求 unadjustedMovement（原始输入，绕过系统加速），
   * 若浏览器不支持该选项则回退到普通锁定。
   */
  VRangeTest.prototype.lock = function () {
    var el = this.canvas;
    if (!el.requestPointerLock) {
      this.onEvent('lockunsupported', {});
      return;
    }
    try {
      var p = el.requestPointerLock({ unadjustedMovement: true });
      if (p && typeof p.then === 'function') {
        // 新版浏览器返回 Promise；不支持该选项时会被拒绝，此时回退
        p.catch(function () {
          try { el.requestPointerLock(); } catch (e) { /* 忽略 */ }
        });
      }
    } catch (e) {
      try { el.requestPointerLock(); } catch (e2) { /* 忽略 */ }
    }
  };

  VRangeTest.prototype.unlock = function () {
    if (document.exitPointerLock) document.exitPointerLock();
  };

  VRangeTest.prototype.toggleLock = function () {
    if (this.locked) this.unlock();
    else this.lock();
  };

  /* ============================ 读数快照 ============================ */
  /**
   * @returns {Object} 供 UI 渲染的完整读数
   */
  VRangeTest.prototype.getSnapshot = function () {
    var ready = this.isReady();
    var distCm = ready ? VCalc.cmFromCounts(this.totalCountsX, this.dpi) : null;
    var spinProgress = ready
      ? Math.abs(this.spinCounts) * VCalc.degPerCount(this.sens)
      : 0;
    var spinCm = ready ? VCalc.cmFromCounts(Math.abs(this.spinCounts), this.dpi) : 0;

    return {
      ready: ready,
      mode: this.mode,
      modeLabel: this.getModeLabel(),
      locked: this.locked,
      yaw: this.yaw,
      yawHeading: normalize360(this.yaw),
      pitch: this.pitch,
      totalCountsX: this.totalCountsX,
      totalCountsY: this.totalCountsY,
      distCm: distCm,
      // 360° 校准
      spinActive: this.spinActive,
      spinDone: this.spinDone,
      spinProgressDeg: spinProgress,
      spinCm: spinCm,
      spinResult: this.spinResult,
      // 定位测试
      hits: this.hits,
      misses: this.misses,
      lastHitMs: this.lastHitMs,
      bestHitMs: this.bestHitMs,
      avgHitMs: this.hits > 0 ? this.totalHitMs / this.hits : null,
      accuracy: this.getAccuracy(),
      // 灵敏度测试流程（无流程进行时为 null）
      drill: this.getDrillSnapshot()
    };
  };

  /* ============================ 主循环 ============================ */
  VRangeTest.prototype._loop = function (now) {
    if (this._destroyed) return;
    this._rafId = window.requestAnimationFrame(this._loop);

    // 推进测试流程（生成靶位 / 超时判定 / 跟枪逐帧采样）
    this._tickDrill();

    /* 渲染判定：
     *   只要「画布可见」或「处于全屏」或「测试流程正在跑」就渲染。
     * 不能只看 IntersectionObserver —— 全屏切换、元素刚展开、观察器还没回调时，
     * 它可能仍报告"不可见"，那样画面就会停在上一帧甚至一片漆黑。
     * 省电的目标由「真的在页面外且没在测试」来承担。 */
    if (this.visible || this.forcedVisible || this.drill) {
      this._render(now);
    }

    // 限制回调频率（默认 12Hz），避免高频写 DOM 造成掉帧
    if (!this._lastUpdate || now - this._lastUpdate > 1000 / UPDATE_HZ) {
      this._lastUpdate = now;
      this._emitUpdate(false);
    }
  };

  VRangeTest.prototype._emitUpdate = function (force) {
    this.onUpdate(this.getSnapshot(), !!force);
  };

  /* ============================ 渲染 ============================ */
  /**
   * 相机变换 + 透视投影。
   *
   * 相机位于原点（视点高度 CAM_HEIGHT），变换顺序与真实 FPS 一致：
   *   1. 先把世界点转到相机坐标系（绕 Y 轴旋转 -yaw）
   *   2. 再绕相机右轴旋转 -pitch（抬头时同一物体在画面中下移）
   *   3. 最后做透视除法：x = cx + focal·x/z，y = cy - focal·y/z
   *
   * 为什么必须用真正的三维投影，而不是「x 由水平角决定 / y 由地平线偏移决定」的近似：
   *   近似公式只在俯仰接近 0 时成立。一旦允许上下自由观察，
   *   近似会让「画面上看到的靶心位置」与「命中判定用的角度」对不上 ——
   *   玩家瞄准了靶心却判 miss。用真正的投影可以从根本上避免这种不一致。
   *
   * @param {number} xCam 相机右方向分量（米）
   * @param {number} yCam 相机上方向分量（米，相对视点高度）
   * @param {number} zCam 相机前方向分量（米）
   * @returns {{x:number, y:number, z:number, visible:boolean}} z 为沿视线的深度
   */
  VRangeTest.prototype._cam = function (xCam, yCam, zCam) {
    var p = this.pitch * RAD;
    var cosP = Math.cos(p), sinP = Math.sin(p);

    var z2 = zCam * cosP + yCam * sinP;   // 沿视线方向的深度（透视除法用它）
    var y2 = yCam * cosP - zCam * sinP;   // 画面垂直方向分量

    var visible = z2 > NEAR;
    var zz = visible ? z2 : NEAR;         // 不可见时也返回坐标（供折线裁剪判断），但不参与命中

    return {
      x: this.cx + this.focal * xCam / zz,
      y: this.cy - this.focal * y2 / zz,
      z: z2,
      visible: visible
    };
  };

  /**
   * 投影「相对相机的方向」：方位差 dAz（度）+ 仰角 el（度），距离 dist（米）。
   * 用于靶位等「以玩家为中心、按方向摆放」的物体。
   */
  VRangeTest.prototype._project = function (dAz, el, dist) {
    var a = dAz * RAD, e = el * RAD;
    return this._cam(
      dist * Math.cos(e) * Math.sin(a),
      dist * Math.sin(e),
      dist * Math.cos(e) * Math.cos(a)
    );
  };

  /**
   * 投影世界场景点：方位角 az（度）、水平距离 dist（米）、高度 height（米）。
   * 用于地面网格与后墙这类固定在世界坐标里的几何体。
   */
  VRangeTest.prototype._projectPoint = function (az, dist, height) {
    var dAz = (az - this.yaw) * RAD;
    return this._cam(
      dist * Math.sin(dAz),
      height - CAM_HEIGHT,
      dist * Math.cos(dAz)
    );
  };

  /**
   * 视线方向与某个「方位角 + 仰角」方向之间的夹角（度）。
   * 用球面余弦定理计算，因此是一个真正的圆形命中圈（不随俯仰拉伸变形）。
   */
  VRangeTest.prototype._angularDistance = function (az, el) {
    var cosG =
      Math.sin(el * RAD) * Math.sin(this.pitch * RAD) +
      Math.cos(el * RAD) * Math.cos(this.pitch * RAD) * Math.cos((az - this.yaw) * RAD);
    return Math.acos(clamp(cosG, -1, 1)) * DEG;
  };

  /** 靶面在屏幕上的半径（像素）：半径随深度线性收缩 */
  VRangeTest.prototype._targetScreenRadius = function (depth) {
    return TARGET_RADIUS_M * (this.focal / Math.max(NEAR, depth));
  };

  /** 地平线在屏幕上的 y 坐标：向上看时地平线下移（由 _cam 在同一套数学下推出） */
  VRangeTest.prototype._horizonY = function () {
    return this.cy + this.focal * Math.tan(this.pitch * RAD);
  };

  VRangeTest.prototype._render = function (now) {
    var ctx = this.ctx;
    var w = this.w, h = this.h;
    var horizonY = this._horizonY();

    /* ---------- 1. 天空 ---------- */
    ctx.clearRect(0, 0, w, h);
    if (horizonY > 0) {
      // 比早期版本整体提亮一档：全屏时画面会占满整块屏幕，
      // 过暗的底色会让"进入全屏"看起来像是屏幕被调暗了。
      var sky = ctx.createLinearGradient(0, 0, 0, Math.max(horizonY, 1));
      sky.addColorStop(0, '#12202E');
      sky.addColorStop(0.6, '#1B2C3E');
      sky.addColorStop(1, '#274054');
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, w, Math.min(horizonY, h));
    }

    /* ---------- 2. 地面 ---------- */
    if (horizonY < h) {
      var ground = ctx.createLinearGradient(0, horizonY, 0, h);
      ground.addColorStop(0, '#22303E');
      ground.addColorStop(0.3, '#1A2734');
      ground.addColorStop(1, '#111A23');
      ctx.fillStyle = ground;
      ctx.fillRect(0, Math.max(horizonY, 0), w, h - Math.max(horizonY, 0));
    }

    /* ---------- 3. 后墙（先画墙，靶子随后画在墙前面） ---------- */
    this._drawWall();

    /* ---------- 4. 地面网格：距离环 + 径向线 ---------- */
    this._drawGroundGrid();

    /* ---------- 5. 靶位 ---------- */
    this._drawTargets(now);

    /* ---------- 6. 顶部罗盘 & 底部进度 ---------- */
    this._drawCompass();
    if (this.mode === 'spin') this._drawSpinProgress();

    /* ---------- 7. 准星与命中反馈 ---------- */
    this._drawCrosshair(now);

    /* ---------- 8. 右侧俯仰刻度（上下观察时的方位参考） ---------- */
    this._drawPitchScale();

    /* ---------- 9. 暗角，增强聚焦感 ---------- */
    this._drawVignette();

    /* ---------- 10. 参数无效时的提示（画布内文字，DOM 浮层由 main.js 负责） ---------- */
    if (!this.isReady()) {
      ctx.save();
      ctx.fillStyle = 'rgba(236,232,225,.55)';
      ctx.font = '600 14px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('请先在上方填写有效的 DPI 与游戏内灵敏度', w / 2, h - 22);
      ctx.restore();
    }
  };

  /**
   * 靶场后墙：由一圈「竖直面板」拼成的圆柱面。
   * 逐片绘制（每 4° 一片）而不是拼一条大折线，这样在抬头/低头导致部分面板落到
   * 相机后方时，只需跳过该片即可，不需要复杂的多边形裁剪。
   */
  VRangeTest.prototype._drawWall = function () {
    var ctx = this.ctx;
    var w = this.w;

    /* 性能：整圈墙有 60 片（每 6°），如果每片都 createLinearGradient，
     * 每帧就要新建 60 个渐变对象 —— 全屏下这是掉帧主因。
     * 这里改为固定两种纯色交替 + 一层按方位角的暗化，视觉几乎一致但快得多。 */
    for (var az = 0; az < 360; az += 6) {
      var az2 = az + 6;
      // 只要有一角跑到相机后方就整片跳过（6° 切片很窄，视觉上看不出来）
      var b0 = this._projectPoint(az, WALL_RADIUS, 0);
      var b1 = this._projectPoint(az2, WALL_RADIUS, 0);
      var t1 = this._projectPoint(az2, WALL_RADIUS, WALL_HEIGHT);
      var t0 = this._projectPoint(az, WALL_RADIUS, WALL_HEIGHT);
      if (!b0.visible || !b1.visible || !t0.visible || !t1.visible) continue;

      // 屏幕外的整片可以直接跳过（省掉大量绘制）
      var minX = Math.min(b0.x, b1.x, t0.x, t1.x);
      var maxX = Math.max(b0.x, b1.x, t0.x, t1.x);
      if (minX > w + 40 || maxX < -40) continue;

      ctx.beginPath();
      ctx.moveTo(t0.x, t0.y);
      ctx.lineTo(t1.x, t1.y);
      ctx.lineTo(b1.x, b1.y);
      ctx.lineTo(b0.x, b0.y);
      ctx.closePath();

      // 相邻片明暗交替，形成分段面板的纵深感
      ctx.fillStyle = (Math.floor(az / 6) % 2 === 0) ? '#26394A' : '#213243';
      ctx.fill();

      // 越靠视野边缘越暗，补回一点"远处衰减"的层次
      var edge = Math.abs(angleDelta(az + 3, this.yaw)) / 90;
      if (edge > 0.35) {
        ctx.fillStyle = 'rgba(6,10,14,' + Math.min(0.45, (edge - 0.35) * 0.75) + ')';
        ctx.fill();
      }

      // 每 6° 一条面板缝，每 90° 用红色高亮（帮助判断方位）
      ctx.beginPath();
      ctx.moveTo(t0.x, t0.y);
      ctx.lineTo(b0.x, b0.y);
      ctx.strokeStyle = (az % 90 === 0) ? 'rgba(255,70,85,.22)' : 'rgba(255,255,255,.045)';
      ctx.lineWidth = (az % 90 === 0) ? 1.4 : 1;
      ctx.stroke();
    }

    // 墙脚线（贴地那圈）：给地面与墙面一个清晰的分界
    this._strokeRing(WALL_RADIUS, 0, 'rgba(255,70,85,.30)', 1.5);
    // 墙顶线
    this._strokeRing(WALL_RADIUS, WALL_HEIGHT, 'rgba(140,170,200,.20)', 1);
  };

  /**
   * 画一圈「水平圆环」（固定高度、固定半径），逐段采样并跳过不可见段。
   * 用于地面距离环与墙面上下边缘线。
   */
  VRangeTest.prototype._strokeRing = function (radius, height, strokeStyle, lineWidth) {
    var ctx = this.ctx;
    var started = false;
    ctx.beginPath();
    for (var az = 0; az <= 360; az += 4) {
      var p = this._projectPoint(az, radius, height);
      if (!p.visible) { started = false; continue; }
      if (!started) { ctx.moveTo(p.x, p.y); started = true; }
      else ctx.lineTo(p.x, p.y);
    }
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  };

  /** 地面网格：以视点为圆心的距离环 + 每 15° 的径向线 */
  VRangeTest.prototype._drawGroundGrid = function () {
    var ctx = this.ctx;

    // 距离环（米）
    var rings = [4, 8, 12, 20, 28];
    for (var k = 0; k < rings.length; k++) {
      this._strokeRing(
        rings[k], 0,
        (k === 0) ? 'rgba(150,190,220,.20)' : 'rgba(150,190,220,.11)',
        1
      );
    }

    // 径向线：从近处沿方位角向远处延伸（地面直线仍投影为直线）
    for (var az = 0; az < 360; az += 15) {
      var dAz = angleDelta(az, this.yaw);
      if (Math.abs(dAz) > CULL_DEG) continue;

      ctx.beginPath();
      var started = false;
      for (var r = 1; r <= 32; r += 1) {
        var p = this._projectPoint(az, r, 0);
        if (!p.visible) { started = false; continue; }
        if (!started) { ctx.moveTo(p.x, p.y); started = true; }
        else ctx.lineTo(p.x, p.y);
      }
      ctx.strokeStyle = (az % 45 === 0) ? 'rgba(150,190,220,.17)' : 'rgba(150,190,220,.09)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  };

  /**
   * 绘制靶位。
   * - 自由转向 / 360° 校准：绘制环绕一周的 12 个靶（感受空间方位）
   * - 定位测试 / 测试流程：只绘制当前目标靶（画面干净，便于集中注意力）
   */
  VRangeTest.prototype._drawTargets = function (now) {
    // 测试流程进行中：只绘制当前流程靶
    if (this.drill && (this.drill.type === 'flick' || this.drill.type === 'track')) {
      // 甩枪的间隔阶段（gap）不显示靶，但命中波纹继续播完
      if (this.drill.type === 'flick' && this.drill.phase !== 'live') {
        this._drawHitBurst(now);
        return;
      }
      this._drawOneTarget(
        this.drill.targetAz, this.drill.targetEl || 0, true, now, this.drill.type,
        this.drill.type === 'flick' ? this.drill.startTime : 0
      );
      this._drawHitBurst(now);
      return;
    }

    if (this.mode === 'target') {
      this._drawOneTarget(this.targetAz, this.targetEl || 0, true, now, 'target', this.targetSpawnTime);
      this._drawHitBurst(now);
      return;
    }
    for (var az = 0; az < 360; az += 30) {
      this._drawOneTarget(az, 0, false, now, 'idle', 0);
    }
    this._drawHitBurst(now);
  };

  /**
   * 单个靶：支架 + 同心圆靶面（始终正面朝向玩家的 billboard）。
   *
   * 视觉设计的三个目标：
   *   1. **一眼就能看到**：靶面背后有柔和的暗色光晕，把它从后墙/地面上"抬"起来；
   *      外圈有高对比描边，深色背景下不会糊成一团。
   *   2. **立刻知道该打哪**：出现时有一圈扩散波纹（spawn ripple），
   *      让视线第一时间捕捉到新靶；靶心有色点，便于精确对准。
   *   3. **看得出命中**：命中处留下一圈扩散的命中波纹（hit burst），
   *      并区分"命中(绿) / 脱靶(红)"。
   *
   * @param {number} az 世界方位角（度）
   * @param {number} el 仰角（度，相对视点高度，向上为正）
   * @param {boolean} isActive 是否为当前目标
   * @param {number} now 当前时间戳
   * @param {string} kind 'flick' 甩枪 / 'track' 跟枪 / 'target' 手动 / 'idle' 装饰
   * @param {number} [spawnTime] 靶出现的时间戳，用于播放"出现波纹"
   */
  VRangeTest.prototype._drawOneTarget = function (az, el, isActive, now, kind, spawnTime) {
    var ctx = this.ctx;
    var dAz = angleDelta(az, this.yaw);
    if (Math.abs(dAz) > CULL_DEG) return;

    var p = this._project(dAz, el, TARGET_DIST);
    if (!p.visible) return;
    if (p.x < -140 || p.x > this.w + 140) return;

    var radiusPx = this._targetScreenRadius(p.z);
    if (radiusPx < 0.6) return;

    var isTrack = (kind === 'track');
    var accent = isTrack ? '79,214,232' : '255,70,85';
    var hasSpawn = isActive && typeof spawnTime === 'number' && spawnTime > 0;
    var sinceSpawn = hasSpawn ? (now - spawnTime) : 1e9;

    /* ---- 1. 地面阴影 + 支架（先画，保证被靶面压住） ---- */
    var ground = this._projectPoint(az, TARGET_DIST, 0);
    if (ground.visible) {
      var depthScale = this.focal / Math.max(NEAR, p.z);

      // 地面投影阴影：给靶子一个"落在地上"的锚点
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(ground.x, ground.y, 0.42 * depthScale, 0.13 * depthScale, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,.34)';
      ctx.fill();
      ctx.restore();

      // 支架：细杆 + 底座
      var postW = Math.max(2, 0.085 * depthScale);
      var boardBottom = p.y + radiusPx * 0.62;
      var postTop = Math.min(boardBottom, ground.y);
      if (ground.y > postTop) {
        var grad = ctx.createLinearGradient(p.x - postW, 0, p.x + postW, 0);
        grad.addColorStop(0, '#1B2A38');
        grad.addColorStop(0.45, '#3A5169');
        grad.addColorStop(1, '#182634');
        ctx.fillStyle = grad;
        ctx.fillRect(p.x - postW / 2, postTop, postW, ground.y - postTop);

        // 底座
        ctx.beginPath();
        ctx.ellipse(ground.x, ground.y, postW * 1.6, postW * 0.7, 0, 0, Math.PI * 2);
        ctx.fillStyle = '#22333F';
        ctx.fill();
      }
    }

    /* ---- 2. 命中/脱靶闪烁（在靶面之下，形成发光感） ---- */
    var flash = isActive && this.hitFlashTime > 0 && (now - this.hitFlashTime) < 280;
    if (flash) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(p.x, p.y, radiusPx * 2.1, 0, Math.PI * 2);
      ctx.fillStyle = this.hitFlashOk ? 'rgba(72,199,142,.26)' : 'rgba(255,70,85,.22)';
      ctx.fill();
      ctx.restore();
    }

    /* ---- 3. 靶面：暗色光晕 → 底圆 → 同心环 → 描边 → 靶心 ---- */
    ctx.save();
    ctx.translate(p.x, p.y);

    // 暗色光晕：把靶面从复杂背景里"抬"出来。
    // 性能：这里用两圈半透明填充代替 createRadialGradient —— 视觉几乎一致，
    // 但不会每帧为每个靶新建渐变对象（全屏 + 12 个装饰靶时差别很明显）。
    ctx.beginPath();
    ctx.arc(0, 0, radiusPx * 1.95, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(6,10,14,.30)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, 0, radiusPx * 1.42, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(6,10,14,.38)';
    ctx.fill();

    // 底圆
    ctx.beginPath();
    ctx.arc(0, 0, radiusPx, 0, Math.PI * 2);
    ctx.fillStyle = '#0E1720';
    ctx.fill();

    // 同心环（外→内：白-红-白-红），风格接近无畏契约靶场机器人
    var rings = [
      { r: 1.00, fill: '#E8E4DD' },
      { r: 0.80, fill: '#FF4655' },
      { r: 0.58, fill: '#E8E4DD' },
      { r: 0.36, fill: '#FF4655' },
      { r: 0.18, fill: '#E8E4DD' }
    ];
    for (var i = 0; i < rings.length; i++) {
      ctx.beginPath();
      ctx.arc(0, 0, radiusPx * rings[i].r, 0, Math.PI * 2);
      ctx.fillStyle = rings[i].fill;
      ctx.fill();
    }

    // 环与环之间压一条细暗线，边缘更利落（避免白红相邻发糊）
    ctx.strokeStyle = 'rgba(14,23,32,.45)';
    ctx.lineWidth = 1;
    for (var k = 1; k < rings.length; k++) {
      ctx.beginPath();
      ctx.arc(0, 0, radiusPx * rings[k].r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 外圈高对比描边：当前目标用主题色，装饰靶用弱描边
    ctx.beginPath();
    ctx.arc(0, 0, radiusPx, 0, Math.PI * 2);
    if (isActive) {
      ctx.strokeStyle = 'rgb(' + accent + ')';
      ctx.lineWidth = 2.6;
    } else {
      ctx.strokeStyle = 'rgba(236,232,225,.32)';
      ctx.lineWidth = 1.2;
    }
    ctx.stroke();

    // 靶心：亮色小点 + 暗环，便于精确对准
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(1.6, radiusPx * 0.075), 0, Math.PI * 2);
    ctx.fillStyle = '#0E1720';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(0.9, radiusPx * 0.032), 0, Math.PI * 2);
    ctx.fillStyle = 'rgb(' + accent + ')';
    ctx.fill();
    ctx.restore();

    /* ---- 4. 出现波纹：靶刚出现时向外扩散一圈，抓住视觉注意力 ---- */
    if (hasSpawn && sinceSpawn < 460) {
      var t = sinceSpawn / 460;
      ctx.save();
      ctx.beginPath();
      ctx.arc(p.x, p.y, radiusPx * (1.0 + t * 1.5), 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(' + accent + ',' + (0.55 * (1 - t)) + ')';
      ctx.lineWidth = 2.2;
      ctx.stroke();
      ctx.restore();
    }

    /* ---- 5. 持续脉动外环：明确"这就是当前目标" ---- */
    if (isActive) {
      var pulse = 0.5 + 0.5 * Math.sin(now / 340);
      ctx.beginPath();
      ctx.arc(p.x, p.y, radiusPx + 7 + pulse * 5, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(' + accent + ',' + (0.16 + pulse * 0.24) + ')';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    /* ---- 6. 跟枪靶：水平参考线，提示"目标只在水平方向移动" ---- */
    if (isTrack && isActive) {
      ctx.save();
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.moveTo(Math.max(0, p.x - radiusPx * 4), p.y);
      ctx.lineTo(Math.min(this.w, p.x + radiusPx * 4), p.y);
      ctx.strokeStyle = 'rgba(79,214,232,.20)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }
  };

  /**
   * 命中波纹：命中后在该位置留下一圈扩散的圆环，作为"打中了"的即时反馈。
   * 位置用「方位角 + 仰角」记录，因此镜头转动后波纹依然贴在世界里。
   */
  VRangeTest.prototype._drawHitBurst = function (now) {
    var b = this._hitBurst;
    if (!b) return;
    var age = now - b.t;
    if (age < 0 || age > 420) { this._hitBurst = null; return; }

    var dAz = angleDelta(b.az, this.yaw);
    if (Math.abs(dAz) > CULL_DEG) return;
    var p = this._project(dAz, b.el, TARGET_DIST);
    if (!p.visible) return;

    var radiusPx = this._targetScreenRadius(p.z);
    var t = age / 420;
    var ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.arc(p.x, p.y, radiusPx * (1.1 + t * 1.9), 0, Math.PI * 2);
    ctx.strokeStyle = b.ok
      ? 'rgba(72,199,142,' + (0.75 * (1 - t)) + ')'
      : 'rgba(255,70,85,' + (0.6 * (1 - t)) + ')';
    ctx.lineWidth = 3 * (1 - t) + 1;
    ctx.stroke();

    // 命中时再加一个中心十字，强化"这一枪有效"
    if (b.ok) {
      var len = radiusPx * 0.9 * (1 - t * 0.3);
      ctx.beginPath();
      ctx.moveTo(p.x - len, p.y); ctx.lineTo(p.x + len, p.y);
      ctx.moveTo(p.x, p.y - len); ctx.lineTo(p.x, p.y + len);
      ctx.strokeStyle = 'rgba(72,199,142,' + (0.8 * (1 - t)) + ')';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.restore();
  };

  /** 顶部罗盘 HUD：线性显示方位，方便确认「转了多少度」 */
  VRangeTest.prototype._drawCompass = function () {
    var ctx = this.ctx;
    var w = this.w;
    var hCompass = 30;
    var pxPerDeg = w / COMPASS_SPAN;
    var heading = normalize360(this.yaw);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, hCompass);
    ctx.clip();
    ctx.fillStyle = 'rgba(7,12,17,.55)';
    ctx.fillRect(0, 0, w, hCompass);

    for (var offset = -COMPASS_SPAN / 2; offset <= COMPASS_SPAN / 2; offset += 5) {
      var deg = normalize360(heading + offset);
      var x = this.cx + offset * pxPerDeg;
      if (x < -20 || x > w + 20) continue;

      var isMajor = Math.abs(deg % 90) < 0.001;
      var isMid = Math.abs(deg % 30) < 0.001;
      var tickH = isMajor ? 12 : (isMid ? 8 : 4);

      ctx.beginPath();
      ctx.moveTo(x, hCompass - tickH - 2);
      ctx.lineTo(x, hCompass - 2);
      ctx.strokeStyle = isMajor ? 'rgba(255,70,85,.85)' : 'rgba(236,232,225,.28)';
      ctx.lineWidth = isMajor ? 2 : 1;
      ctx.stroke();

      if (isMajor) {
        ctx.fillStyle = 'rgba(236,232,225,.72)';
        ctx.font = '600 10px "Consolas", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(Math.round(deg) + '°', x, hCompass - 17);
      }
    }

    // 中心指示三角
    ctx.beginPath();
    ctx.moveTo(this.cx, hCompass - 1);
    ctx.lineTo(this.cx - 5, hCompass - 9);
    ctx.lineTo(this.cx + 5, hCompass - 9);
    ctx.closePath();
    ctx.fillStyle = '#FF4655';
    ctx.fill();
    ctx.restore();
  };

  /** 360° 校准的底部进度条 */
  VRangeTest.prototype._drawSpinProgress = function () {
    var ctx = this.ctx;
    var w = this.w, h = this.h;
    var barW = Math.min(420, w * 0.55);
    var barH = 8;
    var x0 = (w - barW) / 2;
    var y0 = h - 44;
    var progress = this.spinDone
      ? 1
      : clamp(Math.abs(this.spinCounts) * (this.isReady() ? VCalc.degPerCount(this.sens) : 0) / 360, 0, 1);

    ctx.save();
    ctx.fillStyle = 'rgba(7,12,17,.75)';
    ctx.fillRect(x0 - 10, y0 - 26, barW + 20, barH + 36);

    ctx.fillStyle = 'rgba(236,232,225,.12)';
    ctx.fillRect(x0, y0, barW, barH);

    ctx.fillStyle = this.spinDone ? '#48C78E' : '#FF4655';
    ctx.fillRect(x0, y0, barW * progress, barH);

    ctx.font = '600 12px "Consolas", monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(236,232,225,.92)';
    var label;
    if (!this.spinActive && !this.spinDone) {
      label = '点击画布开始校准，然后朝一个方向匀速移动鼠标';
    } else if (this.spinDone) {
      label = '完成！本次 360° 用了 ' + VCalc.format(this.spinResult.cm360, 2) + ' cm' +
              '（用时 ' + VCalc.format(this.spinResult.elapsedMs / 1000, 2) + ' s）';
    } else {
      label = '已转 ' + VCalc.format(progress * 360, 0) + '° / 360°  ·  ' +
              VCalc.format(this.isReady() ? VCalc.cmFromCounts(Math.abs(this.spinCounts), this.dpi) : 0, 1) + ' cm';
    }
    ctx.fillText(label, w / 2, y0 + barH + 16);
    ctx.restore();
  };

  /** 准星：4 条短线 + 中心点，颜色与游戏内常见的绿色准星一致 */
  VRangeTest.prototype._drawCrosshair = function (now) {
    var ctx = this.ctx;
    var cx = this.cx, cy = this.cy;

    /* 按画布高度缩放：全屏（尤其 2K/4K）下画布比窗口大得多，
     * 固定像素尺寸的准星会显得极小、难以对准。这里以 620px 高为基准放大。 */
    var k = clamp(this.h / 620, 1, 2.4);
    var gap = 5 * k, len = 9 * k, thick = Math.max(2, 2 * k);

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.9)';
    ctx.shadowBlur = 3 * k;
    ctx.strokeStyle = '#3DF08A';
    ctx.fillStyle = '#3DF08A';
    ctx.lineWidth = thick;

    // 上
    ctx.beginPath(); ctx.moveTo(cx, cy - gap); ctx.lineTo(cx, cy - gap - len); ctx.stroke();
    // 下
    ctx.beginPath(); ctx.moveTo(cx, cy + gap); ctx.lineTo(cx, cy + gap + len); ctx.stroke();
    // 左
    ctx.beginPath(); ctx.moveTo(cx - gap, cy); ctx.lineTo(cx - gap - len, cy); ctx.stroke();
    // 右
    ctx.beginPath(); ctx.moveTo(cx + gap, cy); ctx.lineTo(cx + gap + len, cy); ctx.stroke();
    // 中心点
    ctx.beginPath(); ctx.arc(cx, cy, 1.4 * k, 0, Math.PI * 2); ctx.fill();

    // 定位测试的命中反馈：短暂的 X 形命中标记
    if (this.mode === 'target' && this.hitFlashTime > 0 && (now - this.hitFlashTime) < 200) {
      var a = 8 * k, b = 14 * k;
      ctx.strokeStyle = this.hitFlashOk ? '#48C78E' : '#FF4655';
      ctx.lineWidth = Math.max(2, 2 * k);
      ctx.beginPath();
      ctx.moveTo(cx - b, cy - b); ctx.lineTo(cx - a, cy - a);
      ctx.moveTo(cx + b, cy - b); ctx.lineTo(cx + a, cy - a);
      ctx.moveTo(cx - b, cy + b); ctx.lineTo(cx - a, cy + a);
      ctx.moveTo(cx + b, cy + b); ctx.lineTo(cx + a, cy + a);
      ctx.stroke();
    }
    ctx.restore();
  };

  /** 暗角（vignette），让画面中心更聚焦。渐变按尺寸缓存，避免每帧新建。 */
  VRangeTest.prototype._drawVignette = function () {
    var ctx = this.ctx;
    var w = this.w, h = this.h;

    if (!this._vignette) {
      var g = ctx.createRadialGradient(
        w / 2, h / 2, Math.min(w, h) * 0.34,
        w / 2, h / 2, Math.max(w, h) * 0.78
      );
      g.addColorStop(0, 'rgba(0,0,0,0)');
      // 只压一点点边缘：全屏时原来 0.42 的暗角会让整块屏幕显得"发黑"
      g.addColorStop(1, 'rgba(0,0,0,.26)');
      this._vignette = g;
    }
    ctx.fillStyle = this._vignette;
    ctx.fillRect(0, 0, w, h);
  };

  /**
   * 右侧俯仰刻度：上下观察时给出「当前抬头/低头多少度」的参考。
   * 水平方位由顶部罗盘负责，这条竖尺负责垂直方向，两者合起来就是完整的方位感知。
   */
  VRangeTest.prototype._drawPitchScale = function () {
    var ctx = this.ctx;
    var w = this.w, h = this.h;
    var x = w - 26;
    var top = 46, bottom = h - 46;
    if (bottom - top < 60) return;

    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.strokeStyle = 'rgba(236,232,225,.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();

    // 每 15° 一个刻度（0 与 ±45 加亮）
    for (var deg = -75; deg <= 75; deg += 15) {
      var ty = this.cy - (deg / 85) * ((bottom - top) / 2);
      if (ty < top || ty > bottom) continue;
      var major = (deg % 45 === 0);
      ctx.beginPath();
      ctx.moveTo(x - (major ? 7 : 4), ty);
      ctx.lineTo(x + (major ? 2 : 0), ty);
      ctx.strokeStyle = major ? 'rgba(255,70,85,.55)' : 'rgba(236,232,225,.20)';
      ctx.lineWidth = major ? 1.6 : 1;
      ctx.stroke();
      if (deg === 0) {
        ctx.fillStyle = 'rgba(236,232,225,.45)';
        ctx.font = '9px "Consolas", monospace';
        ctx.textAlign = 'right';
        ctx.fillText('0°', x - 10, ty + 3);
      }
    }

    // 当前俯仰指示块
    var py = this.cy - (clamp(this.pitch, -85, 85) / 85) * ((bottom - top) / 2);
    ctx.beginPath();
    ctx.moveTo(x - 9, py);
    ctx.lineTo(x + 3, py - 5);
    ctx.lineTo(x + 3, py + 5);
    ctx.closePath();
    ctx.fillStyle = '#FF4655';
    ctx.fill();
    ctx.restore();
  };

  /* ============================ 销毁 ============================ */
  VRangeTest.prototype.destroy = function () {
    this._destroyed = true;
    if (this.drill) this.abortDrill('destroy');
    if (this._rafId) window.cancelAnimationFrame(this._rafId);

    var c = this.canvas;
    c.removeEventListener('mousemove', this._onMouseMove);
    c.removeEventListener('mousedown', this._onMouseDown);
    c.removeEventListener('click', this._onClick);
    c.removeEventListener('contextmenu', this._onContextMenu);
    window.removeEventListener('mouseup', this._onMouseUp);
    window.removeEventListener('blur', this._onBlur);
    document.removeEventListener('pointerlockchange', this._onPointerLockChange);
    document.removeEventListener('pointerlockerror', this._onPointerLockError);
    c.removeEventListener('touchstart', this._onTouchStart);
    c.removeEventListener('touchmove', this._onTouchMove);
    c.removeEventListener('touchend', this._onTouchEnd);
    if (this._ro) this._ro.disconnect();
    if (this._io) this._io.disconnect();
    if (this._onResize) window.removeEventListener('resize', this._onResize);

    if (this.locked) this.unlock();
  };

  return VRangeTest;
})();
