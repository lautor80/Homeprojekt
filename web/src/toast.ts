import '@ui5/webcomponents/dist/Toast.js';

/** Kurze Erfolgsmeldung unten im Bild (wie MessageToast in UI5). */
export function toast(text: string, duration = 3000): void {
  const el = document.createElement('ui5-toast') as HTMLElement & { open: boolean; duration: number };
  el.textContent = text;
  el.duration = duration;
  el.setAttribute('placement', 'BottomCenter');
  document.body.appendChild(el);
  el.addEventListener('close', () => el.remove());
  requestAnimationFrame(() => (el.open = true));
}
