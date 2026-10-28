// Thin wrapper over the Electron bridge. Outside Electron (plain browser preview) a simulator is loaded.
let bridge = window.xlam;
if (!bridge) bridge = (await import('./mock.js')).createMock();

export async function call(method, args) {
  const r = await bridge.invoke(method, args);
  if (!r.ok) { const e = new Error(r.error); e.code = r.code; throw e; }
  return r.data;
}
export const onEvent = (cb) => bridge.on(cb);
export const win = bridge.win;
export const isMock = !window.xlam;
