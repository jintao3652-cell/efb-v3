const expression = process.argv[2];
const list = await (await fetch("http://127.0.0.1:9334/json/list")).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
const result = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ timeout: true }), 60000);
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== 1) return;
    clearTimeout(timer);
    resolve(message);
  });
  ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
});
console.log(JSON.stringify(result?.result?.result?.value ?? result).slice(0, 3000));
ws.close();
