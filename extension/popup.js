const tabs = document.querySelector('#tabs');
const errorBox = document.querySelector('#error');
chrome.runtime.onMessage.addListener((message) => {
  if (message.event === 'state') void refresh();
});
let latest = 0;
async function refresh() {
  // State events can overlap. Render only the newest response.
  const request = ++latest;
  document.querySelector('#refresh').disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ op: 'status' });
    if (request !== latest) return;
    errorBox.hidden = true;
    if (!response) throw new Error('The extension worker did not respond.');
    if (response.error) throw new Error(response.error);
    document.querySelector('#connection').textContent = response.result.connected
      ? 'Connected'
      : 'Ready';
    document.querySelector('#lamp').className = 'ready';
    const focused = document.activeElement?.dataset.tabId;
    tabs.replaceChildren();
    for (const claim of response.result.claims) {
      const row = document.createElement('div');
      row.className = 'tab';
      const info = document.createElement('div');
      const name = document.createElement('p');
      name.textContent = claim.agent;
      const url = document.createElement('p');
      url.className = 'url';
      let address = claim.url;
      try {
        const parsed = new URL(claim.url);
        address = ['http:', 'https:'].includes(parsed.protocol)
          ? parsed.host + (parsed.pathname === '/' ? '' : parsed.pathname)
          : parsed.protocol === 'data:'
            ? 'Data page'
            : claim.url;
      } catch {}
      url.textContent = address;
      info.append(name, url);
      const stop = document.createElement('button');
      stop.textContent = 'Stop';
      stop.dataset.tabId = claim.tabId;
      stop.setAttribute('aria-label', `Stop ${claim.agent} on ${address}`);
      stop.onclick = async () => {
        stop.disabled = true;
        try {
          const result = await chrome.runtime.sendMessage({
            op: 'release',
            args: { tabId: claim.tabId },
          });
          if (result.error) throw new Error(result.error);
          await refresh();
        } catch (error) {
          errorBox.textContent = error.message;
          errorBox.hidden = false;
          stop.disabled = false;
        }
      };
      row.append(info, stop);
      tabs.append(row);
      if (claim.tabId === focused) stop.focus();
    }
    if (!response.result.claims.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No active tabs.';
      tabs.append(empty);
    }
  } catch (error) {
    if (request !== latest) return;
    document.querySelector('#connection').textContent = 'Unavailable';
    document.querySelector('#lamp').className = '';
    errorBox.textContent = `${error.message} Run setup, then reload this extension.`;
    errorBox.hidden = false;
  } finally {
    if (request === latest) document.querySelector('#refresh').disabled = false;
  }
}
document.querySelector('#refresh').onclick = refresh;
void refresh();
