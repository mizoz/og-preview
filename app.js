(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var STORE = 'og-preview:v1';
  var SELF = location.origin + location.pathname;

  var GEN_FIELDS = ['gUrl', 'gTitle', 'gDesc', 'gSite', 'gType', 'gImg', 'gImgW', 'gImgH', 'gImgAlt', 'gCard', 'gHandle', 'gColor', 'gLocale'];
  var mode = 'check';
  var lastData = null;
  var localImg = null; // {src,w,h} from the file picker, preview only
  var imgCache = {};

  // ---------- helpers ----------
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (attrs[k] == null || attrs[k] === false) continue;
      if (k === 'class') el.className = attrs[k];
      else if (k === 'text') el.textContent = attrs[k];
      else if (k === 'style') el.style.cssText = attrs[k];
      else el.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) {
      if (c == null || c === false) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }
  function load() { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch (e) { return {}; } }
  function save(patch) {
    try {
      var s = load();
      for (var k in patch) s[k] = patch[k];
      localStorage.setItem(STORE, JSON.stringify(s));
    } catch (e) { /* private mode or full */ }
  }
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('show'); }, 1800);
  }
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(function () { toast('Copied'); });
    var ta = h('textarea', { style: 'position:fixed;opacity:0' }); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Copied'); } catch (e) { toast('Copy failed, select and copy by hand'); }
    ta.remove();
    return Promise.resolve();
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function abs(u, base) {
    if (!u) return '';
    try { return new URL(u, base || undefined).href; } catch (e) { return ''; }
  }
  function host(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }
  function safeImg(u) { return /^(https?:|data:image\/|blob:)/i.test(u) ? u : ''; }
  function isAbsHttp(u) { return /^https?:\/\//i.test(u); }

  var canvas = document.createElement('canvas').getContext('2d');
  function textWidth(text, font) { canvas.font = font; return canvas.measureText(text).width; }
  function fitWidth(text, font, max) {
    var w = textWidth(text, font);
    if (w <= max) return { text: text, cut: false, w: w };
    var lo = 0, hi = text.length, ell = ' ...';
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (textWidth(text.slice(0, mid).trimEnd() + ell, font) <= max) lo = mid; else hi = mid - 1;
    }
    var cut = text.slice(0, lo);
    var sp = cut.lastIndexOf(' ');
    if (sp > lo * 0.6) cut = cut.slice(0, sp);
    return { text: cut.trimEnd() + ell, cut: true, w: w, kept: cut.trimEnd().length };
  }

  // ---------- parsing ----------
  function parse(html, pageUrl) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var d = { titles: [], metas: [], links: [], jsonld: [], all: [] };
    doc.querySelectorAll('title').forEach(function (t) {
      if (t.closest('svg')) return;
      var v = t.textContent.trim(); d.titles.push(v); d.all.push(['<title>', v]);
    });
    doc.querySelectorAll('meta').forEach(function (m) {
      var prop = m.getAttribute('property'), name = m.getAttribute('name');
      var key = (prop || name || '').trim().toLowerCase();
      if (!key) return;
      var v = (m.getAttribute('content') || '').trim();
      d.metas.push({ key: key, attr: prop ? 'property' : 'name', value: v });
      d.all.push([(prop ? 'property=' : 'name=') + key, v]);
    });
    doc.querySelectorAll('link[rel]').forEach(function (l) {
      var rel = l.getAttribute('rel').toLowerCase().trim();
      if (!/canonical|icon|alternate|manifest/.test(rel)) return;
      var v = l.getAttribute('href') || '';
      d.links.push({ rel: rel, href: v, sizes: l.getAttribute('sizes') || '', hreflang: l.getAttribute('hreflang') || '' });
      d.all.push(['link rel=' + rel, v]);
    });
    doc.querySelectorAll('script[type="application/ld+json"]').forEach(function (s) {
      var txt = s.textContent.trim(), item = { ok: true, types: [] };
      try {
        var j = JSON.parse(txt);
        var walk = function (o) {
          if (!o || typeof o !== 'object') return;
          if (Array.isArray(o)) { o.forEach(walk); return; }
          if (o['@type']) item.types = item.types.concat(o['@type']);
          if (o['@graph']) walk(o['@graph']);
        };
        walk(j);
      } catch (e) { item.ok = false; item.err = e.message; }
      d.jsonld.push(item);
      d.all.push(['JSON-LD', item.ok ? (item.types.join(', ') || '(no @type)') : 'invalid JSON']);
    });
    var baseEl = doc.querySelector('base[href]');
    d.lang = (doc.documentElement.getAttribute('lang') || '');
    d.get = function (k) { for (var i = 0; i < d.metas.length; i++) if (d.metas[i].key === k) return d.metas[i].value; return ''; };
    d.has = function (k) { return d.metas.some(function (m) { return m.key === k; }); };
    d.link = function (r) { for (var i = 0; i < d.links.length; i++) if (d.links[i].rel === r) return d.links[i].href; return ''; };

    var canonicalRaw = d.link('canonical');
    var base = pageUrl || abs(d.get('og:url')) || abs(canonicalRaw) || '';
    if (baseEl) base = abs(baseEl.getAttribute('href'), base || undefined) || base;
    d.base = base;

    var icon = '';
    ['icon', 'shortcut icon', 'apple-touch-icon'].some(function (r) { icon = d.link(r); return !!icon; });
    if (!icon) d.links.some(function (l) { if (/icon/.test(l.rel)) { icon = l.href; return true; } });

    var m = {
      title: d.titles[0] || '',
      desc: d.get('description'),
      ogTitle: d.get('og:title'), ogDesc: d.get('og:description'),
      ogImageRaw: d.get('og:image') || d.get('og:image:url') || d.get('og:image:secure_url'),
      ogUrl: d.get('og:url'), site: d.get('og:site_name'), type: d.get('og:type'),
      imgW: parseInt(d.get('og:image:width'), 10) || 0, imgH: parseInt(d.get('og:image:height'), 10) || 0,
      imgAlt: d.get('og:image:alt'),
      twCard: d.get('twitter:card').toLowerCase(), twTitle: d.get('twitter:title'), twDesc: d.get('twitter:description'),
      twImageRaw: d.get('twitter:image') || d.get('twitter:image:src'), twSite: d.get('twitter:site'),
      canonicalRaw: canonicalRaw, iconRaw: icon,
      theme: d.get('theme-color'), robots: d.get('robots')
    };
    m.ogImage = abs(m.ogImageRaw, base || undefined);
    m.twImage = abs(m.twImageRaw, base || undefined);
    m.canonical = abs(canonicalRaw, base || undefined);
    m.pageUrl = base || m.canonical;
    m.domain = host(m.pageUrl) || host(m.ogImage) || 'example.com';
    m.favicon = icon ? abs(icon, base || undefined) : (m.pageUrl ? abs('/favicon.ico', m.pageUrl) : '');
    m.cardTitle = m.ogTitle || m.twTitle || m.title;
    m.cardDesc = m.ogDesc || m.twDesc || m.desc;
    m.cardImg = m.ogImage || m.twImage;
    m.xTitle = m.twTitle || m.ogTitle || m.title;
    m.xDesc = m.twDesc || m.ogDesc || m.desc;
    m.xImg = m.twImage || m.ogImage;
    d.m = m;
    return d;
  }

  // ---------- image measuring ----------
  function measure(src, cb) {
    if (!src) return cb(null);
    if (imgCache[src]) { if (imgCache[src].done) cb(imgCache[src]); else imgCache[src].cbs.push(cb); return; }
    var rec = imgCache[src] = { done: false, cbs: [cb] };
    var im = new Image();
    var fin = function (ok) {
      rec.done = true; rec.ok = ok; rec.w = ok ? im.naturalWidth : 0; rec.h = ok ? im.naturalHeight : 0;
      rec.cbs.forEach(function (f) { f(rec); }); rec.cbs = [];
    };
    im.onload = function () { fin(true); };
    im.onerror = function () { fin(false); };
    im.referrerPolicy = 'no-referrer';
    im.src = src;
    // file size only works when the image host allows CORS; most don't, that's fine
    if (/^https?:/i.test(src) && window.fetch) {
      fetch(src, { method: 'HEAD', mode: 'cors', credentials: 'omit' }).then(function (r) {
        var n = parseInt(r.headers.get('content-length'), 10);
        if (n) { rec.bytes = n; if (rec.done && lastData) render(lastData); }
      }).catch(function () {});
    }
  }
  function imgInfo(m) {
    if (localImg) return { ok: true, w: localImg.w, h: localImg.h, local: true, done: true };
    return m.cardImg ? imgCache[m.cardImg] : null;
  }
  function imgSrc(m, which) {
    if (localImg) return localImg.src;
    return safeImg(which === 'x' ? m.xImg : m.cardImg);
  }

  // ---------- checks ----------
  var DESC_PX = 1000; // two lines of a ~600px snippet, observed, not official
  var MULTI_OK = /^(theme-color|og:image(:.*)?|og:locale:alternate|article:tag|article:author|og:video(:.*)?|og:audio(:.*)?|book:tag|music:.*|video:tag|video:actor)$/;
  function fmtKB(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB'; }

  function runChecks(d) {
    var m = d.m, out = [];
    var add = function (sev, msg, fix) { out.push({ sev: sev, msg: msg, fix: fix || '' }); };

    // image
    if (!m.ogImageRaw && !d.has('og:image')) {
      if (m.twImageRaw) add('warn', 'No og:image, only twitter:image.', 'LinkedIn, Facebook, Slack and WhatsApp read og:image. Add <meta property="og:image" content="https://..."> with the same image.');
      else add('bad', 'No og:image. Most apps will show no picture, or pick a random one from the page.', 'Add a 1200 x 630 image: <meta property="og:image" content="https://yoursite.com/share.png">');
    } else if (!m.ogImageRaw) {
      add('bad', 'og:image is empty.', 'Put the full image URL in the content attribute.');
    } else {
      if (/^\/\//.test(m.ogImageRaw)) add('warn', 'og:image is protocol-relative (' + m.ogImageRaw + ').', 'Write it out with https:// in front. Some crawlers do not resolve //.');
      else if (!isAbsHttp(m.ogImageRaw) && !/^data:/.test(m.ogImageRaw)) add('bad', 'og:image is a relative URL (' + m.ogImageRaw + ').', 'Use the full absolute URL: ' + (m.ogImage && isAbsHttp(m.ogImage) ? m.ogImage : 'https://yoursite.com' + (m.ogImageRaw.charAt(0) === '/' ? '' : '/') + m.ogImageRaw) + '. Crawlers often ignore relative paths.');
      else if (/^http:/i.test(m.ogImageRaw)) add('warn', 'og:image uses http, not https.', 'Serve the image over https. Some apps skip insecure images.');
      if (/^data:/.test(m.ogImageRaw)) add('bad', 'og:image is a data: URI.', 'Crawlers need a real URL they can download. Upload the image and link to it.');
    }
    if (m.twImageRaw && !isAbsHttp(m.twImageRaw)) add('bad', 'twitter:image is not an absolute URL (' + m.twImageRaw + ').', 'Use the full https:// URL, or remove twitter:image and let X use og:image.');

    var info = imgInfo(m);
    if (m.cardImg || localImg) {
      if (!info || !info.done) add('info', 'Loading the image to measure it...', '');
      else if (!info.ok) add('bad', 'The image could not be loaded: ' + m.cardImg, 'Check the URL opens in a private window. If it needs a login, sits behind hotlink protection or blocks bots, platforms can\'t fetch it either.');
      else {
        var w = info.w, ht = info.h, r = w / ht, lbl = (info.local ? 'Local test image is ' : 'Image is ') + w + ' x ' + ht + ' px';
        if (w < 200 || ht < 200) add('bad', lbl + '. That is below Facebook\'s 200 x 200 minimum.', 'Use a 1200 x 630 image.');
        else if (w < 1200 || ht < 627) add('warn', lbl + '. LinkedIn asks for at least 1200 x 627' + (w < 401 ? ', and shows images under 401 px wide as a small thumbnail' : '') + '.', 'Export the image at 1200 x 630.');
        if (Math.abs(r - 1.91) > 0.12 && w >= 200 && ht >= 200) {
          add('warn', lbl + ', a ' + r.toFixed(2) + ':1 ratio. Cards are about 1.91:1, so this gets cropped' + (r < 1.5 ? ' a lot (top and bottom cut off)' : '') + '.', 'Use 1200 x 630 and keep text and logos inside the middle.');
        } else if (w >= 1200 && ht >= 627) add('ok', lbl + ', ratio ' + r.toFixed(2) + ':1. Good for every platform.', '');
        if (m.twCard === 'summary' && Math.abs(r - 1) > 0.1) add('info', 'twitter:card is "summary", so X crops the image to a small square.', 'Use summary_large_image for a wide image, or give X a square twitter:image.');
        if (!info.local && (m.imgW || m.imgH) && (m.imgW !== w || m.imgH !== ht)) add('warn', 'og:image:width/height say ' + m.imgW + ' x ' + m.imgH + ' but the image is ' + w + ' x ' + ht + '.', 'Update the two tags to the real size, or remove them.');
        if (info.bytes) {
          if (info.bytes > 5 * 1048576) add('bad', 'Image file is ' + fmtKB(info.bytes) + '. LinkedIn and X cap images at 5 MB.', 'Compress it (JPG at 80% quality is usually under 300 KB).');
          else if (info.bytes > 300 * 1024) add('info', 'Image file is ' + fmtKB(info.bytes) + '. WhatsApp often skips large preview images.', 'Recommended: keep it around 300 KB or less.');
        }
      }
      if (!info || !info.local) {
        if (!m.imgW || !m.imgH) add('info', 'No og:image:width / og:image:height.', 'Add them (e.g. 1200 and 630). Facebook can then show the image on the very first share instead of waiting to download it.');
        if (!m.imgAlt) add('info', 'No og:image:alt.', 'Describe the image in a short sentence for screen reader users.');
      }
    }

    // title
    if (!d.titles.length) add('bad', 'No <title> tag.', 'Add <title>Your page title</title>. Google and every app fall back to it.');
    else if (d.titles.length > 1) add('bad', d.titles.length + ' <title> tags.', 'Keep exactly one.');
    var gt = m.title || m.ogTitle;
    if (gt) {
      var ft = fitWidth(gt, '20px Arial', 600);
      if (ft.cut) add('warn', 'Title is ' + gt.length + ' characters and about ' + Math.round(ft.w) + ' px wide. Google cuts it near 600 px, after about ' + ft.kept + ' characters.', 'Put the important words first, or shorten it to around 55 characters.');
      else if (gt.length < 15) add('info', 'Title is short (' + gt.length + ' characters).', 'You have room: around 50 to 60 characters fits Google.');
      else add('ok', 'Title fits Google (' + gt.length + ' characters, about ' + Math.round(ft.w) + ' px).', '');
    }
    if (!m.ogTitle) add('warn', 'No og:title.', 'Apps fall back to <title>, which often includes your site name. Add <meta property="og:title" content="..."> with a cleaner headline.');
    else if (m.ogTitle.length > 90) add('info', 'og:title is ' + m.ogTitle.length + ' characters.', 'Cards show one or two lines. Under about 70 characters is safest.');

    // description
    if (!m.desc) add('warn', 'No meta description.', 'Add <meta name="description" content="..."> with one or two sentences (about 150 characters). Google may still pick its own text.');
    else {
      var fd = fitWidth(m.desc, '14px Arial', DESC_PX);
      if (fd.cut) add('warn', 'Meta description is ' + m.desc.length + ' characters. Google usually cuts it after about ' + fd.kept + '.', 'Trim to about 150 characters, with the point up front.');
      else if (m.desc.length < 50) add('info', 'Meta description is short (' + m.desc.length + ' characters).', 'Aim for 110 to 160 characters.');
      else add('ok', 'Meta description length is fine (' + m.desc.length + ' characters).', '');
    }
    if (!m.ogDesc) add('warn', 'No og:description.', 'Add <meta property="og:description" content="...">. Facebook and LinkedIn may otherwise pull random text from the page.');

    // X
    var cards = ['summary', 'summary_large_image', 'app', 'player'];
    if (!d.has('twitter:card')) add('warn', 'No twitter:card.', 'Add <meta name="twitter:card" content="summary_large_image">. X falls back to og:title, og:description and og:image for the rest.');
    else if (cards.indexOf(m.twCard) < 0) add('bad', 'twitter:card is "' + m.twCard + '", which X does not recognise.', 'Use summary_large_image or summary.');

    // canonical + url
    var canons = d.links.filter(function (l) { return l.rel === 'canonical'; });
    if (!canons.length) add('warn', 'No canonical link.', 'Add <link rel="canonical" href="https://yoursite.com/this-page"> so search engines and apps agree on one URL.');
    else {
      if (canons.length > 1) add('bad', canons.length + ' canonical links.', 'Keep one. With several, Google ignores them all.');
      if (!isAbsHttp(m.canonicalRaw)) add('warn', 'Canonical is relative (' + m.canonicalRaw + ').', 'Google accepts it, but an absolute https URL is safer.');
    }
    if (!m.ogUrl) add('info', 'No og:url.', 'Add <meta property="og:url" content="..."> with the canonical URL, so shares of ?utm= links count as one page.');
    else if (m.canonical && abs(m.ogUrl).replace(/\/$/, '') !== m.canonical.replace(/\/$/, '')) add('info', 'og:url and canonical differ.', 'og:url: ' + m.ogUrl + ' / canonical: ' + m.canonical + '. Usually they should match.');
    if (!m.type) add('info', 'No og:type.', 'Add <meta property="og:type" content="website"> (or "article" for posts).');
    if (!m.site) add('info', 'No og:site_name.', 'Add your brand name. Slack, Discord and Facebook show it above the title.');

    // duplicates + attribute mixups
    var counts = {};
    d.metas.forEach(function (x) { counts[x.key] = (counts[x.key] || 0) + 1; });
    var dups = Object.keys(counts).filter(function (k) { return counts[k] > 1 && !MULTI_OK.test(k); });
    if (dups.length) add('warn', 'Duplicate tags: ' + dups.map(function (k) { return k + ' x' + counts[k]; }).join(', ') + '.', 'Platforms pick one (usually the first) and you can\'t be sure which. Often a theme and an SEO plugin both write them; turn one off.');
    if ((counts['og:image'] || 0) > 1) add('info', counts['og:image'] + ' og:image tags.', 'Most platforms use the first one. Make sure the first is the one you want.');
    var wrongAttr = d.metas.filter(function (x) { return /^og:/.test(x.key) && x.attr === 'name'; }).map(function (x) { return x.key; });
    if (wrongAttr.length) add('info', 'Open Graph tags use name= instead of property=: ' + wrongAttr.slice(0, 4).join(', ') + (wrongAttr.length > 4 ? '...' : '') + '.', 'Most apps accept it, but the spec says property="og:...".');

    // misc
    if (/noindex/i.test(m.robots)) add('warn', 'robots meta says noindex.', 'Google won\'t list this page. Fine for drafts, remove it before launch.');
    if (!m.iconRaw) add('info', 'No favicon link tag.', 'Add <link rel="icon" href="/favicon.svg">. Google results, Slack and Discord show it next to your site name.');
    if (d.jsonld.length) {
      var bad = d.jsonld.filter(function (j) { return !j.ok; });
      if (bad.length) add('bad', 'JSON-LD has invalid JSON: ' + bad[0].err, 'Fix the syntax (often a trailing comma or a stray quote), then test it in Google\'s Rich Results Test.');
      var types = [].concat.apply([], d.jsonld.map(function (j) { return j.types; }));
      if (types.length) add('ok', 'JSON-LD found: ' + types.join(', ') + '.', '');
    } else if (mode !== 'gen') add('info', 'No JSON-LD structured data.', 'Optional, but it can earn rich results in Google (articles, events, products, FAQ).');

    var order = { bad: 0, warn: 1, info: 2, ok: 3 };
    out.sort(function (a, b) { return order[a.sev] - order[b.sev]; });
    return out;
  }

  // ---------- previews ----------
  function imgBox(src, cls, label) {
    var box = h('div', { class: 'img ' + (cls || '') });
    if (!src) { box.classList.add('none'); box.textContent = 'No image'; return box; }
    var im = h('img', { alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', decoding: 'async' });
    im.onerror = function () { box.classList.add('none'); box.textContent = 'Image failed to load'; };
    im.src = src;
    box.appendChild(im);
    if (label) box.appendChild(label);
    return box;
  }
  function icon(src) { var s = safeImg(src); if (!s) return null; var i = h('img', { alt: '', referrerpolicy: 'no-referrer' }); i.onerror = function () { i.remove(); }; i.src = s; return i; }
  function pv(title, stage, wide) {
    return h('div', { class: 'pv' + (wide ? ' wide' : '') }, [h('h3', { text: title }), stage]);
  }

  function renderPreviews(d) {
    var m = d.m, wrap = $('previews'), info = imgInfo(m) || {};
    wrap.textContent = '';
    var img = imgSrc(m), xImg = imgSrc(m, 'x');
    var bigOk = !img || !info.done || !info.ok || info.w >= 401;

    // Google
    var gTitle = m.title || m.ogTitle || m.domain;
    var ft = fitWidth(gTitle, '20px Arial', 600);
    var gDesc = m.desc ? fitWidth(m.desc, '14px Arial', DESC_PX) : null;
    var path = '';
    try { path = new URL(m.pageUrl).pathname.split('/').filter(Boolean).join(' › '); } catch (e) {}
    var gfav = h('div', { class: 'fav' }); var fi = icon(m.favicon);
    if (fi) { fi.style.cssText = 'width:18px;height:18px;margin:4px'; gfav.appendChild(fi); }
    var g = h('div', { class: 'stage g' }, [
      h('div', { class: 'site' }, [gfav, h('div', {}, [
        h('div', { class: 'sn', text: m.site || m.domain }),
        h('div', { class: 'bc', text: (m.pageUrl ? (function () { try { return new URL(m.pageUrl).origin; } catch (e) { return m.domain; } })() : 'https://' + m.domain) + (path ? ' › ' + path : '') })
      ])]),
      h('div', { class: 't', text: ft.text }),
      h('div', { class: 'd', text: gDesc ? gDesc.text : 'No meta description, so Google picks text from the page.' }),
      h('div', { class: 'meas', text: 'Title ' + Math.round(ft.w) + ' / 600 px' + (gDesc ? ' · description ' + Math.round(gDesc.w) + ' / ~' + DESC_PX + ' px' : '') + '. Google may rewrite either one.' })
    ]);
    wrap.appendChild(pv('Google search result', g, true));

    // LinkedIn
    var liBody = h('div', { class: 'body' }, [h('div', { class: 't clamp2', text: m.cardTitle || m.domain }), h('div', { class: 'dm', text: m.domain })]);
    var li = h('div', { class: 'stage li' }, [h('div', { class: 'box' }, bigOk ? [imgBox(img, 'r191'), liBody] : [h('div', { class: 'row2' }, [imgBox(img, 'r1'), liBody])])]);
    wrap.appendChild(pv('LinkedIn', li));

    // Facebook
    var fbBody = h('div', { class: 'body' }, [
      h('div', { class: 'dm clamp1', text: m.domain }),
      h('div', { class: 't clamp2', text: m.cardTitle || m.domain }),
      m.cardDesc ? h('div', { class: 'd clamp1', text: m.cardDesc }) : null
    ]);
    var fbBig = !img || !info.done || !info.ok || (info.w >= 600 && info.h >= 315);
    var fb = h('div', { class: 'stage fb' }, [h('div', { class: 'box' }, fbBig ? [imgBox(img, 'r191'), fbBody] : [h('div', { style: 'display:flex' }, [imgBox(img, 'r1', null), fbBody])])]);
    if (!fbBig) fb.querySelector('.img').style.cssText = 'width:120px;flex:none';
    wrap.appendChild(pv('Facebook', fb));

    // X
    var xm = document.querySelector('input[name=xmode]:checked').value;
    var large = xm === 'large' || (xm === 'auto' && m.twCard === 'summary_large_image');
    var x;
    if (large) {
      x = h('div', { class: 'stage x' }, [
        h('div', { class: 'box large' }, [imgBox(xImg, 'r191', h('span', { class: 'ov', text: m.xTitle || m.domain }))]),
        h('div', { class: 'from', text: 'From ' + m.domain })
      ]);
    } else {
      x = h('div', { class: 'stage x' }, [h('div', { class: 'box sm' }, [
        imgBox(xImg, 'r1'),
        h('div', { class: 'body' }, [
          h('div', { class: 'dm clamp1', text: m.domain }),
          h('div', { class: 'clamp1', text: m.xTitle || m.domain }),
          m.xDesc ? h('div', { class: 'd clamp2', text: m.xDesc }) : null
        ])
      ])]);
    }
    var xLabel = 'X ' + (large ? 'large card' : 'summary card') + (xm === 'auto' && !m.twCard ? ' (no twitter:card, X may show no card)' : '');
    wrap.appendChild(pv(xLabel, x));

    // Slack
    var slLarge = m.twCard === 'summary_large_image';
    var slText = h('div', {}, [
      h('div', { class: 'sn' }, [icon(m.favicon), m.site || m.domain]),
      h('div', { class: 't', text: m.cardTitle || m.domain }),
      m.cardDesc ? h('div', { class: 'd clamp3', text: m.cardDesc }) : null,
      slLarge && img ? imgBox(img, 'r191 big') : null
    ]);
    var sl = h('div', { class: 'stage sl' }, [h('div', { class: 'att' }, [slText, !slLarge && img ? imgBox(img, 'thumb') : null])]);
    wrap.appendChild(pv('Slack', sl));

    // Discord
    var color = /^#?[0-9a-f]{3,8}$/i.test(m.theme) ? (m.theme.charAt(0) === '#' ? m.theme : '#' + m.theme) : '';
    var dsLarge = m.twCard === 'summary_large_image';
    var emb = h('div', { class: 'emb', style: color ? 'border-left-color:' + color : '' }, [
      h('div', {}, [
        m.site ? h('div', { class: 'sn', text: m.site }) : null,
        h('div', { class: 't', text: m.cardTitle || m.domain }),
        m.cardDesc ? h('div', { class: 'd clamp3', text: m.cardDesc }) : null
      ]),
      !dsLarge && img ? imgBox(img, 'thumb') : h('span'),
      dsLarge && img ? imgBox(img, 'r191 big') : null
    ]);
    wrap.appendChild(pv('Discord', h('div', { class: 'stage ds' }, [emb])));

    // iMessage
    var apBody = h('div', { class: 'body' }, [h('div', { class: 't clamp2', text: m.cardTitle || m.domain }), h('div', { class: 'dm', text: m.domain })]);
    var ap = h('div', { class: 'stage ap' }, [h('div', { class: 'bub' }, img ? [imgBox(img, 'r191'), apBody] : [h('div', { class: 'ic' }, [icon(m.favicon), apBody])])]);
    wrap.appendChild(pv('iMessage', ap));

    // WhatsApp
    var waLarge = img && info.done && info.ok && info.w >= 300;
    var waBody = h('div', { class: 'body' }, [
      h('div', { class: 't clamp2', text: m.cardTitle || m.domain }),
      m.cardDesc ? h('div', { class: 'd clamp2', text: m.cardDesc }) : null,
      h('div', { class: 'dm', text: m.domain })
    ]);
    var lp = waLarge ? h('div', { class: 'lp' }, [imgBox(img, 'r191'), waBody]) : h('div', { class: 'lp row3' }, [img ? imgBox(img, 'r1') : null, waBody]);
    var wa = h('div', { class: 'stage wa' }, [h('div', { class: 'bub' }, [lp, h('div', { class: 'link', text: m.pageUrl || 'https://' + m.domain })])]);
    wrap.appendChild(pv('WhatsApp', wa));
  }

  function renderChecks(d) {
    var list = runChecks(d), ul = $('checks'), n = { bad: 0, warn: 0, info: 0, ok: 0 };
    var names = { bad: 'Fix', warn: 'Check', info: 'Tip', ok: 'OK' };
    ul.textContent = '';
    list.forEach(function (c) {
      n[c.sev]++;
      ul.appendChild(h('li', { class: c.sev }, [h('span', { class: 'tag', text: names[c.sev] }), c.msg, c.fix ? h('span', { class: 'fix', text: c.fix }) : null]));
    });
    $('summary').textContent = n.bad + ' to fix, ' + n.warn + ' to check, ' + n.info + ' tips, ' + n.ok + ' passing.';
  }

  function renderFound(d) {
    var tb = $('found').querySelector('tbody');
    tb.textContent = '';
    d.all.forEach(function (r) { tb.appendChild(h('tr', {}, [h('td', {}, [h('code', { text: r[0] })]), h('td', { text: r[1] })])); });
    $('foundCount').textContent = d.all.length;
  }

  function render(d) {
    lastData = d;
    $('emptyState').hidden = true;
    $('out').hidden = false;
    $('foundWrap').hidden = mode === 'gen';
    renderChecks(d);
    renderPreviews(d);
    renderFound(d);
  }
  function analyse(d) {
    render(d);
    var src = d.m.cardImg;
    if (src && !localImg) measure(src, function () { if (lastData === d) render(d); });
  }

  // ---------- check mode ----------
  function runCheck() {
    var html = $('html').value;
    if (!html.trim()) { toast('Paste some HTML first'); $('html').focus(); return; }
    var url = $('url').value.trim();
    save({ url: url, html: html.length < 300000 ? html : '' });
    var d = parse(html, isAbsHttp(url) ? url : '');
    analyse(d);
    $('btnToGen').hidden = false;
  }

  function msg(text, cls) {
    var el = $('fetchMsg'); el.hidden = !text; el.className = 'msg ' + (cls || '');
    el.textContent = '';
    (Array.isArray(text) ? text : [text]).forEach(function (t, i) { if (i) el.appendChild(h('br')); el.appendChild(document.createTextNode(t)); });
  }

  function tryFetch() {
    var url = $('url').value.trim();
    if (!/^https?:\/\/[^\s]+\.[^\s]+/i.test(url)) {
      if (url && !/^https?:/i.test(url)) { url = 'https://' + url; $('url').value = url; }
      else { msg('Type a full URL, like https://example.com/page', 'bad'); $('url').focus(); return; }
    }
    msg('Fetching...');
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 12000);
    fetch(url, { mode: 'cors', credentials: 'omit', redirect: 'follow', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) {
        return r.text().then(function (t) {
          clearTimeout(timer);
          $('html').value = t;
          runCheck();
          msg(r.ok ? 'Fetched (HTTP ' + r.status + '). This site allows other pages to read it, so this is roughly what a crawler sees.'
                   : 'The server answered HTTP ' + r.status + '. Crawlers get the same error, so the preview will be blank on every platform.', r.ok ? 'ok' : 'bad');
        });
      })
      .catch(function (e) {
        clearTimeout(timer);
        var aborted = e && e.name === 'AbortError';
        msg([
          aborted ? 'The request took too long and was stopped.' : 'Your browser blocked this request. That is normal: most sites don\'t let other websites read their HTML (a browser rule called CORS).',
          'It doesn\'t mean anything is wrong with your page, and it doesn\'t affect LinkedIn, Facebook or X, whose crawlers run on servers.',
          'To check it anyway: use the bookmarklet below on the page, or open the page, press Ctrl+U (Cmd+Option+U on a Mac) to view the source, copy it all and paste it here.'
        ], 'bad');
        document.querySelector('.bm').open = true;
      });
  }

  // ---------- generator ----------
  function genValues() { var v = {}; GEN_FIELDS.forEach(function (id) { v[id] = $(id).value.trim(); }); return v; }
  function setGen(v) {
    GEN_FIELDS.forEach(function (id) { if (v[id] != null) $(id).value = v[id]; });
    if (!$('gType').value) $('gType').value = 'website';
    if (!$('gCard').value) $('gCard').value = 'summary_large_image';
    syncColorPick();
  }
  function syncColorPick() { var c = $('gColor').value.trim(); if (/^#[0-9a-f]{6}$/i.test(c)) $('gColorPick').value = c; }

  function buildSnippet(v) {
    var L = [], a = function (s) { L.push(s); };
    var meta = function (attr, k, val) { if (val) a('<meta ' + attr + '="' + k + '" content="' + esc(val) + '">'); };
    if (v.gTitle) a('<title>' + esc(v.gTitle) + '</title>');
    meta('name', 'description', v.gDesc);
    if (v.gUrl) a('<link rel="canonical" href="' + esc(v.gUrl) + '">');
    a('');
    a('<!-- Open Graph -->');
    meta('property', 'og:type', v.gType || 'website');
    meta('property', 'og:site_name', v.gSite);
    meta('property', 'og:title', v.gTitle);
    meta('property', 'og:description', v.gDesc);
    meta('property', 'og:url', v.gUrl);
    meta('property', 'og:image', v.gImg);
    if (v.gImg) { meta('property', 'og:image:width', v.gImgW); meta('property', 'og:image:height', v.gImgH); meta('property', 'og:image:alt', v.gImgAlt); }
    meta('property', 'og:locale', v.gLocale);
    a('');
    a('<!-- X (falls back to the og: tags above) -->');
    meta('name', 'twitter:card', v.gCard || 'summary_large_image');
    if (v.gHandle) meta('name', 'twitter:site', v.gHandle.charAt(0) === '@' ? v.gHandle : '@' + v.gHandle);
    if (v.gColor) { a(''); meta('name', 'theme-color', v.gColor); }
    return L.join('\n');
  }

  function runGen(skipSave) {
    var v = genValues();
    var snip = buildSnippet(v);
    $('snippet').textContent = snip;
    $('cTitle').textContent = v.gTitle ? v.gTitle.length + ' chars' : '';
    $('cDesc').textContent = v.gDesc ? v.gDesc.length + ' chars' : '';
    $('cTitle').classList.toggle('over', v.gTitle.length > 60);
    $('cDesc').classList.toggle('over', v.gDesc.length > 160);
    if (!skipSave) save({ gen: v });
    var hasAny = GEN_FIELDS.some(function (id) { return id !== 'gType' && id !== 'gCard' && v[id]; });
    if (!hasAny && !localImg) { $('out').hidden = true; $('emptyState').hidden = false; return; }
    // the snippet itself is what gets checked, so the checks match what you copy
    var favicon = v.gUrl ? '<link rel="icon" href="/favicon.ico">' : '';
    analyse(parse(favicon + snip, isAbsHttp(v.gUrl) ? v.gUrl : ''));
  }

  function autoSize() {
    var src = $('gImg').value.trim();
    if (!isAbsHttp(src)) return;
    measure(src, function (r) {
      if (!r.ok || src !== $('gImg').value.trim()) return;
      if (!$('gImgW').value && !$('gImgH').value) { $('gImgW').value = r.w; $('gImgH').value = r.h; runGen(); }
    });
  }

  function toGenerator() {
    if (!lastData) return;
    var m = lastData.m;
    setGen({
      gUrl: m.canonical || abs(m.ogUrl) || m.pageUrl || '',
      gTitle: m.ogTitle || m.title, gDesc: m.ogDesc || m.desc, gSite: m.site,
      gType: m.type && /^(website|article|product|profile|video\.other)$/.test(m.type) ? m.type : 'website',
      gImg: isAbsHttp(m.cardImg) ? m.cardImg : '', gImgW: m.imgW || '', gImgH: m.imgH || '', gImgAlt: m.imgAlt,
      gCard: m.twCard === 'summary' ? 'summary' : 'summary_large_image',
      gHandle: m.twSite, gColor: m.theme, gLocale: lastData.get('og:locale')
    });
    var info = m.cardImg && imgCache[m.cardImg];
    if (info && info.ok && (!m.imgW || !m.imgH)) { $('gImgW').value = info.w; $('gImgH').value = info.h; }
    setMode('gen', true);
    runGen();
    $('tabGen').focus();
    toast('Loaded into the generator');
  }

  // ---------- mode / tabs ----------
  function setMode(next, quiet) {
    mode = next;
    var gen = next === 'gen';
    $('tabCheck').setAttribute('aria-selected', String(!gen)); $('tabCheck').tabIndex = gen ? -1 : 0;
    $('tabGen').setAttribute('aria-selected', String(gen)); $('tabGen').tabIndex = gen ? 0 : -1;
    $('panelCheck').hidden = gen; $('panelGen').hidden = !gen;
    save({ mode: next });
    if (quiet) return;
    if (gen) runGen(true);
    else if ($('html').value.trim()) runCheck();
    else { $('out').hidden = true; $('emptyState').hidden = false; }
  }

  // ---------- examples ----------
  var EX_IMG = 'https://mizoz.github.io/og-preview/og.png';
  var EXAMPLE = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <title>Spring Comms Meetup 2027 | Tickets, Speakers and Schedule | Calgary Comms Collective</title>',
    '  <meta name="description" content="A half-day meetup for communications and marketing people in Calgary: four short talks, one workshop, good coffee.">',
    '  <link rel="icon" href="/favicon.svg">',
    '  <meta property="og:type" content="website">',
    '  <meta property="og:site_name" content="Calgary Comms Collective">',
    '  <meta property="og:title" content="Spring Comms Meetup 2027">',
    '  <meta property="og:title" content="Spring Comms Meetup 2027 | Calgary Comms Collective">',
    '  <meta property="og:description" content="Four short talks, one workshop, good coffee. Half a day, downtown Calgary.">',
    '  <meta property="og:url" content="https://example.com/events/spring-meetup">',
    '  <meta property="og:image" content="' + EX_IMG + '">',
    '  <meta name="theme-color" content="#2554c7">',
    '</head>',
    '<body>...</body>',
    '</html>'
  ].join('\n');
  var GEN_EXAMPLE = {
    gUrl: 'https://example.com/events/spring-meetup', gTitle: 'Spring Comms Meetup 2027',
    gDesc: 'Four short talks, one workshop, good coffee. A half-day meetup for communications and marketing people in downtown Calgary.',
    gSite: 'Calgary Comms Collective', gType: 'website', gImg: EX_IMG, gImgW: '1200', gImgH: '630',
    gImgAlt: 'Event title on a blue background', gCard: 'summary_large_image', gHandle: '', gColor: '#2554c7', gLocale: 'en_CA'
  };

  // ---------- bookmarklet ----------
  function bookmarklet() {
    var code = "(function(){var o=[],q=document.querySelectorAll('head title,meta[property],meta[name],link[rel],script[type=\"application/ld+json\"]');" +
      "for(var i=0;i<q.length;i++){var e=q[i];if(e.tagName=='LINK'&&!/canonical|icon|alternate/i.test(e.rel))continue;o.push(e.outerHTML)}" +
      "var s=o.join('\\n');if(s.length>60000)s=s.slice(0,60000);" +
      "window.open('" + SELF + "#u='+encodeURIComponent(location.href)+'&h='+encodeURIComponent(s),'_blank')})();";
    $('bookmarklet').href = 'javascript:' + code;
  }

  // ---------- URL hash state ----------
  function readHash() {
    var raw = location.hash.slice(1);
    if (!raw) return false;
    if (raw === 'generate') { setMode('gen'); return true; }
    var p;
    try { p = new URLSearchParams(raw); } catch (e) { return false; }
    if (p.has('h')) {
      $('url').value = p.get('u') || '';
      $('html').value = p.get('h') || '';
      history.replaceState(null, '', location.pathname + location.search);
      setMode('check', true);
      runCheck();
      msg('Tags loaded from the bookmarklet. They were read after the page\'s scripts ran; check View Source too if your tags come from JavaScript.', 'ok');
      return true;
    }
    if (p.has('g')) {
      try { setGen(JSON.parse(p.get('g'))); } catch (e) { return false; }
      setMode('gen');
      return true;
    }
    return false;
  }

  // ---------- wire up ----------
  function init() {
    bookmarklet();
    var s = load();
    if (s.url) $('url').value = s.url;
    if (s.html) $('html').value = s.html;
    setGen(s.gen || {});

    $('btnCheck').addEventListener('click', runCheck);
    $('btnFetch').addEventListener('click', tryFetch);
    $('url').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); tryFetch(); } });
    $('btnExample').addEventListener('click', function () { $('html').value = EXAMPLE; $('url').value = 'https://example.com/events/spring-meetup'; msg(''); runCheck(); });
    $('btnClear').addEventListener('click', function () { $('html').value = ''; $('url').value = ''; msg(''); save({ html: '', url: '' }); $('btnToGen').hidden = true; $('out').hidden = true; $('emptyState').hidden = false; lastData = null; });
    $('btnToGen').addEventListener('click', toGenerator);
    $('bookmarklet').addEventListener('click', function (e) { e.preventDefault(); toast('Drag it to your bookmarks bar instead of clicking'); });

    var t;
    GEN_FIELDS.forEach(function (id) {
      $(id).addEventListener('input', function () { if (id === 'gColor') syncColorPick(); clearTimeout(t); t = setTimeout(runGen, 200); });
    });
    $('gImg').addEventListener('change', autoSize);
    $('gColorPick').addEventListener('input', function () { $('gColor').value = this.value; runGen(); });
    $('gLocalImg').addEventListener('change', function () {
      var f = this.files && this.files[0];
      if (localImg) { URL.revokeObjectURL(localImg.src); localImg = null; }
      if (!f) { runGen(); return; }
      var src = URL.createObjectURL(f), im = new Image();
      im.onload = function () { localImg = { src: src, w: im.naturalWidth, h: im.naturalHeight }; runGen(); };
      im.onerror = function () { toast('That file is not an image the browser can read'); };
      im.src = src;
    });
    $('btnGenExample').addEventListener('click', function () { setGen(GEN_EXAMPLE); runGen(); });
    $('btnGenClear').addEventListener('click', function () {
      setGen({ gUrl: '', gTitle: '', gDesc: '', gSite: '', gType: 'website', gImg: '', gImgW: '', gImgH: '', gImgAlt: '', gCard: 'summary_large_image', gHandle: '', gColor: '', gLocale: '' });
      $('gLocalImg').value = ''; if (localImg) { URL.revokeObjectURL(localImg.src); localImg = null; }
      runGen();
    });
    $('btnCopy').addEventListener('click', function () { copyText($('snippet').textContent); });
    $('btnShare').addEventListener('click', function () {
      copyText(SELF + '#g=' + encodeURIComponent(JSON.stringify(genValues())));
    });
    document.querySelectorAll('input[name=xmode]').forEach(function (r) { r.addEventListener('change', function () { if (lastData) renderPreviews(lastData); }); });
    $('linkGen').addEventListener('click', function (e) { e.preventDefault(); setMode('gen'); $('tabGen').focus(); window.scrollTo({ top: $('tool').offsetTop - 10 }); });

    [$('tabCheck'), $('tabGen')].forEach(function (tab, i, all) {
      tab.addEventListener('click', function () { setMode(i ? 'gen' : 'check'); });
      tab.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End') {
          e.preventDefault();
          var n = (e.key === 'Home') ? 0 : (e.key === 'End') ? 1 : 1 - i;
          all[n].focus(); all[n].click();
        }
      });
    });

    if (!readHash()) {
      setMode(s.mode === 'gen' ? 'gen' : 'check');
    }
    window.addEventListener('hashchange', readHash);
  }

  init();
})();
