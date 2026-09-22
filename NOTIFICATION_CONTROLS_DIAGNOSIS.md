# iPhone PWA notification controls — diagnosis (2026-09-22)

Code fix lives in `mirandagarrett1992-code/Lucid-rooms`, branch
`claude/lucid-iphone-notification-controls-4qgws0` (pwa-controls.js,
push-subscribe.js, room-view.html). This debug repo does not contain the
notification modal.

## Evidence (Supabase, project Lucid-rooms)
- The newest owner push subscription is the pre-reinstall iPhone endpoint
  (…8PzU85jN_3r8, last updated 2026-09-21 21:10 UTC), followed by 24 stale
  Apple endpoints from July. The reinstalled PWA never registered.
- Only one notification_dispatches row ever: the 9/21 test (accepted, shown).
  The "Device reported notification displayed" text is that old receipt,
  re-shown on every modal open.
- 19:55:12 UTC today: a preference save reached the DB (max_daily=20,
  interval=60). Save is the one control that doesn't touch the service worker.
- After the reinstall (token refresh 19:57:51 UTC), zero requests from the
  modal reached push-subscribe: no subscription write, no test, no status read.

## Root causes
1. Enable, Turn off, Send test ping and Check delivery all ran unbounded
   async steps (service worker ready/getRegistration/getSubscription/
   subscribe and the shared token refresh). If any one stalled, nothing
   happened on screen and the button looked dead.
2. The page caches one owner token per load. pwa-controls never renewed it
   on 401, so any modal used more than an hour after launch failed.
3. The modal never compared this device's subscription with the server, so
   it looked configured (permission granted, Delivery "On") while the
   server was still sending to the endpoint from before the reinstall.
4. A late dialog `close` event could remove a newly reopened modal.
5. The preference dropdowns showed their default values even when the load
   failed, so they could look like saved settings.
