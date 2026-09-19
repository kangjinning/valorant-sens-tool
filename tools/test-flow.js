/* =============================================================================
 * tools/test-flow.js — 测试流程模块单元测试（开发期验证用，部署时无需上传）
 * -----------------------------------------------------------------------------
 * 运行：node tools/test-flow.js
 *
 * 校验对象是 js/testflow.js 里与 DOM 无关的纯逻辑：
 *   1. 候选灵敏度档位的生成（含边界裁剪与去重）
 *   2. 甩枪靶角度序列（左右交替、幅度在合理区间）
 *   3. 四项指标的归一化与加权评分方向是否正确
 *   4. 「差异不显著」的判定是否能如实触发
 * ============================================================================= */

'use strict';

// testflow.js 内部使用全局的 VCalc，这里先注入
global.VCalc = require('../js/calc.js');
var VTestFlow = require('../js/testflow.js');

var passed = 0, failed = 0;

function check(name, actual, expected, tol) {
  var ok;
  if (typeof expected === 'number' && typeof tol === 'number') {
    ok = Math.abs(actual - expected) <= tol;
  } else {
    ok = actual === expected;
  }
  if (ok) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + '  期望: ' + expected + '  实际: ' + actual); }
}
function group(t) { console.log('\n' + t); }
function ok(name, cond, detail) { check(name + (detail ? '  [' + detail + ']' : ''), !!cond, true); }

/* ===================== 1. 候选档位生成 ===================== */
group('1. 候选灵敏度档位生成');
var c5 = VTestFlow.buildCandidates(0.35, 5);
check('生成 5 个档位', c5.length, 5);
ok('包含当前灵敏度 0.35', c5.indexOf(0.35) !== -1, c5.join(' / '));
ok('全部在 0.01~10 之间', c5.every(function (v) { return v >= 0.01 && v <= 10; }), c5.join(' / '));
ok('按升序排列（倍数表即升序）',
   c5.every(function (v, i) { return i === 0 || v > c5[i - 1]; }), c5.join(' / '));
ok('最低档低于当前值、最高档高于当前值', c5[0] < 0.35 && c5[c5.length - 1] > 0.35);

var c3 = VTestFlow.buildCandidates(0.35, 3);
check('3 档模式生成 3 个', c3.length, 3);
var c7 = VTestFlow.buildCandidates(0.35, 7);
check('7 档模式生成 7 个', c7.length, 7);

group('2. 边界情况（贴着 10 或 0.01）');
var cHigh = VTestFlow.buildCandidates(10, 5);
ok('灵敏度 10 时所有档位仍 ≤ 10', cHigh.every(function (v) { return v <= 10; }), cHigh.join(' / '));
ok('灵敏度 10 时至少还有 2 个可用档位', cHigh.length >= 2, String(cHigh.length));
var cLow = VTestFlow.buildCandidates(0.01, 5);
ok('灵敏度 0.01 时所有档位仍 ≥ 0.01', cLow.every(function (v) { return v >= 0.01; }), cLow.join(' / '));
ok('灵敏度 0.01 时至少还有 2 个可用档位', cLow.length >= 2, String(cLow.length));

/* ===================== 3. 甩枪偏移序列 ===================== */
group('3. 甩枪靶偏移序列（水平 + 垂直二维）');
var offs = VTestFlow.buildFlickOffsets(6);
check('生成 6 个偏移', offs.length, 6);
ok('每个偏移都是 {az, el} 对象',
   offs.every(function (o) { return typeof o === 'object' && typeof o.az === 'number' && typeof o.el === 'number'; }),
   JSON.stringify(offs[0]));
ok('水平偏移都在 ±35° 以内（保证靶子在视野内，不用盲拖）',
   offs.every(function (o) { return Math.abs(o.az) <= 35; }),
   offs.map(function (o) { return o.az; }).join(' / '));
ok('水平偏移都不小于 8°（否则太近、测不出甩枪）',
   offs.every(function (o) { return Math.abs(o.az) >= 8; }),
   offs.map(function (o) { return o.az; }).join(' / '));
ok('垂直偏移都在 ±12° 以内（垂直 FOV 约 ±33°，必须可见）',
   offs.every(function (o) { return Math.abs(o.el) <= 12; }),
   offs.map(function (o) { return o.el; }).join(' / '));

var azSignChanges = 0;
for (var i = 1; i < offs.length; i++) if ((offs[i].az > 0) !== (offs[i - 1].az > 0)) azSignChanges++;
ok('水平方向存在左右交替（避免形成单向肌肉记忆）', azSignChanges >= 2, '换向 ' + azSignChanges + ' 次');

var ups = offs.filter(function (o) { return o.el > 0; }).length;
var downs = offs.filter(function (o) { return o.el < 0; }).length;
var flats = offs.filter(function (o) { return o.el === 0; }).length;
ok('垂直方向同时覆盖「上」「下」「水平」三种情况（上下左右都能测到）',
   ups > 0 && downs > 0, '上 ' + ups + ' / 下 ' + downs + ' / 水平 ' + flats);

var offsLong = VTestFlow.buildFlickOffsets(8);
ok('8 个靶时上下覆盖依然成立',
   offsLong.filter(function (o) { return o.el > 0; }).length > 0 &&
   offsLong.filter(function (o) { return o.el < 0; }).length > 0,
   offsLong.map(function (o) { return o.el; }).join(' / '));

/* ===================== 4. 评分方向 ===================== */
group('4. 评分：各指标方向必须正确');

/** 构造一行成绩 */
function row(sens, hitRate, avgMs, pathRatio, onTargetPct) {
  return {
    sens: sens,
    dpi: 800,
    edpi: 800 * sens,
    cm360: 0,
    flick: { hitRate: hitRate, avgMs: avgMs, pathRatio: pathRatio, hits: 6, total: 6 },
    track: { onTargetPct: onTargetPct }
  };
}

// A：又快又准又稳；B：全面更差 → A 必须胜出
var rows = [
  row(0.30, 1.00, 400, 1.05, 80),
  row(0.40, 0.50, 800, 1.60, 40)
];
VTestFlow.scoreRows(rows);
var a = rows[0], b = rows[1];
ok('命中率高的分数更高', a.norm_flickHitRate > b.norm_flickHitRate,
   a.norm_flickHitRate.toFixed(2) + ' vs ' + b.norm_flickHitRate.toFixed(2));
ok('平均耗时短的分数更高（速度指标方向正确）', a.norm_flickSpeed > b.norm_flickSpeed,
   a.norm_flickSpeed.toFixed(2) + ' vs ' + b.norm_flickSpeed.toFixed(2));
ok('路径效率高的分数更高（过冲少者占优）', a.norm_pathScore > b.norm_pathScore,
   a.norm_pathScore.toFixed(2) + ' vs ' + b.norm_pathScore.toFixed(2));
ok('跟枪在靶率高的分数更高', a.norm_trackScore > b.norm_trackScore,
   a.norm_trackScore.toFixed(2) + ' vs ' + b.norm_trackScore.toFixed(2));
ok('全面更好的 A 综合分更高', a.score > b.score, a.score.toFixed(1) + ' vs ' + b.score.toFixed(1));

group('5. 评分：权重与量程');
check('最好的档位总分 = 100（四项归一化后全为 1）', Math.round(a.score), 100, 0.01);
check('最差的档位总分 = 0（四项归一化后全为 0）', Math.round(b.score), 0, 0.01);
var wsum = VTestFlow.METRIC_DEFS.reduce(function (s, d) { return s + d.weight; }, 0);
check('四项权重之和 = 1.0', wsum, 1, 1e-9);

group('6. 评分：所有档位相同时不得制造虚假差异');
var tie = [
  row(0.30, 0.8, 500, 1.2, 60),
  row(0.35, 0.8, 500, 1.2, 60),
  row(0.40, 0.8, 500, 1.2, 60)
];
VTestFlow.scoreRows(tie);
ok('完全相同 → 三档同分', tie[0].score === tie[1].score && tie[1].score === tie[2].score,
   tie.map(function (r) { return r.score.toFixed(1); }).join(' / '));
check('相同档位得中性分 50', Math.round(tie[0].score), 50, 0.01);
ok('分差为 0 → 低于显著阈值（应提示「无显著差异」）',
   (tie[0].score - tie[1].score) < VTestFlow.SIGNIFICANT_SPREAD);

group('7. 评分：一个靶都没命中时不能崩溃');
var noHit = [
  row(0.30, 0, null, null, 30),
  row(0.40, 0.67, 600, 1.1, 70)
];
VTestFlow.scoreRows(noHit);
ok('未命中档位的速度为最差', noHit[0].norm_flickSpeed === 0, String(noHit[0].norm_flickSpeed));
ok('未命中档位分数低于正常档位', noHit[0].score < noHit[1].score,
   noHit[0].score.toFixed(1) + ' vs ' + noHit[1].score.toFixed(1));
ok('分数均为有限数值', isFinite(noHit[0].score) && isFinite(noHit[1].score));

group('8. 显著性阈值合理性');
ok('显著阈值在 3~6 分之间（过小会把噪声当结论，过大则永远不推荐）',
   VTestFlow.SIGNIFICANT_SPREAD >= 3 && VTestFlow.SIGNIFICANT_SPREAD <= 6,
   String(VTestFlow.SIGNIFICANT_SPREAD));

/* ===================== 9. 预设完整性 ===================== */
group('9. 预设参数完整性');
Object.keys(VTestFlow.PRESETS).forEach(function (k) {
  var p = VTestFlow.PRESETS[k];
  ok('预设 ' + k + ' 参数齐全且为正数',
     p.candidates >= 3 && p.flicks >= 3 && p.trackMs >= 3000 &&
     p.countdownMs >= 1000 && p.timeoutMs >= 1500,
     p.label + '：' + p.candidates + ' 档 / ' + p.flicks + ' 靶 / ' + p.trackMs + 'ms');
});

/* ============================ 汇总 ============================ */
console.log('\n' + '='.repeat(52));
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
console.log('='.repeat(52));
process.exit(failed === 0 ? 0 : 1);
