/* =============================================================================
 * tools/e2e/harness-test.js — 端到端交互测试脚本（开发期工具，部署时无需上传）
 * -----------------------------------------------------------------------------
 * 由 tools/e2e/run.js 注入到 index.html 副本中运行。它在真实浏览器引擎里：
 *   阶段一：用合成事件模拟用户操作（输入、快捷按钮、校验、换算、拖动鼠标、
 *           360° 校准、定位测试、重置/恢复），并做像素级画布渲染校验，
 *           最后写入一组可辨识的配置并刷新页面；
 *   阶段二：验证刷新后是否从 localStorage 正确恢复配置。
 * 断言结果既写入页面 #harness-output，也 POST 回 /report 供驱动脚本读取。
 * ============================================================================= */

(function () {
  'use strict';

  var results = [];
  var errors = [];
  var rafTicks = 0;

  /* rAF 探针：确认渲染循环是否真的在跑（headless 虚拟时间下可能被饿死） */
  (function tick() { rafTicks++; window.requestAnimationFrame(tick); })();

  window.addEventListener('error', function (e) {
    errors.push('window.onerror: ' + (e.message || e.error));
  });
  window.addEventListener('unhandledrejection', function (e) {
    errors.push('unhandledrejection: ' + e.reason);
  });

  function ok(name, cond, detail) {
    results.push((cond ? 'PASS' : 'FAIL') + ' :: ' + name + (detail ? '  [' + detail + ']' : ''));
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function $(id) { return document.getElementById(id); }
  function txt(id) { var n = $(id); return n ? n.textContent.trim() : '(missing #' + id + ')'; }
  function num(id) { return parseFloat(txt(id).replace(/[^\d.\-]/g, '')); }

  function setInput(input, value) {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /** 在画布上模拟一次「按住左键拖动 + 横向移动 movementX 个 counts」 */
  function dragX(counts, canvas) {
    canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 500, clientY: 300 }));
    canvas.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, clientX: 600, clientY: 300,
      movementX: counts, movementY: 0
    }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  }

  /**
   * 找到画面中「红色靶面」的像素中心（限制在画面中央区域，避开罗盘/俯仰尺等 HUD 元素）。
   * 用于验证「渲染出来的靶子位置」与「命中判定用的角度」是否一致。
   */
  function redCentroid(canvas) {
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height;
    // 排除 HUD 区域：顶部罗盘（前 34px）、右侧俯仰尺（右侧 45px）、底部进度条（最后 40px）
    var x0 = 0, x1 = W - 45;
    var y0 = 34, y1 = H - 40;
    var img = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    var w = x1 - x0;
    var sx = 0, sy = 0, n = 0;
    for (var y = 0; y < y1 - y0; y += 2) {
      for (var x = 0; x < w; x += 2) {
        var i = (y * w + x) * 4;
        var r = img[i], g = img[i + 1], b = img[i + 2];
        // 靶面的红是 #FF4655；墙面/罗盘的暗红达不到这个亮度
        if (r > 190 && g < 110 && b < 110) { sx += x0 + x; sy += y0 + y; n++; }
      }
    }
    return n > 0 ? { x: sx / n, y: sy / n, n: n, box: [x0, y0, x1, y1] } : null;
  }

  /**
   * 把「靶面像素中心相对准星的偏差」换算成角度（度）。
   * 画布的水平 FOV 固定为 103°，因此 focal = (W/2) / tan(51.5°)。
   */
  function pixelOffsetToDeg(canvas, centroid) {
    var focal = (canvas.width / 2) / Math.tan(51.5 * Math.PI / 180);
    var dx = Math.atan((centroid.x - canvas.width / 2) / focal) * 180 / Math.PI;
    var dy = Math.atan((centroid.y - canvas.height / 2) / focal) * 180 / Math.PI;
    return { dx: dx, dy: dy, deg: Math.sqrt(dx * dx + dy * dy) };
  }

  function clickMode(mode) {
    var btn = document.querySelector('.mode-btn[data-mode="' + mode + '"]');
    if (btn) btn.click();
    return !!btn;
  }

  /**
   * 展开 / 收起「手动模式」折叠区。
   * 画布在这个折叠区里：折叠状态下元素没有渲染盒子，既不会重绘，
   * getImageData 也读不到有效像素 —— 所有像素级断言都必须先展开它。
   */
  function setManualOpen(open) {
    var box = document.querySelector('.manual-modes');
    if (box) box.open = !!open;
  }

  /**
   * 采样画布像素，得到一个可比较的「画面指纹」。
   * 用于在无法查看截图时验证：画布确实绘制了内容、且会随视角旋转而变化。
   */
  function canvasStats(canvas) {
    var ctx = canvas.getContext('2d');
    var data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    var n = 0, red = 0, green = 0, sum = 0, hash = 0;
    var seen = {};

    // 每 13 个像素采样一次，兼顾速度与代表性
    for (var i = 0; i < data.length; i += 4 * 13) {
      var r = data[i], g = data[i + 1], b = data[i + 2];
      n++;
      sum += (r + g + b) / 3;
      if (r > 130 && r - g > 45 && r - b > 35) red++;
      if (g > 150 && g - r > 45 && g - b > 30) green++;
      seen[(r >> 4) + ',' + (g >> 4) + ',' + (b >> 4)] = 1;
      hash = (hash * 31 + r * 7 + g * 3 + b * 11) % 2147483647;
    }

    return {
      n: n,
      avg: n ? sum / n : 0,
      red: red,
      green: green,
      distinct: Object.keys(seen).length,
      hash: hash
    };
  }

  async function run() {
    var dpi = $('dpi'), sens = $('sens'), canvas = $('range-canvas');
    var wrap = $('canvas-wrap');
    var dpr = window.devicePixelRatio || 1;

    /* ---------- A. 首次加载的默认值 ---------- */
    await sleep(200);
    ok('A1 默认 DPI 预填为 800', dpi.value === '800', 'dpi=' + dpi.value);
    ok('A2 默认灵敏度预填为 0.35', sens.value === '0.35', 'sens=' + sens.value);
    ok('A3 默认 eDPI 计算结果 = 280', txt('out-edpi') === '280', txt('out-edpi'));
    ok('A4 默认 cm/360 = 46.65', txt('out-cm360') === '46.65', txt('out-cm360'));
    ok('A5 默认每厘米转向 = 7.72 度', txt('out-degcm') === '7.72', txt('out-degcm'));
    ok('A6 默认 180° 距离 = 23.33', txt('out-cm180') === '23.33', txt('out-cm180'));
    ok('A7 默认 CS2 等效灵敏度 ≈ 1.114', txt('out-cs2').indexOf('1.11') === 0, txt('out-cs2'));
    ok('A8 档位徽标包含「中敏」', txt('out-band').indexOf('中敏') !== -1, txt('out-band'));
    ok('A9 区间参考表渲染出 6 行', document.querySelectorAll('#band-table-body tr').length === 6,
       String(document.querySelectorAll('#band-table-body tr').length));
    ok('A10 职业选手表渲染出 ' + 4 + ' 行', document.querySelectorAll('#pro-table-body tr').length === 4,
       String(document.querySelectorAll('#pro-table-body tr').length));
    ok('A11 当前区间行被高亮', !!document.querySelector('#band-table-body tr.is-current[data-band="mid"]'));
    ok('A12 画布参数有效（浮层已隐藏）', $('canvas-overlay').hidden === true);
    ok('A13 刻度条标记已显示', $('meter-marker').hidden === false);
    ok('A14 360° 表格单元格有值', txt('turn-table').indexOf('46.65 cm') !== -1);

    /* ---------- B. 输入联动：把 DPI 换成 1600，灵敏度换成 0.175（eDPI 仍为 280） ---------- */
    setInput(dpi, '1600');
    setInput(sens, '0.175');
    await sleep(150);
    ok('B1 1600×0.175 的 eDPI 仍为 280', txt('out-edpi') === '280', txt('out-edpi'));
    ok('B2 cm/360 保持不变 = 46.65', txt('out-cm360') === '46.65', txt('out-cm360'));
    ok('B3 公式行包含 "1600 DPI × 0.175"', txt('out-formula').indexOf('1600 DPI') === 0, txt('out-formula'));

    /* ---------- C. DPI 快捷按钮 ---------- */
    document.querySelector('button[data-dpi="3200"]').click();
    await sleep(120);
    ok('C1 点击 3200 快捷按钮后输入框为 3200', dpi.value === '3200', dpi.value);
    ok('C2 该快捷按钮获得高亮', document.querySelector('button[data-dpi="3200"]').classList.contains('is-active'));
    ok('C3 eDPI 随之更新为 560', txt('out-edpi') === '560', txt('out-edpi'));

    /* ---------- D. 非法输入处理 ---------- */
    setInput(dpi, 'abc');
    await sleep(80);
    ok('D1 非数字 DPI 显示错误提示', $('dpi-error').hidden === false, txt('dpi-error'));
    ok('D2 非法输入时结果区回退为 --', txt('out-edpi') === '--', txt('out-edpi'));
    ok('D3 非法输入时画布浮层出现', $('canvas-overlay').hidden === false);
    setInput(dpi, '800.5');
    await sleep(80);
    ok('D4 小数 DPI 被拒绝', $('dpi-error').hidden === false, txt('dpi-error'));
    setInput(dpi, '-800');
    await sleep(80);
    ok('D5 负数 DPI 被拒绝', $('dpi-error').hidden === false, txt('dpi-error'));
    setInput(dpi, '800');
    setInput(sens, '0.35');
    await sleep(80);
    ok('D6 恢复合法 DPI 后错误消失', $('dpi-error').hidden === true);
    ok('D7 恢复后结果重新计算 = 280', txt('out-edpi') === '280', txt('out-edpi'));

    /* ---------- E. 灵敏度边界 ---------- */
    setInput(sens, '0.001');
    await sleep(80);
    ok('E1 灵敏度 0.001 被拒绝（低于 0.01）', $('sens-error').hidden === false, txt('sens-error'));
    setInput(sens, '11');
    await sleep(80);
    ok('E2 灵敏度 11 被拒绝（高于 10）', $('sens-error').hidden === false, txt('sens-error'));
    setInput(sens, '5');
    await sleep(80);
    // 灵敏度 5 合法，但会给出「超出常见范围」的黄色提示（不阻止计算）
    ok('E3 灵敏度 5 合法（仅黄色提示，不报错）',
       $('sens-error').hidden === true || $('sens-error').classList.contains('is-warn'),
       txt('sens-error'));
    ok('E3b 灵敏度 5 时仍能正常计算 eDPI',
       txt('out-edpi') !== '--',
       txt('out-edpi'));
    setInput(sens, '0.35');
    await sleep(80);

    /* ---------- F. 灵敏度滑块与微调按钮 ---------- */
    var slider = $('sens-slider');
    slider.value = '0.5';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(80);
    ok('F1 拖动滑块同步到输入框', sens.value === '0.5', sens.value);
    $('btn-sens-plus').click();
    await sleep(80);
    ok('F2 +0.01 微调生效', sens.value === '0.51', sens.value);
    $('btn-sens-minus').click();
    $('btn-sens-minus').click();
    await sleep(120);
    ok('F3 -0.01 微调生效（连点两次）', sens.value === '0.49', sens.value);
    setInput(sens, '0.35');
    await sleep(80);

    /* ---------- G. 灵敏度换算 ---------- */
    setInput($('target-dpi'), '1600');
    await sleep(120);
    ok('G1 目标 DPI 1600 的等效灵敏度 = 0.175', txt('out-conv-sens') === '0.175', txt('out-conv-sens'));
    ok('G2 换算后 eDPI 仍为 280', txt('out-conv-edpi').indexOf('280') === 0, txt('out-conv-edpi'));
    ok('G3 换算说明显示 cm/360 一致', txt('out-conv-note').indexOf('46.65') !== -1, txt('out-conv-note'));
    ok('G4 套用按钮文案包含目标 DPI', txt('btn-apply-conv').indexOf('1600') !== -1, txt('btn-apply-conv'));
    $('btn-apply-conv').click();
    await sleep(150);
    ok('G5 套用后 DPI 变为 1600', dpi.value === '1600', dpi.value);
    ok('G6 套用后灵敏度变为 0.175', sens.value === '0.175', sens.value);
    setInput(dpi, '800');
    setInput(sens, '0.35');
    setInput($('target-dpi'), '');
    await sleep(120);

    /* ---------- H. 测试画布：原始位移采样 ---------- */
    $('btn-view-reset').click();
    await sleep(150);
    dragX(1000, canvas);
    await sleep(200);
    // 800 DPI + 0.35 灵敏度：1000 counts → 1000 × 0.07 × 0.35 = 24.5°；1000/800×2.54 = 3.175 cm
    ok('H1 拖动 1000 counts → 转向 24.5°', Math.abs(num('ro-yaw') - 24.5) < 0.05, txt('ro-yaw'));
    ok('H2 拖动 1000 counts → 移动 3.18 cm', Math.abs(num('ro-dist') - 3.18) < 0.02, txt('ro-dist'));
    ok('H3 counts 读数正确', txt('ro-counts').indexOf('1000') === 0, txt('ro-counts'));
    ok('H4 HUD 显示换算后的转向角度', txt('hud-yaw').indexOf('24.5') === 0, txt('hud-yaw'));
    ok('H5 画布浮层在参数有效时保持隐藏', $('canvas-overlay').hidden === true);

    // 换灵敏度后，同样的位移应产生不同的角度（验证公式实时生效）
    setInput(sens, '0.7');
    await sleep(120);
    $('btn-view-reset').click();
    await sleep(150);
    dragX(1000, canvas);
    await sleep(200);
    ok('H6 灵敏度翻倍后同样位移转向 49°', Math.abs(num('ro-yaw') - 49) < 0.1, txt('ro-yaw'));
    ok('H7 物理移动距离与灵敏度无关（3.18 cm）', Math.abs(num('ro-dist') - 3.18) < 0.02, txt('ro-dist'));
    setInput(sens, '0.35');
    await sleep(120);

    /* ---------- H8/H9：垂直方向（上下观察）必须真实生效 ---------- */
    $('btn-view-reset').click();
    await sleep(150);
    canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 500, clientY: 300 }));
    canvas.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, clientX: 500, clientY: 400, movementX: 0, movementY: 500
    }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    await sleep(220);
    // 鼠标下移 500 counts → 视角向下：500 × 0.07 × 0.35 = 12.25°
    ok('H8 垂直鼠标输入改变俯仰角', Math.abs(num('hud-pitch')) > 1, txt('hud-pitch'));
    ok('H9 俯仰角严格等于公式值（-12.25°）',
       Math.abs(num('hud-pitch') + 12.25) < 0.15, txt('hud-pitch'));

    // 大幅度上下移动：俯仰应被夹紧在 ±85°，不会翻转
    canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 500, clientY: 300 }));
    canvas.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, clientX: 500, clientY: 900, movementX: 0, movementY: 9000
    }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    await sleep(220);
    ok('H10 大幅低头被夹紧在 -85°（画面不会翻转）',
       Math.abs(num('hud-pitch') + 85) < 0.5, txt('hud-pitch'));
    $('btn-view-reset').click();
    await sleep(150);
    ok('H11 重置视角后俯仰归零', Math.abs(num('hud-pitch')) < 0.01, txt('hud-pitch'));

    /* ---------- I. 360° 校准 ---------- */
    $('btn-view-reset').click();
    ok('I1 切换到 360° 校准模式', clickMode('spin'));
    await sleep(150);
    ok('I2 HUD 模式名已更新', txt('hud-mode') === '360° 校准', txt('hud-mode'));
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(150);
    dragX(5000, canvas);
    await sleep(150);
    var midProgress = txt('hud-extra');
    ok('I3 转动过程中显示进度', midProgress.indexOf('/ 360') !== -1, midProgress);
    ok('I4 5000 counts 进度约 122°', Math.abs(parseFloat(midProgress) - 122.5) < 1, midProgress);
    dragX(5000, canvas);
    dragX(5000, canvas);
    await sleep(250);
    var measured = num('ro-measured');
    // 15000 counts ÷ 800 DPI × 2.54 = 47.625 cm
    ok('I5 完成 360° 后实测距离 ≈ 47.63 cm', Math.abs(measured - 47.63) < 0.05, txt('ro-measured'));
    ok('I6 读数说明包含用时与理论值', txt('ro-measured-sub').indexOf('用时') === 0, txt('ro-measured-sub'));
    ok('I7 弹出了完成提示', document.querySelector('.toast') !== null, txt('toast-region'));

    /* ---------- J. 定位测试 ---------- */
    ok('J1 切换到定位测试模式', clickMode('target'));
    await sleep(200);
    ok('J2 HUD 模式名已更新', txt('hud-mode') === '定位测试', txt('hud-mode'));
    ok('J3 初始命中次数为 0', num('ro-hits') === 0, txt('ro-hits'));
    ok('J4 命中率提示显示', txt('ro-hits-sub').indexOf('定位测试') !== -1 || txt('ro-hits-sub').indexOf('命中率') !== -1,
       txt('ro-hits-sub'));
    // 朝一个方向大量移动后射击，至少不应抛异常
    dragX(3000, canvas);
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(200);
    ok('J5 射击后统计读数仍然正常', txt('ro-hits').indexOf('次') !== -1, txt('ro-hits'));

    /* ---------- K. 自由转向模式回归 ---------- */
    ok('K1 切回自由转向', clickMode('free'));
    await sleep(150);
    ok('K2 模式名恢复', txt('hud-mode') === '自由转向', txt('hud-mode'));

    /* ---------- G3/G4. 渲染与命中判定的一致性（瞄准即命中） ----------
     * 这是「上下左右都能测」能否成立的关键：
     *   渲染用三维投影，命中判定用球面角距离，两者必须描述同一个位置。
     *   若不一致，玩家瞄准了靶心却会判 miss —— 这种 bug 靠命中率测试发现不了，
     *   因为它对「所有档位」都一致地偏，只有把「像素位置」和「判定结果」直接对照才能抓到。
     *
     * 做法（在非零俯仰下进行，正是小角度近似会出错的区间）：
     *   1. 重置视角 → 抬头 15°（俯仰 15°）
     *   2. 读靶面像素中心 → 换算成交角 → 断言「偏了就必须 miss」
     *   3. 仅凭像素反馈闭环把准星移到靶心（夹角 < 0.7°）→ 断言「对准了必须 hit」
     * 两个方向都验证，才算证明渲染与判定一致。 */
    ok('G3-1 进入定位测试模式', clickMode('target'));
    await sleep(200);

    /* 画布在折叠的手动模式里：像素级断言前必须先展开，让它真正参与渲染。
     * 之后（Q 段之前）会重新收起，以保证「开始测试会自动展开折叠区」这条断言仍然有效。 */
    setManualOpen(true);
    await sleep(400);

    /* 重要：前面的 P 段测试把页面滚到了顶部，画布此时不在视口内，
     * IntersectionObserver 会按设计暂停重绘（省电）。若不先滚回来，
     * 下面读到的像素是「上一次可见时的旧画面」，像素与判定必然对不上。
     * 因此先重置视角并把画布滚回视口中央，等它重新开始渲染。 */
    $('btn-view-reset').click();
    await sleep(200);
    canvas.scrollIntoView({ block: 'center' });
    await sleep(600);

    var hashBeforePitch = canvasStats(canvas).hash;
    canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 500, clientY: 300 }));
    canvas.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, clientX: 500, clientY: 300, movementX: 0, movementY: -612   // ≈ 抬头 15°
    }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    await sleep(350);
    ok('G3-2 已进入非零俯仰（15° 附近）', Math.abs(num('hud-pitch') - 15) < 1.5, txt('hud-pitch'));
    ok('G3-2b 俯仰变化后画布确实重绘了（否则下面的像素断言无意义）',
       canvasStats(canvas).hash !== hashBeforePitch);

    // 步骤 2：像素说偏了 → 必须 miss
    var centroid = redCentroid(canvas);
    ok('G3-3 能在画面中定位到红色靶面像素', !!centroid && centroid.n > 30,
       centroid ? ('像素数 ' + centroid.n) : '未找到');

    if (centroid) {
      var pred = pixelOffsetToDeg(canvas, centroid);
      results.push('INFO :: G3 像素换算夹角 dx=' + pred.dx.toFixed(2) + '° dy=' + pred.dy.toFixed(2) +
        '° 合成 ' + pred.deg.toFixed(2) + '°（俯仰 ' + txt('hud-pitch') + '，靶面像素 ' + centroid.n + '）');

      var hitsBefore = num('ro-hits');
      canvas.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(200);
      var didHit = num('ro-hits') > hitsBefore;

      if (pred.deg > 2.6) {
        ok('G3-4 像素显示「偏离靶心」→ 点击确实未命中',
           !didHit, '像素夹角 ' + pred.deg.toFixed(2) + '°');
      } else {
        results.push('INFO :: G3-4 像素夹角仅 ' + pred.deg.toFixed(2) +
          '°，无法用来验证「偏离→miss」，跳过该断言');
      }
    }

    // 步骤 3：闭环瞄准 → 必须 hit
    var aimOk = false, aimDeg = null;
    for (var it = 0; it < 7; it++) {
      var c2 = redCentroid(canvas);
      if (!c2) break;
      var off2 = pixelOffsetToDeg(canvas, c2);
      aimDeg = off2.deg;
      if (off2.deg < 0.7) { aimOk = true; break; }
      // 需要的鼠标 counts：水平 = Δ角度 ÷ (0.07×灵敏度)；垂直方向符号相反（下移鼠标 = 低头）
      var dPerCount = 0.07 * parseFloat(sens.value);
      canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 500, clientY: 300 }));
      canvas.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, clientX: 500, clientY: 300,
        movementX: off2.dx / dPerCount, movementY: off2.dy / dPerCount
      }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
      await sleep(120);
    }
    ok('G4-1 仅凭像素反馈即可把准星移到靶心（夹角 < 0.7°）', aimOk,
       aimDeg === null ? '未找到靶面' : ('夹角 ' + aimDeg.toFixed(2) + '°'));

    if (aimOk) {
      var hitsB = num('ro-hits');
      canvas.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(200);
      ok('G4-2 像素显示已对准靶心 → 点击确实命中（渲染与判定一致）',
         num('ro-hits') > hitsB, txt('ro-hits'));
    }
    clickMode('free');
    await sleep(120);

    /* ---------- L. 重置与恢复 ---------- */
    $('btn-save').click();
    await sleep(200);
    $('btn-reset').click();
    await sleep(200);
    ok('L1 重置后 DPI 输入为空', dpi.value === '', '"' + dpi.value + '"');
    ok('L2 重置后灵敏度输入为空', sens.value === '', '"' + sens.value + '"');
    ok('L3 重置后结果区为 --', txt('out-edpi') === '--', txt('out-edpi'));
    ok('L4 重置后画布浮层出现', $('canvas-overlay').hidden === false);
    ok('L5 重置后「恢复上次保存」按钮可见', $('btn-restore').hidden === false);
    $('btn-restore').click();
    await sleep(200);
    ok('L6 恢复成功（eDPI = 280）', txt('out-edpi') === '280', txt('out-edpi') + ' / dpi=' + dpi.value + ' sens=' + sens.value);

    /* ---------- M. 职业选手行点击套用 ---------- */
    var proRow = document.querySelector('#pro-table-body tr.is-clickable[data-dpi]');
    if (proRow) proRow.click();
    await sleep(200);
    ok('M1 点击职业选手行可套用配置', dpi.value === proRow.getAttribute('data-dpi') &&
       sens.value === proRow.getAttribute('data-sens'),
       dpi.value + ' × ' + sens.value);

    /* ---------- N. 无脚本错误 ---------- */
    ok('N1 运行期间没有 JS 错误', errors.length === 0, errors.join(' | '));
    ok('N2 requestAnimationFrame 渲染循环在运行', rafTicks > 5, 'ticks=' + rafTicks);

    /* ---------- O. 画布渲染的像素级验证（无法肉眼看截图时的替代手段） ---------- */
    canvas.scrollIntoView({ block: 'center' });
    await sleep(600);
    ok('O1 画布分辨率按 DPR 放大且比例正确',
       canvas.width >= 800 && Math.abs(canvas.width / canvas.height - 1200 / 620) < 0.03,
       canvas.width + 'x' + canvas.height);
    var s1 = canvasStats(canvas);
    ok('O2 画布已绘制内容（非纯黑空画布）', s1.avg > 8, 'avg亮度=' + s1.avg.toFixed(1));
    ok('O3 画面中存在红色靶位/装饰像素', s1.red > 0, 'red样本=' + s1.red);
    ok('O4 画面具有色彩层次（多种像素值）', s1.distinct > 30, 'distinct=' + s1.distinct);
    ok('O5 画面中央存在准星绿色像素', s1.green > 0, 'green样本=' + s1.green);

    dragX(4000, canvas);   // 800 DPI / 0.35 灵敏度 → 约 98° 转向
    await sleep(500);
    var s2 = canvasStats(canvas);
    ok('O6 鼠标移动后画面确实旋转（像素哈希改变）', s2.hash !== s1.hash, s1.hash + ' → ' + s2.hash);

    /* ---------- P. 隐藏时暂停渲染（性能行为） ---------- */
    window.scrollTo(0, 0);
    await sleep(400);
    var h1 = canvasStats(canvas).hash;
    await sleep(400);
    var h2 = canvasStats(canvas).hash;
    ok('P1 画布离开视口后停止重绘（省电）', h1 === h2, h1 + ' / ' + h2);

    // 收起折叠区，回到页面的默认状态（只有测试入口卡片可见）
    setManualOpen(false);
    await sleep(250);

    /* ---------- Q. 灵敏度测试流程：完整跑一轮并拿到推荐值 ---------- */
    setInput(dpi, '800');
    setInput(sens, '0.35');
    await sleep(200);

    ok('Q1 存在测试入口按钮', !!$('btn-flow'));
    ok('Q2 入口卡片直接提供强度选择（没有中间准备面板）',
       document.querySelectorAll('input[name="flow-preset"]').length === 3);
    ok('Q3 入口卡片直接提供鼠标垫宽度输入', !!$('flow-pad'));
    ok('Q4 参数已填好时开始按钮可用', $('btn-flow').disabled === false);
    ok('Q5 只提供全屏一种开始方式（不存在窗口模式按钮）',
       document.querySelectorAll('[data-fs="0"]').length === 0);

    // 选「快速」预设（3 档），让端到端测试能在可接受时间内跑完
    var fastRadio = document.querySelector('input[name="flow-preset"][value="fast"]');
    fastRadio.checked = true;
    fastRadio.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(150);
    ok('Q6 切换强度后入口卡片上的档位数同步更新', txt('flow-launcher-count') === '3',
       txt('flow-launcher-count') + ' 档 / ' + txt('flow-launcher-est'));

    $('flow-pad').value = '45';
    $('flow-pad').dispatchEvent(new Event('input', { bubbles: true }));

    /* 点「开始测试」：应当立刻进入测试状态。
     * headless 下全屏请求会因缺少用户手势而被拒绝 —— 正好验证优雅降级。
     * 同时验证折叠的手动模式被自动展开（否则画布没有渲染盒子，全屏会是空白）。 */
    $('btn-flow').click();
    await sleep(600);
    ok('Q7 折叠区被自动展开（保证全屏有渲染内容）',
       !!document.querySelector('.manual-modes[open]'));
    ok('Q8 全屏被拒绝时流程仍能启动（优雅降级）',
       document.body.classList.contains('flow-running'));
    ok('Q9 没有准备面板：一开始面板就是隐藏的，实时读数条已出现',
       $('flow-panel').hidden === true && $('drill-strip').hidden === false);

    // 读数条应立刻给出反馈（锁定鼠标/进全屏可能耗时 1 秒以上）
    var sawStrip = false;
    for (var w1 = 0; w1 < 40 && !sawStrip; w1++) {
      if (txt('drill-sens') !== '--') sawStrip = true; else await sleep(100);
    }
    ok('Q10 读数条立刻显示当前档位信息，不出现空档', sawStrip, 'sens=' + txt('drill-sens'));

    // 等待画布真正进入甩枪模式（要等锁定 + 倒计时结束）
    var sawDrill = false;
    for (var w2 = 0; w2 < 100 && !sawDrill; w2++) {
      if (txt('hud-mode').indexOf('测试') !== -1) sawDrill = true; else await sleep(100);
    }
    ok('Q11 画布确实进入了甩枪/跟枪测试模式', sawDrill, txt('hud-mode'));

    /* 用合成鼠标事件驱动整轮测试：
     * 每步同时给出水平与垂直位移（水平 45 counts ≈ 1.1°、垂直 30 counts ≈ 0.74°，
     * 均小于靶面角半径 2.66°，保证扫描过程中一定会跨进命中圈），并立即点击；
     * 水平每 70 步换向、垂直每 20 步换向，从而覆盖上下左右四个方向的靶位。 */
    var swept = 0, dir = 1, vdir = 1;
    var flowGuard = Date.now() + 200000;
    while (document.body.classList.contains('flow-running') && Date.now() < flowGuard) {
      if (swept % 70 === 0) dir = -dir;
      if (swept % 20 === 0) vdir = -vdir;
      canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 600, clientY: 300 }));
      canvas.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, clientX: 620, clientY: 320,
        movementX: 45 * dir, movementY: 30 * vdir
      }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
      canvas.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      swept++;
      await sleep(2);
    }

    ok('Q12 测试流程自动跑完（没有卡死）',
       !document.body.classList.contains('flow-running'), '扫描 ' + swept + ' 步');
    await sleep(400);
    ok('Q13 结束后显示报告面板', $('flow-panel').hidden === false);

    var report = txt('flow-card');
    ok('Q14 报告包含推荐灵敏度', report.indexOf('推荐灵敏度') !== -1);
    ok('Q15 报告包含成绩表', document.querySelectorAll('.flow-table tbody tr').length >= 2,
       document.querySelectorAll('.flow-table tbody tr').length + ' 行');
    ok('Q16 报告给出结论可信度', report.indexOf('结论可信度') !== -1);
    ok('Q17 报告包含鼠标垫换算校验', report.indexOf('180° 转身需要') !== -1);
    ok('Q18 报告排除了物理上不可用的档位说明或未排除时给足档位',
       report.indexOf('已排除') !== -1 || document.querySelectorAll('.flow-table tbody tr').length === 3);

    var recoEl = document.querySelector('.flow-reco-value strong');
    var recoText = recoEl ? recoEl.textContent.trim() : '';
    ok('Q19 推荐值格式合法（最多 3 位小数）', /^\d+(\.\d{1,3})?$/.test(recoText), recoText);
    ok('Q20 推荐值在合法范围内',
       parseFloat(recoText) >= 0.01 && parseFloat(recoText) <= 10, recoText);
    ok('Q21 存在「应用推荐」按钮', !!document.querySelector('[data-flow="apply"]'));
    ok('Q22 存在「精测一轮」按钮', !!document.querySelector('[data-flow="refine"]'));
    ok('Q23 存在「复制结果」按钮', !!document.querySelector('[data-flow="copy"]'));

    /* Q24：键盘可达性 —— 面板显示后焦点应已落在面板内的按钮上。
     * 全屏 + 鼠标锁定之后焦点还留在画布上，若不主动聚焦，键盘用户 Tab 不到这些按钮。 */
    var activeEl = document.activeElement;
    ok('Q24 报告面板显示后焦点已在面板内的按钮上',
       !!activeEl && $('flow-card').contains(activeEl) && activeEl.tagName === 'BUTTON',
       activeEl ? (activeEl.tagName + ' "' + (activeEl.textContent || '').trim().slice(0, 10) + '"') : 'null');

    /* Q25：复制结果不能抛异常，且必须给出**与复制相关**的反馈
     * （无头环境可能因权限拿不到剪贴板，此时会提示手动复制 —— 两种都算通过） */
    document.querySelector('[data-flow="copy"]').click();
    await sleep(400);
    var copyToasts = Array.prototype.filter.call(
      document.querySelectorAll('.toast'),
      function (t) { return t.textContent.indexOf('复制') !== -1; }
    );
    ok('Q25 点击「复制结果」有明确的复制反馈',
       copyToasts.length > 0,
       copyToasts.length
         ? copyToasts[copyToasts.length - 1].textContent.replace(/\s+/g, ' ').trim().slice(0, 26)
         : ('当前提示：' + Array.prototype.map.call(document.querySelectorAll('.toast'),
              function (t) { return t.textContent.trim().slice(0, 14); }).join(' | ')));

    document.querySelector('[data-flow="apply"]').click();
    await sleep(350);
    ok('Q26 应用推荐后输入框同步为推荐值', sens.value === recoText, sens.value + ' vs ' + recoText);
    ok('Q27 应用推荐后结果区立即重算', txt('out-edpi') !== '--', txt('out-edpi') + ' eDPI');
    ok('Q28 推荐值的 eDPI 与 DPI 一致',
       Math.abs(num('out-edpi') - 800 * parseFloat(recoText)) < 1.5,
       num('out-edpi') + ' vs ' + (800 * parseFloat(recoText)).toFixed(2));

    document.querySelector('[data-flow="close"]').click();
    await sleep(400);
    ok('Q29 关闭流程后回到空闲状态',
       !document.body.classList.contains('flow-active') && $('flow-panel').hidden === true);
    ok('Q30 关闭后画布复位为自由转向模式', txt('hud-mode') === '自由转向', txt('hud-mode'));
    ok('Q31 关闭后读数条隐藏', $('drill-strip').hidden === true);
    ok('Q32 关闭后折叠区重新收起（页面回到只有测试入口的状态）',
       !document.querySelector('.manual-modes[open]'));

    /* 回归断言：路径效率这一列必须有真实数值。
     * 曾经因为 canvas.js 未初始化 totalPathDeg，导致该列恒为 "--"，
     * 而它占综合评分的 20% 权重 —— 属于「静默失效」，必须由测试守住。 */
    var pathCells = document.querySelectorAll('.flow-table tbody tr td:nth-child(6)');
    var pathOk = pathCells.length > 0, pathSample = [];
    for (var pi = 0; pi < pathCells.length; pi++) {
      var pv = pathCells[pi].textContent.trim();
      pathSample.push(pv);
      if (!/^\d+(\.\d+)?×$/.test(pv)) pathOk = false;
    }
    ok('Q33 路径效率列是真实数值而非占位符', pathOk, pathSample.join(' / '));
    var scoreCells = document.querySelectorAll('.flow-table tbody tr td:nth-child(8)');
    var scoreOk = scoreCells.length > 0;
    for (var si = 0; si < scoreCells.length; si++) {
      var sv = parseFloat(scoreCells[si].textContent);
      if (!isFinite(sv) || sv < 0 || sv > 100) scoreOk = false;
    }
    ok('Q34 综合分都在 0~100 之间', scoreOk);

    /* ---------- 诊断信息：把真实产出的报告内容导出，便于人工核对措辞与数字 ---------- */
    var tableRows = document.querySelectorAll('.flow-table tbody tr');
    var tableText = [];
    for (var ti = 0; ti < tableRows.length; ti++) {
      tableText.push(tableRows[ti].textContent.replace(/\s+/g, ' ').trim());
    }
    var confEl = document.querySelector('.flow-confidence');
    results.push('INFO :: 推荐灵敏度 ' + recoText +
      ' | 表格 ' + tableRows.length + ' 行：' + tableText.join(' || '));
    results.push('INFO :: ' + (confEl ? confEl.textContent.replace(/\s+/g, ' ').trim() : '(无可信度文本)'));
    var verdictEl = document.querySelector('.flow-verdict');
    results.push('INFO :: ' + (verdictEl ? verdictEl.textContent.replace(/\s+/g, ' ').trim() : '(无结论文本)'));

    /* ---------- F. 全屏布局（headless 可能因缺少用户手势而拒绝，此时记为 SKIP） ---------- */
    var fsOk = false, fsErr = '';
    try {
      await wrap.requestFullscreen();
      fsOk = !!document.fullscreenElement;
    } catch (e) {
      fsErr = e && e.name ? e.name : String(e);
    }
    if (fsOk) {
      await sleep(600);
      var fsRect = canvas.getBoundingClientRect();
      ok('F1 全屏后画布铺满窗口高度', fsRect.height > window.innerHeight * 0.8,
         'canvas ' + Math.round(fsRect.width) + 'x' + Math.round(fsRect.height) +
         ' / window ' + window.innerWidth + 'x' + window.innerHeight);
      ok('F2 全屏后画布缓冲区按新的 CSS 尺寸重建',
         Math.abs(canvas.height / dpr - fsRect.height) < 3,
         'buffer ' + canvas.height + ' / dpr ' + dpr + ' vs css ' + Math.round(fsRect.height));
      await document.exitFullscreen();
      await sleep(600);
      var backRect = canvas.getBoundingClientRect();
      ok('F3 退出全屏后画布恢复原始宽高比',
         Math.abs(backRect.width / backRect.height - 1200 / 620) < 0.05,
         Math.round(backRect.width) + 'x' + Math.round(backRect.height));
    } else {
      results.push('SKIP :: F1-F3 全屏布局 —— headless 环境拒绝全屏（' +
        (fsErr || '需要用户手势') + '），该路径需在真实浏览器中手动确认');
    }

    /* ---------- R. 全屏相关的画布行为回归测试 ----------
     * 用户反馈过的真实问题：「全屏后屏幕变暗」。根因有两层：
     *   1) 改画布尺寸会清空缓冲区，若这一帧不补画，全屏瞬间就是一块黑屏；
     *   2) 渲染只看 IntersectionObserver，全屏切换后观察器还没回调时会被判定为"不可见"。
     * 这两条都很难靠肉眼截图复现，所以在这里用 ?debug=1 暴露的句柄直接验证。 */
    setManualOpen(true);
    await sleep(300);
    canvas.scrollIntoView({ block: 'center' });
    await sleep(400);

    var VST = window.__vst;
    ok('R1 ?debug=1 时暴露调试句柄', !!VST && !!VST.range);

    if (VST && VST.range) {
      // 模拟「全屏刚切换、IntersectionObserver 还没反应过来」的瞬间
      VST.range.visible = false;
      VST.range.forcedVisible = false;
      VST.range.refreshSize();          // 重建缓冲区（会清空画布）
      await sleep(150);
      var afterResize = canvasStats(canvas);
      ok('R2 尺寸重建后立刻补画一帧，不会留下黑屏',
         afterResize.avg > 8 && afterResize.distinct > 20,
         '平均亮度 ' + afterResize.avg.toFixed(1) + ' / 色彩层次 ' + afterResize.distinct);

      // forcedVisible：即使观察器报告"不可见"（全屏切换期间就是这种情况）也持续渲染
      VST.range.forcedVisible = true;
      VST.range.visible = false;
      var hBefore = canvasStats(canvas).hash;
      dragX(1500, canvas);
      await sleep(300);
      var hAfter = canvasStats(canvas).hash;
      ok('R3 forcedVisible 时即使被判定为不可见也继续渲染（画面随转向更新）',
         hBefore !== hAfter, hBefore + ' → ' + hAfter);

      // 还原：交给 IntersectionObserver 正常管理
      VST.range.forcedVisible = false;
      VST.range.visible = true;

      // DPR 像素预算：缓冲区不得超过上限（全屏 2K/4K 下防止帧率崩掉）
      var bufPx = canvas.width * canvas.height;
      var cssPx = canvas.getBoundingClientRect().width * canvas.getBoundingClientRect().height;
      ok('R4 画布缓冲区受像素预算约束（不会因全屏 + HiDPI 爆炸）',
         bufPx <= 4200000 * 1.05 || bufPx <= cssPx * 1.05,
         '缓冲区 ' + Math.round(bufPx / 10000) + ' 万像素 / CSS ' + Math.round(cssPx / 10000) + ' 万像素');
    }

    /* R5：提示条移进了画布（为了在全屏里可见），必须确认它没有被画布的
     * overflow:hidden 裁掉、也没有跑到视口外。 */
    $('btn-save').click();               // 触发一次「已保存」提示
    await sleep(200);
    var toastEl = document.querySelector('.toast');
    var toastRect = toastEl ? toastEl.getBoundingClientRect() : null;
    ok('R5 提示条仍显示在视口内（全屏下才有反馈，不能被裁掉）',
       !!toastRect && toastRect.width > 0 && toastRect.height > 0 &&
       toastRect.top >= 0 && toastRect.bottom <= window.innerHeight + 1 &&
       toastRect.right <= window.innerWidth + 1,
       toastRect ? ('位置 ' + Math.round(toastRect.left) + ',' + Math.round(toastRect.top) +
                    ' 尺寸 ' + Math.round(toastRect.width) + 'x' + Math.round(toastRect.height)) : '未生成提示');
    setManualOpen(false);
    await sleep(200);

    /* R6：通用不变式 —— 任何带 hidden 属性的元素，计算样式必须是 display:none。
     * 这条断言能一次性防住整类 bug：作者样式里的 display 会盖掉浏览器的
     * 默认 [hidden]{display:none}，曾经导致全屏面板不退出、按钮无法隐藏等问题。 */
    (function () {
      var offenders = [];
      var els = document.querySelectorAll('[hidden]');
      for (var i = 0; i < els.length; i++) {
        var d = window.getComputedStyle(els[i]).display;
        if (d !== 'none') {
          offenders.push((els[i].id ? '#' + els[i].id : els[i].className) + ' → display:' + d);
        }
      }
      ok('R6 所有带 hidden 的元素确实不可见（hidden 未被 CSS 覆盖）',
         offenders.length === 0, offenders.length ? offenders.join(' | ') : '共检查 ' + els.length + ' 个元素');
    })();

    /* R7：可隐藏元素在 JS 切换 hidden 时，显示/隐藏都要真的生效 */
    (function () {
      var target = $('btn-restore');                     // 曾经因为 .btn{display:inline-flex} 而无法隐藏
      var before = window.getComputedStyle(target).display;
      target.hidden = true;
      var whenHidden = window.getComputedStyle(target).display;
      target.hidden = false;
      var whenShown = window.getComputedStyle(target).display;
      target.hidden = true;
      ok('R7 hidden 切换在按钮上真实生效', whenHidden === 'none' && whenShown !== 'none',
         '隐藏时 ' + whenHidden + ' / 显示时 ' + whenShown + '（初始 ' + before + '）');
    })();

    /* R8：用 CSSOM 检查全屏规则不会让 .flow-panel 的 hidden 失效。
     * 无头浏览器进不了全屏，所以无法"真的"全屏一次；但可以直接问浏览器：
     * 有没有哪条同时命中 :fullscreen 与 .flow-panel、且声明了 display 的规则
     * 忘了加 :not([hidden])？—— 这正是「全屏后面板不退出、吞掉点击」的成因。 */
    (function () {
      var offenders = [];
      for (var s = 0; s < document.styleSheets.length; s++) {
        var rules;
        try { rules = document.styleSheets[s].cssRules; } catch (e) { continue; }
        for (var r = 0; r < rules.length; r++) {
          var rule = rules[r];
          if (!rule.selectorText || !rule.style || !rule.style.display) continue;
          rule.selectorText.split(',').forEach(function (sel) {
            sel = sel.trim();
            if (/full-?screen/.test(sel) && /\.flow-panel\b/.test(sel) && !/:not\(\[hidden\]\)/.test(sel)) {
              offenders.push(sel);
            }
          });
        }
      }
      ok('R8 全屏规则不会让 .flow-panel 的 hidden 失效（面板必须能退出）',
         offenders.length === 0, offenders.join(' | ') || '未发现违规规则');
    })();

    /* ---------- 输出（注意：必须放在所有断言之后） ---------- */
    var fail = results.filter(function (r) { return r.indexOf('FAIL') === 0; }).length;
    var report = 'HARNESS-BEGIN\n' + results.join('\n') +
      '\nRAF_TICKS ' + rafTicks +
      '\nHARNESS-TOTAL ' + results.length + ' FAIL ' + fail + '\nHARNESS-END';

    var pre = document.createElement('pre');
    pre.id = 'harness-output';
    pre.textContent = report;
    document.body.appendChild(pre);
    document.title = 'HARNESS ' + (results.length - fail) + '/' + results.length;

    // 通过 HTTP 回传（POST 到本地测试服务器）
    try {
      fetch('/report', { method: 'POST', body: report });
    } catch (e) { /* 忽略，dump-dom 也能拿到 */ }

    /* ---------- 阶段一收尾：写入一组有辨识度的配置，然后刷新页面 ------------------
     * 用 1234 DPI × 0.567 灵敏度（eDPI = 699.68，cm/360 = 18.67），
     * 便于阶段二判断「恢复的是保存值」而不是任何默认值。
     * ------------------------------------------------------------------------- */
    setInput(dpi, '1234');
    setInput(sens, '0.567');
    await sleep(900);   // 等待自动保存的防抖（500ms）完成
    try { window.sessionStorage.setItem('vst:harness-phase', '2'); } catch (e) { /* 忽略 */ }
    await sleep(300);
    window.location.reload();
  }

  /* ==========================================================================
   * 阶段二：页面刷新后，验证 localStorage 里的配置被正确恢复
   * （阶段一结束时写入 1234 DPI × 0.567，然后 location.reload()）
   * ======================================================================== */
  async function runPhase2() {
    await sleep(300);
    var dpi = $('dpi'), sens = $('sens');
    ok('R1 刷新后 DPI 从本地存储恢复', dpi.value === '1234', dpi.value);
    ok('R2 刷新后灵敏度从本地存储恢复', sens.value === '0.567', sens.value);
    ok('R3 恢复后 eDPI 自动重算 = 699.68', txt('out-edpi') === '699.68', txt('out-edpi'));
    ok('R4 恢复后 cm/360 = 18.67', txt('out-cm360') === '18.67', txt('out-cm360'));
    ok('R5 刷新后画布参数有效', $('canvas-overlay').hidden === true);

    try { window.sessionStorage.removeItem('vst:harness-phase'); } catch (e) { /* 忽略 */ }

    var fail = results.filter(function (r) { return r.indexOf('FAIL') === 0; }).length;
    var report = 'HARNESS-BEGIN\n' + results.join('\n') +
      '\nHARNESS-TOTAL ' + results.length + ' FAIL ' + fail + '\nHARNESS-END';
    var pre = document.createElement('pre');
    pre.id = 'harness-output';
    pre.textContent = report;
    document.body.appendChild(pre);
    try { fetch('/report', { method: 'POST', body: report }); } catch (e) { /* 忽略 */ }
  }

  window.addEventListener('load', function () {
    setTimeout(function () {
      var phase = '1';
      try { phase = window.sessionStorage.getItem('vst:harness-phase') || '1'; } catch (e) { /* 忽略 */ }

      var task = (phase === '2') ? runPhase2() : run();
      task.catch(function (e) {
        var pre = document.createElement('pre');
        pre.id = 'harness-output';
        pre.textContent = 'HARNESS-BEGIN\nFATAL :: ' + (e && e.stack ? e.stack : e) + '\nHARNESS-END';
        document.body.appendChild(pre);
        try { fetch('/report', { method: 'POST', body: pre.textContent }); } catch (e2) { /* 忽略 */ }
      });
    }, 400);
  });
})();
