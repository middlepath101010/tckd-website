# -*- coding: utf-8 -*-
"""
全站文字对比度审计探针（WCAG 2.1）

用途：改动配色 / 新增页面后，量化检查有没有文字对比度不达标。
用法：
    python _audit.py                      # 生成 _a_<page>.html
    # 再用无头 Chrome 截图，浮层会列出所有不达标项（选择器 + 字号 + 颜色 + 实际对比度）
    # 看完记得删掉临时页：rm -f _a_*.html

实现要点：
- 复制页面并注入审计脚本，遍历所有含直接文本节点的可见元素
- 取 computed color；沿祖先链自外向内合成背景色，background-image 的
  渐变取首个色标参与合成（否则 hero 深蓝底会被误判成白色，产生大量假报警）
- 半透明前景先与其背景合成，再按 WCAG 大字号阈值（>=24px，或 >=18.66px 且 >=700）
  判定达标线（大字号 3.0 / 正文 4.5）
- 结果渲染为全屏浮层，靠截图读取：无头 Chrome 的 --dump-dom 在长页面上会挂死
"""
import io, os, re, shutil

BASE = os.path.dirname(os.path.abspath(__file__))
PAGES = ["index.html", "query.html", "faq.html", "process.html", "about.html", "contact.html"]

AUDIT_JS = r"""
<script>
(function () {
  function parse(c) {
    if (!c) return null;
    var m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    var p = m[1].split(',').map(function (s) { return parseFloat(s); });
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  function comp(fg, bg) {
    var a = fg.a;
    return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
  }
  function lum(c) {
    function f(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  function ratio(a, b) {
    var l1 = lum(a), l2 = lum(b);
    if (l1 < l2) { var t = l1; l1 = l2; l2 = t; }
    return (l1 + 0.05) / (l2 + 0.05);
  }
  function gradFirst(bi) {
    if (!bi || bi.indexOf('gradient') === -1) return null;
    var m = bi.match(/rgba?\([^)]+\)/);
    return m ? parse(m[0]) : null;
  }
  // 从 html 到目标元素逐层叠加：先背景色、后渐变（渐变覆盖在背景色之上）
  function bgOf(el) {
    var chain = [], n = el;
    while (n && n.nodeType === 1) { chain.push(n); n = n.parentElement; }
    chain.reverse();
    var layers = [];
    for (var i = 0; i < chain.length; i++) {
      var cs = getComputedStyle(chain[i]);
      var c = parse(cs.backgroundColor);
      if (c && c.a > 0) layers.push(c);
      var g = gradFirst(cs.backgroundImage);
      if (g) layers.push(g);
    }
    var base = { r: 255, g: 255, b: 255, a: 1 };
    for (var j = 0; j < layers.length; j++) base = comp(layers[j], base);
    return base;
  }
  function selectorOf(el) {
    var s = el.tagName.toLowerCase();
    if (el.id) return s + '#' + el.id;
    if (el.className && typeof el.className === 'string') {
      var cls = el.className.split(/\s+/).filter(function (c) { return c && c.indexOf('t-') !== 0; });
      if (cls.length) return s + '.' + cls.slice(0, 2).join('.');
    }
    return s;
  }
  var bad = [], seen = {};
  var all = document.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    // 只取直接含文本的元素
    var own = '';
    for (var k = 0; k < el.childNodes.length; k++) {
      if (el.childNodes[k].nodeType === 3) own += el.childNodes[k].nodeValue;
    }
    own = own.trim();
    if (!own) continue;
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    var fg = parse(cs.color);
    if (!fg) continue;
    var bg = bgOf(el);
    var eff = fg.a < 1 ? comp(fg, bg) : fg;
    var cr = ratio(eff, bg);
    var fs = parseFloat(cs.fontSize);
    var fw = parseInt(cs.fontWeight, 10) || 400;
    var isLarge = fs >= 24 || (fs >= 18.66 && fw >= 700);
    var need = isLarge ? 3.0 : 4.5;
    if (cr < need) {
      var key = selectorOf(el) + '|' + own.slice(0, 12);
      if (seen[key]) continue;
      seen[key] = 1;
      bad.push({
        sel: selectorOf(el),
        txt: own.slice(0, 16),
        cr: Math.round(cr * 100) / 100,
        need: need,
        fs: Math.round(fs * 10) / 10,
        fw: fw,
        color: cs.color,
        bg: 'rgb(' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + ')'
      });
    }
  }
  bad.sort(function (a, b) { return a.cr - b.cr; });
  var box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;background:#fff;color:#111;' +
    'font:12px/1.5 ui-monospace,Menlo,monospace;padding:12px 16px;max-height:100vh;overflow:hidden;' +
    'border-right:2px solid #c00;width:720px';
  var h = '<div style="font-weight:700;font-size:15px;margin-bottom:8px">对比度审计 · 不达标 ' + bad.length + ' 处</div>';
  for (var j = 0; j < Math.min(bad.length, 34); j++) {
    var b = bad[j];
    h += '<div><b style="color:#c00">' + b.cr + '</b> /需' + b.need + ' <b>' + b.sel + '</b> ' +
      b.fs + 'px/' + b.fw + ' <span style="color:#06c">' + b.color + '</span> on ' + b.bg +
      ' <span style="color:#888">「' + b.txt + '」</span></div>';
  }
  box.innerHTML = h;
  document.documentElement.appendChild(box);
  document.title = 'BAD=' + bad.length;
})();
</script>
</body>
"""

for p in PAGES:
    src = os.path.join(BASE, p)
    if not os.path.exists(src):
        continue
    s = io.open(src, encoding="utf-8").read()
    s = s.replace("</body>", AUDIT_JS, 1)
    out = os.path.join(BASE, "_a_" + p)
    io.open(out, "w", encoding="utf-8").write(s)
    print("wrote", "_a_" + p)
print("done")
