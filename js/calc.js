/* =============================================================================
 * calc.js — 无畏契约灵敏度核心计算模块（纯函数，不依赖 DOM）
 * -----------------------------------------------------------------------------
 * 设计说明：
 *   本文件只做数学运算与输入校验，不触碰任何 DOM，因此可以：
 *     1. 在浏览器中通过 window.VCalc 使用；
 *     2. 在 Node.js 中通过 require('./calc.js') 直接做单元测试（见 tools/test-calc.js）。
 *   所有公式均标注来源与推导过程，便于核对。
 * ============================================================================= */

/* eslint-disable no-var */
(function () {
  'use strict';

  /* ---------------------------------------------------------------------------
   * 一、常量与官方换算系数
   * ------------------------------------------------------------------------- */

  /**
   * 无畏契约引擎的 yaw 系数：1 个鼠标 count（鼠标移动 1/DPI 英寸）在
   * 「灵敏度 = 1.0」时让视角水平旋转 0.07 度。
   *
   * 因此：每 count 旋转角度 = 0.07 × 游戏内灵敏度（度）
   *
   * 该系数与 CS 系列（0.022）不同，所以两游戏的「灵敏度」数值不能直接比较，
   * 必须通过 cm/360 或下文的换算比互相转换。
   */
  var VALORANT_YAW_PER_COUNT = 0.07;

  /** CS:GO / CS2 / Apex（Source 引擎）的 yaw 系数：0.022 度 / count / 灵敏度 */
  var SOURCE_YAW_PER_COUNT = 0.022;

  /** 1 英寸 = 2.54 厘米（把英寸换算成厘米用） */
  var CM_PER_INCH = 2.54;

  /** 输入合法区间 */
  var DPI_MIN = 1;
  var DPI_MAX = 100000;
  var SENS_MIN = 0.01;
  var SENS_MAX = 10;
  var SENS_MAX_DECIMALS = 3;   // 游戏内灵敏度最多 3 位小数（如 0.375）

  /** DPI 的「建议区间」：超出只给提示，不阻止计算（有些鼠标确实能以 12800 工作） */
  var DPI_SOFT_MIN = 100;
  var DPI_SOFT_MAX = 32000;

  /* ---------------------------------------------------------------------------
   * 二、输入校验
   * ------------------------------------------------------------------------- */

  /** 校验失败的统一返回结构 */
  function fail(message) {
    return { ok: false, value: null, error: message, warning: null };
  }

  /**
   * 校验鼠标 DPI：只允许正整数。
   * @param {string|number} raw 用户原始输入
   * @returns {{ok: boolean, value: (number|null), error: (string|null), warning: (string|null)}}
   */
  function parseDpi(raw) {
    var text = String(raw == null ? '' : raw).trim();

    if (text === '') {
      return fail('请输入鼠标 DPI');
    }
    // 只接受纯数字：排除 "-800"、"800.5"、"8e2"、"800dpi"、全角数字等
    if (!/^\d+$/.test(text)) {
      return fail('只能输入正整数，不能包含小数点、负号、字母或空格');
    }

    var value = Number(text);
    if (!isFinite(value) || Math.floor(value) !== value) {
      return fail('DPI 必须是整数');
    }
    if (value < DPI_MIN) {
      return fail('DPI 必须大于 0');
    }
    if (value > DPI_MAX) {
      return fail('DPI 超出上限（最大 ' + DPI_MAX + '）');
    }

    var warning = null;
    if (value < DPI_SOFT_MIN || value > DPI_SOFT_MAX) {
      warning = '该 DPI 超出常见鼠标范围（' + DPI_SOFT_MIN + '~' + DPI_SOFT_MAX +
                '），请确认没有填错。';
    }
    return { ok: true, value: value, error: null, warning: warning };
  }

  /**
   * 校验游戏内灵敏度：0.01 ~ 10 的数值，最多 3 位小数。
   * @param {string|number} raw
   * @returns {{ok: boolean, value: (number|null), error: (string|null), warning: (string|null)}}
   */
  function parseSens(raw) {
    var text = String(raw == null ? '' : raw).trim();

    if (text === '') {
      return fail('请输入游戏内灵敏度');
    }
    // 允许 "0.35"、".35"、".5"、"1"、"10"，最多 3 位小数；排除负号、字母、多余小数点
    if (!/^(\d+(\.\d{1,3})?|\.\d{1,3})$/.test(text)) {
      return fail('只能输入数字，且最多 ' + SENS_MAX_DECIMALS + ' 位小数（例如 0.375）');
    }

    var value = Number(text);
    if (!isFinite(value)) {
      return fail('灵敏度数值无效');
    }
    if (value < SENS_MIN - 1e-9) {
      return fail('灵敏度最小为 ' + SENS_MIN);
    }
    if (value > SENS_MAX + 1e-9) {
      return fail('灵敏度最大为 ' + SENS_MAX);
    }

    var warning = null;
    if (value > 3) {
      warning = '灵敏度大于 3 时 eDPI 通常已远超职业区间，注意确认是否填错。';
    }
    return { ok: true, value: value, error: null, warning: warning };
  }

  /* ---------------------------------------------------------------------------
   * 三、核心公式
   * ------------------------------------------------------------------------- */

  /**
   * EDPI（有效 DPI）—— 本工具的核心公式。
   *
   *   EDPI = 鼠标 DPI × 游戏内灵敏度
   *
   * 例：800 DPI × 0.35 = 280 eDPI
   *
   * @param {number} dpi
   * @param {number} sens
   * @returns {number}
   */
  function edpi(dpi, sens) {
    return dpi * sens;
  }

  /**
   * 每 1 个鼠标 count 让视角旋转的角度（度）。
   *   degPerCount = 0.07 × 灵敏度
   */
  function degPerCount(sens) {
    return VALORANT_YAW_PER_COUNT * sens;
  }

  /**
   * 转满 360° 需要的鼠标 count 数（与 DPI 无关，只取决于灵敏度）。
   *   countsPer360 = 360 ÷ (0.07 × 灵敏度)
   */
  function countsPer360(sens) {
    return 360 / degPerCount(sens);
  }

  /**
   * cm/360：角色转满一圈所需鼠标横向移动的厘米数。
   *
   * 推导：
   *   1) 转满一圈需要 counts = 360 ÷ (0.07 × 灵敏度) 个 count
   *   2) 1 count = 1/DPI 英寸  →  需要的英寸数 = counts ÷ DPI
   *   3) 换算成厘米：× 2.54
   *
   *   合并后：cm/360 = (360 × 2.54) ÷ (DPI × 灵敏度 × 0.07) = 914.4 ÷ (DPI × 灵敏度 × 0.07)
   *
   * 例：800 × 0.35 → 914.4 ÷ 19.6 ≈ 46.65 cm
   *
   * @param {number} dpi
   * @param {number} sens
   * @returns {number}
   */
  function cmPer360(dpi, sens) {
    return (360 * CM_PER_INCH) / (dpi * sens * VALORANT_YAW_PER_COUNT);
  }

  /**
   * 转动指定角度所需的鼠标移动距离（厘米）。
   *   cm = (角度 × 2.54) ÷ (DPI × 灵敏度 × 0.07)
   */
  function cmForTurn(degrees, dpi, sens) {
    return (degrees * CM_PER_INCH) / (dpi * sens * VALORANT_YAW_PER_COUNT);
  }

  /**
   * 鼠标每移动 1 厘米，视角转过的角度（度）—— cm/360 的倒数形式。
   *   degPerCm = (0.07 × DPI × 灵敏度) ÷ 2.54
   */
  function degPerCm(dpi, sens) {
    return (degPerCount(sens) * dpi) / CM_PER_INCH;
  }

  /**
   * 由鼠标位移（count 数）计算视角旋转角度（度）。
   *   yaw = counts × 0.07 × 灵敏度
   * 用于测试画布：直接使用鼠标原始 movementX，不做平滑与插值。
   */
  function yawFromCounts(counts, sens) {
    return counts * degPerCount(sens);
  }

  /**
   * 由鼠标位移（count 数）计算物理移动距离（厘米）。
   *   cm = counts ÷ DPI × 2.54
   */
  function cmFromCounts(counts, dpi) {
    return (counts / dpi) * CM_PER_INCH;
  }

  /** 由厘米反推 count 数：counts = cm ÷ 2.54 × DPI */
  function countsFromCm(cm, dpi) {
    return (cm / CM_PER_INCH) * dpi;
  }

  /**
   * 灵敏度换算：保持手法（cm/360 与 eDPI）不变，把当前 DPI/灵敏度
   * 换算成「目标 DPI」下应该使用的游戏内灵敏度。
   *
   * 推导：要求 DPI₁ × S₁ = DPI₂ × S₂（eDPI 相等）
   *   → S₂ = DPI₁ × S₁ ÷ DPI₂
   *
   * 例：800 DPI × 0.35 → 换到 1600 DPI，则 S₂ = 800 × 0.35 ÷ 1600 = 0.175
   */
  function sensForTargetDpi(curDpi, curSens, targetDpi) {
    return (curDpi * curSens) / targetDpi;
  }

  /** 反推 DPI：已知目标灵敏度，求该用多少 DPI 才能保持同样的 eDPI */
  function dpiForTargetSens(curDpi, curSens, targetSens) {
    return (curDpi * curSens) / targetSens;
  }

  /** 达到指定 eDPI 所需的游戏内灵敏度（DPI 固定时） */
  function sensForTargetEdpi(targetEdpi, dpi) {
    return targetEdpi / dpi;
  }

  /** 由目标 cm/360 反推所需 eDPI：eDPI = 914.4 ÷ (cm × 0.07) */
  function edpiForCm360(cm) {
    return (360 * CM_PER_INCH) / (cm * VALORANT_YAW_PER_COUNT);
  }

  /** 由目标 cm/360 与固定灵敏度反推所需 DPI */
  function dpiForCm360(cm, sens) {
    return (360 * CM_PER_INCH) / (cm * sens * VALORANT_YAW_PER_COUNT);
  }

  /* ---------------------------------------------------------------------------
   * 四、跨游戏换算（只做系数换算，不改变 eDPI 在本游戏内的含义）
   * ------------------------------------------------------------------------- */

  /**
   * 无畏契约灵敏度 → CS2 / Apex 等效灵敏度。
   *   两游戏每 count 转动角度相同即可：
   *   0.07 × sens_val = 0.022 × sens_cs  →  sens_cs = sens_val × (0.07 ÷ 0.022) ≈ sens_val × 3.1818
   */
  function toSourceSens(sens) {
    return sens * (VALORANT_YAW_PER_COUNT / SOURCE_YAW_PER_COUNT);
  }

  /** CS2 / Apex 灵敏度 → 无畏契约等效灵敏度（除以 3.1818） */
  function fromSourceSens(sens) {
    return sens * (SOURCE_YAW_PER_COUNT / VALORANT_YAW_PER_COUNT);
  }

  /* ---------------------------------------------------------------------------
   * 五、区间判定
   * ------------------------------------------------------------------------- */

  /**
   * eDPI 区间定义（社区经验值，来自公开资料汇总，用于给出「从哪开始试」的建议）。
   * 边界遵循 [min, max) 半开区间，避免重叠。
   */
  var BANDS = [
    { key: 'very-low',  min: 0,        max: 160,      label: '超低敏' },
    { key: 'low',       min: 160,      max: 240,      label: '低敏' },
    { key: 'mid',       min: 240,      max: 320,      label: '中敏（主流）' },
    { key: 'mid-high',  min: 320,      max: 400,      label: '中高敏' },
    { key: 'high',      min: 400,      max: 600,      label: '高敏' },
    { key: 'very-high', min: 600,      max: Infinity, label: '极高敏' }
  ];

  /** 职业选手最集中的参考区间（用于刻度条与文案高亮） */
  var PRO_BAND = { min: 200, max: 400 };

  /**
   * 判断 eDPI 落在哪个区间。
   * @param {number} value eDPI
   * @returns {{key:string,label:string,min:number,max:number}}
   */
  function classifyBand(value) {
    if (!isFinite(value) || value <= 0) {
      return { key: 'unknown', label: '未计算', min: 0, max: 0 };
    }
    for (var i = 0; i < BANDS.length; i++) {
      if (value >= BANDS[i].min && value < BANDS[i].max) {
        return BANDS[i];
      }
    }
    return BANDS[BANDS.length - 1];
  }

  /* ---------------------------------------------------------------------------
   * 六、数值格式化
   * ------------------------------------------------------------------------- */

  /** 四舍五入到指定小数位，返回数字 */
  function roundTo(value, decimals) {
    var factor = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
  }

  /**
   * 智能格式化：按数值大小自动选择小数位，避免出现 46.6530612244898 这种长串。
   * @param {number} value
   * @param {number} [maxDecimals=2]
   */
  function format(value, maxDecimals) {
    if (value == null || !isFinite(value)) return '--';
    var d = typeof maxDecimals === 'number' ? maxDecimals : 2;

    // 绝对值很大时不需要小数位
    if (Math.abs(value) >= 10000) d = 0;
    else if (Math.abs(value) >= 1000) d = Math.min(d, 1);

    var rounded = roundTo(value, d);
    // 去掉多余的尾随 0：0.350 → 0.35，280.00 → 280
    var text = rounded.toFixed(d);
    if (text.indexOf('.') !== -1) {
      text = text.replace(/0+$/, '').replace(/\.$/, '');
    }
    return text;
  }

  /** 输入框回填用：按精度输出灵敏度（最多 3 位小数，去掉尾随 0） */
  function formatSens(value) {
    return format(value, SENS_MAX_DECIMALS);
  }

  /** 限制数值到区间内 */
  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  /* ---------------------------------------------------------------------------
   * 七、一次性计算全部结果（供 main.js 与测试使用）
   * ------------------------------------------------------------------------- */

  /**
   * 汇总计算：输入合法的 dpi / sens，输出页面需要的全部数值。
   * @param {number} dpi
   * @param {number} sens
   */
  function computeAll(dpi, sens) {
    var counts360 = countsPer360(sens);
    return {
      edpi: edpi(dpi, sens),
      degPerCount: degPerCount(sens),
      countsPer360: counts360,
      cmPer360: cmPer360(dpi, sens),
      degPerCm: degPerCm(dpi, sens),
      cm90: cmForTurn(90, dpi, sens),
      cm180: cmForTurn(180, dpi, sens),
      cm45: cmForTurn(45, dpi, sens),
      sourceSens: toSourceSens(sens),
      band: classifyBand(edpi(dpi, sens))
    };
  }

  /* ---------------------------------------------------------------------------
   * 八、导出
   * ------------------------------------------------------------------------- */
  var api = {
    // 常量
    VALORANT_YAW_PER_COUNT: VALORANT_YAW_PER_COUNT,
    SOURCE_YAW_PER_COUNT: SOURCE_YAW_PER_COUNT,
    CM_PER_INCH: CM_PER_INCH,
    DPI_MIN: DPI_MIN,
    DPI_MAX: DPI_MAX,
    SENS_MIN: SENS_MIN,
    SENS_MAX: SENS_MAX,
    SENS_MAX_DECIMALS: SENS_MAX_DECIMALS,
    BANDS: BANDS,
    PRO_BAND: PRO_BAND,

    // 校验
    parseDpi: parseDpi,
    parseSens: parseSens,

    // 公式
    edpi: edpi,
    degPerCount: degPerCount,
    countsPer360: countsPer360,
    cmPer360: cmPer360,
    cmForTurn: cmForTurn,
    degPerCm: degPerCm,
    yawFromCounts: yawFromCounts,
    cmFromCounts: cmFromCounts,
    countsFromCm: countsFromCm,
    sensForTargetDpi: sensForTargetDpi,
    dpiForTargetSens: dpiForTargetSens,
    sensForTargetEdpi: sensForTargetEdpi,
    edpiForCm360: edpiForCm360,
    dpiForCm360: dpiForCm360,
    toSourceSens: toSourceSens,
    fromSourceSens: fromSourceSens,

    // 判定与格式化
    classifyBand: classifyBand,
    roundTo: roundTo,
    format: format,
    formatSens: formatSens,
    clamp: clamp,

    // 汇总
    computeAll: computeAll
  };

  // 浏览器环境
  if (typeof window !== 'undefined') {
    window.VCalc = api;
  }
  // Node.js 环境（用于单元测试）
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
