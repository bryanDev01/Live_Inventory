// Receives push messages while the app is closed or in the background.
self.addEventListener('push', (event) => {
	let data = {};
	try {
		data = event.data ? event.data.json() : {};
	} catch {
		data = {};
	}

	const title = data.title || 'Inventario';
	const body = data.body || 'Hay un cambio en la tasa de referencia.';

	event.waitUntil(
		self.registration.showNotification(title, {
			body,
			lang: 'es',
			tag: 'rate-change',
			renotify: true,
			data: { url: '/' },
		}),
	);
});

self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	event.waitUntil(
		self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
			for (const client of list) {
				if ('focus' in client) return client.focus();
			}
			return self.clients.openWindow('/');
		}),
	);
});
