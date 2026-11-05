(() => {
  if (globalThis.__browserBridge?.version === 14) return;
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
    version: 14,
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
  const minimumJerk = (t) => t * t * t * (10 - 15 * t + 6 * t * t);
  const random = (low, high) => low + Math.random() * (high - low);
  const side = () => (Math.random() < 0.5 ? -1 : 1);
  const turn = (degrees) => ((((degrees + 180) % 360) + 360) % 360) - 180;
  // Bezier curve parameterized by arc length, so the speed profile applies to distance.
  const stroke = (points) => {
    const curve = (u) => {
      let level = points;
      while (level.length > 1)
        level = level
          .slice(1)
          .map((point, index) => [
            level[index][0] + (point[0] - level[index][0]) * u,
            level[index][1] + (point[1] - level[index][1]) * u,
          ]);
      return level[0];
    };
    const samples = Array.from({ length: 65 }, (_, index) => curve(index / 64));
    const lengths = [0];
    for (let index = 1; index < samples.length; index++)
      lengths.push(
        lengths[index - 1] +
          Math.hypot(
            samples[index][0] - samples[index - 1][0],
            samples[index][1] - samples[index - 1][1],
          ),
      );
    const length = lengths[64];
    return {
      length,
      at(fraction) {
        const target = fraction * length;
        let index = 1;
        while (index < 64 && lengths[index] < target) index++;
        const span = lengths[index] - lengths[index - 1] || 1;
        return curve((index - 1 + (target - lengths[index - 1]) / span) / 64);
      },
    };
  };
  // A nearly straight line, a C arc or an S curve that bends to a random side.
  const bend = (from, to, kind) => {
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const distance = Math.hypot(dx, dy) || 1;
    const at = (along, across) => [
      from[0] + dx * along - (dy / distance) * across,
      from[1] + dy * along + (dx / distance) * across,
    ];
    if (kind === 's') {
      const offset = Math.min(distance * random(0.08, 0.14), 46) * side();
      return stroke([from, at(1 / 3, offset), at(2 / 3, -offset), to]);
    }
    const offset = kind === 'c' ? Math.min(distance * random(0.07, 0.16), 60) : distance * 0.03;
    return stroke([from, at(0.5, offset * random(kind === 'c' ? 1 : 0, 1) * side()), to]);
  };
  // Each reach varies its shape and pace. Long reaches sometimes overshoot and settle back.
  const route = (from, to) => {
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const distance = Math.hypot(dx, dy);
    const roll = Math.random();
    const kind = roll < 0.3 ? 'line' : roll < 0.7 ? 'c' : 's';
    const ms = Math.max(400, travelMs(distance) * random(0.9, 1.12));
    if (distance <= 260 || Math.random() < 0.5) return [{ path: bend(from, to, kind), ms }];
    const past = distance * random(0.02, 0.04);
    const aside = distance * random(-0.015, 0.015);
    const over = [
      to[0] + (dx * past - dy * aside) / distance,
      to[1] + (dy * past + dx * aside) / distance,
    ];
    return [
      { path: bend(from, over, kind), ms },
      { path: stroke([over, to]), ms: 170 },
    ];
  };
  // The tip leads: the cursor turns around its tip toward its heading in proportion to speed,
  // so it stands upright again as it slows down. The angle unwraps to avoid spinning.
  const keyframes = (segments, startAngle) => {
    const total = segments.reduce((sum, segment) => sum + segment.ms, 0);
    const peak = (1.875 * segments[0].path.length) / segments[0].ms || 1;
    const samples = [];
    let elapsed = 0;
    for (const { path, ms } of segments) {
      const steps = Math.max(2, Math.ceil(ms / 16));
      for (let index = samples.length ? 1 : 0; index <= steps; index++) {
        const t = index / steps;
        samples.push({ time: elapsed + t * ms, point: path.at(minimumJerk(t)) });
      }
      elapsed += ms;
    }
    let heading = startAngle;
    return samples.map(({ time, point }, index) => {
      const before = samples[Math.max(0, index - 1)];
      const after = samples[Math.min(samples.length - 1, index + 1)];
      const dx = after.point[0] - before.point[0];
      const dy = after.point[1] - before.point[1];
      const speed = Math.hypot(dx, dy) / (after.time - before.time || 1);
      if (speed > 0.001) heading += turn((Math.atan2(dy, dx) * 180) / Math.PI + 135 - heading);
      // The first and last frames hold the starting angle and upright exactly.
      const ends = index === 0 || index === samples.length - 1;
      const weight = ends ? 0 : Math.min(1, speed / (0.5 * peak));
      const lean = weight * weight * (3 - 2 * weight);
      const progress = index === samples.length - 1 ? 1 : Math.min(1, time / total);
      const angle = heading * lean + startAngle * (1 - lean) * (1 - progress);
      return {
        offset: progress,
        transform: `translate3d(${point[0].toFixed(1)}px,${point[1].toFixed(1)}px,0) rotate(${angle.toFixed(1)}deg)`,
      };
    });
  };
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
    'M.92 3.82A2.29 2.29 0 0 1 3.82.92L21.57 6.93A2.4 2.4 0 0 1 21.75 11.4L15.49 14.08A2.68 2.68 0 0 0 14.08 15.49L11.4 21.75A2.4 2.4 0 0 1 6.93 21.57Z';
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
      'position:absolute;left:-.83px;top:-.83px;width:22px;height:22px;transform-origin:.83px .83px;will-change:transform;';
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
          '<g transform="translate(10.4 10.4) scale(.9)">' +
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
    const angle = (Math.atan2(from.b, from.a) * 180) / Math.PI;
    const distance = Math.hypot(x - from.e, y - from.f);
    if (state.watched && !still() && (distance >= 0.5 || Math.abs(angle) >= 0.5)) {
      const start = [from.e, from.f];
      const segments = changed
        ? route(start, [x, y])
        : [{ path: stroke([start, [x, y]]), ms: 150 }];
      const duration = segments.reduce((sum, segment) => sum + segment.ms, 0);
      travel = cursor.animate(keyframes(segments, angle), duration);
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
