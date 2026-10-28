(() => {
  if (globalThis.__browserBridge?.version === 2) return;
  const previous = globalThis.__browserBridge;
  const previousOwner = previous?.owner;
  const previousKey = previous?.ownerKey;
  previous?.release?.();
  const documentId =
    crypto.randomUUID?.() ??
    [...crypto.getRandomValues(new Uint8Array(16))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  const state = { version: 2, documentId, refs: new Map(), sequence: 0, owner: null };
  const ids = new WeakMap();
  let host,
    cursor,
    label,
    icon,
    observer,
    hidden = false;
  const originals = new Map();
  const iconHref =
    'data:image/svg+xml,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#171717"/><path d="M9 6v20l5-6 4 8 4-2-4-8h8z" fill="#e5e5e5"/></svg>',
    );
  function visual() {
    if (host?.isConnected) return;
    host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText =
      'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;contain:strict;';
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent =
      ':host{pointer-events:none} .cursor{position:absolute;left:0;top:0;display:none;width:19px;height:24px;filter:drop-shadow(0 1px 1px #000c);will-change:transform} .pointer{width:100%;height:100%;background:#e5e5e5;clip-path:polygon(0 0,0 94%,28% 68%,49% 100%,66% 90%,46% 60%,88% 60%)} .label{position:absolute;left:21px;top:18px;white-space:nowrap;background:#171717;color:#ddd;border:1px solid #3a3a3a;border-radius:4px;padding:2px 5px;font:11px/1.4 "Segoe UI",sans-serif} .pulse{position:absolute;inset:-8px;border:1px solid #aaa;border-radius:50%;opacity:0} @keyframes pulse{0%{opacity:.8;transform:scale(.5)}100%{opacity:0;transform:scale(1.4)}} @media(prefers-reduced-motion:reduce){.pulse{animation:none!important}}';
    cursor = document.createElement('div');
    cursor.className = 'cursor';
    const arrow = document.createElement('div');
    arrow.className = 'pointer';
    label = document.createElement('span');
    label.className = 'label';
    const pulse = document.createElement('div');
    pulse.className = 'pulse';
    cursor.append(pulse, arrow, label);
    root.append(style, cursor);
    document.documentElement.append(host);
  }
  function badge() {
    if (!state.owner) return;
    observer?.disconnect();
    for (const link of document.querySelectorAll('link[rel~="icon"]')) {
      if (link === icon) continue;
      if (!originals.has(link)) originals.set(link, link.getAttribute('href'));
      else if (link.getAttribute('href') !== iconHref)
        originals.set(link, link.getAttribute('href'));
      if (link.getAttribute('href') !== iconHref) link.setAttribute('href', iconHref);
    }
    if (!icon?.isConnected) {
      icon = document.createElement('link');
      icon.rel = 'icon';
      icon.href = iconHref;
      icon.type = 'image/svg+xml';
      (document.head || document.documentElement).append(icon);
    }
    observer ??= new MutationObserver(badge);
    observer.observe(document.head || document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['href', 'rel'],
    });
  }
  state.claim = (owner, key) => {
    state.owner = owner;
    state.ownerKey = key;
    visual();
    label.textContent = owner;
    badge();
  };
  state.move = (x, y, click = false) => {
    if (!state.owner || document.visibilityState !== 'visible') return;
    visual();
    cursor.style.display = 'block';
    cursor.style.transition =
      click || matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'none'
        : 'transform 70ms linear';
    cursor.style.transform = `translate3d(${x}px,${y}px,0)`;
    if (click) {
      const pulse = cursor.querySelector('.pulse');
      pulse.getAnimations().forEach((animation) => animation.cancel());
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches)
        pulse.animate(
          [
            { opacity: 0.8, transform: 'scale(.5)' },
            { opacity: 0, transform: 'scale(1.4)' },
          ],
          220,
        );
    }
  };
  state.hide = (value) => {
    hidden = value;
    if (host) host.style.visibility = value ? 'hidden' : 'visible';
  };
  state.release = (expectedKey) => {
    if (expectedKey && state.ownerKey !== expectedKey) return;
    state.owner = null;
    observer?.disconnect();
    observer = null;
    for (const [link, original] of originals)
      if (link.getAttribute('href') === iconHref) {
        if (original === null) link.removeAttribute('href');
        else link.setAttribute('href', original);
      }
    originals.clear();
    icon?.remove();
    icon = null;
    host?.remove();
    host = null;
    cursor = null;
  };
  state.resolve = (ref) => state.refs.get(ref)?.deref() ?? null;
  state.snapshot = (limit = 200, maxText = 12000) => {
    const items = [];
    const visit = (root) => {
      for (const element of root.querySelectorAll(
        'a[href],button,input,textarea,select,[role],[contenteditable="true"],[tabindex]',
      )) {
        if (items.length >= limit) break;
        if (element === host || element.closest('[aria-hidden="true"],[inert]')) continue;
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height || getComputedStyle(element).visibility === 'hidden')
          continue;
        let ref = ids.get(element);
        if (!ref) {
          ref = `${state.documentId}:${++state.sequence}`;
          ids.set(element, ref);
          state.refs.set(ref, new WeakRef(element));
        }
        const labels = (element.getAttribute('aria-labelledby') || '')
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent || '')
          .join(' ');
        const name =
          element.getAttribute('aria-label') ||
          labels.trim() ||
          (element.labels && [...element.labels].map((label) => label.textContent).join(' ')) ||
          element.innerText ||
          element.getAttribute('placeholder') ||
          element.getAttribute('title') ||
          '';
        items.push({
          ref,
          tag: element.tagName.toLowerCase(),
          role:
            element.getAttribute('role') ||
            element.getAttribute('type') ||
            element.tagName.toLowerCase(),
          name: name.trim().slice(0, 220),
          ...(element.matches('input,textarea,select')
            ? {
                value:
                  element.type === 'password' ? '[password]' : String(element.value).slice(0, 200),
              }
            : {}),
          ...(element.disabled ? { disabled: true } : {}),
        });
      }
      for (const element of root.querySelectorAll('*'))
        if (element.shadowRoot && items.length < limit) visit(element.shadowRoot);
    };
    visit(document);
    for (const [ref, value] of state.refs) if (!value.deref()?.isConnected) state.refs.delete(ref);
    return {
      documentId: state.documentId,
      title: document.title,
      url: location.href,
      text: (document.body?.innerText || '').slice(0, maxText),
      elements: items,
      truncated: items.length >= limit,
    };
  };
  document.addEventListener(
    'mousemove',
    (event) => {
      if (event.isTrusted && state.owner && !hidden) state.move(event.clientX, event.clientY);
    },
    { passive: true },
  );
  document.addEventListener(
    'mousedown',
    (event) => {
      if (event.isTrusted && state.owner && !hidden) state.move(event.clientX, event.clientY, true);
    },
    { passive: true },
  );
  globalThis.__browserBridge = state;
  if (previousOwner) state.claim(previousOwner, previousKey);
})();
