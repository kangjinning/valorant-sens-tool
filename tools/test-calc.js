/* =============================================================================
 * tools/test-calc.js — 计算模块单元测试（开发期验证用，部署时无需上传）
 * -----------------------------------------------------------------------------
 * 运行方式（Windows / Linux / macOS 均可，需已安装 Node.js 14+）：
 *     node tools/test-calc.js
 *
 * 校验目标：
 *   1. EDPI 公式严格符合无畏契约标准：EDPI = DPI × 游戏内灵敏度
 *   2. cm/360 公式与公开换算器（yaw = 0.07）结果一致
 *   3. 输入校验的边界行为正确
 *   4. 各公式之间自洽（counts→角度→厘米 互推一致）
 * ============================================================================= */

'use strict';

var VCalc = require('../js/calc.js');

/* ------------------------------ 极简断言器 ------------------------------ */
var passed = 0;
var failed = 0;

function check(name, actual, expected, tolerance) {
  var ok;
  if (typeof expected === 'number' && typeof tolerance === 'number') {
    ok = Math.abs(actual - expected) <= tolerance;
  } else {
    ok = actual === expected;
  }
  if (ok) {
    passed++;
    console.log('  ✓ ' + name);
  } else {
    failed++;
    console.log('  ✗ ' + name + '  期望: ' + expected + '  实际: ' + actual);
  }
}

function group(title) {
  console.log('\n' + title);
}

/* ============================ 1. EDPI 公式 ============================ */
group('1. EDPI = DPI × 游戏内灵敏度');
check('800 DPI × 0.35 = 280', VCalc.edpi(800, 0.35), 280, 1e-9);
check('1600 DPI × 0.175 = 280', VCalc.edpi(1600, 0.175), 280, 1e-9);
check('1600 DPI × 0.1 = 160', VCalc.edpi(1600, 0.1), 160, 1e-9);
check('800 DPI × 0.37 = 296', VCalc.edpi(800, 0.37), 296, 1e-9);
check('400 DPI × 1 = 400', VCalc.edpi(400, 1), 400, 1e-9);

/* ============================ 2. cm/360 公式 ============================
 * 参照公开换算器给出的锚点值（yaw = 0.07）：
 *   280 eDPI → 46.7 cm
 *   160 eDPI → 81.6 cm
 *   100 eDPI → 130.6 cm
 *   400 eDPI → 32.7 cm
 *   800 eDPI → 16.3 cm
 * ====================================================================== */
group('2. cm/360 = (360 × 2.54) ÷ (DPI × 灵敏度 × 0.07)');
check('800 × 0.35 → 46.65 cm', VCalc.cmPer360(800, 0.35), 46.65, 0.01);
check('1600 × 0.175 → 46.65 cm（eDPI 相同结果相同）', VCalc.cmPer360(1600, 0.175), 46.65, 0.01);
check('1600 × 0.1 → 81.6 cm', VCalc.cmPer360(1600, 0.1), 81.6, 0.05);
check('1600 × 0.0625 → 130.6 cm', VCalc.cmPer360(1600, 0.0625), 130.6, 0.05);
check('800 × 0.5 → 32.7 cm', VCalc.cmPer360(800, 0.5), 32.7, 0.05);
check('1600 × 0.5 → 16.3 cm', VCalc.cmPer360(1600, 0.5), 16.3, 0.05);

group('3. 转身距离与 cm/360 的倍数关系');
check('180° 距离 ≈ cm/360 的一半', VCalc.cmForTurn(180, 800, 0.35), VCalc.cmPer360(800, 0.35) / 2, 1e-9);
check('90° 距离 ≈ cm/360 的四分之一', VCalc.cmForTurn(90, 800, 0.35), VCalc.cmPer360(800, 0.35) / 4, 1e-9);

group('4. 每厘米转向角度与 cm/360 互为倒数');
var cm360 = VCalc.cmPer360(800, 0.35);
check('degPerCm × cmPer360 = 360', VCalc.degPerCm(800, 0.35) * cm360, 360, 1e-6);

group('5. 360° 所需 counts（与 DPI 无关）');
check('灵敏度 0.35 → 14693.88 counts', VCalc.countsPer360(0.35), 360 / (0.07 * 0.35), 1e-6);

/* ==================== 6. counts ↔ 角度 ↔ 厘米 自洽性 ====================
 * 这是测试画布赖以成立的核心一致性：鼠标走过「cm/360」这么长的距离，
 * 换算出的角度必须正好是 360°。
 * ==================================================================== */
group('6. 测试画布一致性：走完 cm/360 的距离 = 转满 360°');
var needCounts = VCalc.countsFromCm(cm360, 800);
check('cm → counts 再 → cm 还原', VCalc.cmFromCounts(needCounts, 800), cm360, 1e-9);
check('该 counts 对应的角度 = 360°', VCalc.yawFromCounts(needCounts, 0.35), 360, 1e-9);
check('countsPer360 与 countsFromCm 一致', VCalc.countsPer360(0.35), needCounts, 1e-6);

/* ============================ 7. 灵敏度换算 ============================ */
group('7. 灵敏度换算（保持 eDPI 不变）');
check('800×0.35 → 1600 DPI 用 0.175', VCalc.sensForTargetDpi(800, 0.35, 1600), 0.175, 1e-9);
check('换算前后 eDPI 相同', VCalc.edpi(1600, VCalc.sensForTargetDpi(800, 0.35, 1600)), 280, 1e-9);
check('换算前后 cm/360 相同',
  VCalc.cmPer360(1600, VCalc.sensForTargetDpi(800, 0.35, 1600)),
  VCalc.cmPer360(800, 0.35), 1e-9);
check('达到 280 eDPI 在 1600 DPI 下的灵敏度 = 0.175', VCalc.sensForTargetEdpi(280, 1600), 0.175, 1e-9);
check('反推 DPI：0.35→0.175 需要 1600 DPI', VCalc.dpiForTargetSens(800, 0.35, 0.175), 1600, 1e-9);

group('8. 由 cm/360 反推 eDPI / DPI');
check('46.6539 cm → 280 eDPI', VCalc.edpiForCm360(46.6539), 280, 0.05);
check('46.6539 cm + 灵敏度 0.35 → 800 DPI', VCalc.dpiForCm360(46.6539, 0.35), 800, 0.1);

/* ============================ 9. 跨游戏换算 ============================ */
group('9. CS2 / Apex 等效灵敏度（yaw 0.022）');
check('无畏契约 0.35 → CS2 1.1136', VCalc.toSourceSens(0.35), 0.35 * 0.07 / 0.022, 1e-9);
check('换算系数约为 3.1818', VCalc.VALORANT_YAW_PER_COUNT / VCalc.SOURCE_YAW_PER_COUNT, 3.1818, 0.0001);
check('双向换算可还原', VCalc.fromSourceSens(VCalc.toSourceSens(0.35)), 0.35, 1e-9);

/* ============================ 10. DPI 校验 ============================ */
group('10. DPI 输入校验（只允许正整数）');
check('800 合法', VCalc.parseDpi('800').ok, true);
check('800 的值正确', VCalc.parseDpi('800').value, 800);
check('带空格 " 800 " 合法', VCalc.parseDpi(' 800 ').ok, true);
check('小数 800.5 非法', VCalc.parseDpi('800.5').ok, false);
check('负数 -800 非法', VCalc.parseDpi('-800').ok, false);
check('科学计数法 1e3 非法', VCalc.parseDpi('1e3').ok, false);
check('字母 800dpi 非法', VCalc.parseDpi('800dpi').ok, false);
check('全角数字 ８００ 非法', VCalc.parseDpi('８００').ok, false);
check('0 非法', VCalc.parseDpi('0').ok, false);
check('空字符串非法', VCalc.parseDpi('').ok, false);
check('超出上限 100001 非法', VCalc.parseDpi('100001').ok, false);
check('过低 DPI 给出警告但不报错', VCalc.parseDpi('50').ok === true &&
      typeof VCalc.parseDpi('50').warning === 'string', true);
check('常见 800 无警告', VCalc.parseDpi('800').warning, null);

/* ============================ 11. 灵敏度校验 ============================ */
group('11. 灵敏度输入校验（0.01 ~ 10）');
check('0.35 合法', VCalc.parseSens('0.35').ok, true);
check('0.375 合法（3 位小数）', VCalc.parseSens('0.375').value, 0.375);
check('.5 合法（省略前导 0）', VCalc.parseSens('.5').value, 0.5);
check('下边界 0.01 合法', VCalc.parseSens('0.01').ok, true);
check('上边界 10 合法', VCalc.parseSens('10').ok, true);
check('0.001 非法（低于下限）', VCalc.parseSens('0.001').ok, false);
check('0.0001 非法（4 位小数）', VCalc.parseSens('0.0001').ok, false);
check('10.1 非法（超上限）', VCalc.parseSens('10.1').ok, false);
check('0 非法', VCalc.parseSens('0').ok, false);
check('负数 -0.5 非法', VCalc.parseSens('-0.5').ok, false);
check('字母 abc 非法', VCalc.parseSens('abc').ok, false);
check('空字符串非法', VCalc.parseSens('').ok, false);
check('1.5.2 非法', VCalc.parseSens('1.5.2').ok, false);

/* ============================ 12. 区间判定 ============================ */
group('12. eDPI 区间判定（半开区间，边界不重叠）');
check('140 → very-low', VCalc.classifyBand(140).key, 'very-low');
check('160 → low（下边界归入本区间）', VCalc.classifyBand(160).key, 'low');
check('239 → low', VCalc.classifyBand(239).key, 'low');
check('280 → mid（主流区间）', VCalc.classifyBand(280).key, 'mid');
check('320 → mid-high', VCalc.classifyBand(320).key, 'mid-high');
check('400 → high', VCalc.classifyBand(400).key, 'high');
check('600 → very-high', VCalc.classifyBand(600).key, 'very-high');
check('2000 → very-high', VCalc.classifyBand(2000).key, 'very-high');
check('0 → unknown', VCalc.classifyBand(0).key, 'unknown');
check('职业区间常量正确', VCalc.PRO_BAND.min === 200 && VCalc.PRO_BAND.max === 400, true);

/* ============================ 13. 格式化 ============================ */
group('13. 数值格式化（避免出现超长小数）');
check('46.6530612 → "46.65"', VCalc.format(46.6530612, 2), '46.65');
check('280 → "280"（不留 .00）', VCalc.format(280, 2), '280');
check('0.175 → "0.175"', VCalc.format(0.175, 3), '0.175');
check('0.350 → "0.35"', VCalc.format(0.35, 3), '0.35');
check('14693.87 → "14694"（大数不留小数）', VCalc.format(14693.877, 2), '14694');
check('null → "--"', VCalc.format(null, 2), '--');

/* ============================ 14. 汇总函数 ============================ */
group('14. computeAll 汇总一致性');
var all = VCalc.computeAll(800, 0.35);
check('edpi = 280', all.edpi, 280, 1e-9);
check('cmPer360 = 46.65', all.cmPer360, 46.65, 0.01);
check('band = mid', all.band.key, 'mid');
check('cs2 = 1.1136', all.sourceSens, 1.1136, 0.0001);

/* ============================ 结果汇总 ============================ */
console.log('\n' + '='.repeat(52));
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
console.log('='.repeat(52));

process.exit(failed === 0 ? 0 : 1);
