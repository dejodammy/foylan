(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const icon = (name) => `<svg class="i" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  $$('[data-year]').forEach((el) => { el.textContent = new Date().getFullYear(); });

  /* Mobile menu: the rail's nav opens as a sheet */
  const menuBtn = $('.menu-toggle');
  const railNav = $('#head-nav');
  if (menuBtn && railNav) {
    const set = (open) => {
      document.body.classList.toggle('menu-open', open);
      document.documentElement.style.overflow = open ? 'hidden' : '';
      menuBtn.setAttribute('aria-expanded', String(open));
      $('use', menuBtn).setAttribute('href', open ? '#i-x' : '#i-list');
    };
    menuBtn.addEventListener('click', () => set(!document.body.classList.contains('menu-open')));
    matchMedia('(min-width: 861px)').addEventListener('change', (e) => { if (e.matches) set(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') set(false); });
  }

  /* Pigment dock: choose the ink the visitor pours, including their own brand colour */
  const PKEY = 'foylan-pigment';
  const names = { red: 'Foylan red', black: 'Press black', indigo: 'Indigo' };
  const swatches = $$('[data-pigment]');
  const custom = $('[data-pigment-custom]');
  const nameEl = $('[data-pigment-name]');
  const applyPigment = (key, hex, announce) => {
    swatches.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.pigment === key)));
    custom?.closest('.custom').classList.toggle('on', key === 'custom');
    if (custom && hex) { custom.value = hex; custom.closest('.custom').style.setProperty('--sw', hex); }
    if (nameEl) nameEl.textContent = key === 'custom' ? `Your colour ${hex.toUpperCase()}` : names[key];
    document.dispatchEvent(new CustomEvent('ink:pigment', { detail: { key, hex } }));
    try { localStorage.setItem(PKEY, JSON.stringify({ key, hex: hex || null })); } catch { /* unavailable */ }
    $$('[data-brand-colour]').forEach((el) => { if (key === 'custom' && hex) el.value = hex; });
    $$('[data-brand-swatch]').forEach((el) => { el.style.setProperty('--sw', key === 'custom' && hex ? hex : '#d90429'); });
    if (announce && window.__ink) window.__ink.drop();
  };
  swatches.forEach((b) => b.addEventListener('click', () => applyPigment(b.dataset.pigment, null, true)));
  custom?.addEventListener('input', () => applyPigment('custom', custom.value, false));
  custom?.addEventListener('change', () => applyPigment('custom', custom.value, true));
  $$('[data-drop]').forEach((b) => b.addEventListener('click', () => window.__ink?.drop()));
  try { localStorage.removeItem(PKEY); } catch { /* unavailable */ }

  /* Reveal on scroll (content is visible without JS or with reduced motion) */
  const revealEls = $$('[data-fade], [data-curtain]');
  if ('IntersectionObserver' in window && matchMedia('(prefers-reduced-motion: no-preference)').matches) {
    const io = new IntersectionObserver((entries) => entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }), { rootMargin: '0px 0px -10% 0px', threshold: 0.1 });
    revealEls.forEach((el) => io.observe(el));
  } else {
    revealEls.forEach((el) => el.classList.add('in'));
  }

  /* Work rail prev/next */
  $$('[data-rail]').forEach((wrap) => {
    const rail = $('.strip-rail', wrap);
    if (!rail) return;
    const step = () => (rail.querySelector('li')?.getBoundingClientRect().width || 300) + 18;
    $('[data-rail-prev]', wrap)?.addEventListener('click', () => rail.scrollBy({ left: -step(), behavior: 'smooth' }));
    $('[data-rail-next]', wrap)?.addEventListener('click', () => rail.scrollBy({ left: step(), behavior: 'smooth' }));
  });

  /* Colour mixer on the home page: sets the custom pigment and pours it */
  const mixer = $('[data-mixer]');
  if (mixer) {
    const face = $('[data-mixer-face]');
    const label = $('.mixer-label');
    const show = () => { face.style.setProperty('--sw', mixer.value); label.innerHTML = `Your colour <b>${mixer.value.toUpperCase()}</b>`; };
    try { const sv = JSON.parse(localStorage.getItem(PKEY)); if (sv?.key === 'custom' && sv.hex) mixer.value = sv.hex; } catch { /* none */ }
    show();
    mixer.addEventListener('input', () => { show(); applyPigment('custom', mixer.value, false); });
    $('[data-mixer-pour]').addEventListener('click', () => { applyPigment('custom', mixer.value, false); window.__ink?.drop(); });
  }

  /* Trusted by: each logo pours its brand colour into the ink */
  const wall = $('[data-trusted]');
  if (wall) {
    const brands = $$('[data-brand]', wall);
    const pourFrom = (b) => {
      const r = b.getBoundingClientRect();
      window.__ink?.drop(r.left + r.width / 2, r.top + r.height / 2, b.dataset.brand);
    };
    let last = 0;
    brands.forEach((b) => {
      const go = () => { const now = performance.now(); if (now - last > 250) { last = now; pourFrom(b); } };
      b.addEventListener('pointerenter', go);
      b.addEventListener('focus', go);
      b.addEventListener('click', () => { last = 0; go(); });
    });
    // While the wall is on screen, logos take turns pouring on their own.
    if (matchMedia('(prefers-reduced-motion: no-preference)').matches && 'IntersectionObserver' in window) {
      let timer = null, i = 0;
      const order = brands.map((_, k) => k).sort(() => Math.random() - 0.5);
      const tick = () => {
        const b = brands[order[i++ % order.length]];
        b.classList.add('pulse');
        pourFrom(b);
        setTimeout(() => b.classList.remove('pulse'), 1400);
      };
      new IntersectionObserver(([e]) => {
        if (e.isIntersecting && !timer) { tick(); timer = setInterval(tick, 2600); }
        else if (!e.isIntersecting && timer) { clearInterval(timer); timer = null; }
      }, { threshold: 0.35 }).observe(wall);
    }
  }

  /* Footer wordmark fills with Foylan red when it comes into view */
  const word = $('.foot-word');
  if (word && 'IntersectionObserver' in window) {
    new IntersectionObserver(([e]) => word.classList.toggle('in', e.isIntersecting), { threshold: 0.6 }).observe(word);
  } else word?.classList.add('in');

  /* Quote list: kept in this browser only, as a convenience */
  const KEY = 'foylan-quote-v2';
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } };
  const write = (list) => { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* storage unavailable */ } };
  let quote = read();
  const has = (name) => quote.some((q) => q.name === name);

  const toggleBtn = $('.quote-toggle');
  const drawer = $('#quote-drawer');
  const scrim = $('.scrim');
  let lastFocus = null;

  const render = () => {
    $$('[data-quote-count]').forEach((el) => { el.textContent = quote.length; });
    $$('[data-add]').forEach((b) => b.setAttribute('aria-pressed', String(has(b.dataset.add))));
    if (drawer) {
      drawer.classList.toggle('is-empty', quote.length === 0);
      $('[data-quote-list]', drawer).innerHTML = quote.map((q, i) => `
        <li>
          <img src="${esc(q.img || 'assets/images/favicon-192.png')}" alt="" width="76" height="76" loading="lazy">
          <div><strong>${esc(q.name)}</strong><span>${esc(q.cat || '')}</span></div>
          <button type="button" data-remove="${i}" aria-label="Remove ${esc(q.name)}">${icon('trash')}</button>
        </li>`).join('');
    }
    const picked = $('[data-picked]');
    if (picked) {
      $('ul', picked).innerHTML = quote.map((q, i) => `<li>${esc(q.name)}<button type="button" data-remove="${i}" aria-label="Remove ${esc(q.name)}">${icon('x')}</button></li>`).join('');
      $('ul', picked).hidden = quote.length === 0;
      $('.picked-empty', picked).hidden = quote.length > 0;
      $('[data-picked-count]', picked).textContent = quote.length === 1 ? '1 item' : `${quote.length} items`;
    }
  };

  const openDrawer = () => {
    if (!drawer) return;
    lastFocus = document.activeElement;
    drawer.inert = false;
    drawer.setAttribute('aria-hidden', 'false');
    drawer.classList.add('open');
    scrim.hidden = false;
    requestAnimationFrame(() => scrim.classList.add('show'));
    toggleBtn?.setAttribute('aria-expanded', 'true');
    $('[data-drawer-close]', drawer).focus();
  };
  const closeDrawer = () => {
    if (!drawer || !drawer.classList.contains('open')) return;
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    drawer.inert = true;
    scrim.classList.remove('show');
    setTimeout(() => { scrim.hidden = true; }, 500);
    toggleBtn?.setAttribute('aria-expanded', 'false');
    lastFocus?.focus();
  };
  toggleBtn?.addEventListener('click', openDrawer);
  $$('[data-drawer-close]').forEach((el) => el.addEventListener('click', closeDrawer));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

  document.addEventListener('click', (e) => {
    const add = e.target.closest('[data-add]');
    if (add) {
      const name = add.dataset.add;
      if (has(name)) quote = quote.filter((q) => q.name !== name);
      else {
        quote.push({ name, cat: add.dataset.cat || '', img: add.dataset.img || '' });
        toggleBtn?.classList.remove('bump');
        void toggleBtn?.offsetWidth;
        toggleBtn?.classList.add('bump');
      }
      write(quote); render();
      return;
    }
    const rm = e.target.closest('[data-remove]');
    if (rm) {
      quote.splice(Number(rm.dataset.remove), 1);
      write(quote); render();
      if (drawer?.classList.contains('open')) ($('[data-remove]', drawer) || $('[data-drawer-close]', drawer)).focus();
    }
  });
  window.addEventListener('storage', (e) => { if (e.key === KEY) { quote = read(); render(); } });

  /* Gallery: filter and lightbox */
  const shop = $('.shop');
  if (shop) {
    const items = $$('li', shop);
    const count = $('.shop-count');
    const empty = $('.shop-empty');
    $$('.filters button').forEach((btn) => btn.addEventListener('click', () => {
      const f = btn.dataset.filter;
      $$('.filters button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      let n = 0;
      items.forEach((li) => { li.hidden = !(f === 'all' || li.dataset.cat === f); if (!li.hidden) n++; });
      if (count) count.textContent = `${n} pieces`;
      if (empty) empty.hidden = n > 0;
    }));

    const lb = $('.lightbox');
    const lbImg = $('img', lb);
    const lbName = $('[data-lb-name]', lb);
    const lbAdd = $('[data-add]', lb);
    let cur = 0, back = null;
    const visible = () => items.filter((li) => !li.hidden);
    const show = (i) => {
      const list = visible();
      cur = (i + list.length) % list.length;
      const li = list[cur];
      const img = $('img', li);
      lbImg.src = img.src; lbImg.alt = img.alt;
      lbName.textContent = img.alt;
      lbAdd.dataset.add = li.dataset.name;
      lbAdd.dataset.cat = li.dataset.label;
      lbAdd.dataset.img = img.getAttribute('src');
      render();
    };
    const open = (li) => { back = document.activeElement; show(visible().indexOf(li)); lb.classList.add('open'); lb.setAttribute('aria-hidden', 'false'); document.body.style.overflow = 'hidden'; $('.lb-close', lb).focus(); };
    const close = () => { lb.classList.remove('open'); lb.setAttribute('aria-hidden', 'true'); document.body.style.overflow = ''; back?.focus(); };
    items.forEach((li) => $('.zoom', li).addEventListener('click', () => open(li)));
    $('.lb-close', lb).addEventListener('click', close);
    $('.lb-prev', lb).addEventListener('click', () => show(cur - 1));
    $('.lb-next', lb).addEventListener('click', () => show(cur + 1));
    document.addEventListener('keydown', (e) => {
      if (!lb.classList.contains('open')) return;
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowLeft') show(cur - 1);
      if (e.key === 'ArrowRight') show(cur + 1);
      if (e.key === 'Tab') {
        const f = $$('button', lb), first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
  }

  /* Quote request form: no backend, so it hands a complete email to the visitor's mail app */
  const form = $('form#quote');
  if (form) {
    const rules = {
      name: (v) => v.trim().length > 1 || 'Enter your name so we know who to reply to.',
      email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) || 'Enter an email address like name@company.com.',
      message: (v) => v.trim().length > 9 || 'Tell us what you need: items, quantities and when you need them (at least 10 characters).',
    };
    const check = (el) => {
      const r = rules[el.name]; if (!r) return true;
      const res = r(el.value), f = el.closest('.field');
      f.classList.toggle('bad', res !== true);
      el.setAttribute('aria-invalid', String(res !== true));
      $('.err', f).textContent = res === true ? '' : res;
      return res === true;
    };
    const inputs = $$('input, textarea', form).filter((el) => rules[el.name]);
    inputs.forEach((el) => {
      el.addEventListener('blur', () => { if (el.value) check(el); });
      el.addEventListener('input', () => { if (el.closest('.field').classList.contains('bad')) check(el); });
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const ok = inputs.map(check).every(Boolean);
      if (!ok) { inputs.find((el) => el.getAttribute('aria-invalid') === 'true')?.focus(); return; }
      const d = new FormData(form);
      const lines = [
        `Name: ${d.get('name')}`,
        d.get('company') ? `Company: ${d.get('company')}` : null,
        `Email: ${d.get('email')}`,
        d.get('phone') ? `Phone: ${d.get('phone')}` : null,
        d.get('deadline') ? `Needed by: ${d.get('deadline')}` : null,
        quote.length ? `\nItems:\n${quote.map((q) => `- ${q.name}`).join('\n')}` : null,
        d.get('message') ? `\nDetails:\n${d.get('message')}` : null,
      ].filter((l) => l !== null).join('\n');
      const subject = `Quote request${d.get('company') ? `: ${d.get('company')}` : ''}`;
      window.location.href = `mailto:info@foylanventures.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines)}`;
      const sent = $('.sent', form);
      const text = $('.sent-text', sent);
      if (text) text.value = `To: info@foylanventures.com
Subject: ${subject}

${lines}`;
      sent.classList.add('show');
      sent.focus();
    });
  }

  /* Copy the composed request when the visitor has no email app */
  $$('.sent-copy').forEach((b) => b.addEventListener('click', async () => {
    const t = $('.sent-text', b.closest('.sent'));
    try { await navigator.clipboard.writeText(t.value); }
    catch { t.select(); document.execCommand?.('copy'); }
    b.textContent = 'Copied';
    setTimeout(() => { b.textContent = 'Copy request'; }, 2200);
  }));

  render();
})();
