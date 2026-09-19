/* ==========================================================================
   同城快递 TC EXPRESS · 全站交互脚本
   1) 中英双语切换（记忆在 localStorage；仅切换 <html lang>，文字由 CSS 控制显隐）
   2) 移动端导航开合
   3) 页头滚动加深阴影
   4) 常见问题：分组筛选 + 手风琴
   5) 一键复制（微信号 / 电话）
   6) 运费试算器（体积重 ÷6000 · 空运 420P/KG · 海运 150/130/100 阶梯）
   7) 运单查询（前端演示态，接真实接口时替换 renderTrack）
   8) 派送区域速查（免费区 / 打车到付）
   ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------
     1. 语言切换
     ------------------------------------------------------------------ */
  var LANG_KEY = 'tcd_lang';

  function applyLang(lang) {
    var html = document.documentElement;
    html.setAttribute('lang', lang === 'en' ? 'en' : 'zh-CN');
    html.setAttribute('data-lang', lang);

    var zhBtn = document.querySelector('[data-lang-btn="zh"]');
    var enBtn = document.querySelector('[data-lang-btn="en"]');
    if (zhBtn) zhBtn.classList.toggle('is-on', lang !== 'en');
    if (enBtn) enBtn.classList.toggle('is-on', lang === 'en');

    // 同步页面标题（若声明了 data-title-en）
    var enTitle = html.getAttribute('data-title-en');
    var zhTitle = html.getAttribute('data-title-zh');
    if (enTitle && zhTitle) {
      document.title = lang === 'en' ? enTitle : zhTitle;
    }
  }

  function initLang() {
    // 默认语言取页面自身声明的 data-lang（中文页=zh，英文页=en），
    // 避免英文页被硬编码默认值强制切回中文（会影响 Googlebot 渲染）。
    var htmlEl = document.documentElement;
    var saved = htmlEl.getAttribute('data-lang') || 'zh';
    try { saved = localStorage.getItem(LANG_KEY) || saved; } catch (e) { /* 隐私模式忽略 */ }
    applyLang(saved);

    document.querySelectorAll('[data-lang-btn]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var lang = btn.getAttribute('data-lang-btn');
        try { localStorage.setItem(LANG_KEY, lang); } catch (e) { /* 忽略 */ }
        applyLang(lang);
      });
    });
  }

  /* ------------------------------------------------------------------
     2. 移动端导航
     ------------------------------------------------------------------ */
  function initMobileNav() {
    var burger = document.querySelector('.tcd-burger');
    var panel = document.querySelector('.tcd-mobile');
    if (!burger || !panel) return;

    burger.addEventListener('click', function () {
      var open = panel.classList.toggle('is-open');
      burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    panel.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () {
        panel.classList.remove('is-open');
        burger.setAttribute('aria-expanded', 'false');
      });
    });
  }

  /* ------------------------------------------------------------------
     3. 页头滚动效果
     ------------------------------------------------------------------ */
  function initStickyHeader() {
    var header = document.querySelector('.tcd-header');
    if (!header) return;
    var onScroll = function () {
      header.classList.toggle('is-stuck', window.scrollY > 8);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  /* ------------------------------------------------------------------
     4. 常见问题：筛选 + 手风琴
     ------------------------------------------------------------------ */
  function initFaq() {
    var list = document.querySelector('.tcd-faq');
    if (!list) return;

    var items = Array.prototype.slice.call(list.querySelectorAll('.tcd-faq__item'));
    var chips = Array.prototype.slice.call(document.querySelectorAll('.tcd-chip[data-filter]'));

    // 手风琴：展开时收起同组其它项
    items.forEach(function (item) {
      var q = item.querySelector('.tcd-faq__q');
      var a = item.querySelector('.tcd-faq__a');
      if (!q || !a) return;
      q.setAttribute('aria-expanded', item.classList.contains('is-open') ? 'true' : 'false');
      if (!item.classList.contains('is-open')) a.hidden = true;

      q.addEventListener('click', function () {
        var willOpen = !item.classList.contains('is-open');
        items.forEach(function (other) {
          other.classList.remove('is-open');
          var oa = other.querySelector('.tcd-faq__a');
          var oq = other.querySelector('.tcd-faq__q');
          if (oa) oa.hidden = true;
          if (oq) oq.setAttribute('aria-expanded', 'false');
        });
        if (willOpen) {
          item.classList.add('is-open');
          a.hidden = false;
          q.setAttribute('aria-expanded', 'true');
        }
      });
    });

    if (!chips.length) return;

    chips.forEach(function (chip) {
      chip.addEventListener('click', function () {
        var cat = chip.getAttribute('data-filter');
        chips.forEach(function (c) { c.classList.toggle('is-on', c === chip); });

        items.forEach(function (item) {
          var show = cat === 'all' || item.getAttribute('data-cat') === cat;
          item.hidden = !show;
        });

        // 按分类标题分组时同步隐藏空分组
        document.querySelectorAll('.tcd-faq__group-title').forEach(function (t) {
          var g = t.getAttribute('data-group');
          var visible = items.some(function (item) {
            return !item.hidden && item.getAttribute('data-cat') === g;
          });
          t.hidden = !visible;
        });
      });
    });
  }

  /* ------------------------------------------------------------------
     5. 一键复制（微信号 / 号码）
     ------------------------------------------------------------------ */
  function initCopy() {
    var btns = document.querySelectorAll('[data-copy]');
    if (!btns.length) return;

    function fallback(text) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) { /* 忽略 */ }
      document.body.removeChild(ta);
    }

    btns.forEach(function (btn) {
      var original = btn.innerHTML;
      btn.addEventListener('click', function () {
        var text = btn.getAttribute('data-copy');
        var done = function () {
          btn.innerHTML = '<span class="t-zh">已复制 ✓</span><span class="t-en">Copied ✓</span>';
          btn.disabled = true;
          setTimeout(function () { btn.innerHTML = original; btn.disabled = false; }, 1800);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, function () { fallback(text); done(); });
        } else {
          fallback(text);
          done();
        }
      });
    });
  }

  /* ------------------------------------------------------------------
     6. 运费试算器（纯前端估算：体积重 ÷6000，空运 420P/KG，海运阶梯）
     ------------------------------------------------------------------ */
  // 业务参数集中在此，方便后续调整（单位：菲律宾比索 P）
  var PRICE = {
    air: 420,                                  // 空运每公斤
    sea: [{ max: 30, unit: 150 }, { max: 50, unit: 130 }, { max: Infinity, unit: 100 }],
    diviser: 6000,                             // 体积重系数：长×宽×高÷6000
    minKg: 1,                                  // 一公斤起寄
    insuranceRate: 0.05                        // 保价费率 5%
  };

  function num(el) {
    var v = parseFloat(el && el.value);
    return isFinite(v) && v > 0 ? v : 0;
  }
  function n1(v) { return (Math.round(v * 10) / 10).toFixed(1); }
  function comma(v) { return Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function pickLang(zh, en) {
    return '<span class="t-zh">' + zh + '</span><span class="t-en">' + en + '</span>';
  }

  function initQuote() {
    var form = document.getElementById('tcdQuoteForm');
    if (!form) return;

    var box = document.getElementById('tcdQuoteResult');
    var rows = document.getElementById('tcdQuoteRows');
    // 分项输出位
    var out = {
      pieces: document.getElementById('tcdQpieces'),
      volume: document.getElementById('tcdQvolume'),
      actual: document.getElementById('tcdQactual'),
      billable: document.getElementById('tcdQbillable'),
      unit: document.getElementById('tcdQunit'),
      total: document.getElementById('tcdQtotal'),
      ins: document.getElementById('tcdQinsurance'),
      insRow: document.getElementById('tcdQinsuranceRow'),
      tag: document.getElementById('tcdQtag')
    };

    form.addEventListener('submit', function (e) {
      e.preventDefault();

      var pieces = Math.max(1, Math.round(num(document.getElementById('tcdQPieces')) || 1));
      var L = num(document.getElementById('tcdQLength'));
      var W = num(document.getElementById('tcdQWidth'));
      var H = num(document.getElementById('tcdQHeight'));
      var actual = num(document.getElementById('tcdQWeight'));
      var value = num(document.getElementById('tcdQValue'));
      var serviceEl = form.querySelector('input[name="tcdService"]:checked');
      var service = serviceEl ? serviceEl.value : 'air';

      if (!L || !W || !H || !actual) {
        out.tag.innerHTML = pickLang('请填写长、宽、高与实际重量', 'Enter length, width, height and actual weight');
        box.hidden = false;
        rows.hidden = true;
        return;
      }

      var volumePer = (L * W * H) / PRICE.diviser;
      var volumeTotal = volumePer * pieces;
      var billable = Math.max(actual, volumeTotal, PRICE.minKg);
      billable = Math.round(billable * 10) / 10;

      var unit, unitText;
      if (service === 'air') {
        unit = PRICE.air;
        unitText = '420 P/KG';
      } else {
        unit = PRICE.sea[PRICE.sea.length - 1].unit;
        for (var i = 0; i < PRICE.sea.length; i++) {
          if (billable <= PRICE.sea[i].max) { unit = PRICE.sea[i].unit; break; }
        }
        unitText = unit + ' P/KG';
      }

      var freight = billable * unit;
      var insurance = value > 0 ? value * PRICE.insuranceRate : 0;

      out.pieces.textContent = pieces + ' × ' + L + '×' + W + '×' + H + ' CM';
      out.volume.textContent = n1(volumeTotal) + ' KG';
      out.actual.textContent = n1(actual) + ' KG';
      out.billable.textContent = n1(billable) + ' KG';
      out.unit.textContent = unitText;
      out.total.innerHTML = 'P ' + comma(freight) +
        ' <em>' + pickLang('按 ' + n1(billable) + ' KG 估算', 'estimated on ' + n1(billable) + ' kg') + '</em>';
      if (insurance > 0) {
        out.insRow.hidden = false;
        out.ins.innerHTML = 'P ' + comma(insurance) +
          ' <em>' + pickLang('货值 5% · 选填', '5% of declared value · optional') + '</em>';
      } else {
        out.insRow.hidden = true;
      }
      out.tag.innerHTML = volumeTotal > actual
        ? pickLang('本次按体积重计费', 'Charged by volumetric weight')
        : pickLang('本次按实际重量计费', 'Charged by actual weight');

      rows.hidden = false;
      box.hidden = false;
      box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  /* ------------------------------------------------------------------
     7. 运单查询（真实接口 /api/track；后端只回传匹配行，且仅含物流状态）
        收件人与货物属于冒领三件套，接口与前端一律不展示。
     ------------------------------------------------------------------ */
  function initTrack() {
    var form = document.getElementById('tcdTrackForm');
    if (!form) return;

    var input = document.getElementById('tcdTrackInput');
    var box = document.getElementById('tcdTrackResult');
    var numEl = document.getElementById('tcdTrackNum');
    var listEl = document.getElementById('tcdTrackList');
    var tagEl = document.getElementById('tcdTrackTag');
    var meta = document.getElementById('tcdTrackMeta');
    var noticeEl = document.getElementById('tcdTrackNotice');
    var stepsEl = document.getElementById('tcdTrackSteps');
    var latestEl = document.getElementById('tcdTrackLatest');
    var timeEl = document.getElementById('tcdTrackTime');

    // 运单状态五个阶段（与数据源「状态」列对应，顺序即流转顺序）
    var STAGES_ZH = ['国内仓库签收', '国内发货', '已发出在途', '菲律宾到仓', '打包待派送'];
    var STAGES_EN = ['Received at China warehouse', 'Dispatched from China', 'In transit',
      'Arrived at PH warehouse', 'Packed for delivery'];

    function stageIndex(status) {
      var s = String(status || '');
      for (var i = STAGES_ZH.length - 1; i >= 0; i--) {
        if (s.indexOf(STAGES_ZH[i]) !== -1) return i;
      }
      return -1;
    }

    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }

    function showError(msgZh, msgEn) {
      numEl.textContent = '';
      meta.hidden = true;
      if (noticeEl) noticeEl.hidden = true;
      if (stepsEl) stepsEl.hidden = true;
      tagEl.innerHTML = pickLang('查询失败', 'Lookup failed');
      listEl.innerHTML = '<li class="tcd-track__item"><div class="tcd-track__k">' +
        esc(pickLang(msgZh, msgEn)) + '</div></li>';
      box.hidden = false;
      box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var no = (input.value || '').trim();

      if (!no) { showError('请输入国内快递单号', 'Enter your domestic courier number'); return; }
      if (!/^[A-Za-z0-9\-]{4,60}$/.test(no)) { showError('单号格式不正确', 'Invalid number'); return; }

      numEl.textContent = no;
      tagEl.innerHTML = pickLang('查询中…', 'Looking up…');
      meta.hidden = true;
      if (noticeEl) noticeEl.hidden = true;
      if (stepsEl) stepsEl.hidden = true;
      listEl.innerHTML = '';
      box.hidden = false;

      var url = '/api/track?no=' + encodeURIComponent(no);
      fetch(url, { headers: { 'Accept': 'application/json' } })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (res) {
          var d = res.data || {};
          if (!d.found) {
            showError('未查询到该单号，请核对后重试；或加微信 TONGCHENGKD2018 人工查询',
                      'No record found — check the number or message TONGCHENGKD2018 on WeChat');
            return;
          }

          tagEl.textContent = d.status || '';
          latestEl.textContent = d.latest || '—';
          timeEl.textContent = d.updated_at || '—';
          meta.hidden = false;

          // 五阶段进度条：按「状态」列定位当前阶段，已完成 / 当前 / 未到达
          var si = stageIndex(d.status);
          if (stepsEl) {
            if (si >= 0) {
              stepsEl.innerHTML = STAGES_ZH.map(function (z, i) {
                var cls = i < si ? ' is-done' : (i === si ? ' is-now' : '');
                return '<li class="tcd-step' + cls + '">' +
                  '<span class="tcd-step__n">' + (i + 1) + '</span>' +
                  '<span class="tcd-step__k">' +
                  '<span class="t-zh">' + z + '</span>' +
                  '<span class="t-en">' + esc(STAGES_EN[i]) + '</span>' +
                  '</span></li>';
              }).join('');
              stepsEl.hidden = false;
            } else {
              stepsEl.hidden = true;
            }
          }

          // 已分配 TC 运单号的票，顺带提示客户这个号（未分配时不显示）
          if (noticeEl) {
            if (d.tcd_no) {
              noticeEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg><span>' +
                '<span class="t-zh">您的 TC 运单号已生成：<strong>' + esc(d.tcd_no) + '</strong>。以下为物流状态。</span>' +
                '<span class="t-en">Your TC tracking number is <strong>' + esc(d.tcd_no) + '</strong>. Below is the logistics status.</span>' +
                '</span>';
              noticeEl.hidden = false;
            } else {
              noticeEl.hidden = true;
            }
          }

          var items = (d.timeline && d.timeline.length ? d.timeline : []).slice().reverse();
          listEl.innerHTML = items.map(function (ev, i) {
            var cls = ' is-done' + (i === 0 ? ' is-now' : '');
            return '<li class="tcd-track__item' + cls + '">' +
              '<div class="tcd-track__k">' + esc(ev.node || '') + '</div>' +
              (ev.time ? '<div class="tcd-track__t">' + esc(ev.time) + '</div>' : '') +
              '</li>';
          }).join('');
          box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        })
        .catch(function () {
          showError('网络异常，请稍后重试', 'Network error, please retry');
        });
    });
  }

  /* ------------------------------------------------------------------
     8. 派送区域速查（免费区 / 非免费区）
     ------------------------------------------------------------------ */
  var FREE_AREAS = ['makati', 'pasay', 'bgc', 'taguig', 'mandaluyong', 'paranaque', 'parañaque',
    '马卡蒂', '马卡提', '帕塞', '帕赛', '达义', '塔吉格', '曼达卢永', '帕拉尼亚克', '帕拉纳克', '博尼法西奥'];

  function initZone() {
    var form = document.getElementById('tcdZoneForm');
    if (!form) return;

    var input = document.getElementById('tcdZoneInput');
    var ans = document.getElementById('tcdZoneAnswer');

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var q = (input.value || '').trim().toLowerCase();
      if (!q) { ans.hidden = true; return; }

      var hit = FREE_AREAS.some(function (k) { return q.indexOf(k) !== -1 || k.indexOf(q) !== -1; });
      ans.className = 'tcd-answer ' + (hit ? 'tcd-answer--yes' : 'tcd-answer--no');
      ans.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        (hit ? '<circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/>'
             : '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>') +
        '</svg><span>' +
        (hit
          ? '<b>' + pickLang('免费派送区域', 'Free delivery area') + '</b>' +
            pickLang('该区域在免费派送范围内，派送到门不额外收费。', 'This area is in our free delivery zone — door delivery at no extra charge.')
          : '<b>' + pickLang('非免费派送区域', 'Outside the free delivery area') + '</b>' +
            pickLang('不在免费区域内，采用打车配送，<strong>车费由收件人到付</strong>。具体费用与客服确认。', 'Outside the free zone we deliver by ride-hailing, with the <strong>fare paid by the recipient on delivery</strong>. Ask our team for the exact cost.')) +
        '</span>';
      ans.hidden = false;
    });
  }

  /* ------------------------------------------------------------------
     启动
     ------------------------------------------------------------------ */
  function boot() {
    initLang();
    initMobileNav();
    initStickyHeader();
    initFaq();
    initCopy();
    initQuote();
    initTrack();
    initZone();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
