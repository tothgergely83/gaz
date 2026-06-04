const CACHE = 'gazora-v1';
const STATIC = ['./index.html', './style.css', './app.js', './manifest.json', './icon-192.svg', './icon-512.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.url.includes('googleapis.com') || e.request.url.includes('accounts.google.com')) return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(resp => {
      if (resp.ok && e.request.method === 'GET') {
        caches.open(CACHE).then(c => c.put(e.request, resp.clone()));
      }
      return resp;
    }))
  );
});

self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
  e.waitUntil(self.registration.showNotification(data.title || 'Gázóra', {
    body: data.body || 'Ellenőrizze a gázóra állását!',
    icon: '/icon-192.svg',
    badge: '/icon-192.svg',
    tag: data.tag || 'gazora',
    renotify: true,
    data: { url: '/' }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window' }).then(list => {
    if (list.length) return list[0].focus();
    return clients.openWindow('/');
  }));
});

self.addEventListener('periodicsync', e => {
  if (e.tag === 'check-reading') e.waitUntil(checkAndNotify());
});

self.addEventListener('message', e => {
  if (e.data?.type === 'LAST_READING') {
    self.lastReadingDate = e.data.date;
  }
});

async function checkAndNotify() {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const hour = now.getHours();

  if (dayOfWeek === 6 && hour >= 8 && hour < 12) {
    await self.registration.showNotification('Gázóra – heti leolvasás', {
      body: 'Szombat reggel van – ideje leolvasni a gázórát!',
      icon: '/icon-192.svg',
      tag: 'weekly',
      renotify: false
    });
    return;
  }

  const lastDate = self.lastReadingDate;
  if (!lastDate) return;
  const days = (now - new Date(lastDate)) / 86400000;
  if (days > 7) {
    await self.registration.showNotification('Gázóra – késedelmes leolvasás', {
      body: `Utolsó leolvasás ${Math.floor(days)} napja volt. Kérjük, olvassa le az órát!`,
      icon: '/icon-192.svg',
      tag: 'overdue',
      renotify: true
    });
  }
}
