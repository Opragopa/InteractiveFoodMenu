// XHR streaming keeps bearer tokens out of URLs and works on Chromium 38.
// A retry is only made after a broken connection, with exponential backoff.
export function subscribeMenu(url: string, token: string, changed: (state: { version?: number; revoked?: boolean }) => void, connection: (online: boolean) => void) {
  let closed = false, xhr: XMLHttpRequest | undefined, retry: ReturnType<typeof setTimeout> | undefined;
  let delay = 2000;
  const open = () => {
    if (closed) return;
    const current = new XMLHttpRequest(); xhr = current;
    let consumed = 0, pending = "", failed = false;
    const fail = () => {
      if (closed || failed || xhr !== current) return;
      failed = true; connection(false); current.abort();
      retry = setTimeout(open, delay + Math.floor(Math.random() * 1000));
      delay = Math.min(60000, delay * 2);
    };
    current.open("GET", url, true);
    current.withCredentials = true;
    current.setRequestHeader("Authorization", `Bearer ${token}`);
    current.setRequestHeader("Accept", "text/event-stream");
    current.onreadystatechange = () => {
      if (closed || failed || xhr !== current || current.readyState < 3) return;
      if (current.status === 401 || current.status === 403) { closed = true; changed({ revoked: true }); current.abort(); return; }
      if (current.status !== 200) { if (current.readyState === 4) fail(); return; }
      const text = current.responseText;
      pending += text.slice(consumed); consumed = text.length;
      let end: number;
      while ((end = pending.indexOf("\n\n")) >= 0) {
        const event = pending.slice(0, end); pending = pending.slice(end + 2);
        if (event.includes("event: unavailable")) { fail(); return; }
        const data = event.split("\n").find(line => line.startsWith("data: "));
        if (data) {
          try {
            const state = JSON.parse(data.slice(6)); changed(state);
            if (state.revoked) { closed = true; current.abort(); return; }
          } catch { fail(); return; }
          delay = 2000; connection(true);
        }
      }
      if (current.readyState === 4) fail();
    };
    current.onerror = fail;
    current.send();
  };
  const online = () => { clearTimeout(retry); const previous = xhr; xhr = undefined; previous?.abort(); delay = 2000; open(); };
  window.addEventListener("online", online);
  open();
  return () => { closed = true; clearTimeout(retry); xhr?.abort(); window.removeEventListener("online", online); };
}
