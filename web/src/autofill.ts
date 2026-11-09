/**
 * Browser-Autofill in Pflegedialogen unterbinden.
 *
 * Chrome & Co. füllen gespeicherte Anmeldedaten in das Textfeld VOR einem Passwortfeld – in der
 * Benutzerpflege landete so die E-Mail-Adresse des Admins im Feld „Rollen“ und das eigene Passwort im
 * Startpasswort (Issue #8). UI5-Eingabefelder haben kein `autocomplete`; daher wird es am inneren
 * <input> gesetzt: Passwortfelder `new-password` (kein Einfüllen gespeicherter Kennwörter), andere `off`.
 * Gilt für alle Elemente mit dem Attribut `data-kein-autofill` (die Anmeldeseite bleibt unberührt).
 */
const SEL = '[data-kein-autofill]';

function setzen(el: Element, n = 0) {
  const inp = (el as HTMLElement).shadowRoot?.querySelector('input');
  if (!inp) { if (n < 40) setTimeout(() => setzen(el, n + 1), 50); return; }
  const pw = (el.getAttribute('type') ?? '').toLowerCase() === 'password';
  inp.setAttribute('autocomplete', pw ? 'new-password' : 'off');
  inp.setAttribute('data-lpignore', 'true');      // Passwortmanager wie LastPass
  inp.setAttribute('data-1p-ignore', 'true');     // 1Password
}

export function autofillSperren() {
  if (typeof document === 'undefined') return;
  document.querySelectorAll(SEL).forEach((e) => setzen(e));
  new MutationObserver((ms) => {
    for (const m of ms) {
      if (m.type === 'attributes' && m.target instanceof Element && m.target.matches(SEL)) setzen(m.target);
      for (const n of m.addedNodes) {
        if (!(n instanceof Element)) continue;
        if (n.matches(SEL)) setzen(n);
        n.querySelectorAll(SEL).forEach((e) => setzen(e));
      }
    }
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['type'] });
}
