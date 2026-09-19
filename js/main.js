/* =============================================================================
 * main.js — UI 装配层
 * -----------------------------------------------------------------------------
 * 职责：
 *   1. 读取/校验输入框 → 调用 calc.js 计算 → 渲染结果区
 *   2. 渲染参考数据表格（来自 data.js）
 *   3. localStorage 自动保存 / 恢复 / 重置
 *   4. 创建并驱动 js/canvas.js 的测试画布（读数、提示、事件）
 * 不在此文件做任何数学计算，全部走 VCalc，保证公式只有一处实现。
 * ============================================================================= */

/* eslint-disable no-var */
(function () {
  'use strict';

  /* ========================== 1. 元素引用 ========================== */
  function $(id) { return document.getElementById(id); }

  var el = {
    // 输入
    dpi: $('dpi'),
    sens: $('sens'),
    sensSlider: $('sens-slider'),
    targetDpi: $('target-dpi'),
    dpiError: $('dpi-error'),
    sensError: $('sens-error'),
    targetDpiError: $('target-dpi-error'),
    // 按钮
    btnSave: $('btn-save'),
    btnReset: $('btn-reset'),
    btnRestore: $('btn-restore'),
    btnSensMinus: $('btn-sens-minus'),
    btnSensPlus: $('btn-sens-plus'),
    btnApplyConv: $('btn-apply-conv'),
    btnLock: $('btn-lock'),
    btnViewReset: $('btn-view-reset'),
    lockState: $('lock-state'),
    btnDismissNotice: $('btn-dismiss-notice'),
    // 结果
    outEdpi: $('out-edpi'),
    outFormula: $('out-formula'),
    outBand: $('out-band'),
    meterMarker: $('meter-marker'),
    outCm360: $('out-cm360'),
    outDegCm: $('out-degcm'),
    outCm180: $('out-cm180'),
    outCs2: $('out-cs2'),
    turnTable: $('turn-table'),
    outConvSens: $('out-conv-sens'),
    outConvEdpi: $('out-conv-edpi'),
    outConvNote: $('out-conv-note'),
    // 表格容器
    bandBody: $('band-table-body'),
    proBody: $('pro-table-body'),
    proSourceNote: $('pro-source-note'),
    // 画布
    canvas: $('range-canvas'),
    overlay: $('canvas-overlay'),
    overlayTitle: $('overlay-title'),
    overlayText: $('overlay-text'),
    hudMode: $('hud-mode'),
    hudYaw: $('hud-yaw'),
    hudPitch: $('hud-pitch'),
    hudDist: $('hud-dist'),
    hudExtraWrap: $('hud-extra-wrap'),
    hudExtra: $('hud-extra'),
    canvasTip: $('canvas-tip'),
    roDist: $('ro-dist'),
    roCounts: $('ro-counts'),
    roYaw: $('ro-yaw'),
    roMeasured: $('ro-measured'),
    roMeasuredSub: $('ro-measured-sub'),
    roHits: $('ro-hits'),
    roHitsSub: $('ro-hits-sub'),
    // 提示
    toastRegion: $('toast-region'),
    saveHint: $('save-hint'),
    // 测试流程
    btnFlow: $('btn-flow'),
    canvasWrap: $('canvas-wrap'),
    flowPanel: $('flow-panel'),
    flowCard: $('flow-card'),
    flowCountdown: $('flow-countdown'),
    flowCountdownNum: $('flow-countdown-num'),
    drillStrip: $('drill-strip'),
    drillStage: $('drill-stage'),
    drillSens: $('drill-sens'),
    drillEdpi: $('drill-edpi'),
    drillProgress: $('drill-progress'),
    // 测试入口卡片（设置项 + 开始按钮）
    flowPad: $('flow-pad'),
    flowLauncherCount: $('flow-launcher-count'),
    flowLauncherEst: $('flow-launcher-est'),
    flowLauncherNote: $('flow-launcher-note')
  };

  /* ========================== 2. 应用状态 ========================== */
  var state = {
    dpi: null,          // 合法时为正整数，否则 null
    sens: null,         // 合法时为数值，否则 null
    dpiText: '',        // 原始输入字符串
    sensText: '',
    targetDpi: null,
    lastSaved: null,    // 本次会话中「最近一次保存过的配置」，供恢复按钮使用
    saveTimer: 0
  };

  var DEFAULT_DPI = '800';
  var DEFAULT_SENS = '0.35';

  /* ========================== 3. 通用 UI 工具 ========================== */

  /** 轻提示（右下角浮层，2.6 秒后自动消失） */
  function toast(message, type) {
    if (!el.toastRegion) return;
    var node = document.createElement('div');
    node.className = 'toast' + (type === 'ok' ? ' is-ok' : '');
    node.textContent = message;
    el.toastRegion.appendChild(node);
    window.setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, 2600);
  }

  /**
   * 显示/隐藏某个输入框的错误提示。
   * @param {HTMLElement} node
   * @param {string} message 为空表示隐藏
   * @param {'error'|'warn'} [kind] error=红色错误，warn=黄色提示
   */
  function setError(node, message, kind) {
    if (!node) return;
    node.classList.toggle('is-warn', kind === 'warn');
    if (message) {
      node.textContent = message;
      node.hidden = false;
    } else {
      node.textContent = '';
      node.hidden = true;
    }
  }

  /** 更新输入框的合法/非法样式 */
  function markInput(input, ok, hasText) {
    if (!input) return;
    input.classList.toggle('is-invalid', !ok && !!hasText);
    input.classList.toggle('is-valid', ok && !!hasText);
  }

  /**
   * 让「常见值」快捷按钮反映当前输入值的高亮状态。
   * 注意选择器限定为 button，避免命中参考表格里同样带 data-dpi 的行。
   */
  function syncChips(attr, value) {
    var chips = document.querySelectorAll('button[' + attr + ']');
    for (var i = 0; i < chips.length; i++) {
      var v = chips[i].getAttribute(attr);
      chips[i].classList.toggle('is-active', value !== null && String(value) === v);
    }
  }

  /* ========================== 4. 参考表格渲染 ========================== */

  /** 由 eDPI 反算 cm/360：cm = 914.4 ÷ (eDPI × 0.07) */
  function cmFromEdpi(edpiValue) {
    return (360 * VCalc.CM_PER_INCH) / (edpiValue * VCalc.VALORANT_YAW_PER_COUNT);
  }

  /** 渲染 eDPI 区间参考表 */
  function renderBandTable() {
    if (!el.bandBody) return;
    var html = '';

    for (var i = 0; i < VCalc.BANDS.length; i++) {
      var band = VCalc.BANDS[i];
      var detail = V_DATA.bandDetails[band.key] || { label: band.label, traits: '', best: '' };

      // 区间文字
      var rangeText;
      if (band.min === 0) rangeText = '0 ~ ' + band.max;
      else if (band.max === Infinity) rangeText = band.min + ' 以上';
      else rangeText = band.min + ' ~ ' + band.max;

      // 对应 cm/360 区间（职业区间 200~400 单独高亮）
      var cmText;
      if (band.min === 0) cmText = '&gt; ' + VCalc.format(cmFromEdpi(band.max), 1) + ' cm';
      else if (band.max === Infinity) cmText = '&lt; ' + VCalc.format(cmFromEdpi(band.min), 1) + ' cm';
      else cmText = VCalc.format(cmFromEdpi(band.max), 1) + ' ~ ' + VCalc.format(cmFromEdpi(band.min), 1) + ' cm';

      var isPro = band.min === 200 || band.max === 400;
      html += '<tr data-band="' + band.key + '">' +
                '<td class="mono">' + rangeText + '</td>' +
                '<th scope="row">' + detail.label + (isPro ? ' ★' : '') + '</th>' +
                '<td class="mono">' + cmText + '</td>' +
                '<td>' + detail.traits + '<br><span class="help">适合：' + detail.best + '</span></td>' +
              '</tr>';
    }

    el.bandBody.innerHTML = html;
  }

  /** 渲染职业选手参考表（点击某一行可把该配置套用到输入框） */
  function renderProTable() {
    if (!el.proBody) return;
    var html = '';

    for (var i = 0; i < V_DATA.proRefs.length; i++) {
      var p = V_DATA.proRefs[i];
      var e = VCalc.edpi(p.dpi, p.sens);
      var cm = VCalc.cmPer360(p.dpi, p.sens);
      var name = p.name ? p.name : '（社区常见值）';
      var clickable = !!p.name;   // 只有真实选手配置才提供一键套用

      html += '<tr' + (clickable
                  ? ' class="is-clickable" data-dpi="' + p.dpi + '" data-sens="' + p.sens + '"' +
                    ' title="点击套用该配置：' + p.dpi + ' DPI × ' + p.sens + '"'
                  : '') + '>' +
                '<th scope="row">' + name + (p.note ? '<br><span class="help">' + p.note + '</span>' : '') + '</th>' +
                '<td class="mono">' + p.dpi + '</td>' +
                '<td class="mono">' + VCalc.formatSens(p.sens) + '</td>' +
                '<td class="mono">' + VCalc.format(e, 1) + '</td>' +
                '<td class="mono">' + VCalc.format(cm, 1) + ' cm</td>' +
              '</tr>';
    }

    el.proBody.innerHTML = html;
    if (el.proSourceNote) el.proSourceNote.textContent = V_DATA.proSourceNote;
  }

  /** 高亮当前 eDPI 所在的区间行 */
  function highlightBand(edpiValue) {
    if (!el.bandBody) return;
    var band = edpiValue === null ? { key: 'unknown' } : VCalc.classifyBand(edpiValue);
    var rows = el.bandBody.querySelectorAll('tr');
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.toggle('is-current', rows[i].getAttribute('data-band') === band.key);
    }
  }

  /* ========================== 5. 结果区渲染 ========================== */

  /** 把结果区恢复为「未计算」状态 */
  function renderEmptyResult() {
    el.outEdpi.textContent = '--';
    el.outFormula.textContent = 'EDPI = DPI × 游戏内灵敏度';
    el.outBand.textContent = '等待输入…';
    el.meterMarker.hidden = true;
    el.outCm360.textContent = '--';
    el.outDegCm.textContent = '--';
    el.outCm180.textContent = '--';
    el.outCs2.textContent = '--';
    if (el.turnTable) {
      var cells = el.turnTable.querySelectorAll('td[data-cell]');
      for (var i = 0; i < cells.length; i++) cells[i].textContent = '--';
    }
    highlightBand(null);
  }

  /**
   * 渲染全部计算结果。
   * @param {number} dpi
   * @param {number} sens
   */
  function renderResult(dpi, sens) {
    var r = VCalc.computeAll(dpi, sens);
    var bandDetail = V_DATA.bandDetails[r.band.key] || { label: r.band.label, traits: '' };

    /* --- EDPI 主数字与公式说明 --- */
    el.outEdpi.textContent = VCalc.format(r.edpi, 2);
    el.outFormula.textContent = dpi + ' DPI × ' + VCalc.formatSens(sens) + ' 灵敏度 = ' +
                                VCalc.format(r.edpi, 2) + ' eDPI';

    /* --- 档位徽标：说明相对职业区间的位置 --- */
    var relation;
    if (r.edpi < VCalc.PRO_BAND.min) {
      relation = '低于职业常见区间 ' + VCalc.PRO_BAND.min + '~' + VCalc.PRO_BAND.max + '（更稳、转身更慢）';
    } else if (r.edpi > VCalc.PRO_BAND.max) {
      relation = '高于职业常见区间 ' + VCalc.PRO_BAND.min + '~' + VCalc.PRO_BAND.max + '（更快、微调更难）';
    } else {
      relation = '位于职业常见区间 ' + VCalc.PRO_BAND.min + '~' + VCalc.PRO_BAND.max + ' 内';
    }
    el.outBand.textContent = '『' + bandDetail.label + '』 · ' + relation;

    /* --- 刻度条位置（0 ~ meterMax 映射到 0%~100%，超出则贴边） --- */
    var ratio = VCalc.clamp(r.edpi / V_DATA.meterMax, 0, 1);
    el.meterMarker.hidden = false;
    el.meterMarker.style.left = (ratio * 100) + '%';

    /* --- 关键指标 --- */
    el.outCm360.textContent = VCalc.format(r.cmPer360, 2);
    el.outDegCm.textContent = VCalc.format(r.degPerCm, 2);
    el.outCm180.textContent = VCalc.format(r.cm180, 2);
    el.outCs2.textContent = VCalc.format(r.sourceSens, 3);

    /* --- 转身距离表 --- */
    if (el.turnTable) {
      var map = { 45: r.cm45, 90: r.cm90, 180: r.cm180, 360: r.cmPer360 };
      var cells2 = el.turnTable.querySelectorAll('td[data-cell]');
      for (var i = 0; i < cells2.length; i++) {
        var key = cells2[i].getAttribute('data-cell');
        cells2[i].textContent = VCalc.format(map[key], 2) + ' cm';
      }
    }

    highlightBand(r.edpi);
    renderConversion();
  }

  /** 渲染灵敏度换算结果 */
  function renderConversion() {
    var ok = state.dpi !== null && state.sens !== null && state.targetDpi !== null;

    if (!ok) {
      el.outConvSens.textContent = '--';
      el.outConvEdpi.textContent = '--';
      el.btnApplyConv.hidden = true;
      el.outConvNote.textContent = state.targetDpi === null
        ? '填写「目标 DPI」后会自动算出等效灵敏度。'
        : '换算前后 eDPI 与 cm/360 完全一致，只有 DPI 和灵敏度这两个数字变了。';
      return;
    }

    var newSens = VCalc.sensForTargetDpi(state.dpi, state.sens, state.targetDpi);
    var newEdpi = VCalc.edpi(state.targetDpi, newSens);

    el.outConvSens.textContent = VCalc.formatSens(newSens);
    el.outConvEdpi.textContent = VCalc.format(newEdpi, 2) + ' eDPI';

    var cmBefore = VCalc.cmPer360(state.dpi, state.sens);
    var cmAfter = VCalc.cmPer360(state.targetDpi, newSens);
    el.outConvNote.textContent =
      '换算后 cm/360 = ' + VCalc.format(cmAfter, 2) + ' cm，与原来的 ' +
      VCalc.format(cmBefore, 2) + ' cm 一致（eDPI 不变）。';

    // 「套用」按钮：把 DPI 换成目标 DPI，并把灵敏度换成等效值
    if (state.targetDpi !== state.dpi) {
      el.btnApplyConv.hidden = false;
      el.btnApplyConv.textContent = '套用：DPI 改为 ' + state.targetDpi +
                                    '，灵敏度改为 ' + VCalc.formatSens(newSens);
    } else {
      el.btnApplyConv.hidden = true;
    }
  }

  /* ========================== 6. 校验与联动 ========================== */

  /** 同步滑块位置（滑块范围与输入框一致：0.01~10） */
  function syncSlider(value) {
    if (!el.sensSlider) return;
    if (value === null) return;
    el.sensSlider.value = String(VCalc.clamp(value, VCalc.SENS_MIN, VCalc.SENS_MAX));
  }

  /** 把画布参数与浮层状态同步到当前输入 */
  function syncCanvasConfig() {
    if (!range) return;

    // 测试流程进行中：画布灵敏度由流程控制（正在测某一档），
    // 这里只更新参数有效性，绝不覆盖流程设置的档位灵敏度。
    if (flow && flow.isRunning()) return;

    var ready = range.setConfig({ dpi: state.dpi, sens: state.sens });

    if (ready) {
      el.overlay.hidden = true;
    } else {
      el.overlay.hidden = false;
      var missing = [];
      if (state.dpi === null) missing.push('鼠标 DPI');
      if (state.sens === null) missing.push('游戏内灵敏度');
      el.overlayTitle.textContent = '请先填写：' + missing.join(' + ');
      el.overlayText.textContent = '需要有效的 DPI 与游戏内灵敏度，画布才能按真实比例换算转向角度。' +
                                   '（DPI 为正整数，灵敏度为 0.01~10 之间的数值）';
    }
  }

  /**
   * 主流程：读取输入 → 校验 → 渲染 → 保存
   * @param {boolean} [fromUser] 是否由用户操作触发（决定是否写 localStorage）
   */
  function recalc(fromUser) {
    state.dpiText = el.dpi.value.trim();
    state.sensText = el.sens.value.trim();
    var targetText = el.targetDpi ? el.targetDpi.value.trim() : '';

    /* ---- 校验 DPI ---- */
    var dpiRes = VCalc.parseDpi(state.dpiText);
    state.dpi = dpiRes.ok ? dpiRes.value : null;
    if (!dpiRes.ok) {
      setError(el.dpiError, dpiRes.error, 'error');
    } else if (dpiRes.warning) {
      // 合法但超出常见范围：给黄色提示，不阻止计算
      setError(el.dpiError, '提示：' + dpiRes.warning, 'warn');
    } else {
      setError(el.dpiError, null);
    }
    markInput(el.dpi, dpiRes.ok, state.dpiText !== '');

    /* ---- 校验灵敏度 ---- */
    var sensRes = VCalc.parseSens(state.sensText);
    state.sens = sensRes.ok ? sensRes.value : null;
    if (!sensRes.ok) {
      setError(el.sensError, sensRes.error, 'error');
    } else if (sensRes.warning) {
      setError(el.sensError, '提示：' + sensRes.warning, 'warn');
    } else {
      setError(el.sensError, null);
    }
    markInput(el.sens, sensRes.ok, state.sensText !== '');

    if (sensRes.ok) syncSlider(sensRes.value);

    /* ---- 校验目标 DPI（可为空） ---- */
    var targetRes = { ok: false, value: null, error: null };
    if (targetText !== '') {
      targetRes = VCalc.parseDpi(targetText);
      setError(el.targetDpiError, targetRes.error, 'error');
      state.targetDpi = targetRes.ok ? targetRes.value : null;
    } else {
      setError(el.targetDpiError, null);
      state.targetDpi = null;
    }
    markInput(el.targetDpi, targetRes.ok, targetText !== '');

    /* ---- 快捷按钮高亮 ---- */
    syncChips('data-dpi', state.dpi);
    syncChips('data-target-dpi', state.targetDpi);

    /* ---- 渲染结果 ---- */
    if (state.dpi !== null && state.sens !== null) {
      renderResult(state.dpi, state.sens);
    } else {
      renderEmptyResult();
      renderConversion();
    }

    /* ---- 同步测试画布 ---- */
    syncCanvasConfig();

    /* ---- 同步测试入口卡片（按钮可用性 / 档位数 / 预计用时） ---- */
    syncLauncherInfo();

    /* ---- 自动保存（仅在两个值都合法时写入，避免把半成品存进本地） ---- */
    if (state.dpi !== null && state.sens !== null) {
      scheduleSave();
    }
  }

  /** 防抖保存到 localStorage */
  function scheduleSave() {
    if (state.saveTimer) window.clearTimeout(state.saveTimer);
    state.saveTimer = window.setTimeout(function () {
      saveNow(false);
    }, 500);
  }

  /**
   * 立即保存。
   * @param {boolean} notify 是否弹出提示
   */
  function saveNow(notify) {
    if (state.dpi === null || state.sens === null) {
      if (notify) toast('请先填写有效的 DPI 与灵敏度', 'warn');
      return;
    }
    var ok = VStorage.save({
      dpi: String(state.dpi),
      sens: VCalc.formatSens(state.sens),
      targetDpi: state.targetDpi === null ? '' : String(state.targetDpi)
    });
    state.lastSaved = {
      dpi: String(state.dpi),
      sens: VCalc.formatSens(state.sens),
      targetDpi: state.targetDpi === null ? '' : String(state.targetDpi)
    };
    if (el.btnRestore) el.btnRestore.hidden = false;

    if (notify) {
      if (ok) toast('已保存到本机浏览器：' + state.dpi + ' DPI × ' + VCalc.formatSens(state.sens), 'ok');
      else toast('当前浏览器禁用了本地存储，配置仅本次有效', 'warn');
    }
  }

  /** 从存储恢复配置 */
  function restoreFrom(cfg, notify) {
    if (!cfg) return false;
    el.dpi.value = cfg.dpi || '';
    el.sens.value = cfg.sens || '';
    if (el.targetDpi) el.targetDpi.value = cfg.targetDpi || '';
    recalc(false);
    if (notify) toast('已恢复上次保存的配置', 'ok');
    return true;
  }

  /* ========================== 7. 事件绑定 ========================== */

  function bindInputs() {
    /* ---- 文本输入：实时校验与计算 ---- */
    el.dpi.addEventListener('input', function () { recalc(true); });
    el.sens.addEventListener('input', function () { recalc(true); });
    if (el.targetDpi) el.targetDpi.addEventListener('input', function () { recalc(true); });

    /* ---- 失焦时把合法值规范化（去掉前导 0 等） ---- */
    el.dpi.addEventListener('blur', function () {
      if (state.dpi !== null) el.dpi.value = String(state.dpi);
      recalc(false);
    });
    el.sens.addEventListener('blur', function () {
      if (state.sens !== null) el.sens.value = VCalc.formatSens(state.sens);
      recalc(false);
    });

    /* ---- 常见 DPI 快捷按钮（只取 button，避免命中参考表格的行） ---- */
    var dpiChips = document.querySelectorAll('button[data-dpi]');
    for (var i = 0; i < dpiChips.length; i++) {
      dpiChips[i].addEventListener('click', function () {
        el.dpi.value = this.getAttribute('data-dpi');
        recalc(true);
        saveNow(false);
      });
    }

    /* ---- 目标 DPI 快捷按钮 ---- */
    var targetChips = document.querySelectorAll('button[data-target-dpi]');
    for (var j = 0; j < targetChips.length; j++) {
      targetChips[j].addEventListener('click', function () {
        if (el.targetDpi) el.targetDpi.value = this.getAttribute('data-target-dpi');
        recalc(true);
      });
    }

    /* ---- 灵敏度滑块（与输入框双向同步） ---- */
    if (el.sensSlider) {
      el.sensSlider.addEventListener('input', function () {
        el.sens.value = VCalc.formatSens(Number(this.value));
        recalc(true);
      });
    }

    /* ---- 灵敏度微调按钮：步进 0.01 ---- */
    function stepSens(delta) {
      var base = state.sens !== null ? state.sens : 0.35;
      var next = VCalc.clamp(VCalc.roundTo(base + delta, 3), VCalc.SENS_MIN, VCalc.SENS_MAX);
      el.sens.value = VCalc.formatSens(next);
      recalc(true);
    }
    if (el.btnSensMinus) el.btnSensMinus.addEventListener('click', function () { stepSens(-0.01); });
    if (el.btnSensPlus) el.btnSensPlus.addEventListener('click', function () { stepSens(0.01); });

    /* ---- 保存 / 重置 / 恢复 ---- */
    if (el.btnSave) {
      el.btnSave.addEventListener('click', function () {
        if (state.saveTimer) window.clearTimeout(state.saveTimer);
        saveNow(true);
      });
    }

    if (el.btnReset) {
      el.btnReset.addEventListener('click', function () {
        el.dpi.value = '';
        el.sens.value = '';
        if (el.targetDpi) el.targetDpi.value = '';
        VStorage.clear();
        recalc(false);
        el.sensSlider.value = '0.35';
        toast('已清空输入，并删除浏览器中保存的配置', 'ok');
      });
    }

    if (el.btnRestore) {
      el.btnRestore.addEventListener('click', function () {
        if (!restoreFrom(state.lastSaved, true)) toast('没有可恢复的配置', 'warn');
      });
    }

    /* ---- 套用换算结果 ---- */
    if (el.btnApplyConv) {
      el.btnApplyConv.addEventListener('click', function () {
        if (state.dpi === null || state.sens === null || state.targetDpi === null) return;
        var newSens = VCalc.sensForTargetDpi(state.dpi, state.sens, state.targetDpi);
        el.dpi.value = String(state.targetDpi);
        el.sens.value = VCalc.formatSens(newSens);
        recalc(true);
        saveNow(false);
        toast('已套用：' + state.targetDpi + ' DPI × ' + VCalc.formatSens(newSens) +
              '（手感保持不变）', 'ok');
      });
    }

    /* ---- 职业选手表格：点击行套用配置 ---- */
    if (el.proBody) {
      el.proBody.addEventListener('click', function (ev) {
        var row = ev.target;
        while (row && row !== el.proBody && !(row.getAttribute && row.getAttribute('data-dpi'))) {
          row = row.parentNode;
        }
        if (!row || row === el.proBody || !row.getAttribute) return;
        el.dpi.value = row.getAttribute('data-dpi');
        el.sens.value = row.getAttribute('data-sens');
        recalc(true);
        saveNow(false);
        toast('已套用该参考配置', 'ok');
      });
    }

    /* ---- 小屏提示条 ---- */
    if (el.btnDismissNotice) {
      el.btnDismissNotice.addEventListener('click', function () {
        document.body.classList.add('notice-dismissed');
        try { window.sessionStorage.setItem('vst:notice-dismissed', '1'); } catch (e) { /* 忽略 */ }
      });
    }
  }

  /* ========================== 8. 测试画布装配 ========================== */

  var range = null;
  var flow = null;

  /** 各模式下的操作提示文案 */
  var MODE_TIP = {
    free: '按住鼠标左键拖动即可转向（上下左右都可以）；点「锁定鼠标」后可直接移动鼠标（无需按住），输入更接近游戏。',
    spin: '点击画布开始校准，然后朝一个方向匀速移动鼠标，直到转满 360°；中途往回转会扣进度。上下视角可以自由活动，不影响水平一圈的计量。',
    target: '把准星对准红色靶心后点击左键。靶子会出现在视野内任意位置（上下左右都有），需要同时控制水平与垂直两个方向。'
  };

  function setupCanvas() {
    if (!el.canvas || typeof VRangeTest === 'undefined') return;

    range = new VRangeTest(el.canvas, {
      // 画布读数同时喂给「手动模式读数区」与「测试流程实时读数条」
      onUpdate: function (snapshot, force) {
        updateReadouts(snapshot, force);
        if (flow) flow.onFrame(snapshot);
      },
      onEvent: handleCanvasEvent
    });

    setupTestFlow();

    /* ---- 模式切换 ---- */
    var modeBtns = document.querySelectorAll('.mode-btn');
    for (var i = 0; i < modeBtns.length; i++) {
      modeBtns[i].addEventListener('click', function () {
        var mode = this.getAttribute('data-mode');
        for (var k = 0; k < modeBtns.length; k++) modeBtns[k].classList.remove('is-active');
        this.classList.add('is-active');
        range.setMode(mode);
        el.canvasTip.textContent = MODE_TIP[mode] || '';
        el.canvasTip.classList.remove('is-warn');
        updateReadouts(range.getSnapshot(), true);
      });
    }

    /* ---- 点击画布：360° 校准模式下开始校准 ---- */
    el.canvas.addEventListener('click', function () {
      if (range.mode === 'spin' && !range.spinActive && !range.spinDone && range.isReady()) {
        range.startSpin();
      }
    });
    // 键盘可访问性：画布获得焦点后按空格/回车同样可以开始校准
    el.canvas.addEventListener('keydown', function (e) {
      if ((e.key === ' ' || e.key === 'Enter') && range.mode === 'spin' && range.isReady()) {
        e.preventDefault();
        range.startSpin();
      }
    });

    /* ---- 锁定鼠标 ---- */
    if (el.btnLock) el.btnLock.addEventListener('click', function () { range.toggleLock(); });

    /* ---- 重置视角 ---- */
    if (el.btnViewReset) {
      el.btnViewReset.addEventListener('click', function () {
        range.resetView();
        toast('已重置视角与测试数据', 'ok');
      });
    }
  }

  /** 处理画布事件（提示、说明） */
  function handleCanvasEvent(type, payload) {
    if (type === 'lockchange') {
      el.lockState.textContent = payload.locked ? '已锁定（按 Esc 解锁）' : '未锁定';
      el.btnLock.textContent = payload.locked ? '解除锁定（Esc）' : '锁定鼠标（推荐）';
      if (payload.locked) {
        toast('已锁定鼠标：直接左右移动鼠标即可转向，按 Esc 解锁', 'ok');
      }
    } else if (type === 'lockerror') {
      toast('浏览器拒绝了指针锁定，请改用「按住左键拖动」的方式测试', 'warn');
    } else if (type === 'lockunsupported') {
      toast('当前浏览器不支持指针锁定，请改用拖拽方式测试', 'warn');
    } else if (type === 'needconfig') {
      toast('请先填写有效的 DPI 与游戏内灵敏度', 'warn');
    } else if (type === 'spincomplete') {
      toast('360° 校准完成：本次用了 ' + VCalc.format(payload.cm360, 2) + ' cm，' +
            '用时 ' + VCalc.format(payload.elapsedMs / 1000, 2) + ' 秒', 'ok');
    }
    // 流程内的命中/超时反馈由流程自己的实时读数条呈现，这里不做处理
  }

  /* ========================== 8.1 灵敏度测试流程装配 ========================== */

  /** 创建流程控制器并接好与页面其余部分的联动 */
  function setupTestFlow() {
    if (typeof VTestFlow === 'undefined' || !el.flowPanel) return;

    flow = new VTestFlow({
      range: range,
      wrap: el.canvasWrap,
      panel: el.flowPanel,
      card: el.flowCard,
      countdownEl: el.flowCountdown,
      countdownNum: el.flowCountdownNum,
      strip: el.drillStrip,
      stripFields: {
        stage: el.drillStage,
        sens: el.drillSens,
        edpi: el.drillEdpi,
        progress: el.drillProgress
      },
      // 流程只读取当前配置，不直接改输入框
      getConfig: function () { return { dpi: state.dpi, sens: state.sens }; },
      // 「应用推荐」时把推荐灵敏度写回输入框，并立即重算 + 保存
      applySens: function (sens) {
        el.sens.value = VCalc.formatSens(sens);
        recalc(true);
        saveNow(false);
      },
      // 流程结束后把画布参数恢复成用户输入框里的值，并把模式复位到「自由转向」
      onFinish: function () {
        syncCanvasConfig();
        var btns = document.querySelectorAll('.mode-btn');
        for (var i = 0; i < btns.length; i++) {
          btns[i].classList.toggle('is-active', btns[i].getAttribute('data-mode') === 'free');
        }
        el.canvasTip.textContent = MODE_TIP.free;
      },
      // 完全关闭流程（已退出全屏）后，把手动模式重新收起，页面回到「只有测试入口」的干净状态
      onClose: function () {
        setManualModesOpen(false);
        syncCanvasConfig();
      },
      toast: toast
    });

    if (el.btnFlow) {
      el.btnFlow.addEventListener('click', function () {
        // 画布（含全屏目标元素）放在折叠的手动模式里：必须先展开，
        // 否则元素没有渲染盒子，requestFullscreen 会得到一个空白画面。
        setManualModesOpen(true);
        // 直接把入口卡片上的设置交给流程：点一下即进入全屏开跑，没有中间面板
        flow.startFromLauncher();
      });
    }

    // 测试强度单选 / 鼠标垫宽度：更新高亮与入口卡片上的「档位数 · 预计用时」
    var presetInputs = document.querySelectorAll('input[name="flow-preset"]');
    for (var pi = 0; pi < presetInputs.length; pi++) {
      presetInputs[pi].addEventListener('change', syncLauncherInfo);
    }
    if (el.flowPad) el.flowPad.addEventListener('input', syncLauncherInfo);
    syncLauncherInfo();
  }

  /**
   * 展开 / 收起「手动模式」折叠区。
   * 展开是为了让画布（以及全屏目标元素）真正参与渲染 —— 折叠状态下元素没有盒子，
   * 对它有 requestFullscreen 只会得到空白画面。
   */
  function setManualModesOpen(open) {
    var box = document.querySelector('.manual-modes');
    if (box) box.open = !!open;
  }

  /**
   * 同步测试入口卡片的状态：
   *   · 单选按钮的高亮
   *   · 「共 N 档 · 预计 X」文案
   *   · 参数无效时把开始按钮置灰并给出原因
   */
  function syncLauncherInfo() {
    var pills = document.querySelectorAll('.flow-pill');
    for (var i = 0; i < pills.length; i++) {
      var input = pills[i].querySelector('input');
      pills[i].classList.toggle('is-active', !!(input && input.checked));
    }

    var presetKey = 'normal';
    var checked = document.querySelector('input[name="flow-preset"]:checked');
    if (checked && checked.value) presetKey = checked.value;
    var preset = (typeof VTestFlow !== 'undefined' && VTestFlow.PRESETS[presetKey]) || null;

    if (preset) {
      if (el.flowLauncherCount) el.flowLauncherCount.textContent = String(preset.candidates);
      if (el.flowLauncherEst) el.flowLauncherEst.textContent = preset.est;
    }

    // 参数是否就绪：直接决定按钮可用性与提示
    var ready = state.dpi !== null && state.sens !== null;
    if (el.btnFlow) {
      el.btnFlow.disabled = !ready;
      el.btnFlow.title = ready ? '' : '请先填写有效的 DPI 与游戏内灵敏度';
    }
    if (el.flowLauncherNote) {
      el.flowLauncherNote.hidden = ready;
    }
  }

  /**
   * 把画布读数写到 DOM（由 canvas.js 以约 12Hz 回调，避免每帧写 DOM）
   * @param {Object} s 快照
   * @param {boolean} force 是否强制刷新（切换模式、重置时）
   */
  function updateReadouts(s, force) {
    void force;

    /* ---- 画布内 HUD ---- */
    el.hudMode.textContent = s.modeLabel;
    el.hudYaw.textContent = VCalc.format(s.yawHeading, 1) + '°';
    if (el.hudPitch) el.hudPitch.textContent = VCalc.format(s.pitch || 0, 1) + '°';
    el.hudDist.textContent = s.distCm === null ? '--' : VCalc.format(s.distCm, 1) + ' cm';

    if (s.mode === 'spin') {
      el.hudExtraWrap.hidden = false;
      el.hudExtra.textContent = VCalc.format(s.spinProgressDeg, 0) + '° / 360°';
    } else {
      el.hudExtraWrap.hidden = true;
    }

    /* ---- 画布下方读数 ---- */
    el.roDist.innerHTML = (s.distCm === null ? '--' : VCalc.format(s.distCm, 2)) + '<small>cm</small>';
    el.roCounts.textContent = Math.round(s.totalCountsX) + ' counts（Δcount 累计）';
    el.roYaw.innerHTML = VCalc.format(s.yaw, 1) + '<small>°</small>';

    /* 实测 cm/360：只在 360° 校准完成时有「真正测出来」的结果 */
    if (s.spinResult) {
      el.roMeasured.innerHTML = VCalc.format(s.spinResult.cm360, 2) + '<small>cm</small>';
      el.roMeasuredSub.textContent = '用时 ' + VCalc.format(s.spinResult.elapsedMs / 1000, 2) +
        ' 秒 · 理论值 ' + VCalc.format(s.spinResult.theoreticalCm, 2) +
        ' cm（偏差 ' + VCalc.format(s.spinResult.deviationPct, 2) + '%）';
    } else if (s.spinActive) {
      el.roMeasured.innerHTML = VCalc.format(s.spinCm, 2) + '<small>cm</small>';
      el.roMeasuredSub.textContent = '进行中：已转 ' + VCalc.format(s.spinProgressDeg, 0) +
        '° / 360°，继续同方向移动鼠标';
    } else {
      el.roMeasured.textContent = '--';
      el.roMeasuredSub.textContent = '切换到「360° 校准」并转满一圈';
    }

    /* 定位测试统计 */
    el.roHits.innerHTML = s.hits + '<small>次</small>';
    if (s.hits + s.misses > 0) {
      el.roHitsSub.textContent =
        '命中率 ' + VCalc.format((s.accuracy || 0) * 100, 0) + '% · 平均 ' +
        (s.avgHitMs === null ? '--' : VCalc.format(s.avgHitMs, 0) + ' ms') +
        ' · 最快 ' + (s.bestHitMs === null ? '--' : VCalc.format(s.bestHitMs, 0) + ' ms');
    } else {
      el.roHitsSub.textContent = '切换到「定位测试」模式';
    }
  }

  /* ========================== 9. 启动 ========================== */

  function boot() {
    renderBandTable();
    renderProTable();
    bindInputs();
    setupCanvas();

    /* ---- 恢复提示条状态 ---- */
    try {
      if (window.sessionStorage.getItem('vst:notice-dismissed') === '1') {
        document.body.classList.add('notice-dismissed');
      }
    } catch (e) { /* 忽略 */ }

    /* ---- 恢复本地保存的配置；没有则给一组常见默认值方便直接体验 ---- */
    var saved = VStorage.load();
    if (saved && (saved.dpi || saved.sens)) {
      state.lastSaved = saved;
      if (el.btnRestore) el.btnRestore.hidden = false;
      restoreFrom(saved, false);
      toast('已恢复上次保存的配置：' + (saved.dpi || '--') + ' DPI × ' + (saved.sens || '--'), 'ok');
    } else {
      el.dpi.value = DEFAULT_DPI;
      el.sens.value = DEFAULT_SENS;
      recalc(false);
    }

    /* ---- 存储可用性提示 ---- */
    if (!VStorage.available && el.saveHint) {
      el.saveHint.textContent = '当前浏览器禁用了本地存储（可能是无痕模式），配置无法长期保存。';
    }

    // 首次对齐一次读数
    if (range) updateReadouts(range.getSnapshot(), true);

    /* ---- 调试 / 自动化测试句柄 ----
     * 只在 URL 带 ?debug=1 时挂到 window 上，方便：
     *   · 控制台里手动调参（例如 VST.range.forcedVisible = true）
     *   · 端到端测试直接验证全屏相关的画布行为（渲染门控、尺寸重建、DPR 预算）
     * 正常访问时不会暴露任何东西。 */
    try {
      if (/(\?|&)debug=1(&|$)/.test(window.location.search)) {
        window.__vst = { range: range, flow: flow, version: 1 };
      }
    } catch (e) { /* 忽略 */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
