(() => {
  if (globalThis.__browserBridge?.version === 6) return;
  const previous = globalThis.__browserBridge;
  const previousOwner = previous?.owner;
  const previousKey = previous?.ownerKey;
  const previousPosition = previous?.position;
  const previousAttention = previous?.watched === true;
  previous?.release?.();
  const documentId =
    crypto.randomUUID?.() ??
    [...crypto.getRandomValues(new Uint8Array(16))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  const state = {
    version: 6,
    documentId,
    refs: new Map(),
    sequence: 0,
    owner: null,
    watched: previousAttention,
    position: previousPosition ?? { x: 24, y: 24 },
  };
  const ids = new WeakMap();
  const waits = new Set();
  const movementMs = 500;
  const actionPauseMs = 150;
  let host, cursor, icon, observer;
  const originals = new Map();
  const pointerPathData =
    'M4.1 2.8 21 9.7Q22.4 10.3 20.9 10.9L14.1 13.6Q13.7 13.7 13.6 14.1L10.9 20.9Q10.3 22.4 9.7 21L2.8 4.1Q2 2 4.1 2.8Z';
  const pointerAttributes = {
    d: pointerPathData,
    fill: '#fff',
    stroke: '#000',
    'stroke-width': '1.6',
    'stroke-linejoin': 'round',
  };
  const pointerPath =
    '<path ' +
    Object.entries(pointerAttributes)
      .map(([key, value]) => `${key}="${value}"`)
      .join(' ') +
    '/>';
  let iconHref, iconSource;
  function visual() {
    if (host?.isConnected) return;
    host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText =
      'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;contain:strict;';
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent =
      ':host{pointer-events:none} .cursor{position:absolute;left:0;top:0;width:22px;height:22px;will-change:transform} .pointer,.pointer svg{display:block;width:100%;height:100%} .pulse{position:absolute;inset:-8px;border:1px solid #aaa;border-radius:50%;opacity:0} @media(prefers-reduced-motion:reduce){.pulse{animation:none!important}}';
    cursor = document.createElement('div');
    cursor.className = 'cursor';
    cursor.style.transform = `translate3d(${state.position.x}px,${state.position.y}px,0)`;
    const arrow = document.createElement('div');
    arrow.className = 'pointer';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const path = document.createElementNS(svg.namespaceURI, 'path');
    for (const [key, value] of Object.entries(pointerAttributes)) path.setAttribute(key, value);
    svg.append(path);
    arrow.append(svg);
    const pulse = document.createElement('div');
    pulse.className = 'pulse';
    cursor.append(pulse, arrow);
    root.append(style, cursor);
    document.documentElement.append(host);
  }
  function faviconUrl() {
    const href = [...originals.values()].findLast((original) => original.href)?.href;
    try {
      return new URL(href || '/favicon.ico', document.baseURI).href;
    } catch {
      return null;
    }
  }
  function badge() {
    if (!state.owner) return;
    observer?.disconnect();
    for (const link of document.querySelectorAll('link[rel~="icon"]')) {
      if (link === icon) continue;
      const href = link.getAttribute('href');
      let original = originals.get(link);
      if (!original || href !== original.appliedHref) {
        original = { href, appliedHref: href };
        originals.set(link, original);
      }
      if (iconHref && href !== iconHref) {
        original.appliedHref = iconHref;
        link.setAttribute('href', iconHref);
      }
    }
    if (iconHref && !icon?.isConnected) {
      icon = document.createElement('link');
      icon.rel = 'icon';
      icon.type = 'image/svg+xml';
      icon.dataset.browserBridgeIcon = '';
      (document.head || document.documentElement).append(icon);
    }
    if (icon && icon.getAttribute('href') !== iconHref) icon.href = iconHref;
    observer ??= new MutationObserver(badge);
    observer.observe(document.head || document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['href', 'rel'],
    });
  }
  state.claim = (owner, key, position) => {
    state.owner = owner;
    state.ownerKey = key;
    if (position) state.position = position;
    visual();
    badge();
    return { documentId, faviconUrl: faviconUrl() };
  };
  state.setIcon = (data, key, expectedDocumentId, source) => {
    if (!state.owner || state.ownerKey !== key || documentId !== expectedDocumentId) return false;
    if (source !== faviconUrl() || !data?.startsWith('data:image/')) return false;
    iconSource = source;
    iconHref =
      'data:image/svg+xml,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
          '<image width="32" height="32" opacity="0.55" href="' +
          data.replaceAll('&', '&amp;').replaceAll('"', '&quot;') +
          '"/>' +
          '<g transform="translate(11 11) scale(.9)">' +
          pointerPath +
          '</g></svg>',
      );
    badge();
    return true;
  };
  state.setAttention = (watched) => {
    state.watched = !!watched;
    if (!state.watched) {
      if (cursor) cursor.style.transition = 'none';
      for (const finish of [...waits]) finish();
    }
  };
  const wait = (ms) => {
    if (!state.owner || !state.watched || !ms) return;
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        waits.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      waits.add(finish);
    });
  };
  state.pause = () => wait(actionPauseMs);
  state.move = async (x, y, click = false) => {
    if (!state.owner) return;
    const changed = state.position.x !== x || state.position.y !== y;
    state.position = { x, y };
    visual();
    const animate = state.watched && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    cursor.style.transition = animate
      ? `transform ${movementMs}ms cubic-bezier(.22,.61,.36,1)`
      : 'none';
    cursor.style.transform = `translate3d(${x}px,${y}px,0)`;
    if (animate && changed) await wait(movementMs);
    if (click && cursor && state.owner && state.watched) {
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
    if (host) host.style.visibility = value ? 'hidden' : 'visible';
  };
  state.release = (expectedKey) => {
    if (expectedKey && state.ownerKey !== expectedKey) return;
    state.owner = null;
    state.setAttention(false);
    observer?.disconnect();
    observer = null;
    const controlIcon = icon;
    controlIcon?.remove();
    icon = null;
    let restored;
    for (const [link, original] of originals)
      if (link.getAttribute('href') === original.appliedHref) {
        if (original.href === null) link.removeAttribute('href');
        else link.setAttribute('href', original.href);
        if (link.isConnected) restored = link;
      }
    // Reinsert after removing the control icon so Chromium invalidates its cached selection.
    if (restored) {
      const parent = restored.parentNode;
      const next = restored.nextSibling;
      restored.remove();
      parent.insertBefore(restored, next);
    } else if (controlIcon && iconSource) {
      controlIcon.removeAttribute('data-browser-bridge-icon');
      controlIcon.removeAttribute('type');
      controlIcon.href = iconSource;
      (document.head || document.documentElement).append(controlIcon);
    }
    originals.clear();
    iconHref = null;
    iconSource = null;
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
  globalThis.__browserBridge = state;
  if (previousOwner) state.claim(previousOwner, previousKey);
})();
