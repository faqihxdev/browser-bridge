(() => {
  if (globalThis.__browserBridge?.version === 11) return;
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
    version: 11,
    documentId,
    refs: new Map(),
    sequence: 0,
    owner: null,
    watched: previousAttention,
    position: previousPosition ?? { x: 24, y: 24 },
  };
  const ids = new WeakMap();
  const waits = new Set();
  const actionPauseMs = 150;
  let host, cursor, arrow, icon, observer, layers, travel, idle, idleTimer;
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const matrix = (element) => {
    const value = getComputedStyle(element).transform;
    return new DOMMatrixReadOnly(value === 'none' ? undefined : value);
  };
  // Fitts-style timing: long reaches take longer, short hops stay quick.
  const travelMs = (distance) =>
    Math.min(700, Math.max(400, 280 + 80 * Math.log2(1 + distance / 24)));
  const idleMs = 28000;
  const idleRadius = 3.2;
  // A slow, irregular wander: overlapping waves with random phases, softly held inside
  // idleRadius. It eases out of and back to rest, so starting and looping never jump.
  const wander = () => {
    const waves = [
      [2.4, 9, 'x'],
      [1.6, 19, 'x'],
      [2.4, 12, 'y'],
      [1.6, 17, 'y'],
    ].map(([amplitude, cycles, axis]) => ({
      amplitude,
      cycles,
      axis,
      phase: Math.random() * Math.PI * 2,
    }));
    return Array.from({ length: 281 }, (_, index) => {
      const t = index / 280;
      const edge = Math.min(1, (Math.min(t, 1 - t) * idleMs) / 1500);
      const envelope = edge * edge * (3 - 2 * edge);
      let x = 0;
      let y = 0;
      for (const wave of waves) {
        const value = wave.amplitude * Math.sin(Math.PI * 2 * wave.cycles * t + wave.phase);
        if (wave.axis === 'x') x += value;
        else y += value;
      }
      const radius = Math.hypot(x, y);
      const scale = radius ? (envelope * idleRadius * Math.tanh(radius / idleRadius)) / radius : 0;
      return { transform: `translate(${(x * scale).toFixed(2)}px,${(y * scale).toFixed(2)}px)` };
    });
  };
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
    cursor = document.createElement('div');
    cursor.className = 'cursor';
    // CSSOM styles work on nonce-only pages without inserting an inline stylesheet.
    cursor.style.cssText =
      'position:absolute;left:0;top:0;width:22px;height:22px;will-change:transform;';
    cursor.style.transform = `translate3d(${state.position.x}px,${state.position.y}px,0)`;
    arrow = document.createElement('div');
    arrow.className = 'pointer';
    arrow.style.cssText = 'display:block;width:100%;height:100%;will-change:transform;';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '22');
    svg.setAttribute('height', '22');
    svg.style.cssText = 'display:block;width:100%;height:100%;';
    const path = document.createElementNS(svg.namespaceURI, 'path');
    for (const [key, value] of Object.entries(pointerAttributes)) path.setAttribute(key, value);
    svg.append(path);
    arrow.append(svg);
    const pulse = document.createElement('div');
    pulse.className = 'pulse';
    pulse.style.cssText =
      'position:absolute;inset:-8px;border:1px solid #aaa;border-radius:50%;opacity:0;';
    cursor.append(pulse, arrow);
    root.append(cursor);
    host.popover = 'manual';
    document.documentElement.append(host);
    layers?.disconnect();
    layers = new MutationObserver(raise);
    layers.observe(document.documentElement, {
      subtree: true,
      attributes: true,
      attributeFilter: ['open'],
    });
    addEventListener('toggle', lift, true);
    addEventListener('fullscreenchange', raise, true);
    raise();
  }
  // Modal dialogs, popovers and fullscreen elements render in the top layer above any z-index.
  // The cursor is a manual popover, and reopening it puts it above newer top-layer elements.
  function raise() {
    if (!host?.isConnected || !host.showPopover) return;
    try {
      if (host.matches(':popover-open')) host.hidePopover();
      host.showPopover();
    } catch {
      // Without the top layer, the cursor still sits above ordinary page content.
    }
  }
  function lift(event) {
    if (event.target !== host) raise();
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
    rest();
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
      travel?.cancel();
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
  // Idle drift shows that the tab is still owned and makes the cursor easier to spot.
  // It moves the arrow inside the cursor with replace compositing so it runs off the main thread.
  function rest() {
    if (idle && idle.effect?.target === arrow) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!arrow || !state.owner || still() || travel?.playState === 'running') return;
      idle = arrow.animate(wander(), { duration: idleMs, iterations: Infinity });
    }, 600);
  }
  state.move = async (x, y, click = false) => {
    if (!state.owner) return;
    const changed = state.position.x !== x || state.position.y !== y;
    state.position = { x, y };
    visual();
    raise();
    clearTimeout(idleTimer);
    // Start from the visible point, including any idle offset, so travel never jumps.
    const offset = matrix(arrow);
    const from = matrix(cursor).translate(offset.e, offset.f);
    travel?.cancel();
    idle?.cancel();
    travel = idle = null;
    cursor.style.transform = `translate3d(${x}px,${y}px,0)`;
    const dx = x - from.e;
    const dy = y - from.f;
    const distance = Math.hypot(dx, dy);
    if (state.watched && !still() && distance >= 0.5) {
      const duration = changed ? travelMs(distance) : 150;
      // Hands reach along a slight arc with a minimum-jerk speed profile.
      const bend = Math.min(distance * 0.1, 36) * (Math.random() < 0.5 ? -1 : 1);
      const cx = from.e + dx / 2 - (dy / distance) * bend;
      const cy = from.f + dy / 2 + (dx / distance) * bend;
      const frames = Array.from({ length: 21 }, (_, index) => {
        const t = index / 20;
        const s = t * t * t * (10 - 15 * t + 6 * t * t);
        const u = 1 - s;
        const px = u * u * from.e + 2 * u * s * cx + s * s * x;
        const py = u * u * from.f + 2 * u * s * cy + s * s * y;
        return { transform: `translate3d(${px.toFixed(1)}px,${py.toFixed(1)}px,0)` };
      });
      travel = cursor.animate(frames, duration);
      await wait(duration);
    }
    if (click && cursor && state.owner && state.watched) {
      const pulse = cursor.querySelector('.pulse');
      pulse.getAnimations().forEach((animation) => animation.cancel());
      if (!still())
        pulse.animate(
          [
            { opacity: 0.8, transform: 'scale(.5)' },
            { opacity: 0, transform: 'scale(1.4)' },
          ],
          220,
        );
    }
    if (state.owner) rest();
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
    clearTimeout(idleTimer);
    layers?.disconnect();
    layers = null;
    removeEventListener('toggle', lift, true);
    removeEventListener('fullscreenchange', raise, true);
    host?.remove();
    host = null;
    cursor = arrow = null;
    travel = idle = null;
  };
  state.resolve = (ref) => state.refs.get(ref)?.deref() ?? null;
  state.snapshot = (limit = 200, maxText = 12000) => {
    const items = [];
    let truncated = false;
    const visit = (root) => {
      for (const element of root.querySelectorAll(
        'a[href],button,input,textarea,select,[role],[contenteditable="true"],[tabindex]',
      )) {
        if (element === host || element.closest('[aria-hidden="true"],[inert]')) continue;
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height || getComputedStyle(element).visibility === 'hidden')
          continue;
        if (items.length >= limit) {
          truncated = true;
          break;
        }
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
        if (element.shadowRoot && !truncated) visit(element.shadowRoot);
    };
    visit(document);
    for (const [ref, value] of state.refs) if (!value.deref()?.isConnected) state.refs.delete(ref);
    return {
      documentId: state.documentId,
      title: document.title,
      url: location.href,
      text: (document.body?.innerText || '').slice(0, maxText),
      elements: items,
      truncated,
    };
  };
  globalThis.__browserBridge = state;
  if (previousOwner) state.claim(previousOwner, previousKey);
})();
