/**
 * Отрисовка кропа/масштаба снимка вкладки по плану planCapture: createImageBitmap + OffscreenCanvas → PNG data:-URL.
 * Self-contained (только веб-API, без замыканий): работает в service worker, а стенд гоняет ТУ ЖЕ функцию в странице.
 */
export async function renderCapture(dataUrl, plan) {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(plan.outW, plan.outH);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, plan.sx, plan.sy, plan.sw, plan.sh, 0, 0, plan.outW, plan.outH);
  if (bmp.close) bmp.close();
  const out = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
  let bin = "";
  for (let i = 0; i < out.length; i += 0x8000) bin += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
  return "data:image/png;base64," + btoa(bin);
}
