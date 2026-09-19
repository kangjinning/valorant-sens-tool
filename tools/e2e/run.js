/* =============================================================================
 * tools/e2e/run.js — 浏览器端到端测试驱动（开发期工具，部署时无需上传）
 * -----------------------------------------------------------------------------
 * 作用：
 *   1. 启动一个本地静态服务器（等价于线上静态托管的角色），
 *      在内存中生成一个测试页面：index.html + 注入 tools/e2e/harness-test.js
 *   2. 用 headless Chrome / Edge 以「真实时间」打开该页面
 *      （刻意不使用 --virtual-time-budget：虚拟时间会让 requestAnimationFrame
 *        被饿死，导致画布读数不刷新，从而产生假失败）
 *   3. 页面用合成鼠标事件模拟真实操作，把断言结果 POST 回 /report；
 *      收到「完整交互」与「刷新后恢复配置」两份报告后打印并退出。
 *
 * 运行：
 *     node tools/e2e/run.js
 *     如需指定浏览器：CHROME_PATH="C:\...\chrome.exe" node tools/e2e/run.js
 *
 * 退出码：0 = 全部断言通过；1 = 有断言失败；2 = 超时或环境缺失
 * ============================================================================= */

'use strict';

var http = require('http');
var fs = require('fs');
var os = require('os');
var path = require('path');
var spawn = require('child_process').spawn;

var ROOT = path.resolve(__dirname, '..', '..');   // 项目根目录
var PORT = 8123;
var PROFILE = path.join(os.tmpdir(), 'valorant-sens-tool-e2e');
var TIMEOUT_MS = 300000;   // 含「灵敏度测试流程」完整跑一轮（快速预设），需要较长时间
var EXPECTED_REPORTS = 2;

/* ------------------------------ 定位浏览器 ------------------------------ */
function findBrowser() {
  var candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/snap/bin/chromium'
  ];
  for (var i = 0; i < candidates.length; i++) {
    if (candidates[i] && fs.existsSync(candidates[i])) return candidates[i];
  }
  return null;
}

var BROWSER = findBrowser();
if (!BROWSER) {
  console.error('未找到 Chrome / Edge。请安装浏览器，或用 CHROME_PATH 环境变量指定可执行文件路径。');
  process.exit(2);
}

/* 每次运行都从干净的浏览器配置开始，避免上次的 localStorage 影响「首次访问」断言 */
try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }

/* ------------------------------ 静态服务器 ------------------------------ */
var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

var chrome = null;
var done = false;
var reports = [];

function finish(code) {
  if (done) return;
  done = true;
  try { if (chrome) chrome.kill(); } catch (e) { /* 忽略 */ }
  setTimeout(function () {
    try { server.close(); } catch (e) { /* 忽略 */ }
    process.exit(code);
  }, 300);
}

/** 在内存里生成测试页：index.html 原样输出，只在 </body> 前注入测试脚本 */
function buildHarnessHtml() {
  return fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
    .replace('</body>', '<script src="/tools/e2e/harness-test.js"></script>\n</body>');
}

var server = http.createServer(function (req, res) {
  /* ---- 接收页面回传的测试报告 ---- */
  if (req.method === 'POST' && req.url === '/report') {
    var body = '';
    req.on('data', function (c) { body += c; });
    req.on('end', function () {
      reports.push(body);
      console.log('\n===== 第 ' + reports.length + ' 份报告 =====\n' + body);
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
      res.end('ok');

      if (reports.length >= EXPECTED_REPORTS) {
        var failed = /FAIL [1-9]/.test(reports.join('\n'));
        finish(failed ? 1 : 0);
      }
    });
    return;
  }

  var urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/_harness.html';

  /* ---- 测试页（内存生成） ---- */
  if (urlPath === '/_harness.html') {
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(buildHarnessHtml());
    return;
  }

  /* ---- 其余文件按项目根目录提供 ---- */
  var file = path.join(ROOT, urlPath);
  if (file.indexOf(ROOT) !== 0) {       // 防目录穿越
    res.writeHead(403);
    res.end('403');
    return;
  }
  fs.readFile(file, function (err, data) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', function () {
  console.log('浏览器：' + BROWSER);
  console.log('测试地址：http://127.0.0.1:' + PORT + '/_harness.html?debug=1');
  chrome = spawn(BROWSER, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--window-size=1440,1000',
    '--user-data-dir=' + PROFILE,
    // ?debug=1 会让页面挂出 window.__vst，便于端到端测试验证全屏相关的画布行为
    'http://127.0.0.1:' + PORT + '/_harness.html?debug=1'
  ], { stdio: 'ignore' });
});

setTimeout(function () {
  console.log('E2E 超时：未在 ' + (TIMEOUT_MS / 1000) + ' 秒内收到 ' + EXPECTED_REPORTS +
              ' 份报告（已收到 ' + reports.length + ' 份）');
  finish(2);
}, TIMEOUT_MS);
