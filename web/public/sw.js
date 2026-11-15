// Service Worker des Portals: nimmt Push-Nachrichten entgegen und zeigt sie an – auch wenn das Portal nicht geöffnet ist.
// Bewusst ohne Zwischenspeicher für Seiten: Die Oberfläche kommt weiter direkt vom Server (Updates wirken sofort).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = {}; }
  e.waitUntil(self.registration.showNotification(d.titel || 'Portal', {
    body: d.text || '', icon: '/push-192.png', badge: '/push-192.png', data: { pfad: typeof d.pfad === 'string' && d.pfad.startsWith('/') ? d.pfad : '/' },
  }));
});

// Antippen: das geöffnete Portal nach vorn holen und zur Stelle springen – sonst neu öffnen
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const ziel = new URL((e.notification.data && e.notification.data.pfad) || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const fenster = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const f of fenster) {
      try { const n = await f.navigate(ziel); await (n || f).focus(); return; } catch { /* nächstes Fenster bzw. neu öffnen */ }
    }
    await self.clients.openWindow(ziel);
  })());
});
