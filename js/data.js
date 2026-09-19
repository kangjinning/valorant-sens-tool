/* =============================================================================
 * data.js — 参考数据（唯一需要人工维护的数据文件）
 * -----------------------------------------------------------------------------
 * 说明：
 *   1. 所有参考值都是「公开资料汇总 + 社区经验」，不是官方标准，仅供起步参考。
 *   2. 如需增删职业选手参考值，只改本文件的 proRefs 数组即可，页面表格会自动渲染。
 *   3. 表格中的 cm/360 由 js/calc.js 的公式实时计算，不写死数字，避免公式与文档不一致。
 * ============================================================================= */

/* eslint-disable no-var */
var V_DATA = (function () {
  'use strict';

  /**
   * eDPI 区间详情。
   * key 必须与 js/calc.js 中 BANDS 的 key 一一对应；区间数字只在 calc.js 里定义一次。
   */
  var bandDetails = {
    'very-low': {
      label: '超低敏',
      traits: '微调最稳、压枪最好控，但转身极慢，需要很大的桌面/鼠标垫空间',
      best: '追求极致稳定的狙击手；桌面宽度 ≥ 60cm 的手臂流玩家'
    },
    'low': {
      label: '低敏',
      traits: '稳定性好、长距离跟枪不易过冲；180° 转身仍需要较宽空间',
      best: '手臂流玩家，习惯用大范围挥动做定位'
    },
    'mid': {
      label: '中敏（主流）',
      traits: '稳定性与转身速度平衡，职业选手最密集的区间（约 280 附近）',
      best: '绝大多数玩家的起步区间，推荐先从这里开始测'
    },
    'mid-high': {
      label: '中高敏',
      traits: '转身与甩枪更省力，仍能保持较好的小范围控制',
      best: '手腕流玩家、需要频繁转身清点的打法'
    },
    'high': {
      label: '高敏',
      traits: '转身非常快、依赖手腕操作；微调难度上升，容易过冲',
      best: '手腕流玩家、鼠标垫较小或桌面空间有限'
    },
    'very-high': {
      label: '极高敏',
      traits: '轻微手抖都会明显偏移准星，长时间稳定性差',
      best: '少见。除非桌面空间极小，否则不建议长期使用'
    }
  };

  /**
   * 职业选手参考值（带日期的公开资料）。
   * 数据来源：ProSettings 等公开选手设置站（2026-07 抓取核对）。
   * 注意：选手会随时修改设置，这里的数字只用于对比「量级」，不是推荐配置。
   */
  var proRefs = [
    { name: 'aspas',   dpi: 800,  sens: 0.37,  note: 'Leviatán 决斗者' },
    { name: 'zekken',  dpi: 1600, sens: 0.175, note: 'Sentinels 决斗者' },
    { name: 'Demon1',  dpi: 1600, sens: 0.1,   note: '低敏代表' },
    { name: '',        dpi: 800,  sens: 0.35,  note: '社区最常见的起步配置（非选手）' }
  ];

  /** 职业选手表格下方的来源与免责说明 */
  var proSourceNote =
    '数据为公开资料汇总（ProSettings 等，2026-07 核对），选手设置会随版本与个人习惯变化。' +
    '表格仅用于对比量级：可以看到 800 DPI × 0.35 与 1600 DPI × 0.175 的 eDPI 完全相同（280），' +
    '而 cs/360 也一样 —— 这正是 eDPI 的用途。';

  /**
   * eDPI 刻度条的显示范围（用于把当前值映射到 0~800 的进度条上）。
   * 超出 800 时标记会贴在右端。
   */
  var meterMax = 800;

  return {
    bandDetails: bandDetails,
    proRefs: proRefs,
    proSourceNote: proSourceNote,
    meterMax: meterMax
  };
})();

// Node.js 环境（一般不需要，仅为保持与 calc.js 一致的加载方式）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = V_DATA;
}
