const tabs = document.querySelector('#tabs');
const errorBox = document.querySelector('#error');
async function refresh() {
  errorBox.hidden = true; document.querySelector('#refresh').disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ op: 'status' });
    if (response.error) throw new Error(response.error);
    document.querySelector('#connection').textContent = response.result.connected ? 'Browser connected' : 'Controller ready';
    document.querySelector('#lamp').className = 'ready';
    tabs.replaceChildren();
    for (const claim of response.result.claims) {
      const row = document.createElement('div'); row.className = 'tab';
      const info = document.createElement('div'); const name = document.createElement('p'); name.textContent = claim.agent;
      const url = document.createElement('p'); url.className = 'url'; url.textContent = claim.url;
      info.append(name, url);
      const stop = document.createElement('button'); stop.textContent = 'Stop'; stop.setAttribute('aria-label', `Stop ${claim.agent} on ${claim.url}`);
      stop.onclick = async () => {
        stop.disabled = true;
        try { const result = await chrome.runtime.sendMessage({ op: 'release', args: { tabId: claim.tabId } }); if (result.error) throw new Error(result.error); await refresh(); }
        catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; stop.disabled = false; }
      };
      row.append(info, stop); tabs.append(row);
    }
    if (!response.result.claims.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'No agent is controlling a tab.'; tabs.append(empty); }
  } catch (error) {
    document.querySelector('#connection').textContent = 'Connection unavailable'; document.querySelector('#lamp').className = '';
    errorBox.textContent = `${error.message} Run Browser Bridge setup, then reload this extension.`; errorBox.hidden = false;
  } finally { document.querySelector('#refresh').disabled = false; }
}
document.querySelector('#refresh').onclick = refresh;
void refresh();
