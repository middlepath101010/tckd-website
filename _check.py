#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""站点静态自检：HTML 结构闭合、资源存在性、锚点/目标文件有效性、JSON-LD 合法性、双语文案配对。"""
import json
import os
import re
import sys
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.abspath(__file__))
PAGES = ["index.html", "process.html", "pricing.html", "about.html", "faq.html", "contact.html"]
# 站点自 2026-09-20 起为纯静态展示站：运单查询功能（含 /api/track 后端、data/ 私有数据）
# 与运费试算页（query.html）已彻底移除，不再参与导航互链与 SEO 体检。
NO_PUBLIC_ENTRY = set()

VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
        "param", "source", "track", "wbr"}
# 允许省略闭合的标签
OPTIONAL = {"li", "p", "tr", "td", "th", "thead", "tbody", "option", "dt", "dd"}

problems = []


class Checker(HTMLParser):
    def __init__(self, name):
        super().__init__(convert_charrefs=True)
        self.name = name
        self.stack = []
        self.ids = []
        self.assets = []
        self.hrefs = []
        self.zh = 0
        self.en = 0
        self.imgs_missing_alt = []
        self.titles = 0
        self.h1 = 0
        self.h2 = []
        self.headings = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if a.get("id"):
            self.ids.append(a["id"])
        if tag in ("img", "script", "link", "source"):
            src = a.get("src") or a.get("href") or ""
            if src and not src.startswith(("http", "//", "data:", "#")) and tag != "link":
                self.assets.append(src)
            if tag == "link" and a.get("rel") == "stylesheet" and a.get("href"):
                self.assets.append(a["href"])
            if tag == "img" and not a.get("alt"):
                self.imgs_missing_alt.append(a.get("src", "?"))
        if tag == "a" and a.get("href"):
            self.hrefs.append(a["href"])
        if tag == "title":
            self.titles += 1
        if re.fullmatch(r"h[1-6]", tag):
            self.headings.append(tag)
            if tag == "h1":
                self.h1 += 1
            if tag == "h2":
                self.h2.append(a.get("id", ""))
        cls = a.get("class", "")
        if "t-zh" in cls.split():
            self.zh += 1
        if "t-en" in cls.split():
            self.en += 1
        if tag not in VOID:
            self.stack.append(tag)

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        # 回退匹配，容忍隐式闭合
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i] == tag:
                if i != len(self.stack) - 1:
                    dropped = self.stack[i + 1:]
                    bad = [d for d in dropped if d not in OPTIONAL]
                    if bad:
                        problems.append("%s: <%s> 未闭合（被 <%s> 提前关闭）" % (self.name, ">, <".join(bad), tag))
                del self.stack[i:]
                return
        problems.append("%s: 出现多余的 </%s>" % (self.name, tag))


for page in PAGES:
    path = os.path.join(ROOT, page)
    if not os.path.exists(path):
        problems.append("%s: 文件不存在" % page)
        continue
    raw = open(path, encoding="utf-8").read()
    c = Checker(page)
    c.feed(raw)
    c.close()

    leftover = [t for t in c.stack if t not in OPTIONAL]
    if leftover:
        problems.append("%s: 结尾未闭合标签 %s" % (page, leftover))
    if c.titles != 1:
        problems.append("%s: <title> 数量为 %d" % (page, c.titles))
    if c.h1 != 1:
        problems.append("%s: <h1> 数量为 %d（应为 1）" % (page, c.h1))
    dup = [i for i in set(c.ids) if c.ids.count(i) > 1]
    if dup:
        problems.append("%s: 重复 id %s" % (page, dup))
    if c.zh != c.en:
        problems.append("%s: 双语标签不配对 .t-zh=%d .t-en=%d" % (page, c.zh, c.en))
    if c.imgs_missing_alt:
        problems.append("%s: 图片缺少 alt %s" % (page, c.imgs_missing_alt))

    # 资源文件存在性
    for asset in c.assets:
        if not os.path.exists(os.path.join(ROOT, asset)):
            problems.append("%s: 引用资源缺失 %s" % (page, asset))

    # 站内链接存在性
    for h in c.hrefs:
        if h.startswith(("http", "mailto:", "tel:", "//")):
            continue
        f, _, frag = h.partition("#")
        if not f:
            if frag and frag not in c.ids:
                problems.append("%s: 页内锚点 #%s 不存在" % (page, frag))
            continue
        target = os.path.join(ROOT, f)
        if not os.path.exists(target):
            problems.append("%s: 链接文件不存在 %s" % (page, h))
        elif frag:
            t = open(target, encoding="utf-8").read()
            if 'id="%s"' % frag not in t:
                problems.append("%s: 跨页锚点 %s 在目标页不存在" % (page, h))

    # JSON-LD
    for block in re.findall(r'<script type="application/ld\+json">(.*?)</script>', raw, re.S):
        try:
            data = json.loads(block)
        except Exception as e:
            problems.append("%s: JSON-LD 解析失败 %s" % (page, e))
            continue
        blob = json.dumps(data, ensure_ascii=False)
        for key in ('"url"', '"logo"', '"image"', '"item"'):
            for m in re.finditer(re.escape(key) + r'\s*:\s*"([^"]*)"', blob):
                if not m.group(1).startswith(("http://", "https://")):
                    problems.append("%s: JSON-LD %s 非完整 URL: %s" % (page, key, m.group(1)))

# --------------------------------------------------------------------------
# 导航一致性：全站页头导航 / 移动菜单 / 页脚快速导航必须逐项一致
# --------------------------------------------------------------------------


def nav_hrefs(raw, pattern):
    return re.findall(pattern, raw)


def footer_hrefs(raw):
    """取页脚「快速导航」列中的链接。"""
    m = re.search(r"快速导航.*?</ul>", raw, re.S)
    if not m:
        return []
    return re.findall(r'<li><a href="([^"]+)"', m.group(0))


KEYWORDS = {"zh": "快速导航"}

nav_map = {}
mobile_map = {}
foot_map = {}
for page in PAGES:
    path = os.path.join(ROOT, page)
    if not os.path.exists(path):
        continue
    raw = open(path, encoding="utf-8").read()
    nav_map[page] = nav_hrefs(raw, r'<a class="tcd-nav__link[^"]*" href="([^"]+)"')
    mobile_map[page] = nav_hrefs(raw, r'<a class="tcd-mobile__link" href="([^"]+)"')
    foot_map[page] = footer_hrefs(raw)

for label, mapping in (("页头导航", nav_map), ("移动菜单", mobile_map), ("页脚快速导航", foot_map)):
    ref_page = PAGES[0]
    ref = mapping.get(ref_page, [])
    if not ref:
        problems.append("%s: 在 %s 中未取到任何链接（选择器可能已失效）" % (label, ref_page))
        continue
    for page, links in mapping.items():
        if links != ref:
            miss = [h for h in ref if h not in links]
            extra = [h for h in links if h not in ref]
            detail = []
            if miss:
                detail.append("缺少 %s" % miss)
            if extra:
                detail.append("多出 %s" % extra)
            if not detail:
                detail.append("顺序不一致")
            problems.append("%s: %s 与 %s 不一致（%s）" % (label, page, ref_page, "；".join(detail)))

# 每个页面都应能直达其余每个页面（页面级互链完整）
for page in PAGES:
    path = os.path.join(ROOT, page)
    if not os.path.exists(path):
        continue
    raw = open(path, encoding="utf-8").read()
    for other in PAGES:
        if other == page or other in NO_PUBLIC_ENTRY:
            continue
        if ('href="%s"' % other) not in raw:
            problems.append("%s: 缺少指向 %s 的链接" % (page, other))

# ---- SEO：canonical / hreflang 自洽与中英互链（2026-09-20 增） ----
# 血泪教训：构建脚本曾把 hreflang 全部写成 https://feisugo.com/False.html，
# 中英配对彻底失效但页面照常能看，肉眼查不出来。此处强制体检。
SEO_BASE = "https://feisugo.com/"


def seo_slugs(rel):
    """由文件相对路径推出 (中文 slug, 英文 slug)，index 视为目录根。"""
    if rel.startswith("en/"):
        name = rel[3:]
        return ("" if name == "index.html" else name,
                "en/" if name == "index.html" else "en/" + name)
    return ("" if rel == "index.html" else rel,
            "en/" if rel == "index.html" else "en/" + rel)


for rel in PAGES + ["en/" + p for p in PAGES]:
    path = os.path.join(ROOT, rel)
    if not os.path.exists(path):
        problems.append("SEO: 缺少页面 %s" % rel)
        continue
    raw = open(path, encoding="utf-8").read()
    zh_slug, en_slug = seo_slugs(rel)
    zh_url, en_url = SEO_BASE + zh_slug, SEO_BASE + en_slug
    self_url = en_url if rel.startswith("en/") else zh_url
    want = {
        "canonical": '<link rel="canonical" href="%s">' % self_url,
        "hreflang zh-CN": '<link rel="alternate" hreflang="zh-CN" href="%s">' % zh_url,
        "hreflang en": '<link rel="alternate" hreflang="en" href="%s">' % en_url,
        "hreflang x-default": '<link rel="alternate" hreflang="x-default" href="%s">' % en_url,
    }
    for key, needle in want.items():
        if needle not in raw:
            problems.append("SEO: %s 的 %s 不正确，应为 %s" % (rel, key, needle))
    if "__SITE_URL__" in raw:
        problems.append("SEO: %s 仍残留 __SITE_URL__ 占位" % rel)
    if "False.html" in raw or "None.html" in raw:
        problems.append("SEO: %s 存在构建脚本残留链接" % rel)

print("检查页面：%s" % ", ".join(PAGES))
if problems:
    print("\n发现 %d 个问题：" % len(problems))
    for p in problems:
        print("  ✗ " + p)
    sys.exit(1)
print("\n✓ 全部检查通过：标签闭合、资源齐全、锚点有效、双语配对、JSON-LD 合法、三处导航全站一致。")
