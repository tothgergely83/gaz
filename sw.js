const CACHE = 'gazora-v2';
const STATIC = ['./index.html', './style.css', './app.js', './manifest.json', './icon-192.svg', './icon-512.svg'];

// Icon URL relative to this SW's scope (works on any subdirectory deployment)
const ICON = new URL('./icon-192.svg', self.location.href).href;
const APP_URL = new URL('./', self.location.href).href;

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
  if (e.request.url.includes('googleapis.com') || e.request.url.includes('accounts.google.com') || e.request.url.includes('open-meteo.com')) return;
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
    icon: ICON, badge: ICON,
    tag: data.tag || 'gazora',
    renotify: true,
    data: { url: APP_URL }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window' }).then(list => {
    const existing = list.find(c => c.url.startsWith(APP_URL));
    if (existing) return existing.focus();
    return clients.openWindow(APP_URL);
  }));
});

self.addEventListener('periodicsync', e => {
  if (e.tag === 'check-reading') e.waitUntil(checkAndNotify());
});

self.addEventListener('message', e => {
  if (e.data?.type === 'LAST_READING') {
    self.lastReadingDate = e.data.date;
  }
  if (e.data?.type === 'SCHEDULE_WEEKLY') {
    scheduleWeeklyTrigger();
  }
});

// ---- Scheduled notification via TimestampTrigger (Chrome Android) ----

function nextSaturday8am() {
  const now = new Date();
  const daysUntil = (6 - now.getDay() + 7) % 7 || 7; // next Saturday (not today if already Sat)
  const sat = new Date(now);
  sat.setDate(now.getDate() + daysUntil);
  sat.setHours(8, 0, 0, 0);
  return sat;
}

async function scheduleWeeklyTrigger() {
  if (typeof TimestampTrigger === 'undefined') return false;
  // Cancel previous scheduled notification with same tag
  const existing = await self.registration.getNotifications({ tag: 'weekly-trigger', includeTriggered: true }).catch(() => []);
  existing.forEach(n => n.close());

  const sat = nextSaturday8am();
  await self.registration.showNotification('Gázóra – heti leolvasás', {
    body: 'Szombat reggel van – ideje leolvasni a gázórát!',
    icon: ICON,
    tag: 'weekly-trigger',
    renotify: true,
    showTrigger: new TimestampTrigger(sat.getTime()),
    data: { url: APP_URL }
  });
  return true;
}

// ---- Periodic sync fallback ----

async function checkAndNotify() {
  // Re-schedule TimestampTrigger for next week
  await scheduleWeeklyTrigger();

  const now = new Date();
  const dayOfWeek = now.getDay();
  const hour = now.getHours();

  if (dayOfWeek === 6 && hour >= 7 && hour < 14) {
    await self.registration.showNotification('Gázóra – heti leolvasás', {
      body: 'Szombat reggel van – ideje leolvasni a gázórát!',
      icon: ICON,
      tag: 'weekly',
      renotify: false,
      data: { url: APP_URL }
    });
    return;
  }

  const lastDate = self.lastReadingDate;
  if (!lastDate) return;
  const days = (now - new Date(lastDate)) / 86400000;
  if (days > 7) {
    await self.registration.showNotification('Gázóra – késedelmes leolvasás', {
      body: `Utolsó leolvasás ${Math.floor(days)} napja volt. Kérjük, olvassa le az órát!`,
      icon: ICON,
      tag: 'overdue',
      renotify: true,
      data: { url: APP_URL }
    });
  }
}
