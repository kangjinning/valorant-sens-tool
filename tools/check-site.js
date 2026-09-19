/* =============================================================================
 * tools/check-site.js — 静态站点完整性自检（开发期验证用，部署时无需上传）
 * -----------------------------------------------------------------------------
 * 运行方式：node tools/check-site.js
 *
 * 检查内容：
 *   1. index.html 引用的所有本地文件（css/js）是否存在
 *   2. main.js 里 getElementById / $() 用到的 id，是否都能在 index.html 中找到
 *   3. index.html 里每个 <script> 的加载顺序是否为依赖顺序
 *   4. 是否存在外链资源（http/https/cdn），确保可以完全离线部署
 *   5. HTML 中标签的基本闭合情况（成本极低的粗检）
 * ============================================================================= */

'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var problems = [];
var notes = [];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

/* ---------------------- 1. 引用文件是否存在 ---------------------- */
var html = read('index.html');

var refs = [];
var reRef = /(?:src|href)\s*=\s*"([^"]+)"/g;
var m;
while ((m = reRef.exec(html)) !== null) {
  refs.push(m[1]);
}

refs.forEach(function (ref) {
  if (/^(https?:)?\/\//i.test(ref) || /^data:/i.test(ref) || /^mailto:/i.test(ref) || ref.charAt(0) === '#') {
    return;
  }
  if (!exists(ref)) problems.push('index.html 引用的文件不存在：' + ref);
});
notes.push('检查了 ' + refs.length + ' 个 src/href 引用');

/* ---------------------- 2. JS 用到的 id 是否存在 ---------------------- */
var mainJs = read('js/main.js');
var htmlIds = {};
var reId = /\bid\s*=\s*"([^"]+)"/g;
while ((m = reId.exec(html)) !== null) {
  htmlIds[m[1]] = true;
}

var usedIds = {};
var reDollar = /\$\('([^']+)'\)/g;
while ((m = reDollar.exec(mainJs)) !== null) {
  usedIds[m[1]] = true;
}
var reGetById = /getElementById\('([^']+)'\)/g;
while ((m = reGetById.exec(mainJs)) !== null) {
  usedIds[m[1]] = true;
}

Object.keys(usedIds).forEach(function (id) {
  if (!htmlIds[id]) problems.push('main.js 引用了 index.html 中不存在的 id：#' + id);
});
notes.push('校验了 main.js 使用的 ' + Object.keys(usedIds).length + ' 个元素 id');

/* ---- 反向检查：canvas.js / data.js 里用到的全局依赖是否已加载 ---- */
var canvasJs = read('js/canvas.js');
if (canvasJs.indexOf('VCalc.') !== -1 && html.indexOf('js/calc.js') === -1) {
  problems.push('canvas.js 依赖 VCalc，但 index.html 未加载 js/calc.js');
}

/* ---------------------- 3. script 加载顺序 ---------------------- */
var scripts = [];
var reScript = /<script\s+src="([^"]+)"/g;
while ((m = reScript.exec(html)) !== null) scripts.push(m[1]);

var expectedOrder = ['js/data.js', 'js/calc.js', 'js/storage.js', 'js/canvas.js', 'js/testflow.js', 'js/main.js'];
var actualOrder = scripts.filter(function (s) { return expectedOrder.indexOf(s) !== -1; });
if (actualOrder.join(',') !== expectedOrder.join(',')) {
  problems.push('脚本加载顺序不正确。期望 ' + expectedOrder.join(' → ') +
                '，实际 ' + actualOrder.join(' → '));
} else {
  notes.push('脚本加载顺序正确：' + actualOrder.join(' → '));
}

/* ---------------------- 4. 离线可用性检查 ----------------------
 * 只检查「浏览器渲染时必须抓取」的资源：样式表、脚本、图片、图标。
 * rel="canonical"、og:* 这类是元数据（不是请求），指向自己的域名属于正常用法，
 * 不能算外部依赖。 */
var offlineIssues = [];

/* 4a. 脚本：任何外链脚本都会破坏离线能力 */
var reAnyScript = /<script[^>]*src\s*=\s*"([^"]+)"/g;
while ((m = reAnyScript.exec(html)) !== null) {
  if (/^(https?:)?\/\//i.test(m[1])) offlineIssues.push('外部脚本 ' + m[1]);
}

/* 4b. 样式表 */
var reAnyCss = /<link[^>]*rel\s*=\s*"stylesheet"[^>]*href\s*=\s*"([^"]+)"/g;
while ((m = reAnyCss.exec(html)) !== null) {
  if (/^(https?:)?\/\//i.test(m[1])) offlineIssues.push('外部样式表 ' + m[1]);
}

/* 4c. 图标（data: 内联不算外部） */
var reAnyIcon = /<link[^>]*rel\s*=\s*"icon"[^>]*href\s*=\s*"([^"]+)"/g;
while ((m = reAnyIcon.exec(html)) !== null) {
  if (/^https?:\/\//i.test(m[1])) offlineIssues.push('外部图标 ' + m[1]);
}

/* 4d. 页面内的 <img>（本站目前没有，留作约束） */
var reAnyImg = /<img[^>]*src\s*=\s*"([^"]+)"/g;
while ((m = reAnyImg.exec(html)) !== null) {
  if (/^(https?:)?\/\//i.test(m[1])) offlineIssues.push('外部图片 ' + m[1]);
}

/* 4e. CSS 里的 @import / url(http...) */
var cssText = read('css/style.css');
if (/@import\s+url\(\s*['"]?https?:/i.test(cssText) || /url\(\s*['"]?https?:\/\//i.test(cssText)) {
  offlineIssues.push('css/style.css 里有远程 @import 或 url()');
}

if (offlineIssues.length) {
  problems.push('发现会影响离线使用的远程资源：' + offlineIssues.join(', '));
} else {
  notes.push('页面对外零请求（样式/脚本/图标/图片全部为本地或内联，可完全离线运行）');
}

/* 4f. 顺带确认站点规范地址已填成自有域名 */
if (html.indexOf('rel="canonical"') === -1) {
  notes.push('提示：index.html 未设置 rel="canonical"（可选）');
} else if (html.indexOf('https://www.kang.love/') === -1) {
  problems.push('rel="canonical" 没有指向 https://www.kang.love/');
} else {
  notes.push('✓ canonical / og:url 指向 https://www.kang.love/');
}

void refs;

/* ---------------------- 5. 标签粗检 ---------------------- */
['div', 'section', 'main', 'table', 'details'].forEach(function (tag) {
  var open = (html.match(new RegExp('<' + tag + '(\\s|>)', 'g')) || []).length;
  var close = (html.match(new RegExp('</' + tag + '>', 'g')) || []).length;
  if (open !== close) {
    problems.push('<' + tag + '> 标签数量不匹配：开始 ' + open + ' 个，结束 ' + close + ' 个');
  }
});
notes.push('完成主要容器标签闭合粗检');

/* ---------------------- 6. CSS 关键不变式 ---------------------- */
/* hidden 属性必须被钉死：浏览器默认的 [hidden]{display:none} 属于 UA 样式，
 * 优先级低于任何作者样式 —— 只要某元素在作者样式里写了 display，hidden 就失效。
 * 曾经因此出现「全屏后面板不退出、遮住画面还吞掉所有点击」的严重问题。 */
/* 注意：先剥掉注释再检查 —— 否则注释里举例说明的旧写法会被误判成真实规则 */
var css = read('css/style.css').replace(/\/\*[\s\S]*?\*\//g, '');
if (!/\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/.test(css)) {
  problems.push('css/style.css 缺少全局规则 "[hidden] { display: none !important; }"：' +
                '缺少它时，任何带 display 的作者样式都会让元素的 hidden 属性失效');
} else {
  notes.push('✓ hidden 属性已全局钉死（[hidden]{display:none!important}）');
}
/* 逐条解析 CSS 规则：任何「同时限定 :fullscreen 与 .flow-panel、又声明了 display、
 * 却没有加 :not([hidden])」的选择器，都会让面板在全屏下无法隐藏。 */
(function () {
  var offenders = [];
  var chunks = css.split('}');
  chunks.forEach(function (chunk) {
    var brace = chunk.indexOf('{');
    if (brace === -1) return;
    var selector = chunk.slice(0, brace);
    var body = chunk.slice(brace + 1);
    if (!/(^|;)\s*display\s*:/.test(body)) return;        // 只看声明了 display 的规则
    selector.split(',').forEach(function (sel) {
      var s = sel.trim();
      if (/full-?screen/.test(s) && /\.flow-panel\b/.test(s) && !/:not\(\[hidden\]\)/.test(s)) {
        offenders.push(s);
      }
    });
  });
  if (offenders.length) {
    problems.push('全屏规则直接给 .flow-panel 设了 display，会覆盖它的 hidden（应改写为 ' +
                  '.flow-panel:not([hidden])）：' + offenders.join(' | '));
  } else {
    notes.push('✓ 全屏规则未破坏 .flow-panel 的 hidden 行为');
  }
})();

/* ---------------------- 7. README 与仓库整洁度 ---------------------- */

var readme0 = read('README.md');

/* 7a. 仓库里只应保留一个文档（README.md）。
 *     本项目刻意不写额外的部署/使用文档，避免文档与实现漂移。 */
var strayDocs = [];
(function walk(dir, depth) {
  if (depth > 2) return;
  var items;
  try { items = fs.readdirSync(path.join(ROOT, dir)); } catch (e) { return; }
  items.forEach(function (name) {
    if (name === 'node_modules' || name.charAt(0) === '.') return;
    var rel = dir ? dir + '/' + name : name;
    var full = path.join(ROOT, rel);
    var st;
    try { st = fs.statSync(full); } catch (e) { return; }
    if (st.isDirectory()) { walk(rel, depth + 1); return; }
    if (/\.md$/i.test(name) && rel !== 'README.md') strayDocs.push(rel);
  });
})('', 0);
if (strayDocs.length) {
  problems.push('除了 README.md 之外不应再有其他文档：' + strayDocs.join(', '));
} else {
  notes.push('✓ 仓库只有 README.md 一个文档');
}

/* 7b. 已删除的部署产物不应再被引用 */
['deploy/', 'nginx', 'docs/', 'pages.yml', '.nojekyll',
 'UBUNTU-DEPLOY', 'WINDOWS-LOCAL', 'USER-GUIDE', 'TECH-NOTES', 'GITHUB.md']
  .forEach(function (needle) {
    var inHtml = html.indexOf(needle) !== -1;
    if (inHtml) problems.push('index.html 仍在引用已删除的部署内容：' + needle);
    var inReadme = readme0.indexOf(needle) !== -1 &&
                   // README 里允许出现「部署」这个词，但不允许指向已删除的文件
                   new RegExp('\\]\\([^)]*' + needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(readme0);
    if (inReadme) problems.push('README.md 仍在链接已删除的文件：' + needle);
  });

/* 7c. README 里引用的本地图片必须真实存在 ——
 *     GitHub 上裂图很显眼，而这里看不到渲染结果，所以必须机器检查。 */
var mdRefs = [];
var reMd = /!\[[^\]]*\]\(([^)]+)\)|<img[^>]*src="([^"]+)"/g;
var mm;
while ((mm = reMd.exec(readme0)) !== null) {
  var ref = mm[1] || mm[2];
  if (ref && !/^(https?:)?\/\//i.test(ref) && ref.charAt(0) !== '#') mdRefs.push(ref);
}
var badRefs = mdRefs.filter(function (r) { return !exists(String(r).split('#')[0]); });
if (badRefs.length) {
  problems.push('README.md 引用了不存在的文件（GitHub 上会裂图）：' + badRefs.join(', '));
} else {
  notes.push('✓ README 引用的 ' + mdRefs.length + ' 张本地图片都存在');
}

/* 7d. README 里不要留下 GitHub Pages 相关的说法（本项目用自己的域名） */
if (/github\.io|GitHub Pages|pages\.yml/i.test(readme0)) {
  problems.push('README.md 仍提到 GitHub Pages / github.io —— 本项目使用自有域名 www.kang.love');
} else {
  notes.push('✓ README 未残留 GitHub Pages 相关内容');
}

/* ---------------------- 8. 关键文案/公式抽检 ---------------------- */
if (html.indexOf('EDPI = DPI × 游戏内灵敏度') === -1) {
  problems.push('index.html 中未找到 EDPI 公式说明文案');
}
if (html.indexOf('0.07') === -1) {
  notes.push('提示：index.html 未直接出现 yaw 系数 0.07（当前位于知识说明区，可接受）');
}

/* ---------------------- 输出 ---------------------- */
console.log('静态站点自检：' + ROOT + '\n');
notes.forEach(function (n) { console.log('  · ' + n); });

if (problems.length === 0) {
  console.log('\n✅ 全部检查通过，没有发现问题。');
  process.exit(0);
} else {
  console.log('\n❌ 发现 ' + problems.length + ' 个问题：');
  problems.forEach(function (p) { console.log('  - ' + p); });
  process.exit(1);
}
